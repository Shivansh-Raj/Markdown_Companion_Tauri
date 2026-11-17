import { inTranscript, extractJson } from "./coach";

/**
 * Follow-up detection (earlier action items vs. a new meeting) and live question suggestions.
 * Nothing here ever ticks a checkbox or edits a file: it only reports what the transcript suggests.
 */

export type ItemState = "open" | "done" | "unknown";

export interface PriorItem {
  id: string;
  task: string;
  owner: string | null;
  deadline: string | null;
  meetingTitle: string;
  meetingDate: string;
  /** From the Markdown checkbox in a tracked file, when the item could be found there. */
  state: ItemState;
  file?: string;
}

export type FollowStatus = "resolved" | "discussed_open" | "delayed" | "not_mentioned";

export interface FollowUp {
  id: string;
  status: FollowStatus;
  /** A quote from the new transcript supporting the status (verified to exist). */
  evidence: string;
  note: string;
}

export interface RecurringTopic { topic: string; meetings: string[]; evidence: string }

export interface FollowUpReport {
  createdAtMs: number;
  items: PriorItem[];
  results: FollowUp[];
  topics: RecurringTopic[];
  /** Quotes the AI gave that were not in the transcript (their statuses were reset). */
  dropped: number;
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

// ---- reading checkbox state from Markdown ----

export interface Checkbox { checked: boolean; text: string }

/** Task lines outside code fences. */
export function parseCheckboxes(content: string): Checkbox[] {
  const out: Checkbox[] = [];
  let fence: string | null = null;
  for (const line of content.split(/\r?\n/)) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { fence = fence === null ? f[1][0] : fence === f[1][0] ? null : fence; continue; }
    if (fence) continue;
    const m = /^\s*(?:>\s*)*(?:[-*+]|\d{1,9}[.)])\s+\[([ xX])\]\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ checked: m[1] !== " ", text: m[2] });
  }
  return out;
}

/** Looks each earlier action item up in the user's Markdown files to read its real checkbox state. */
export function matchCheckboxState(items: PriorItem[], files: { name: string; content: string }[]): PriorItem[] {
  const boxes = files.flatMap((f) => parseCheckboxes(f.content).map((b) => ({ ...b, file: f.name, key: squash(b.text) })));
  return items.map((it) => {
    const key = squash(it.task);
    if (key.length < 4) return it;
    const hits = boxes.filter((b) => b.key === key || (key.length >= 12 && (b.key.includes(key) || (b.key.length >= 12 && key.includes(b.key)))));
    if (!hits.length) return { ...it, state: "unknown" as const };
    // if the same task appears several times, an unchecked copy means it is still open
    const open = hits.find((h) => !h.checked);
    return open ? { ...it, state: "open" as const, file: open.file } : { ...it, state: "done" as const, file: hits[0].file };
  });
}

// ---- comparing with a new meeting ----

export function buildFollowUpSystemPrompt(): string {
  return (
    "You compare action items from EARLIER meetings with the transcript of a NEW meeting. " +
    'Output ONLY a JSON array with one element per action item: {"id": string, "status": "resolved"|"discussed_open"|"delayed"|"not_mentioned", "evidence": string, "note": string}. ' +
    "'resolved' = the new transcript says it was completed. 'discussed_open' = it was discussed again but no completion was stated. " +
    "'delayed' = someone says it is late, postponed or has a new deadline. 'not_mentioned' = it does not come up. " +
    "'evidence' must be an exact quote copied from the new transcript for every status except 'not_mentioned' (use an empty string then). " +
    "'note' is one short sentence. Being mentioned again does NOT mean it is unfinished or finished; judge only from what is said. " +
    "Never invent facts. No code fences, no commentary."
  );
}

const RETHINK = "The user was not satisfied with the previous answer. Re-read the transcript carefully and reconsider each point, " +
  "this time being stricter about evidence.\n\n";

export function buildFollowUpUserPrompt(items: PriorItem[], transcript: string, rethink = false): string {
  const list = items
    .map((i) => `- id=${i.id} | task: ${i.task} | owner: ${i.owner ?? "not stated"} | due: ${i.deadline ?? "not stated"} | from: ${i.meetingTitle} (${i.meetingDate})`)
    .join("\n");
  return `${rethink ? RETHINK : ""}Earlier action items:\n${list}\n\nNew meeting transcript:\n"""\n${transcript}\n"""`;
}

const STATUSES: FollowStatus[] = ["resolved", "discussed_open", "delayed", "not_mentioned"];

