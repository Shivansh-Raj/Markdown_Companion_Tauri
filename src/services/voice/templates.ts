import { ANALYSIS_LABELS, ANALYSIS_TYPES, type AnalysisResult, type AnalysisType } from "./analyses";
import { dateStamp, formatClock } from "./transcript";
import type { Analytics } from "./analytics";
import type { SessionMeta } from "./types";

/** Extra frontmatter properties, e.g. speaking numbers for a practice session. Keys are written as given. */
export type ExtraProperties = Record<string, string | number>;

/** Numbers from the local speaking analysis, as properties a Bases table can show and sort. Missing values are left out. */
export function practiceProperties(a: Analytics): ExtraProperties {
  const out: ExtraProperties = { words: a.wordCount };
  if (a.wpm != null) out.pace_wpm = a.wpm;
  if (a.articulationWpm != null) out.speaking_wpm = a.articulationWpm;
  out.filler_count = a.fillerTotal;
  out.fillers_per_100_words = Math.round(a.fillersPer100 * 10) / 10;
  if (a.pauses) out.long_pauses = a.pauses.long;
  return out;
}

/** YAML frontmatter: properties other tools (note apps, databases) can filter and chart. */
export function frontmatterProperties(meta: SessionMeta, kind: string, extra: ExtraProperties = {}): string {
  const minutes = Math.round((meta.durationMs / 60000) * 10) / 10;
  const more = Object.entries(extra).map(([k, v]) => `${k}: ${typeof v === "number" ? v : JSON.stringify(v)}`);
  return [
    "---",
    `title: ${JSON.stringify(meta.title.trim() || "Recording")}`,
    `type: ${meta.mode}`,
    `kind: ${JSON.stringify(kind)}`,
    `date: ${dateStamp(meta.createdAtMs)}`,
    `duration_min: ${minutes}`,
    ...more,
    `tags: [voice, ${meta.mode}]`,
    "source: markdown-companion",
    "---",
    "",
    "",
  ].join("\n");
}

function header(meta: SessionMeta, title: string, frontmatter = false, extra: ExtraProperties = {}): string {
  if (frontmatter) return `${frontmatterProperties(meta, title, extra)}# ${meta.title.trim() || "Meeting"} — ${title}\n\n`;
  return [
    `# ${meta.title.trim() || "Meeting"} — ${title}`,
    "",
    `- **Date:** ${dateStamp(meta.createdAtMs)}`,
    `- **Length:** ${formatClock(meta.durationMs)}`,
    "",
  ].join("\n");
}

/** One exportable block of Markdown (an analysis, a report, ...). */
export interface Section {
  id: string;
  label: string;
  /** Used in suggested file names, e.g. "summary" -> "2026-11-17 Sprint review summary". */
  suffix: string;
  markdown: string;
  note?: string;
}

const bodyOf = (s: Section) => s.markdown.trim();

function noteOf(s: Section): string {
  return s.note ? `\n> Note: ${s.note}\n` : "";
}

/** One section as a stand-alone document. */
export function standaloneFromSection(meta: SessionMeta, s: Section, frontmatter = false, extra: ExtraProperties = {}): string {
  return `${header(meta, s.label, frontmatter, extra)}${bodyOf(s)}\n${noteOf(s)}`;
}

/** Several sections as one document, in the order given. */
export function combinedFromSections(meta: SessionMeta, docTitle: string, sections: Section[], frontmatter = false, extra: ExtraProperties = {}): string {
  return `${header(meta, docTitle, frontmatter, extra)}${sections.map((s) => `## ${s.label}\n\n${bodyOf(s)}\n${noteOf(s)}`).join("\n")}`;
}

/** Sections as the body of a Notion page: the title, date and length go in the page's title and properties instead. */
export function bodyFromSections(sections: Section[]): string {
  return sections.map((s) => `## ${s.label}\n\n${bodyOf(s)}\n${noteOf(s)}`).join("\n").trim() + "\n";
}

/**
 * Text appended to an existing file. Existing content is never touched, so completed checkboxes and everything
 * else stay exactly as they are; the new block just goes at the end under its own heading.
 */
export function appendFromSections(meta: SessionMeta, sections: Section[]): string {
  const body = sections.map((s) => `### ${s.label}\n\n${bodyOf(s)}\n${noteOf(s)}`).join("\n");
  return `## ${meta.title.trim() || "Recording"} (${dateStamp(meta.createdAtMs)})\n\n${body}`;
}

const TRUNCATED = "the recording was very long, so only the first part was analysed.";

export function meetingSections(results: AnalysisResult[]): Section[] {
  return ANALYSIS_TYPES.map((t) => results.find((r) => r.type === t))
    .filter((r): r is AnalysisResult => !!r)
    .map((r) => ({ id: r.type, label: ANALYSIS_LABELS[r.type], suffix: typeFileSuffix(r.type), markdown: r.markdown, note: r.truncated ? TRUNCATED : undefined }));
}

/** One analysis as a stand-alone document. */
export function standaloneMarkdown(meta: SessionMeta, r: AnalysisResult): string {
  return standaloneFromSection(meta, meetingSections([r])[0]);
}

/** Several analyses as one document, in a fixed order. */
export function combinedMarkdown(meta: SessionMeta, results: AnalysisResult[]): string {
  return combinedFromSections(meta, "meeting notes", meetingSections(results));
}

export function appendBlock(meta: SessionMeta, results: AnalysisResult[]): string {
  return appendFromSections(meta, meetingSections(results));
}

export function appendToContent(existing: string, block: string): string {
  const trimmedEnd = existing.replace(/\s+$/, "");
  return `${trimmedEnd}\n\n${block.trim()}\n`;
}

export function typeFileSuffix(t: AnalysisType): string {
  return t === "summary" ? "summary" : t === "takeaways" ? "takeaways" : "action items";
}
