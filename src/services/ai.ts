import { approvedPayload, type Approved } from "./receipt";

export const DOC_TYPES = ["plan", "tasks", "scheduler", "notes"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export type DocTypeChoice = DocType | "auto";

export const DOC_TYPE_LABELS: Record<DocTypeChoice, string> = {
  auto: "Auto-detect",
  plan: "Plan",
  tasks: "Task list",
  scheduler: "Scheduler",
  notes: "Notes",
};

export const API = "https://api.groq.com/openai/v1";
const ENDPOINT = `${API}/chat/completions`;

/** Best first. Matched against the models the user's key can actually use. */
const PREFERRED = [/llama-3\.3-70b/, /gpt-oss-120b/, /llama-?4/, /llama-3\.1-70b/, /gpt-oss-20b/, /qwen/, /llama-3\.1-8b/];
const NOT_CHAT = /whisper|guard|tts|playai|orpheus|embed|distil-whisper|safeguard|compound/i;

export function pickModel(ids: string[]): string | null {
  const chat = ids.filter((id) => !NOT_CHAT.test(id));
  for (const re of PREFERRED) {
    const hit = chat.find((id) => re.test(id));
    if (hit) return hit;
  }
  return chat[0] ?? null;
}

/** fetch that turns network failures into a readable message. */
export async function groqFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (init.signal?.aborted) throw e;
    throw new Error("Can't reach Groq. Check your internet connection and try again.");
  }
}

/** Verifies a key and reports which model would be used. */
export async function testKey(apiKey: string): Promise<string> {
  cachedModel = null;
  return resolveModel(apiKey, new AbortController().signal);
}

let cachedModel: { key: string; model: string } | null = null;

async function resolveModel(apiKey: string, signal: AbortSignal): Promise<string> {
  if (cachedModel?.key === apiKey) return cachedModel.model;
  const res = await groqFetch(`${API}/models`, { signal, headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 401) throw new Error("Groq rejected the API key. Check it with the KEY button.");
  if (!res.ok) throw new Error(`Could not list Groq models (${res.status}).`);
  const data = await res.json();
  const ids: string[] = (data?.data ?? [])
    .filter((m: { active?: boolean }) => m.active !== false)
    .map((m: { id: string }) => m.id);
  const model = pickModel(ids);
  if (!model) throw new Error("Your Groq key has no chat models available.");
  cachedModel = { key: apiKey, model };
  return model;
}

const TYPE_GUIDE: Record<DocType, string> = {
  plan: "a PLAN: a title, a short goal, phases as '##' sections, and '- [ ]' checkbox steps inside each phase.",
  tasks: "a TASK LIST: a title and '##' groups of '- [ ]' checkbox tasks, ordered by priority.",
  scheduler: "a SCHEDULER: a title and one '##' section per day or time block, with '- [ ] HH:MM – activity' checkbox lines.",
  notes: "NOTES: a title, '##' sections, concise bullet points. Use checkboxes only for real action items.",
};

export function buildSystemPrompt(type: DocTypeChoice): string {
  const base =
    "You write Markdown files for a checklist app. Output ONLY the Markdown document, no commentary and no code fences around it. " +
    "Use GitHub-flavoured Markdown. Begin with a single '# ' title line.";
  if (type === "auto") {
    return (
      base +
      " First decide which document type best fits the request: plan, tasks, scheduler or notes. " +
      "Your very first line must be exactly 'TYPE: <type>' (one of those four words), then a blank line, then the document. " +
      "Types: " + DOC_TYPES.map((t) => `${t} = ${TYPE_GUIDE[t]}`).join(" ")
    );
  }
  return base + " Write " + TYPE_GUIDE[type];
}

/** Splits the leading `TYPE: x` line (auto mode) from the document body, tolerating partial streams. */
export function splitTypeLine(raw: string): { type: DocType | null; body: string; pending: boolean } {
  const m = /^\s*TYPE:\s*([A-Za-z]+)[^\n]*(\n|$)/i.exec(raw);
  if (!m) {
    // The first line may still be arriving ("TY", "TYPE: pl"…); hold output back until we know.
    const head = raw.trimStart();
    const pending = head.length < 6 || (/^TYPE/i.test(head) && !head.includes("\n"));
    return { type: null, body: pending ? "" : raw, pending };
  }
  const word = m[1].toLowerCase() as DocType;
  const type = (DOC_TYPES as readonly string[]).includes(word) ? word : null;
  if (!m[2]) return { type, body: "", pending: true };
  return { type, body: raw.slice(m[0].length).replace(/^\s*\n/, ""), pending: false };
}

export function titleFromMarkdown(md: string, fallback: string): string {
  const m = /^#\s+(.+)$/m.exec(md);
  return (m?.[1] ?? fallback).replace(/[#*_`]/g, "").trim() || fallback;
}

/** Strips a wrapping ```markdown fence if the model added one. */
export function stripFence(md: string): string {
  const m = /^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$/.exec(md);
  return m ? m[1] : md;
}

/** Extracts content deltas from a chunk of SSE text; returns leftover partial line. */
export function parseSse(buffer: string): { deltas: string[]; rest: string; done: boolean } {
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  const deltas: string[] = [];
  let done = false;
  for (const line of lines) {
    const l = line.trim();
    if (!l.startsWith("data:")) continue;
    const data = l.slice(5).trim();
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    try {
      const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
      if (typeof delta === "string") deltas.push(delta);
    } catch {
      /* ignore malformed keep-alive lines */
    }
  }
  return { deltas, rest, done };
}

/**
 * The only function that sends text to the model. It takes the text from an `Approved` receipt (see receipt.ts),
 * so it cannot send anything the user was not shown.
 */
export async function streamChat(opts: {
  apiKey: string;
  approval: Approved;
  signal: AbortSignal;
  onText: (full: string) => void;
}): Promise<string> {
  const { system, user } = approvedPayload(opts.approval);
  const model = await resolveModel(opts.apiKey, opts.signal);
  const res = await groqFetch(ENDPOINT, {
    method: "POST",
    signal: opts.signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = (await res.json())?.error?.message ?? "";
    } catch {
      /* no body */
    }
    if (res.status === 401) throw new Error("Groq rejected the API key. Check it in Settings.");
    if (res.status === 429) throw new Error("Groq rate limit reached. Try again in a moment.");
    if (res.status === 413) {
      const m = /Limit (\d+), Requested (\d+)/.exec(detail);
      const size = m ? ` Your plan allows ${Number(m[1]).toLocaleString()} tokens a minute and this needed about ${Number(m[2]).toLocaleString()}.` : "";
      throw new Error(`That is too much text for Groq's limit on your plan.${size} Ask about a smaller part, wait a minute, or upgrade the plan.`);
    }
    throw new Error(`Groq request failed (${res.status}, model ${model}). ${detail}`.trim());
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSse(buffer);
    buffer = parsed.rest;
    if (parsed.deltas.length) {
      full += parsed.deltas.join("");
      opts.onText(full);
    }
    if (parsed.done) break;
  }
  return full;
}

export function streamGeneration(opts: {
  apiKey: string;
  approval: Approved;
  signal: AbortSignal;
  onText: (full: string) => void;
}): Promise<string> {
  return streamChat(opts);
}
