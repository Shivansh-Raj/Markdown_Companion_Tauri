import { inTranscript } from "./voice/coach";

/** Ask a question about one Markdown file; the answer must come from the file itself. */

export const MAX_ASK_CHARS = 80_000;
export const NOT_FOUND = "I couldn't find that in this file.";

export interface Turn { question: string; answer: string }
export interface Source { quote: string; verified: boolean }
export interface ParsedAnswer { answer: string; sources: Source[] }

export function buildAskSystemPrompt(): string {
  return (
    "You answer questions about ONE Markdown document, using ONLY what is written in it. " +
    "In the document, '- [x]' is a completed task and '- [ ]' is a task that is not done yet. " +
    `If the document does not contain the answer, reply exactly: ${NOT_FOUND} Never use outside knowledge, never guess, and never invent details. ` +
    "Keep the answer short and direct, in the language of the question. Plain text or simple Markdown lists are fine. " +
    "After the answer, add a line 'SOURCES:' followed by up to 3 lines, each '- \"<exact quote from the document>\"', copied character for character " +
    "from the document. Only list a quote if your answer does not already contain those words. If you answered that it was not found, omit SOURCES."
  );
}

export function limitDoc(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_ASK_CHARS) return { text: content, truncated: false };
  const cut = content.slice(0, MAX_ASK_CHARS);
  const nl = cut.lastIndexOf("\n");
  return { text: nl > 0 ? cut.slice(0, nl) : cut, truncated: true };
}

/** Earlier turns are included (briefly) so follow-up questions like "and who owns it?" make sense. */
export function buildAskUserPrompt(question: string, history: Turn[], doc: string): string {
  const prior = history.slice(-4).map((t) => `Q: ${t.question}\nA: ${t.answer.slice(0, 600)}`).join("\n\n");
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
  return answer.trim().toLowerCase().startsWith("i couldn't find that in this file");
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Which source quotes to show under an answer. Quotes whose words are already in the answer are not repeated;
 * when every verified quote was already in the answer, the UI just says the wording was checked.
 */
export function sourcesToShow(answer: string, sources: Source[]): { extra: string[]; verifiedCount: number } {
  const verified = sources.filter((s) => s.verified);
  const a = squash(answer);
  return { extra: verified.filter((s) => !a.includes(squash(s.quote))).map((s) => s.quote), verifiedCount: verified.length };
}
