import type { TranscriptChunk, Word } from "./types";

/**
 * Speaking analytics computed locally and deterministically from the transcript and its word timestamps.
 * Nothing here uses AI, and nothing here claims to measure confidence, emotion or personality.
 */

export interface Counted { term: string; count: number }
export interface Pause { startMs: number; durationMs: number; before: string; after: string }
export interface PaceWindow { startMs: number; wpm: number; words: number }

export interface Analytics {
  hasTimings: boolean;
  durationMs: number;
  wordCount: number;
  /** Words per minute over the whole recorded time (pauses included). */
  wpm: number | null;
  /** Words per minute while actually speaking (long pauses removed). */
  articulationWpm: number | null;
  fillers: Counted[];
  fillerTotal: number;
  fillersPer100: number;
  repeatedWords: Counted[];
  repeatedPhrases: Counted[];
  /** Same word said twice in a row ("the the"). */
  stutters: { phrase: string; atMs: number | null }[];
  pace: { windows: PaceWindow[]; mean: number; min: number; max: number; cv: number; flagged: (PaceWindow & { kind: "faster" | "slower" })[] } | null;
  pauses: { count: number; long: number; veryLong: number; avgMs: number; ratio: number; longest: Pause[] } | null;
  notes: string[];
}

export const PAUSE_MS = 1000;
export const LONG_PAUSE_MS = 1500;
export const VERY_LONG_PAUSE_MS = 3000;
const WINDOW_MS = 30_000;

const SINGLE_FILLERS = ["um", "umm", "uh", "uhh", "uhm", "er", "erm", "ah", "hmm", "basically", "actually", "literally", "honestly", "like"];
const PHRASE_FILLERS = ["you know", "i mean", "kind of", "sort of"];
const STOP = new Set(("a an the and or but if then so of to in on at for with from by as is are was were be been being it its this that these those " +
  "i you he she we they me him her us them my your our their not no yes do does did have has had will would can could should just very " +
  "there here what which who whom when where why how about into out up down over more some any all than too also").split(" "));

export function norm(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "").replace(/^'+|'+$/g, "");
}

export function flattenWords(chunks: TranscriptChunk[]): Word[] {
  return chunks
    .filter((c) => c.status === "final")
    .flatMap((c) => c.words)
    .filter((w) => norm(w.w))
    .sort((a, b) => a.start - b.start);
}

function countMap(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

function top(m: Map<string, number>, min: number, limit: number): Counted[] {
  return [...m.entries()].filter(([, n]) => n >= min).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([term, count]) => ({ term, count }));
}

export function findFillers(tokens: string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    const pair = `${tokens[i]} ${tokens[i + 1] ?? ""}`;
    if (PHRASE_FILLERS.includes(pair)) {
      found.set(pair, (found.get(pair) ?? 0) + 1);
      i++;
    } else if (SINGLE_FILLERS.includes(tokens[i])) {
      found.set(tokens[i], (found.get(tokens[i]) ?? 0) + 1);
    }
  }
  return found;
}

function repeatedPhrases(tokens: string[]): Counted[] {
  const grams = new Map<string, number>();
  for (let i = 0; i + 3 <= tokens.length; i++) {
    const g = tokens.slice(i, i + 3);
    if (g.every((t) => STOP.has(t) || SINGLE_FILLERS.includes(t))) continue;
    const k = g.join(" ");
    grams.set(k, (grams.get(k) ?? 0) + 1);
  }
  const ranked = top(grams, 3, 12);
  const kept: Counted[] = [];
  for (const r of ranked) { // drop near-duplicates that only shift by a word
    if (!kept.some((k) => k.term.includes(r.term) || r.term.includes(k.term) || k.term.split(" ").slice(1).join(" ") === r.term.split(" ").slice(0, 2).join(" "))) kept.push(r);
  }
  return kept.slice(0, 5);
}

