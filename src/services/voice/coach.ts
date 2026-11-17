import { DELIVERY_CAVEAT, PACE_REFERENCE, type Analytics } from "./analytics";
import { formatClock } from "./transcript";

export type CoachType = "sentences" | "clarity" | "structure" | "vocabulary";
export const COACH_TYPES: CoachType[] = ["sentences", "clarity", "structure", "vocabulary"];
export const COACH_LABELS: Record<CoachType, string> = {
  sentences: "Sentence improvements",
  clarity: "Clarity check",
  structure: "Presentation structure",
  vocabulary: "Vocabulary suggestions",
};

export type Style = "natural" | "professional" | "concise";
export const STYLE_LABELS: Record<Style, string> = { natural: "Natural", professional: "Professional", concise: "Concise" };

export interface SentenceFix {
  original: string;
  category: "awkward" | "casual" | "wordy";
  natural: string;
  professional: string;
  concise: string;
  why: string;
}
export interface ClarityIssue { quote: string; problem: string; suggestion: string }
export type PartStatus = "present" | "weak" | "missing";
export interface StructurePart { status: PartStatus; note: string }
export interface StructureReport {
  introduction: StructurePart;
  mainExplanation: StructurePart;
  supportingPoints: StructurePart;
  conclusion: StructurePart;
  suggestions: string[];
}
export interface VocabSuggestion { said: string; better: string[]; why: string }

export interface CoachResult {
  type: CoachType;
  createdAtMs: number;
  truncated?: boolean;
  /** How many AI suggestions were discarded because their quote was not in the transcript. */
  dropped?: number;
  sentences?: SentenceFix[];
  clarity?: ClarityIssue[];
  structure?: StructureReport;
  vocabulary?: VocabSuggestion[];
}

const RULES =
  "Rules: Keep the speaker's meaning and natural voice. Do NOT turn it into generic corporate language, and do not add facts. " +
  "Quote the speaker's words EXACTLY as they appear in the transcript (copy them verbatim, including any speech-recognition errors). " +
  "Only include items that genuinely need improvement; fewer, better items beat many weak ones. " +
  "Output ONLY JSON, with no code fences and no commentary. Write in the same language as the transcript.";

export function buildCoachSystemPrompt(type: CoachType): string {
  switch (type) {
    case "sentences":
      return (
        "You are a speaking coach reviewing a spoken practice session. Find up to 8 sentences that are awkwardly structured, too casual or unclear for a workplace, or longer than they need to be. " +
        'Output a JSON array of {"original": string, "category": "awkward"|"casual"|"wordy", "natural": string, "professional": string, "concise": string, "why": string}. ' +
        "'natural' keeps the speaker's own conversational voice; 'professional' suits a workplace; 'concise' is the shortest version that keeps the meaning. 'why' is one short sentence on what was wrong. " +
        RULES
      );
    case "clarity":
      return (
        "You are a speaking coach. Find up to 6 places where the explanation is confusing, incomplete, or hard for a listener to follow (a missing step, an undefined term, a jump in logic). " +
        'Output a JSON array of {"quote": string, "problem": string, "suggestion": string}. ' + RULES
      );
    case "structure":
      return (
        "You are a speaking coach judging how a presentation is organised. Judge whether it has an introduction, a main explanation, supporting points and a conclusion. " +
        'Output ONE JSON object: {"introduction": {"status": "present"|"weak"|"missing", "note": string}, "mainExplanation": {...}, "supportingPoints": {...}, "conclusion": {...}, "suggestions": [string]}. ' +
        "Notes are one short sentence grounded in what was actually said. Up to 4 suggestions. " + RULES
      );
    case "vocabulary":
      return (
        "You are a speaking coach. Find up to 8 words or short phrases the speaker used where a more precise, natural and context-appropriate alternative exists (vague words, overused words, wrong register). " +
        'Output a JSON array of {"said": string, "better": [string, string], "why": string}. Offer 1 to 3 alternatives. ' + RULES
      );
  }
}

export function buildCoachUserPrompt(title: string, transcript: string): string {
  return `Practice session: ${title}\n\nTranscript:\n"""\n${transcript}\n"""`;
}

