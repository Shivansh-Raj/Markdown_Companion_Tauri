import { formatClock } from "./transcript";
import type { SessionMeta, TranscriptChunk } from "./types";

export type AnalysisType = "summary" | "takeaways" | "actions";
export const ANALYSIS_TYPES: AnalysisType[] = ["summary", "takeaways", "actions"];
export const ANALYSIS_LABELS: Record<AnalysisType, string> = {
  summary: "Meeting summary",
  takeaways: "Key takeaways",
  actions: "Action items",
};

export interface ActionItem {
  task: string;
  owner: string | null;
  deadline: string | null;
  context: string | null;
}

/** One saved analysis. `markdown` is what gets exported; `items` keeps action items structured. */
export interface AnalysisResult {
  type: AnalysisType;
  createdAtMs: number;
  markdown: string;
  items?: ActionItem[];
  /** Set when the transcript was too long and only the start was analysed. */
  truncated?: boolean;
}

export const MAX_TRANSCRIPT_CHARS = 100_000;

/** The transcript with `[mm:ss]` markers so the model can ground its answers in time. */
export function timedTranscript(chunks: TranscriptChunk[]): string {
  return chunks
    .filter((c) => c.status === "final" && c.text.trim())
    .map((c) => `[${formatClock(c.startMs)}] ${c.text.trim()}`)
    .join("\n");
}

export function limitTranscript(text: string, max = MAX_TRANSCRIPT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  return { text: cut.slice(0, Math.max(cut.lastIndexOf("\n"), 0) || max), truncated: true };
}

const GROUNDING =
  "Base everything strictly on the transcript. Never invent facts, names, owners, deadlines or decisions. " +
  "The transcript comes from speech recognition and may contain mistakes; do not over-interpret odd words. " +
  "Write in the same language as the transcript.";

export function buildSystemPrompt(type: AnalysisType): string {
  switch (type) {
    case "summary":
      return (
        "You summarise meetings. Output ONLY Markdown with no code fences. Use exactly these sections, in order: " +
        "'## Overview' (3-5 sentences), '## Decisions' (bullets; only if decisions were actually made), " +
        "'## Open questions' (bullets; only if questions were left unresolved). Omit a section that has no content. " +
        GROUNDING
      );
    case "takeaways":
      return (
        "You extract the key takeaways of a meeting: the most important information, explanations and discussion points. " +
        "Output ONLY a Markdown bullet list of 5 to 10 items, most important first, each one short sentence, with no code fences " +
        "and no heading. " + GROUNDING
      );
    case "actions":
      return (
        "You extract action items from a meeting. Output ONLY a JSON array, with no code fences and no commentary. " +
        'Each element is {"task": string, "owner": string|null, "deadline": string|null, "context": string|null}. ' +
        "A task is something someone committed to do or was asked to do. 'owner' is a person ONLY if the transcript names who " +
        "does it; otherwise null. 'deadline' is a date or time ONLY if one was stated, written as said (for example 'Friday'); otherwise null. " +
        "'context' is a short phrase on why or what it relates to, or null. If there are no action items output []. " + GROUNDING
      );
  }
}

export function buildUserPrompt(meta: Pick<SessionMeta, "title">, transcript: string): string {
  return `Meeting title: ${meta.title}\n\nTranscript:\n"""\n${transcript}\n"""`;
}

const UNKNOWN = /^\s*(null|none|n\/a|na|unknown|unspecified|not (stated|specified|mentioned|assigned)|tbd|-+)\s*$/i;

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && !UNKNOWN.test(t) ? t : null;
}

/** Pulls the JSON array out of a model reply, tolerating fences and stray text. */
export function parseActionItems(raw: string): ActionItem[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("The AI did not return a list of action items. Try again.");
  let data: unknown;
  try {
    data = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error("The action items came back in an unreadable format. Try again.");
  }
  if (!Array.isArray(data)) throw new Error("The AI did not return a list of action items. Try again.");
  const items: ActionItem[] = [];
  for (const row of data) {
    const r = (row ?? {}) as Record<string, unknown>;
    const task = clean(r.task);
    if (!task) continue;
    items.push({ task, owner: clean(r.owner), deadline: clean(r.deadline), context: clean(r.context) });
  }
  return items;
}

export function actionItemsMarkdown(items: ActionItem[]): string {
  if (!items.length) return "_No action items were identified in this meeting._";
  return items
    .map((i) => {
      const owner = i.owner ?? "_not stated_";
      const due = i.deadline ?? "_not stated_";
      const ctx = i.context ? `\n  - Context: ${i.context}` : "";
      return `- [ ] ${i.task}\n  - Owner: ${owner}\n  - Due: ${due}${ctx}`;
    })
    .join("\n");
}

export function stripFences(text: string): string {
  const m = /^\s*```(?:markdown|md|json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return (m ? m[1] : text).trim();
}

/** Turns the raw model reply into a stored result. */
export function toResult(type: AnalysisType, raw: string, truncated: boolean, now = Date.now()): AnalysisResult {
  if (type === "actions") {
    const items = parseActionItems(raw);
    return { type, createdAtMs: now, items, markdown: actionItemsMarkdown(items), truncated };
  }
  const markdown = stripFences(raw);
  if (!markdown) throw new Error("The AI returned nothing. Try again.");
  return { type, createdAtMs: now, markdown, truncated };
}

/** Latest result per type from a list of saved results. */
export function latestByType(results: AnalysisResult[]): Partial<Record<AnalysisType, AnalysisResult>> {
  const out: Partial<Record<AnalysisType, AnalysisResult>> = {};
  for (const r of results) {
    const cur = out[r.type];
    if (!cur || r.createdAtMs >= cur.createdAtMs) out[r.type] = r;
  }
  return out;
}