export function computeAnalytics(chunks: TranscriptChunk[], durationMs: number): Analytics {
  const words = flattenWords(chunks);
  const hasTimings = words.length > 0;
  const fallbackTokens = chunks.filter((c) => c.status === "final").flatMap((c) => c.text.split(/\s+/)).map(norm).filter(Boolean);
  const tokens = hasTimings ? words.map((w) => norm(w.w)) : fallbackTokens;
  const wordCount = tokens.length;

  const fillerMap = findFillers(tokens);
  const fillers = top(fillerMap, 1, 10);
  const fillerTotal = fillers.reduce((n, f) => n + f.count, 0);

  const content = tokens.filter((t) => !STOP.has(t) && !SINGLE_FILLERS.includes(t) && t.length > 2);
  const repeatedWords = top(countMap(content), Math.max(4, Math.ceil(wordCount * 0.02)), 5);

  const stutters: Analytics["stutters"] = [];
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === tokens[i - 1] && !["that", "had", "very"].includes(tokens[i])) {
      stutters.push({ phrase: `${tokens[i]} ${tokens[i]}`, atMs: hasTimings ? words[i].start : null });
    }
  }

  const a: Analytics = {
    hasTimings, durationMs, wordCount, wpm: null, articulationWpm: null, fillers, fillerTotal,
    fillersPer100: wordCount ? Math.round((fillerTotal / wordCount) * 1000) / 10 : 0,
    repeatedWords, repeatedPhrases: repeatedPhrases(tokens), stutters: stutters.slice(0, 10), pace: null, pauses: null, notes: [],
  };
  if (durationMs > 0 && wordCount > 0) a.wpm = Math.round(wordCount / (durationMs / 60000));
  if (!hasTimings) return a;

  // pauses between consecutive words
  const gaps: Pause[] = [];
  for (let i = 1; i < words.length; i++) {
    const d = words[i].start - words[i - 1].end;
    if (d >= PAUSE_MS) gaps.push({ startMs: words[i - 1].end, durationMs: d, before: words[i - 1].w, after: words[i].w });
  }
  const pauseTotal = gaps.reduce((n, g) => n + g.durationMs, 0);
  const spanMs = words[words.length - 1].end - words[0].start;
  a.pauses = {
    count: gaps.length,
    long: gaps.filter((g) => g.durationMs >= LONG_PAUSE_MS).length,
    veryLong: gaps.filter((g) => g.durationMs >= VERY_LONG_PAUSE_MS).length,
    avgMs: gaps.length ? Math.round(pauseTotal / gaps.length) : 0,
    ratio: spanMs > 0 ? Math.round((pauseTotal / spanMs) * 100) / 100 : 0,
    longest: [...gaps].sort((x, y) => y.durationMs - x.durationMs).slice(0, 5),
  };
  const speakingMs = spanMs - pauseTotal;
  if (speakingMs > 5000) a.articulationWpm = Math.round(wordCount / (speakingMs / 60000));

  // pace over time in 30 s windows
  const end = words[words.length - 1].end;
  const windows: PaceWindow[] = [];
  for (let s = 0; s < end; s += WINDOW_MS) {
    const len = Math.min(WINDOW_MS, end - s);
    if (len < 10_000) continue; // a short tail would give a misleading rate
    const n = words.filter((w) => w.start >= s && w.start < s + WINDOW_MS).length;
    windows.push({ startMs: s, words: n, wpm: Math.round(n / (len / 60000)) });
  }
  if (windows.length >= 2) {
    const rates = windows.map((w) => w.wpm);
    const mean = rates.reduce((x, y) => x + y, 0) / rates.length;
    const sd = Math.sqrt(rates.reduce((x, y) => x + (y - mean) ** 2, 0) / rates.length);
    a.pace = {
      windows, mean: Math.round(mean), min: Math.min(...rates), max: Math.max(...rates), cv: mean ? Math.round((sd / mean) * 100) / 100 : 0,
      flagged: windows.filter((w) => w.words >= 8 && (w.wpm >= mean * 1.3 || w.wpm <= mean * 0.7))
        .map((w) => ({ ...w, kind: (w.wpm >= mean ? "faster" : "slower") as "faster" | "slower" })),
    };
  }
  a.notes = deliveryNotes(a);
  return a;
}

export const DELIVERY_CAVEAT =
  "Based on wording and timing only. Pitch, volume and tone are not measured, and none of this says how confident you were.";
export const PACE_REFERENCE = "Many speaking guides suggest roughly 120–160 words per minute for presentations. That is a rough guide, not a rule.";

/** Cautious, evidence-based observations: each one states the number it comes from. */
export function deliveryNotes(a: Analytics): string[] {
  const notes: string[] = [];
  if (a.pace) {
    if (a.pace.cv <= 0.15) notes.push(`Your pace was steady: it stayed between ${a.pace.min} and ${a.pace.max} words per minute across ${a.pace.windows.length} half-minute sections.`);
    else if (a.pace.cv >= 0.3) notes.push(`Your pace varied a lot: from ${a.pace.min} to ${a.pace.max} words per minute between sections.`);
    else notes.push(`Your pace varied moderately: ${a.pace.min} to ${a.pace.max} words per minute between sections.`);
  }
  if (a.pauses) {
    if (a.pauses.veryLong > 0) notes.push(`There ${a.pauses.veryLong === 1 ? "was 1 pause" : `were ${a.pauses.veryLong} pauses`} of 3 seconds or more.`);
    if (a.pauses.ratio >= 0.25) notes.push(`About ${Math.round(a.pauses.ratio * 100)}% of the time between your first and last word was silence.`);
  }
  if (a.fillerTotal > 0 && a.wordCount >= 50) notes.push(`Filler words made up ${a.fillersPer100} of every 100 words.`);
  if (a.stutters.length >= 3) notes.push(`Immediate word repeats happened ${a.stutters.length} times.`);
  return notes;
}