/** Finds the first complete JSON value ([...] or {...}) in a reply. */
export function extractJson(raw: string): unknown {
  const open = raw.search(/[[{]/);
  if (open < 0) throw new Error("The coach did not return structured feedback. Try again.");
  const openCh = raw[open];
  const closeCh = openCh === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  for (let i = open; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === openCh) depth++;
    else if (c === closeCh && --depth === 0) {
      try {
        return JSON.parse(raw.slice(open, i + 1));
      } catch {
        break;
      }
    }
  }
  throw new Error("The coach's feedback came back in an unreadable format. Try again.");
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

/** True when the quote really appears in what the speaker said (guards against invented quotes). */
export function inTranscript(quote: string, transcriptSquashed: string): boolean {
  const q = squash(quote);
  return q.length >= 3 && transcriptSquashed.includes(q);
}

const str = (v: unknown, max = 600) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const asArray = (v: unknown): unknown[] => {
  if (!Array.isArray(v)) throw new Error("The coach did not return a list. Try again.");
  return v;
};
const cat = (v: unknown): SentenceFix["category"] => (v === "casual" || v === "wordy" ? v : "awkward");
const status = (v: unknown): PartStatus => (v === "present" || v === "weak" ? v : "missing");
const part = (v: unknown): StructurePart => {
  const o = (v ?? {}) as Record<string, unknown>;
  return { status: status(o.status), note: str(o.note, 300) };
};

/** Parses and validates a reply; suggestions quoting words the speaker never said are dropped. */
export function toCoachResult(type: CoachType, raw: string, transcript: string, truncated: boolean, now = Date.now()): CoachResult {
  const json = extractJson(raw);
  const t = squash(transcript);
  const base: CoachResult = { type, createdAtMs: now, truncated, dropped: 0 };
  if (type === "structure") {
    const o = (json ?? {}) as Record<string, unknown>;
    if (Array.isArray(json) || typeof json !== "object") throw new Error("The coach did not return a structure report. Try again.");
    return {
      ...base,
      structure: {
        introduction: part(o.introduction), mainExplanation: part(o.mainExplanation), supportingPoints: part(o.supportingPoints),
        conclusion: part(o.conclusion),
        suggestions: (Array.isArray(o.suggestions) ? o.suggestions : []).map((s) => str(s, 300)).filter(Boolean).slice(0, 4),
      },
    };
  }
  const rows = asArray(json).map((r) => (r ?? {}) as Record<string, unknown>);
  let dropped = 0;
  if (type === "sentences") {
    const sentences: SentenceFix[] = [];
    for (const r of rows) {
      const original = str(r.original);
      const natural = str(r.natural);
      if (!original || !natural) continue;
      if (!inTranscript(original, t)) { dropped++; continue; }
      sentences.push({ original, category: cat(r.category), natural, professional: str(r.professional) || natural, concise: str(r.concise) || natural, why: str(r.why, 300) });
    }
    return { ...base, sentences, dropped };
  }
  if (type === "clarity") {
    const clarity: ClarityIssue[] = [];
    for (const r of rows) {
      const quote = str(r.quote);
      if (!quote || !str(r.problem)) continue;
      if (!inTranscript(quote, t)) { dropped++; continue; }
      clarity.push({ quote, problem: str(r.problem, 300), suggestion: str(r.suggestion, 400) });
    }
    return { ...base, clarity, dropped };
  }
  const vocabulary: VocabSuggestion[] = [];
  for (const r of rows) {
    const said = str(r.said, 120);
    const better = (Array.isArray(r.better) ? r.better : []).map((b) => str(b, 120)).filter(Boolean).slice(0, 3);
    if (!said || !better.length) continue;
    if (!inTranscript(said, t)) { dropped++; continue; }
    vocabulary.push({ said, better, why: str(r.why, 300) });
  }
  return { ...base, vocabulary, dropped };
}

// ---- Markdown ----

const STATUS_LABEL: Record<PartStatus, string> = { present: "Present", weak: "Weak", missing: "Missing" };

export function sentenceBlock(f: SentenceFix, style: Style | "all" = "all"): string {
  const lines = [`**You said:** "${f.original}"`];
  if (style === "all") {
    lines.push(`- **Natural:** ${f.natural}`, `- **Professional:** ${f.professional}`, `- **Concise:** ${f.concise}`);
  } else {
    lines.push(`**Better (${STYLE_LABELS[style].toLowerCase()}):** ${f[style]}`);
  }
  if (f.why) lines.push(`**Why:** ${f.why}`);
  return lines.join("\n");
}

export function coachMarkdown(r: CoachResult): string {
  const note = r.dropped ? `\n_${r.dropped} suggestion(s) were left out because they did not match what was said._\n` : "";
  if (r.sentences) return (r.sentences.length ? r.sentences.map((f) => sentenceBlock(f)).join("\n\n") : "_No sentences needed improving._") + note;
  if (r.clarity) {
    return (r.clarity.length
      ? r.clarity.map((c) => `**You said:** "${c.quote}"\n**Problem:** ${c.problem}\n**Try:** ${c.suggestion}`).join("\n\n")
      : "_Nothing was flagged as unclear._") + note;
  }
  if (r.vocabulary) {
    return (r.vocabulary.length
      ? r.vocabulary.map((v) => `- **"${v.said}"** → ${v.better.map((b) => `"${b}"`).join(" / ")}${v.why ? ` — ${v.why}` : ""}`).join("\n")
      : "_No vocabulary changes suggested._") + note;
  }
  if (r.structure) {
    const s = r.structure;
    const row = (label: string, p: StructurePart) => `- **${label}:** ${STATUS_LABEL[p.status]}${p.note ? ` — ${p.note}` : ""}`;
    const out = [row("Introduction", s.introduction), row("Main explanation", s.mainExplanation), row("Supporting points", s.supportingPoints), row("Conclusion", s.conclusion)];
    if (s.suggestions.length) out.push("", "**Suggestions**", ...s.suggestions.map((x) => `- ${x}`));
    return out.join("\n");
  }
  return "";
}

/** The objective, locally computed numbers as a Markdown section. */
export function speakingAnalysisMarkdown(a: Analytics): string {
  const out: string[] = [];
  out.push("**Pace**", "");
  out.push(`- Words: ${a.wordCount}`);
  if (a.wpm !== null) out.push(`- Overall: ${a.wpm} words per minute${a.articulationWpm ? ` (${a.articulationWpm} while actually speaking)` : ""}`);
  if (a.pace) out.push(`- Range across ${a.pace.windows.length} half-minute sections: ${a.pace.min}–${a.pace.max} wpm`);
  for (const f of a.pace?.flagged ?? []) out.push(`- ${formatClock(f.startMs)}: noticeably ${f.kind} (${f.wpm} wpm)`);
  out.push(`- _${PACE_REFERENCE}_`, "");
  out.push("**Filler words**", "");
  out.push(a.fillers.length ? a.fillers.map((f) => `- "${f.term}" × ${f.count}`).join("\n") : "- None found.");
  if (a.fillerTotal) out.push(`- Total: ${a.fillerTotal} (${a.fillersPer100} per 100 words). "like" and "actually" are sometimes used on purpose.`);
  out.push("", "**Repetition**", "");
  const rep = [
    ...a.repeatedWords.map((w) => `- Word "${w.term}" used ${w.count} times`),
    ...a.repeatedPhrases.map((p) => `- Phrase "${p.term}" said ${p.count} times`),
    ...a.stutters.slice(0, 5).map((s) => `- "${s.phrase}"${s.atMs !== null ? ` at ${formatClock(s.atMs)}` : ""}`),
  ];
  out.push(rep.length ? rep.join("\n") : "- Nothing notable.");
  if (a.pauses) {
    out.push("", "**Pauses**", "");
    out.push(`- ${a.pauses.count} pause(s) of 1 s or more; ${a.pauses.long} of 1.5 s or more; ${a.pauses.veryLong} of 3 s or more`);
    for (const p of a.pauses.longest.slice(0, 3)) out.push(`- ${formatClock(p.startMs)}: ${(p.durationMs / 1000).toFixed(1)} s, after "${p.before}"`);
  }
  if (a.notes.length) out.push("", "**Delivery indicators**", "", ...a.notes.map((n) => `- ${n}`), `- _${DELIVERY_CAVEAT}_`);
  return out.join("\n");
}

export interface Selection { index: number; style: Style }

/** A report containing only the improvements the user picked, in the style they picked. */
export function selectedSentencesMarkdown(fixes: SentenceFix[], picks: Selection[]): string {
  const blocks = picks.filter((p) => fixes[p.index]).map((p) => sentenceBlock(fixes[p.index], p.style));
  return blocks.length ? blocks.join("\n\n") : "_No improvements selected._";
}
