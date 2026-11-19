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
  /** Notes about the same things that are not linked yet, with the words they share. */
  related: { note: NoteRef; why: string[] }[];
}

/** Where the Groq key is stored. `file` means it is unprotected in the app data file; `warning` says why. */
export type KeyStorage = { kind: "none" } | { kind: "keychain" } | { kind: "file"; warning: string };

export interface AskScopes {
  vault_name: string;
  is_vault: boolean;
  folder_name: string;
  folder_notes: number;
  vault_notes: number;
}

export interface AskPassages {
  passages: { path: string; rel: string; name: string; heading: string; text: string }[];
  notes_in_scope: number;
  /** Notes left out because their frontmatter says `ai: false`. */
  excluded: number;
}

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

export interface NotionMe { name: string; workspace: string }
export interface NotionHit { id: string; title: string; url: string }
export interface NotionCreated { id: string; url: string }
export interface NotionPage { markdown: string; truncated: boolean; unknown_block_ids: string[] }
export interface NotionSent { id: string; url: string; linked: boolean }
export interface NotionPulled { file_id: string; title: string; unknown_blocks: number; existing: boolean }
export interface NotionLinkInfo { page_id: string; url: string; title: string; synced_secs: number; local_changed: boolean }
export type NotionSyncState = "in_sync" | "local_changed" | "remote_changed" | "both";
export interface NotionRefreshed { state: NotionSyncState; updated: boolean }
export type NotionPushPlan =
  | { kind: "nothing_to_send" }
  | { kind: "remote_changed"; both: boolean }
  | { kind: "ready"; old_str: string; new_str: string; local_hash: string };
export interface NotionPushed { warnings: string[] }
export interface NotionHome { page_id: string; title: string; url: string }
export type NotionFieldKind = "text" | "number" | "date" | "list" | "relation";
export interface NotionField { key: string; label: string; kind: NotionFieldKind }
export interface NotionProp { id: string; name: string; type: string; options: string[] }
export interface NotionSchema { id: string; title: string; properties: NotionProp[] }
export interface NotionMapEntry { field: string; property: string }
export interface NotionDestination { data_source_id: string; title: string; mapping: NotionMapEntry[] }
export interface NotionRowPreview { database: string; properties: Record<string, unknown>; warnings: string[] }
export interface NotionRowCreated { id: string; url: string; warnings: string[]; linked: boolean }
export interface NotionTemplate { title: string; columns: [string, string][] }
export interface NotionDbPages { database: string; rows: number; pages: { id: string; title: string; url: string; markdown: string }[] }
export interface NotionTask { id: string; title: string; due: string | null; status: string | null; owner: string | null; url: string }
export interface NotionTasksView { database: string; rows: NotionTask[]; truncated: boolean; done_status: string | null; read_only_reason: string | null }
