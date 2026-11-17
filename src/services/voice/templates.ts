import { ANALYSIS_LABELS, ANALYSIS_TYPES, type AnalysisResult, type AnalysisType } from "./analyses";
import { dateStamp, formatClock } from "./transcript";
import type { SessionMeta } from "./types";

function header(meta: SessionMeta, title: string): string {
  return [
    `# ${meta.title.trim() || "Meeting"} — ${title}`,
    "",
    `- **Date:** ${dateStamp(meta.createdAtMs)}`,
    `- **Length:** ${formatClock(meta.durationMs)}`,
    "",
  ].join("\n");
}

function truncatedNote(r: AnalysisResult): string {
  return r.truncated ? "\n> Note: the recording was very long, so only the first part was analysed.\n" : "";
}

/** One analysis as a stand-alone document. */
export function standaloneMarkdown(meta: SessionMeta, r: AnalysisResult): string {
  return `${header(meta, ANALYSIS_LABELS[r.type])}${r.markdown.trim()}\n${truncatedNote(r)}`;
}

/** Several analyses as one document, in a fixed order. */
export function combinedMarkdown(meta: SessionMeta, results: AnalysisResult[]): string {
  const ordered = ANALYSIS_TYPES.map((t) => results.find((r) => r.type === t)).filter((r): r is AnalysisResult => !!r);
  const body = ordered.map((r) => `## ${ANALYSIS_LABELS[r.type]}\n\n${r.markdown.trim()}\n${truncatedNote(r)}`).join("\n");
  return `${header(meta, "meeting notes")}${body}`;
}

/**
 * Text appended to an existing file. Existing content is never touched, so completed checkboxes and everything
 * else stay exactly as they are; the new block just goes at the end under its own heading.
 */
export function appendBlock(meta: SessionMeta, results: AnalysisResult[]): string {
  const ordered = ANALYSIS_TYPES.map((t) => results.find((r) => r.type === t)).filter((r): r is AnalysisResult => !!r);
  const body = ordered.map((r) => `### ${ANALYSIS_LABELS[r.type]}\n\n${r.markdown.trim()}\n${truncatedNote(r)}`).join("\n");
  return `## ${meta.title.trim() || "Meeting"} (${dateStamp(meta.createdAtMs)})\n\n${body}`;
}

export function appendToContent(existing: string, block: string): string {
  const trimmedEnd = existing.replace(/\s+$/, "");
  return `${trimmedEnd}\n\n${block.trim()}\n`;
}

export function typeFileSuffix(t: AnalysisType): string {
  return t === "summary" ? "summary" : t === "takeaways" ? "takeaways" : "action items";
}
