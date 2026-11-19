import { inTranscript } from "./voice/coach";

/** Ask a question about one Markdown file; the answer must come from the file itself. */

export const MAX_ASK_CHARS = 80_000;
export const NOT_FOUND = "I couldn't find that in this file.";

export interface Turn { question: string; answer: string }
export interface Passage { path: string; rel: string; name: string; heading: string; text: string }
/** A quote the AI gave. `passage` is the note it was found in (folder and vault questions only). */
export interface Source { quote: string; verified: boolean; passage?: Passage; /** The section of the document the quote is in, when it falls inside one. */ heading?: string }
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

/**
 * Groq's free tier allows about 8,000 tokens a minute for the default model, answer included. About 14,000
 * characters of document plus the prompt stays safely under that.
 */
export const ASK_BUDGET_CHARS = 14_000;
const CHUNK_MAX = 1_500;
const GAP = "\n\n[…]\n\n";
const FILLER = new Set(("the and what this that file with for from about summarise summarize summary tell give list bullet bullets three two four five main points " +
  "who how why when where which does did are was were has have had can could would should into than then them they their there here please").split(" "));

interface Chunk { index: number; heading: number; text: string }

/** Splits Markdown into pieces at headings, and long sections at blank lines. */
function chunkDoc(content: string): Chunk[] {
  const out: Chunk[] = [];
  let section = -1;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    buf = [];
    if (!text) return;
    if (text.length <= CHUNK_MAX) { out.push({ index: out.length, heading: section, text }); return; }
    let cur = "";
    const push = (t: string) => out.push({ index: out.length, heading: section, text: t });
    for (const para of text.split(/\n\s*\n/)) {
      if (para.length > CHUNK_MAX) {
        // an oversize paragraph is cut into pieces; whatever came before it (a heading) stays with the first piece
        let rest = para;
        if (cur) {
          const room = Math.max(0, CHUNK_MAX - cur.length - 2);
          push(`${cur}\n\n${rest.slice(0, room)}`);
          rest = rest.slice(room);
          cur = "";
        }
        for (let i = 0; i < rest.length; i += CHUNK_MAX) push(rest.slice(i, i + CHUNK_MAX));
        continue;
      }
      if (cur && cur.length + para.length + 2 > CHUNK_MAX) { push(cur); cur = ""; }
      cur = cur ? `${cur}\n\n${para}` : para;
    }
    if (cur) out.push({ index: out.length, heading: section, text: cur });
  };
  for (const line of content.split("\n")) {
    if (/^#{1,6}\s/.test(line)) { flush(); section++; }
    buf.push(line);
  }
  flush();
  return out;
}

export interface Excerpt { text: string; partial: boolean; sent: number; total: number }

/**
 * A file that fits the budget is sent whole. A longer one is cut down to the parts most likely to answer the
 * question (by shared words); for a general question ("summarise this") it takes the start of every section instead.
 * Pieces stay in file order, and gaps are marked.
 */
export function excerptForAsk(content: string, question: string, budget = ASK_BUDGET_CHARS): Excerpt {
  if (content.length <= budget) return { text: content, partial: false, sent: 1, total: 1 };
  const chunks = chunkDoc(content);
  const words = [...new Set((question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => !FILLER.has(w)))];
  const scored = chunks.map((c) => {
    const low = c.text.toLowerCase();
    return { c, score: words.filter((w) => low.includes(w)).length };
  });
  const picked: Chunk[] = [];
  if (words.length > 0 && scored.some((s) => s.score > 0)) {
    let used = 0;
    for (const { c } of [...scored].sort((x, y) => y.score - x.score || x.c.index - y.c.index).filter((s) => s.score > 0)) {
      const cost = c.text.length + GAP.length;
      if (used + cost > budget) continue;
      picked.push(c);
      used += cost;
    }
  } else {
    // General question: the opening of every section, each cut to its share of the budget. If there are too many
    // sections for that, every few sections are skipped so the whole file is still covered.
    const firsts: Chunk[] = [];
    const seen = new Set<number>();
    for (const c of chunks) if (!seen.has(c.heading)) { seen.add(c.heading); firsts.push(c); }
    const MIN_PIECE = 250;
    const keep = Math.max(1, Math.min(firsts.length, Math.floor((budget - 100) / (MIN_PIECE + GAP.length))));
    const stride = firsts.length / keep;
    const chosen = Array.from({ length: keep }, (_, i) => firsts[Math.floor(i * stride)]);
    const per = Math.floor((budget - 100) / chosen.length) - GAP.length; // 100 spare for the leading marker
    for (const c of chosen) {
      const cut = c.text.length > per ? c.text.slice(0, per).replace(/\s+\S*$/, "") : c.text;
      picked.push({ ...c, text: cut || c.text.slice(0, per) });
    }
  }
  picked.sort((a, b) => a.index - b.index);
  let text = "";
  picked.forEach((c, i) => { text += (i > 0 ? (c.index === picked[i - 1].index + 1 ? "\n\n" : GAP) : "") + c.text; });
  if (picked[0] && picked[0].index > 0) text = `[…]\n\n${text}`;
  return { text: text.slice(0, budget), partial: true, sent: picked.length, total: chunks.length };
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

/**
 * The heading of the section a quote is in (the nearest `#` heading above it), or null when it is before any heading or spans
 * two sections. Matching ignores case and punctuation, like the quote check itself.
 */
export function headingForQuote(doc: string, quote: string): string | null {
  const sections: { heading: string | null; text: string[] }[] = [{ heading: null, text: [] }];
  for (const line of doc.split("\n")) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) sections.push({ heading: h[1], text: [] });
    else sections[sections.length - 1].text.push(line);
  }
  for (const s of sections) {
    const squashed = s.text.join(" ").toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();
    if (inTranscript(quote, squashed)) return s.heading;
  }
  return null;
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
  for (const src of sources) if (src.verified) src.heading = headingForQuote(doc, src.quote) ?? undefined;
  return { answer, sources };
}

/**
 * An approved Ask answer as a Notion page body: the question, the answer, and only the quotes that were verified against the
 * source, each with its section. `source` names where the answers came from (a file name or a Notion page, with its link).
 */
export function archiveMarkdown(question: string, answer: string, sources: Source[], source: { name: string; url?: string }): string {
  const where = source.url ? `[${source.name}](${source.url})` : source.name;
  const quotes = sources.filter((s) => s.verified).map((s) => `> ${s.quote.replace(/\n+/g, " ")}\n\n— ${s.heading ? `${s.heading}, ` : ""}${s.passage ? s.passage.name : where}`);
  return [`**Question:** ${question.trim()}`, `**Source:** ${where}`, "## Answer", answer.trim(), ...(quotes.length ? ["## Verified quotes", ...quotes] : [])].join("\n\n") + "\n";
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
