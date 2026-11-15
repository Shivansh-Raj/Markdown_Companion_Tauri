mod discovery;
mod external;
mod filesystem;
mod store;
mod watcher;
mod windows;

use filesystem::{FileLocks, FileSnapshot, ToggleError};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use store::{Settings, Store, TrackedFile};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, RunEvent, State, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use watcher::{Emit, WatchService};

/// Result of the global-shortcut registration, surfaced to the launcher UI.
#[derive(Default)]
struct ShortcutStatus(Mutex<Option<String>>);

/// Set when the user quits, so windows destroyed by shutdown are not recorded as "closed".
#[derive(Default)]
struct Quitting(AtomicBool);

#[derive(Serialize)]
struct FileEntry {
    #[serde(flatten)]
    file: TrackedFile,
    is_open: bool,
}

#[derive(Serialize)]
struct DiscoveredFile {
    canonical_path: String,
    display_name: String,
}

#[derive(Serialize)]
struct LauncherInfo {
    shortcut: String,
    shortcut_error: Option<String>,
}

/// Shared by the `open_tracker` command and launch-time restore.
fn open_tracker_impl(app: &AppHandle, id: &str) -> Result<(), String> {
    let store = app.state::<Store>();
    let watch = app.state::<WatchService>();
    let file = store.get(id).ok_or("Unknown tracker")?;
    // Start watching before the window exists so no change between load and watch is missed.
    if let Err(e) = watch.watch(Path::new(&file.canonical_path), id) {
        eprintln!("File watch failed for {id}: {e}");
    }
    windows::open_tracker(app, id, &file.display_name, store.window_state(id).as_ref())?;
    store.set_open(id, true);
    store.touch_opened(id);
    Ok(())
}

// ---- files & trackers ----

#[tauri::command]
fn list_files(app: AppHandle, store: State<Store>) -> Vec<FileEntry> {
    store
        .files()
        .into_iter()
        .map(|file| FileEntry { is_open: windows::is_open(&app, &file.id), file })
        .collect()
}

#[tauri::command]
fn register_file(path: String, store: State<Store>) -> Result<TrackedFile, String> {
    store.register(&path)
}

/// Removes a file from the list and closes its window. The Markdown file is not touched.
#[tauri::command]
fn unregister_file(app: AppHandle, id: String, store: State<Store>, watch: State<WatchService>) -> Result<(), String> {
    store.remove_file(&id)?; // first, so the window's Destroyed handler finds nothing to update
    watch.unwatch(&id);
    if let Some(w) = app.get_webview_window(&id) {
        let _ = w.destroy();
    }
    Ok(())
}

#[tauri::command]
fn open_tracker(app: AppHandle, id: String) -> Result<(), String> {
    open_tracker_impl(&app, &id)
}

/// Returns the content and version hash of a registered file only; arbitrary paths are not readable.
#[tauri::command(async)]
fn read_tracker_file(id: String, store: State<Store>, watch: State<WatchService>) -> Result<FileSnapshot, String> {
    let file = store.get(&id).ok_or("Unknown tracker")?;
    let path = Path::new(&file.canonical_path);
    let snap = filesystem::read_snapshot(path)?;
    watch.state.note_snapshot(path, &snap.hash);
    Ok(snap)
}

/// Retry after a missing/unreadable file: re-arms the folder watch and reloads.
#[tauri::command(async)]
fn reload_tracker(id: String, store: State<Store>, watch: State<WatchService>) -> Result<FileSnapshot, String> {
    let file = store.get(&id).ok_or("Unknown tracker")?;
    let path = Path::new(&file.canonical_path);
    let _ = watch.rewatch(path);
    let snap = filesystem::read_snapshot(path)?;
    watch.state.note_snapshot(path, &snap.hash);
    Ok(snap)
}

/// Toggles one task marker, only if the file still matches `expected_hash`.
#[tauri::command(async)]
fn toggle_task(
    id: String,
    expected_hash: String,
    byte_offset: usize,
    checked: bool,
    store: State<Store>,
    locks: State<FileLocks>,
    watch: State<WatchService>,
) -> Result<FileSnapshot, ToggleError> {
    let file = store
        .get(&id)
        .ok_or(ToggleError::Failed { message: "Unknown tracker".into() })?;
    let path = Path::new(&file.canonical_path);
    let saved = locks.toggle_task(path, &expected_hash, byte_offset, checked)?;
    // Record our own write so the watcher does not report it back as an external change.
    watch.state.note_snapshot(path, &saved.hash);
    Ok(saved)
}

