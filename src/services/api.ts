import { invoke } from "@tauri-apps/api/core";
import type { SessionMeta, VoiceDevice, VoiceMode, VoiceStatus } from "./voice/types";
import type { NotionTemplate, NotionDestination, NotionField, NotionMapEntry, NotionRowCreated, NotionRowPreview, NotionSchema, NotionHome, NotionPushed, NotionPushPlan, NotionLinkInfo, NotionPulled, NotionRefreshed, NotionSent, NotionHit, NotionMe, NotionPage, AskPassages, AskScopes, DiscoveredFile, FileEntry, FileSnapshot, KeyStorage, LauncherInfo, NoteContext, Settings, TasksView, TrackedFile } from "../types";

export const api = {
  listFiles: () => invoke<FileEntry[]>("list_files"),
  registerFile: (path: string) => invoke<TrackedFile>("register_file", { path }),
  openTracker: (id: string) => invoke<void>("open_tracker", { id }),
  readTrackerFile: (id: string) => invoke<FileSnapshot>("read_tracker_file", { id }),
  reloadTracker: (id: string) => invoke<FileSnapshot>("reload_tracker", { id }),
  toggleTask: (id: string, expectedHash: string, byteOffset: number, checked: boolean) =>
    invoke<FileSnapshot>("toggle_task", { id, expectedHash, byteOffset, checked }),
  saveTrackerContent: (id: string, expectedHash: string, content: string) =>
    invoke<FileSnapshot>("save_tracker_content", { id, expectedHash, content }),
  trackerInfo: (id: string) => invoke<TrackedFile>("tracker_info", { id }),
  noteContext: (id: string) => invoke<NoteContext | null>("note_context", { id }),
  openVaultNote: (id: string, path: string) => invoke<void>("open_vault_note", { id, path }),
  notionConnected: () => invoke<boolean>("notion_connected"),
  notionConnect: (token: string) => invoke<NotionMe>("notion_connect", { token }),
  notionDisconnect: () => invoke<void>("notion_disconnect"),
  notionTest: () => invoke<NotionMe>("notion_test"),
  notionSearch: (query: string) => invoke<NotionHit[]>("notion_search", { query }),
  notionCreatePage: (parent: string, title: string, markdown: string, source?: { file_id: string; content: string }, section?: string) =>
    invoke<NotionSent>("notion_create_page", { parent, title, markdown, source: source ?? null, section: section ?? null }),
  notionDestinationFields: (destination: string) => invoke<NotionField[]>("notion_destination_fields", { destination }),
  notionSearchDatabases: (query: string) => invoke<NotionHit[]>("notion_search_databases", { query }),
  notionSchema: (dataSource: string) => invoke<NotionSchema>("notion_schema", { dataSource }),
  notionTemplate: (key: string) => invoke<NotionTemplate>("notion_template", { key }),
  notionCreateDestination: (key: string) => invoke<NotionDestination>("notion_create_destination", { key }),
  notionDestination: (key: string) => invoke<NotionDestination | null>("notion_destination", { key }),
  notionSetDestination: (key: string, dataSource: string, mapping: NotionMapEntry[]) =>
    invoke<NotionDestination>("notion_set_destination", { key, dataSource, mapping }),
  notionClearDestination: (key: string) => invoke<void>("notion_clear_destination", { key }),
  notionPreviewRow: (key: string, title: string, values: Record<string, unknown>) =>
    invoke<NotionRowPreview>("notion_preview_row", { key, title, values }),
  notionCreateRow: (key: string, title: string, markdown: string, values: Record<string, unknown>, source?: { file_id: string; content: string }) =>
    invoke<NotionRowCreated>("notion_create_row", { key, title, markdown, values, source: source ?? null }),
  notionHome: () => invoke<NotionHome | null>("notion_home"),
  notionSetHome: (page: string) => invoke<NotionHome>("notion_set_home", { page }),
  notionClearHome: () => invoke<void>("notion_clear_home"),
  notionPull: (page: string) => invoke<NotionPulled>("notion_pull", { page }),
  notionLink: (fileId: string) => invoke<NotionLinkInfo | null>("notion_link", { fileId }),
  notionPushPlan: (fileId: string) => invoke<NotionPushPlan>("notion_push_plan", { fileId }),
  notionPush: (fileId: string, expectedHash: string) => invoke<NotionPushed>("notion_push", { fileId, expectedHash }),
  notionRefresh: (fileId: string) => invoke<NotionRefreshed>("notion_refresh", { fileId }),
  notionReadPage: (page: string) => invoke<NotionPage>("notion_read_page", { page }),
  askScopes: (id: string) => invoke<AskScopes | null>("ask_scopes", { id }),
  askRetrieve: (id: string, scope: "folder" | "vault", question: string) => invoke<AskPassages>("ask_retrieve", { id, scope, question }),
  openTasksWindow: () => invoke<void>("open_tasks_window"),
  openTasks: () => invoke<TasksView>("open_tasks"),
  toggleVaultTask: (path: string, offset: number, expect: string, checked: boolean) =>
    invoke<"done" | "stale">("toggle_vault_task", { path, offset, expect, checked }),
  openNoteByPath: (path: string) => invoke<void>("open_note_by_path", { path }),
  openWikilink: (id: string, target: string) => invoke<boolean>("open_wikilink", { id, target }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  unregisterFile: (id: string) => invoke<void>("unregister_file", { id }),
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (theme: string, reopenOnLaunch: boolean) =>
    invoke<Settings>("set_settings", { theme, reopenOnLaunch }),
  setShortcut: (accelerator: string) => invoke<string>("set_shortcut", { accelerator }),
  listFolders: () => invoke<string[]>("list_folders"),
  addFolder: (path: string) => invoke<string>("add_folder", { path }),
  removeFolder: (path: string) => invoke<void>("remove_folder", { path }),
  listDiscovered: () => invoke<DiscoveredFile[]>("list_discovered"),
  getGroqKey: () => invoke<string | null>("get_groq_key"),
  setGroqKey: (key: string) => invoke<KeyStorage>("set_groq_key", { key }),
  groqKeyStorage: () => invoke<KeyStorage>("groq_key_storage"),
  createMarkdownFile: (name: string, content: string) =>
    invoke<TrackedFile>("create_markdown_file", { name, content }),
  getSaveDir: () => invoke<string>("get_save_dir"),
  setSaveDir: (path: string | null) => invoke<void>("set_save_dir", { path }),
  openVoice: () => invoke<void>("open_voice"),
  voiceDevices: () => invoke<VoiceDevice[]>("voice_list_devices"),
  voiceStart: (title: string, mode: VoiceMode, device: string | null) =>
    invoke<SessionMeta>("voice_start", { title, mode, device }),
  voicePause: () => invoke<void>("voice_pause"),
  voiceResume: () => invoke<void>("voice_resume"),
  voiceStop: () => invoke<SessionMeta>("voice_stop"),
  voiceStatus: () => invoke<VoiceStatus | null>("voice_status"),
  voiceReadChunk: (sessionId: string, index: number) => invoke<ArrayBuffer>("voice_read_chunk", { sessionId, index }),
  voiceSessions: () => invoke<SessionMeta[]>("voice_list_sessions"),
  voiceSaveTranscript: (sessionId: string, json: string) => invoke<void>("voice_save_transcript", { sessionId, json }),
  voiceLoadTranscript: (sessionId: string) => invoke<string | null>("voice_load_transcript", { sessionId }),
  voiceSaveAnalysis: (sessionId: string, kind: string, json: string) =>
    invoke<void>("voice_save_analysis", { sessionId, kind, json }),
  voiceListAnalyses: (sessionId: string) => invoke<string[]>("voice_list_analyses", { sessionId }),
  createMarkdownFileIn: (dir: string, name: string, content: string) =>
    invoke<TrackedFile>("create_markdown_file_in", { dir, name, content }),
  voiceDeleteAudio: (sessionId: string) => invoke<void>("voice_delete_audio", { sessionId }),
  voiceDeleteSession: (sessionId: string) => invoke<void>("voice_delete_session", { sessionId }),
  hideLauncher: () => invoke<void>("hide_launcher"),
  launcherInfo: () => invoke<LauncherInfo>("launcher_info"),
};
