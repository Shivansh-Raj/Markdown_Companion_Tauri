import { inTranscript } from "./voice/coach";

/** Ask a question about one Markdown file; the answer must come from the file itself. */

export const MAX_ASK_CHARS = 80_000;
export const NOT_FOUND = "I couldn't find that in this file.";

export interface Turn { question: string; answer: string }
export interface Passage { path: string; rel: string; name: string; heading: string; text: string }
/** A quote the AI gave. `passage` is the note it was found in (folder and vault questions only). */
export interface Source { quote: string; verified: boolean; passage?: Passage }
export interface ParsedAnswer { answer: string; sources: Source[] }

export function buildAskSystemPrompt(): string {
  return (
    "You answer questions about ONE Markdown document, using ONLY what is written in it. " +
    "In the document, '- [x]' is a completed task and '- [ ]' is a task that is not done yet. " +
    `If the document does not contain the answer, reply exactly: ${NOT_FOUND} Never use outside knowledge, never guess, and never invent details. ` +
    "Keep the answer short and direct, in the language of the question. Plain text or simple Markdown lists are fine. " +
    "After the answer, add a line 'SOURCES:' followed by up to 3 lines, each '- \"<exact quote from the document>\"', copied character for character " +
    "from the document. If you answered that it was not found, omit SOURCES."
  );
}

export function limitDoc(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_ASK_CHARS) return { text: content, truncated: false };
  const cut = content.slice(0, MAX_ASK_CHARS);
  const nl = cut.lastIndexOf("\n");
  return { text: nl > 0 ? cut.slice(0, nl) : cut, truncated: true };
}

/** Earlier turns are included (briefly) so follow-up questions like "and who owns it?" make sense. */
export function askHistoryText(history: Turn[]): string {
  return history.slice(-4).map((t) => `Q: ${t.question}\nA: ${t.answer.slice(0, 600)}`).join("\n\n");
}

export function buildAskUserPrompt(question: string, history: Turn[], doc: string): string {
  const prior = askHistoryText(history);
  return `${prior ? `Earlier in this conversation:\n${prior}\n\n` : ""}Document:\n"""\n${doc}\n"""\n\nQuestion: ${question}`;
}

/** Splits the reply into answer and sources, and marks which source quotes really appear in the file. */
export function parseAskAnswer(raw: string, doc: string): ParsedAnswer {
  const idx = raw.search(/\n?\s*SOURCES:\s*/i);
  const answer = (idx >= 0 ? raw.slice(0, idx) : raw).trim();
  const tail = idx >= 0 ? raw.slice(idx).replace(/^\s*SOURCES:\s*/i, "") : "";
  const squashed = doc.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  const sources: Source[] = [];
  for (const line of tail.split("\n")) {
    const m = /^\s*[-*]?\s*["“”']?(.+?)["“”']?\s*$/.exec(line);
    const quote = m?.[1]?.trim() ?? "";
    if (quote.length < 3 || sources.some((s) => s.quote === quote)) continue;
    sources.push({ quote, verified: inTranscript(quote, squashed) });
    if (sources.length === 3) break;
  }
  return { answer, sources };
}

export function isNotFound(answer: string): boolean {
  const a = answer.trim().toLowerCase();
  return a.startsWith("i couldn't find that in this file") || a.startsWith("i couldn't find that in these notes") || a.startsWith("i couldn't find anything about that");
}

// ---- Folder and vault questions: the answer comes from numbered passages taken from several notes ----

export const NOT_FOUND_SCOPED = "I couldn't find that in these notes.";

export function buildScopedSystemPrompt(): string {
  return (
    "You answer questions using ONLY the numbered passages below, which are excerpts from the user's own notes. " +
    "Each passage starts with '[n] note path > heading'. They are excerpts, not whole notes, so do not assume anything beyond them. " +
    "'- [x]' is a completed task and '- [ ]' is a task that is not done yet. " +
    `If the passages do not contain the answer, reply exactly: ${NOT_FOUND_SCOPED} Never use outside knowledge, never guess, and never invent details. ` +
    "Say which note a fact comes from when it matters. Keep the answer short and direct, in the language of the question. " +
    "After the answer, add a line 'SOURCES:' followed by up to 3 lines, each '- [n] \"<exact quote from passage n>\"', copied character for character. " +
    "If you answered that it was not found, omit SOURCES."
  );
}

export function passagesText(passages: Passage[]): string {
  return passages.map((p, i) => `[${i + 1}] ${p.rel}${p.heading ? ` > ${p.heading}` : ""}\n${p.text}`).join("\n\n");
}

export function buildScopedUserPrompt(question: string, history: Turn[], passages: Passage[]): string {
  const prior = askHistoryText(history);
  return `${prior ? `Earlier in this conversation:\n${prior}\n\n` : ""}Passages:\n"""\n${passagesText(passages)}\n"""\n\nQuestion: ${question}`;
}

/** For a follow-up like "and who owns it?", search with the previous question as well. */
export function retrievalQuery(question: string, previous?: string): string {
  const words = question.trim().split(/\s+/).filter(Boolean).length;
  return words < 6 && previous ? `${previous} ${question}` : question;
}

/** Like `parseAskAnswer`, but each verified quote is matched to the passage (and so the note) it was found in. */
export function parseScopedAnswer(raw: string, passages: Passage[]): ParsedAnswer {
  const idx = raw.search(/\n?\s*SOURCES:\s*/i);
  const answer = (idx >= 0 ? raw.slice(0, idx) : raw).trim();
  const tail = idx >= 0 ? raw.slice(idx).replace(/^\s*SOURCES:\s*/i, "") : "";
  const squash = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
  const squashed = passages.map((p) => squash(p.text));
  const sources: Source[] = [];
  for (const line of tail.split("\n")) {
    const m = /^\s*[-*]?\s*(?:\[(\d+)\]\s*)?["“”']?(.+?)["“”']?\s*$/.exec(line);
    const quote = m?.[2]?.trim() ?? "";
    if (quote.length < 3 || sources.some((s) => s.quote === quote)) continue;
    const claimed = m?.[1] ? Number(m[1]) - 1 : -1;
    // Trust the text, not the number: look in the claimed passage first, then in all of them.
    const order = [claimed, ...squashed.keys()].filter((i, n, a) => i >= 0 && i < passages.length && a.indexOf(i) === n);
    const hit = order.find((i) => inTranscript(quote, squashed[i]));
    sources.push({ quote, verified: hit !== undefined, passage: hit !== undefined ? passages[hit] : undefined });
    if (sources.length === 3) break;
  }
  return { answer, sources };
}
