import { invoke } from "@tauri-apps/api/core";
import type { DiscoveredFile, FileEntry, FileSnapshot, LauncherInfo, Settings, TrackedFile } from "../types";

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
  hideLauncher: () => invoke<void>("hide_launcher"),
  launcherInfo: () => invoke<LauncherInfo>("launcher_info"),
};
