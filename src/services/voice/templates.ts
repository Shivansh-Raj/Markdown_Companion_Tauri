import { actionItemsObsidianMarkdown, ANALYSIS_LABELS, ANALYSIS_TYPES, type AnalysisResult, type AnalysisType } from "./analyses";
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

/** YAML frontmatter for Obsidian: properties a vault can filter and chart (Bases, Dataview, search). */
export function obsidianFrontmatter(meta: SessionMeta, kind: string, extra: ExtraProperties = {}): string {
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

function header(meta: SessionMeta, title: string, obsidian = false, extra: ExtraProperties = {}): string {
  if (obsidian) return `${obsidianFrontmatter(meta, title, extra)}# ${meta.title.trim() || "Meeting"} — ${title}\n\n`;
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
  /** Alternative body for the Obsidian format (e.g. Tasks-style action items). Falls back to `markdown`. */
  obsidianMarkdown?: string;
  note?: string;
}

const bodyOf = (s: Section, obsidian: boolean) => (obsidian && s.obsidianMarkdown ? s.obsidianMarkdown : s.markdown).trim();

function noteOf(s: Section): string {
  return s.note ? `\n> Note: ${s.note}\n` : "";
}

/** One section as a stand-alone document. */
export function standaloneFromSection(meta: SessionMeta, s: Section, obsidian = false, extra: ExtraProperties = {}): string {
  return `${header(meta, s.label, obsidian, extra)}${bodyOf(s, obsidian)}\n${noteOf(s)}`;
}

/** Several sections as one document, in the order given. */
export function combinedFromSections(meta: SessionMeta, docTitle: string, sections: Section[], obsidian = false, extra: ExtraProperties = {}): string {
  return `${header(meta, docTitle, obsidian, extra)}${sections.map((s) => `## ${s.label}\n\n${bodyOf(s, obsidian)}\n${noteOf(s)}`).join("\n")}`;
}

/**
 * Text appended to an existing file. Existing content is never touched, so completed checkboxes and everything
 * else stay exactly as they are; the new block just goes at the end under its own heading.
 */
export function appendFromSections(meta: SessionMeta, sections: Section[], obsidian = false): string {
  const body = sections.map((s) => `### ${s.label}\n\n${bodyOf(s, obsidian)}\n${noteOf(s)}`).join("\n");
  return `## ${meta.title.trim() || "Recording"} (${dateStamp(meta.createdAtMs)})\n\n${body}`;
}

const TRUNCATED = "the recording was very long, so only the first part was analysed.";

export function meetingSections(results: AnalysisResult[]): Section[] {
  return ANALYSIS_TYPES.map((t) => results.find((r) => r.type === t))
    .filter((r): r is AnalysisResult => !!r)
    .map((r) => ({ id: r.type, label: ANALYSIS_LABELS[r.type], suffix: typeFileSuffix(r.type), markdown: r.markdown, obsidianMarkdown: r.type === "actions" && r.items ? actionItemsObsidianMarkdown(r.items) : undefined, note: r.truncated ? TRUNCATED : undefined }));
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
