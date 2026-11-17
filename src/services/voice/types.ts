export type VoiceMode = "meeting" | "practice" | "note";

export const MODE_LABELS: Record<VoiceMode, string> = {
  meeting: "Meeting",
  practice: "Practice",
  note: "Quick voice note",
};

export interface VoiceDevice {
  name: string;
  is_default: boolean;
}

export interface SessionMeta {
  id: string;
  title: string;
  mode: VoiceMode;
  createdAtMs: number;
  /** Active recording time only; paused time is excluded. */
  durationMs: number;
  status: "recording" | "paused" | "stopped" | "interrupted";
  device: string;
  chunks: number;
}

export interface VoiceStatus {
  sessionId: string;
  title: string;
  mode: VoiceMode;
  paused: boolean;
  activeMs: number;
}

/** A word with timestamps on the active recording timeline (milliseconds). */
export interface Word {
  w: string;
  start: number;
  end: number;
}

export type ChunkStatus = "pending" | "final" | "failed";

export interface TranscriptChunk {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
  words: Word[];
  status: ChunkStatus;
  /** Milliseconds of actual sound in the chunk (used to ignore silence/phantom text). */
  voicedMs?: number;
  error?: string;
}

export interface ChunkEvent {
  sessionId: string;
  index: number;
  startMs: number;
  endMs: number;
  voicedMs: number;
}
