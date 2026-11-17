import type { SessionMeta, TranscriptChunk, VoiceMode } from "./types";
import { MODE_LABELS } from "./types";

/** Inserts or replaces a chunk, keeping chunks ordered by index. */
export function upsertChunk(chunks: TranscriptChunk[], next: TranscriptChunk): TranscriptChunk[] {
  const rest = chunks.filter((c) => c.index !== next.index);
  return [...rest, next].sort((a, b) => a.index - b.index);
}

/** Whisper sometimes invents text for near-silence; these are the usual phantom phrases. */
const PHANTOM = /^(thanks? for watching[.!]?|thank you[.!]?|you|bye[.!]?|\.+)$/i;

export function isPhantom(text: string, voicedMs: number): boolean {
  return voicedMs < 1200 && PHANTOM.test(text.trim());
}

export function transcriptText(chunks: TranscriptChunk[]): string {
  return chunks
    .filter((c) => c.status === "final" && c.text.trim())
    .map((c) => c.text.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function dateStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** `2026-11-17 meeting-title`, used as the suggested file name. */
export function suggestFileName(meta: Pick<SessionMeta, "title" | "createdAtMs">, suffix = ""): string {
  const title = meta.title.trim() || "recording";
  return `${dateStamp(meta.createdAtMs)} ${title}${suffix ? ` ${suffix}` : ""}`;
}

/** The raw transcript as a Markdown document (also the fallback when no analysis is run). */
export function transcriptMarkdown(meta: SessionMeta, chunks: TranscriptChunk[]): string {
  const lines = [
    `# ${meta.title.trim() || "Voice recording"} — transcript`,
    "",
    `- **Type:** ${MODE_LABELS[meta.mode as VoiceMode] ?? meta.mode}`,
    `- **Date:** ${dateStamp(meta.createdAtMs)}`,
    `- **Length:** ${formatClock(meta.durationMs)}`,
    "",
    "## Transcript",
    "",
  ];
  const body = chunks.filter((c) => c.status === "final" && c.text.trim());
  for (const c of body) lines.push(`**[${formatClock(c.startMs)}]** ${c.text.trim()}`, "");
  if (!body.length) lines.push("_No speech was transcribed._", "");
  return lines.join("\n");
}

export function buildNoteSystemPrompt(): string {
  return (
    "You turn a spoken voice note (a raw speech-to-text transcript) into a clean Markdown note. " +
    "Output ONLY Markdown, with no commentary and no code fences. Start with a single '# ' title line, " +
    "then short '##' sections with concise bullet points. Use '- [ ]' checkboxes ONLY for things the speaker " +
    "clearly said they need to do. Do not invent facts, names, owners, dates or tasks that are not in the transcript. " +
    "Fix obvious speech-to-text errors and remove filler words, but keep the speaker's meaning and wording."
  );
}

export function buildNoteUserPrompt(transcript: string): string {
  return `Transcript:\n"""\n${transcript}\n"""`;
}