/// Saves the full text from the edit mode, only if the file still matches `expected_hash`.
#[tauri::command(async)]
fn save_tracker_content(
    id: String,
    expected_hash: String,
    content: String,
    store: State<Store>,
    locks: State<FileLocks>,
    watch: State<WatchService>,
) -> Result<FileSnapshot, ToggleError> {
    let file = store
        .get(&id)
        .ok_or(ToggleError::Failed { message: "Unknown tracker".into() })?;
    let path = Path::new(&file.canonical_path);
    let saved = locks.save_content(path, &expected_hash, &content)?;
    watch.state.note_snapshot(path, &saved.hash);
    Ok(saved)
}

#[tauri::command]
fn tracker_info(id: String, store: State<Store>) -> Result<TrackedFile, String> {
    store.get(&id).ok_or_else(|| "Unknown tracker".into())
}

#[tauri::command]
fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    if !external::is_safe_external_url(&url) {
        return Err("Blocked: only http, https and mailto links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

// ---- AI file creation ----

#[tauri::command]
fn get_groq_key(store: State<Store>) -> Option<String> {
    store.groq_api_key()
}

#[tauri::command]
fn set_groq_key(key: String, store: State<Store>) -> Result<(), String> {
    store.set_groq_api_key(&key)
}

/// Reduces a title to a safe file stem: letters, digits, `-` and `_` only.
fn safe_stem(raw: &str) -> String {
    let mut out = String::new();
    for c in raw.chars() {
        if c.is_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out: String = out.trim_matches('-').chars().take(60).collect();
    if out.is_empty() { "untitled".into() } else { out }
}

fn save_dir(app: &AppHandle, store: &Store) -> Result<std::path::PathBuf, String> {
    match store.ai_save_dir() {
        Some(d) => Ok(d.into()),
        None => Ok(app.path().document_dir().map_err(|e| e.to_string())?.join("MarkdownCompanion")),
    }
}

/// The folder AI-created files are saved to (custom or default).
#[tauri::command]
fn get_save_dir(app: AppHandle, store: State<Store>) -> Result<String, String> {
    save_dir(&app, &store).map(|p| p.to_string_lossy().to_string())
}

/// `None` resets to the default folder.
#[tauri::command]
fn set_save_dir(path: Option<String>, store: State<Store>) -> Result<(), String> {
    store.set_ai_save_dir(path.as_deref())
}

/// Writes generated Markdown to the save folder as `<name>.md` (never overwriting) and registers it.
#[tauri::command(async)]
fn create_markdown_file(app: AppHandle, name: String, content: String, store: State<Store>) -> Result<TrackedFile, String> {
    let dir = save_dir(&app, &store)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = safe_stem(&name);
    for n in 0..1000u32 {
        let file = if n == 0 { format!("{stem}.md") } else { format!("{stem}-{n}.md") };
        let path = dir.join(file);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                use std::io::Write;
                f.write_all(content.as_bytes()).map_err(|e| e.to_string())?;
                return store.register(&path.to_string_lossy());
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("Could not find a free file name".into())
}

#[cfg(test)]
mod ai_tests {
    use super::safe_stem;
    #[test]
    fn stems_are_safe() {
        assert_eq!(safe_stem("Launch Plan: Week 1!"), "launch-plan-week-1");
        assert_eq!(safe_stem("../../etc/passwd"), "etc-passwd");
        assert_eq!(safe_stem("!!!"), "untitled");
    }
}

// ---- launcher, settings, shortcut ----

#[tauri::command]
fn hide_launcher(app: AppHandle) {
    if let Some(w) = app.get_webview_window(windows::LAUNCHER) {
        let _ = w.hide();
    }
}

#[tauri::command]
fn launcher_info(store: State<Store>, status: State<ShortcutStatus>) -> LauncherInfo {
    LauncherInfo { shortcut: store.shortcut(), shortcut_error: status.0.lock().unwrap().clone() }
}

#[tauri::command]
fn get_settings(store: State<Store>) -> Settings {
    store.settings()
}

#[tauri::command]
fn set_settings(app: AppHandle, theme: String, reopen_on_launch: bool, store: State<Store>) -> Result<Settings, String> {
    let settings = store.update_settings(&theme, reopen_on_launch)?;
    let _ = app.emit("settings-changed", settings.clone());
    Ok(settings)
}

/// Re-registers the global shortcut. The old one stays active if the new one can't be registered.
#[tauri::command]
fn set_shortcut(
    app: AppHandle,
    accelerator: String,
    store: State<Store>,
    status: State<ShortcutStatus>,
) -> Result<String, String> {
    let parsed: Shortcut = accelerator.parse().map_err(|_| "That key combination is not valid".to_string())?;
    if parsed.mods.is_empty() {
        return Err("Include at least one modifier key (Ctrl, Alt, Shift or Cmd)".into());
    }
    let old = store.shortcut();
    if old == accelerator {
        return Ok(old);
    }
    let gs = app.global_shortcut();
    gs.register(accelerator.as_str())
        .map_err(|_| "Could not register that shortcut; it may be in use by another app".to_string())?;
    let _ = gs.unregister(old.as_str());
    store.set_shortcut(&accelerator)?;
    *status.0.lock().unwrap() = None;
    Ok(accelerator)
}

// ---- folder discovery (opt-in) ----

#[tauri::command]
fn list_folders(store: State<Store>) -> Vec<String> {
    store.folders()
}

#[tauri::command]
fn add_folder(path: String, store: State<Store>) -> Result<String, String> {
    store.add_folder(&path)
}

#[tauri::command]
fn remove_folder(path: String, store: State<Store>) -> Result<(), String> {
    store.remove_folder(&path)
}

/// Markdown files found in registered folders that are not tracked yet.
#[tauri::command(async)]
fn list_discovered(store: State<Store>) -> Vec<DiscoveredFile> {
    let mut seen: HashSet<String> = store.files().into_iter().map(|f| f.canonical_path).collect();
    let mut out = Vec::new();
    for folder in store.folders() {
        for path in discovery::scan_folder(Path::new(&folder)) {
            let canonical_path = path.to_string_lossy().to_string();
            if seen.insert(canonical_path.clone()) {
                let display_name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| canonical_path.clone());
                out.push(DiscoveredFile { canonical_path, display_name });
            }
        }
    }
    out
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        windows::toggle_launcher(app);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Background utility: no Dock icon on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data_dir = app.path().app_data_dir()?;
            let store = Store::load(data_dir.join("store.json"));
            let shortcut = store.shortcut();
            app.manage(store.clone());
            app.manage(FileLocks::default());
            app.manage(Quitting::default());

            let handle = app.handle().clone();
            let emit: Emit = Arc::new(move |id, event| {
                let _ = handle.emit_to(id, "tracker-sync", event);
            });
            app.manage(WatchService::new(emit).map_err(|e| e.to_string())?);

            let status = ShortcutStatus::default();
            if let Err(e) = app.global_shortcut().register(shortcut.as_str()) {
                eprintln!("Global shortcut registration failed: {e}");
                *status.0.lock().unwrap() =
                    Some(format!("Could not register {shortcut}; it may be in use by another app."));
            }
            app.manage(status);

            let item = |id: &str, label: &str| MenuItem::with_id(app, id, label, true, None::<&str>);
            let menu = Menu::with_items(
                app,
                &[
                    &item("show", "Open launcher")?,
                    &item("show_all", "Show all trackers")?,
                    &item("hide_all", "Hide all trackers")?,
                    &item("settings", "Settings…")?,
                    &PredefinedMenuItem::separator(app)?,
                    &item("quit", "Quit")?,
                ],
            )?;
            let mut tray = TrayIconBuilder::new().menu(&menu).on_menu_event(|app, event| match event.id.as_ref() {
                "show" => windows::show_launcher(app, "list"),
                "settings" => windows::show_launcher(app, "settings"),
                "show_all" => windows::show_all_trackers(app),
                "hide_all" => windows::hide_all_trackers(app),
                "quit" => {
                    app.state::<Quitting>().0.store(true, Ordering::SeqCst);
                    app.state::<Store>().flush();
                    app.exit(0);
                }
                _ => {}
            });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Trackers are restored only when enabled; otherwise stale "open" flags are cleared.
            if store.settings().reopen_on_launch {
                for id in store.open_ids() {
                    if let Err(e) = open_tracker_impl(app.handle(), &id) {
                        eprintln!("Could not reopen {id}: {e}");
                    }
                }
            } else {
                store.clear_open();
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label();
            if windows::is_tracker(label) {
                match event {
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                        if let Some((w, h, x, y)) = windows::capture_geometry(window) {
                            window.state::<Store>().set_geometry(label, w, h, x, y);
                        }
                    }
                    WindowEvent::Destroyed => {
                        window.state::<WatchService>().unwatch(label);
                        if !window.state::<Quitting>().0.load(Ordering::SeqCst) {
                            window.state::<Store>().set_open(label, false);
                        }
                    }
                    _ => {}
                }
            }
            // Closing the launcher hides it; the app keeps running in the background.
            if let (true, WindowEvent::CloseRequested { api, .. }) = (label == windows::LAUNCHER, event) {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_files,
            register_file,
            unregister_file,
            open_tracker,
            read_tracker_file,
            reload_tracker,
            toggle_task,
            save_tracker_content,
            tracker_info,
            hide_launcher,
            open_external,
            launcher_info,
            get_settings,
            set_settings,
            set_shortcut,
            list_folders,
            add_folder,
            remove_folder,
            list_discovered,
            get_groq_key,
            set_groq_key,
            create_markdown_file,
            get_save_dir,
            set_save_dir
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Keep running in the tray when the last window closes.
            RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
            RunEvent::Exit => app.state::<Store>().flush(),
            _ => {}
        });
}
