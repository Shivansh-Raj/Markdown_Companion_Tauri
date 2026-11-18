/**
 * Context Receipt: the only way text can reach the cloud model.
 *
 * A call site builds a `ReceiptRequest` (the exact system and user text it wants to send, plus a labelled list of
 * what is in it). The receipt dialog shows it, and if the user agrees an `Approved` object is minted. `streamChat`
 * accepts only an `Approved`, and takes the text to send from it, so nothing can be sent that was not shown.
 */

export interface ReceiptItem {
  /** What this is, e.g. "Sprint.md (whole file)" or "Your question". */
  label: string;
  /** The exact text. It must appear verbatim in the request's `system` or `user` text. */
  text: string;
  /** Typed by the user in this app moments ago (a prompt, a question). Shown, but needs no separate review. */
  typed?: boolean;
  note?: string;
}

/**
 * - `review`: the user sees the receipt and must approve (unless they chose "don't ask again" for this exact text).
 * - `typed`: everything sent was typed by the user a moment ago; no dialog.
 * - `standing`: the user switched on a feature that sends recent text periodically (live question suggestions).
 */
export type ReceiptMode = "review" | "typed" | "standing";

export interface ReceiptRequest {
  purpose: string;
  system: string;
  user: string;
  items: ReceiptItem[];
  mode: ReceiptMode;
}

export const DESTINATION = "Groq (api.groq.com)";

const minted = new WeakMap<object, { system: string; user: string }>();

/** Proof that a request was approved. Opaque: build one only with `mint`. */
export interface Approved {
  readonly purpose: string;
  readonly chars: number;
}

/** FNV-1a. For remembering "unchanged text" within a session; not a security hash. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export function totalChars(req: Pick<ReceiptRequest, "system" | "user">): number {
  return req.system.length + req.user.length;
}

/** Roughly 4 characters per token; good enough to show the size of a request. */
export const approxTokens = (chars: number) => Math.ceil(chars / 4);

/** Identifies a request's reviewable content, so approval can be remembered only for unchanged text. */
export function fingerprint(req: ReceiptRequest): string {
  const parts = req.items.filter((i) => !i.typed).map((i) => `${i.label}:${hashText(i.text)}`);
  return `${req.purpose}|${parts.join(",")}`;
}

/** Throws if the items shown do not match what would be sent. Catches a dialog drifting from reality. */
export function assertConsistent(req: ReceiptRequest): void {
  for (const item of req.items) {
    if (!item.text) continue;
    if (!req.user.includes(item.text) && !req.system.includes(item.text)) {
      throw new Error(`Receipt item "${item.label}" is not part of the text being sent.`);
    }
  }
  if (req.mode === "typed" && req.items.some((i) => !i.typed)) {
    throw new Error("A request marked as typed contains text the user did not type.");
  }
}

/** Mints the approval for a request. Call only after the user agreed, or when the mode needs no dialog. */
export function mint(req: ReceiptRequest): Approved {
  assertConsistent(req);
  const approved: Approved = { purpose: req.purpose, chars: totalChars(req) };
  minted.set(approved, { system: req.system, user: req.user });
  return approved;
}

/** The text an approval covers. Throws for anything not minted by `mint`. */
export function approvedPayload(a: Approved): { system: string; user: string } {
  const p = minted.get(a);
  if (!p) throw new Error("Nothing can be sent to the AI without an approved receipt.");
  return p;
}

/** True when no dialog is needed: only typed text, or the user's standing opt-in for a periodic feature. */
export function skipsDialog(reqs: ReceiptRequest[]): boolean {
  return reqs.every((r) => r.mode === "typed" || r.mode === "standing");
}

/** Merges the items of several requests for one dialog, dropping exact duplicates (same transcript, three prompts). */
export function mergedItems(reqs: ReceiptRequest[]): ReceiptItem[] {
  const seen = new Set<string>();
  const out: ReceiptItem[] = [];
  for (const r of reqs) {
    for (const i of r.items) {
      const key = `${i.label}\u0000${hashText(i.text)}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(i);
      }
    }
  }
  return out;
}