/** Validates a reply: unknown ids are dropped and any status without a verifiable quote becomes "not_mentioned". */
export function toFollowUps(raw: string, items: PriorItem[], transcript: string): { results: FollowUp[]; dropped: number } {
  const json = extractJson(raw);
  if (!Array.isArray(json)) throw new Error("The follow-up check did not return a list. Try again.");
  const t = squash(transcript);
  const byId = new Map<string, FollowUp>();
  let dropped = 0;
  for (const row of json) {
    const r = (row ?? {}) as Record<string, unknown>;
    const id = typeof r.id === "string" ? r.id : "";
    if (!items.some((i) => i.id === id)) continue;
    let status: FollowStatus = STATUSES.includes(r.status as FollowStatus) ? (r.status as FollowStatus) : "not_mentioned";
    const evidence = typeof r.evidence === "string" ? r.evidence.trim() : "";
    const note = typeof r.note === "string" ? r.note.trim().slice(0, 300) : "";
    if (status !== "not_mentioned" && !inTranscript(evidence, t)) {
      dropped++;
      status = "not_mentioned";
    }
    byId.set(id, { id, status, evidence: status === "not_mentioned" ? "" : evidence, note });
  }
  // anything the model skipped is reported as not mentioned rather than silently disappearing
  const results = items.map((i) => byId.get(i.id) ?? { id: i.id, status: "not_mentioned" as const, evidence: "", note: "" });
  return { results, dropped };
}

export function buildTopicsSystemPrompt(): string {
  return (
    "You find topics that keep coming up across several meetings. You get summaries of earlier meetings and the transcript of a new one. " +
    'Output ONLY a JSON array (at most 5) of {"topic": string, "meetings": [string], "evidence": string}. ' +
    "A topic counts only if it appears in the new meeting AND in at least one earlier summary. 'meetings' lists the titles of earlier meetings that covered it. " +
    "'evidence' is an exact quote from the NEW transcript. If nothing recurs output []. Never invent topics. No code fences."
  );
}

export function buildTopicsUserPrompt(summaries: { title: string; date: string; markdown: string }[], transcript: string, rethink = false): string {
  const prior = summaries.map((s) => `### ${s.title} (${s.date})\n${s.markdown}`).join("\n\n");
  return `${rethink ? RETHINK : ""}Earlier meetings:\n${prior}\n\nNew meeting transcript:\n"""\n${transcript}\n"""`;
}

export function toTopics(raw: string, transcript: string): { topics: RecurringTopic[]; dropped: number } {
  const json = extractJson(raw);
  if (!Array.isArray(json)) throw new Error("The topic check did not return a list. Try again.");
  const t = squash(transcript);
  const topics: RecurringTopic[] = [];
  let dropped = 0;
  for (const row of json) {
    const r = (row ?? {}) as Record<string, unknown>;
    const topic = typeof r.topic === "string" ? r.topic.trim() : "";
    const evidence = typeof r.evidence === "string" ? r.evidence.trim() : "";
    const meetings = (Array.isArray(r.meetings) ? r.meetings : []).filter((m): m is string => typeof m === "string" && !!m.trim());
    if (!topic || !meetings.length) continue;
    if (!inTranscript(evidence, t)) { dropped++; continue; }
    topics.push({ topic, meetings, evidence });
  }
  return { topics: topics.slice(0, 5), dropped };
}

const STATUS_HEADINGS: [FollowStatus, string][] = [
  ["delayed", "Possibly delayed"],
  ["discussed_open", "Discussed again, no completion recorded"],
  ["resolved", "Sounds finished (check, then tick it yourself)"],
  ["not_mentioned", "Not discussed in this meeting"],
];

function itemLine(i: PriorItem, f?: FollowUp): string {
  const meta = [i.owner ? `Owner: ${i.owner}` : "Owner: _not stated_", i.deadline ? `Due: ${i.deadline}` : "Due: _not stated_", `From: ${i.meetingTitle} (${i.meetingDate})`];
  const where = i.state === "unknown" ? "_not found in your Markdown files, so its checkbox state is unknown_" : i.file ? `still unchecked in ${i.file}` : "";
  const ev = f?.evidence ? `\n  - Said: “${f.evidence}”` : "";
  const note = f?.note ? `\n  - ${f.note}` : "";
  return `- ${i.task}\n  - ${meta.join(" · ")}${where && i.state !== "done" ? `\n  - ${where}` : ""}${ev}${note}`;
}

