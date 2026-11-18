export interface TrackedFile {
  id: string;
  canonical_path: string;
  display_name: string;
  registered_at: number;
  last_opened_at: number | null;
}

export interface FileEntry extends TrackedFile {
  is_open: boolean;
}

export interface LauncherInfo {
  shortcut: string;
  shortcut_error: string | null;
}

export interface FileSnapshot {
  content: string;
  hash: string;
}

export type ToggleError =
  | { kind: "stale"; content: string; hash: string }
  | { kind: "failed"; message: string };

export type SyncEvent =
  | { kind: "changed"; content: string; hash: string }
  | { kind: "missing" }
  | { kind: "unreadable"; message: string };

export type FileStatus = { kind: "ok" } | { kind: "missing" } | { kind: "unreadable"; message: string };

export type ThemeName = "retro-red" | "pixel-dark";

export interface Settings {
  shortcut: string;
  theme: ThemeName;
  reopen_on_launch: boolean;
}

export interface DiscoveredFile {
  canonical_path: string;
  display_name: string;
}

export interface NoteRef {
  path: string;
  name: string;
  rel: string;
  /** Backlinks only: how many times that note links here. */
  count: number;
}

export interface NoteContext {
  vault_name: string;
  vault_root: string;
  is_vault: boolean;
  note_count: number;
  indexed_at_ms: number;
  skipped: string[];
  tags: string[];
  backlinks: NoteRef[];
  outgoing: { label: string; target: NoteRef | null }[];
}

/** Where the Groq key is stored. `file` means it is unprotected in the app data file; `warning` says why. */
export type KeyStorage = { kind: "none" } | { kind: "keychain" } | { kind: "file"; warning: string };

export interface TaskRow {
  path: string;
  note: string;
  rel: string;
  source: string;
  offset: number;
  line: number;
  title: string;
  raw: string;
  due: string | null;
  scheduled: string | null;
  recurring: boolean;
}

export interface TasksView {
  rows: TaskRow[];
  sources: string[];
  truncated: boolean;
}