export function followUpMarkdown(r: FollowUpReport): string {
  const out: string[] = [];
  const active = r.items.filter((i) => i.state !== "done");
  const done = r.items.filter((i) => i.state === "done");
  for (const [status, heading] of STATUS_HEADINGS) {
    const rows = active.filter((i) => r.results.find((x) => x.id === i.id)?.status === status);
    if (!rows.length) continue;
    out.push(`**${heading}**`, "", ...rows.map((i) => itemLine(i, r.results.find((x) => x.id === i.id))), "");
  }
  if (done.length) out.push("**Already ticked in your notes (not re-checked)**", "", ...done.map((i) => `- ${i.task} (${i.file})`), "");
  if (r.topics.length) {
    out.push("**Topics that keep coming up**", "", ...r.topics.map((t) => `- ${t.topic} — also in: ${t.meetings.join(", ")}\n  - Said: “${t.evidence}”`), "");
  }
  if (!out.length) out.push("_No earlier action items to follow up on._", "");
  if (r.dropped) out.push(`_${r.dropped} point(s) were left out or reset because their quote did not match the transcript._`);
  out.push("_Nothing was ticked or changed in your files. These are suggestions to review._");
  return out.join("\n");
}

// ---- live question suggestions ----

export type QuestionKind = "clarify" | "owner" | "deadline" | "assumption" | "risk" | "dependency" | "unresolved";
export interface Suggestion { question: string; reason: string; kind: QuestionKind }

export const SUGGEST_MIN_GAP_MS = 45_000;
export const SUGGEST_MIN_WORDS = 40;
export const SUGGEST_CONTEXT_CHARS = 2400;

/** Decides whether it is a good moment to ask for new questions (never while busy, paused or too soon). */
export function shouldSuggest(s: { enabled: boolean; paused: boolean; inFlight: boolean; transcribing: number; sinceMs: number; newWords: number }): boolean {
  return s.enabled && !s.paused && !s.inFlight && s.transcribing === 0 && s.sinceMs >= SUGGEST_MIN_GAP_MS && s.newWords >= SUGGEST_MIN_WORDS;
}

export function buildQuestionSystemPrompt(): string {
  return (
    "You help someone attending a live meeting by suggesting questions they MAY want to ask. You see the most recent part of the transcript. " +
    'Output ONLY a JSON array of at most 3 items: {"question": string, "reason": string, "kind": "clarify"|"owner"|"deadline"|"assumption"|"risk"|"dependency"|"unresolved"}. ' +
    "Suggest a question only when the transcript shows a real gap: an ambiguous technical explanation (clarify), a task with no named person (owner), " +
    "a commitment with no timeline (deadline), an unstated assumption, an unmentioned risk or dependency, or an issue left unresolved. " +
    "Each question is short, polite and specific to what was said. 'reason' is one short sentence pointing at the gap. " +
    "Do not repeat the questions already suggested. If there is nothing worth asking, output []. No code fences, no commentary."
  );
}

export function buildQuestionUserPrompt(recent: string, already: string[], rethink = false): string {
  const prev = already.length ? `Already suggested (do not repeat):\n${already.map((q) => `- ${q}`).join("\n")}\n\n` : "";
  const again = rethink ? "The user was not satisfied with those suggestions. Think again and offer questions from different angles.\n\n" : "";
  return `${again}${prev}Most recent transcript:\n"""\n${recent}\n"""`;
}

const KINDS: QuestionKind[] = ["clarify", "owner", "deadline", "assumption", "risk", "dependency", "unresolved"];

export function parseQuestions(raw: string, already: string[]): Suggestion[] {
  let json: unknown;
  try { json = extractJson(raw); } catch { return []; }
  if (!Array.isArray(json)) return [];
  const seen = new Set(already.map(squash));
  const out: Suggestion[] = [];
  for (const row of json) {
    const r = (row ?? {}) as Record<string, unknown>;
    const question = typeof r.question === "string" ? r.question.trim().slice(0, 240) : "";
    if (!question || seen.has(squash(question))) continue;
    seen.add(squash(question));
    out.push({
      question,
      reason: typeof r.reason === "string" ? r.reason.trim().slice(0, 200) : "",
      kind: KINDS.includes(r.kind as QuestionKind) ? (r.kind as QuestionKind) : "clarify",
    });
  }
  return out.slice(0, 3);
}

/** The tail of the transcript sent for live suggestions (keeps latency and cost low). */
export function recentContext(text: string, max = SUGGEST_CONTEXT_CHARS): string {
  if (text.length <= max) return text;
  const tail = text.slice(-max);
  const space = tail.indexOf(" ");
  return space > 0 && space < 80 ? tail.slice(space + 1) : tail;
}
