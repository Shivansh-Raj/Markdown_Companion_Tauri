mod discovery;
mod external;
mod filesystem;
mod notion;
mod secrets;
mod store;
mod vault;
mod watcher;
mod voice;
mod windows;

use filesystem::{FileLocks, FileSnapshot, ToggleError};
use serde::{Deserialize, Serialize};
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

/// Opens the note a `[[wikilink]]` points at in its own tracker window. Returns false when nothing matches.
/// The search is limited to the linking note's vault (or folder) and the watched folders.
#[tauri::command(async)]
fn open_wikilink(app: AppHandle, id: String, target: String, store: State<Store>) -> Result<bool, String> {
    let from = store.get(&id).ok_or("Unknown tracker")?;
    let watched: Vec<std::path::PathBuf> = store.folders().iter().map(std::path::PathBuf::from).collect();
    let Some(found) = discovery::resolve_wikilink(Path::new(&from.canonical_path), &watched, &target) else {
        return Ok(false);
    };
    let file = store.register(&found.to_string_lossy())?;
    open_tracker_impl(&app, &file.id)?;
    Ok(true)
}

// ---- Vault index (read-only) ----

#[derive(Serialize)]
struct NoteRef {
    path: String,
    name: String,
    rel: String,
    /// How many times the linking note references this one (backlinks only).
    count: u32,
}

#[derive(Serialize)]
struct OutLink {
    label: String,
    target: Option<NoteRef>,
}

#[derive(Serialize)]
struct NoteContext {
    vault_name: String,
    vault_root: String,
    is_vault: bool,
    note_count: usize,
    indexed_at_ms: u64,
    skipped: Vec<String>,
    tags: Vec<String>,
    backlinks: Vec<NoteRef>,
    outgoing: Vec<OutLink>,
    /// Notes about the same things that are not linked yet, each with the words they share.
    related: Vec<RelatedRef>,
}

#[derive(Serialize)]
struct RelatedRef {
    note: NoteRef,
    why: Vec<String>,
}

fn note_ref(n: &vault::Note, count: u32) -> NoteRef {
    NoteRef { path: n.path.to_string_lossy().into_owned(), name: n.name.clone(), rel: n.rel.clone(), count }
}

fn watched_folders(store: &Store) -> Vec<std::path::PathBuf> {
    store.folders().iter().map(std::path::PathBuf::from).collect()
}

/// Backlinks, outgoing links and tags for a tracked note, from a local read-only index of its vault (or watched
/// folder). Returns None when the note is in neither. The index refreshes incrementally on every call.
#[tauri::command(async)]
fn note_context(id: String, store: State<Store>, vaults: State<vault::VaultState>) -> Result<Option<NoteContext>, String> {
    let file = store.get(&id).ok_or("Unknown tracker")?;
    let path = Path::new(&file.canonical_path);
    let Some((root, is_vault)) = vault::index_root_for(path, &watched_folders(&store)) else { return Ok(None) };
    let mut all = vaults.0.lock().map_err(|_| "Index is busy".to_string())?;
    let index = all.entry(root.clone()).or_insert_with(|| vault::VaultIndex::new(root.clone(), is_vault));
    index.refresh();
    let Some(i) = index.index_of(path) else {
        return Err(if index.skipped.iter().any(|s| path.ends_with(s.split(':').next().unwrap_or(""))) {
            "This note could not be indexed (see the notes skipped by the index).".into()
        } else {
            "This note is outside the indexed folder depth or size limits.".into()
        });
    };
    Ok(Some(NoteContext {
        vault_name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        vault_root: root.to_string_lossy().into_owned(),
        is_vault: index.is_vault,
        note_count: index.notes.len(),
        indexed_at_ms: index.indexed_at_ms,
        skipped: index.skipped.clone(),
        tags: index.notes[i].parsed.tags.clone(),
        backlinks: index.backlinks(i).iter().map(|(b, c)| note_ref(&index.notes[*b], *c)).collect(),
        outgoing: index
            .outgoing(i)
            .into_iter()
            .map(|(l, r)| OutLink { label: l.label.clone(), target: r.map(|t| note_ref(&index.notes[t], 0)) })
            .collect(),
        related: index.related(i, 6).into_iter().map(|(j, why)| RelatedRef { note: note_ref(&index.notes[j], 0), why }).collect(),
    }))
}

#[derive(Serialize)]
struct AskScopes {
    vault_name: String,
    is_vault: bool,
    folder_name: String,
    folder_notes: usize,
    vault_notes: usize,
}

#[derive(Serialize)]
struct PassageOut {
    path: String,
    rel: String,
    name: String,
    heading: String,
    text: String,
}

#[derive(Serialize)]
struct AskPassages {
    passages: Vec<PassageOut>,
    notes_in_scope: usize,
    /// Notes in scope that were left out because their frontmatter says `ai: false`.
    excluded: usize,
}

/// What Ask can search from this note: its folder and its vault (or watched folder). None when the note is in neither.
#[tauri::command(async)]
fn ask_scopes(id: String, store: State<Store>, vaults: State<vault::VaultState>) -> Result<Option<AskScopes>, String> {
    let file = store.get(&id).ok_or("Unknown tracker")?;
    let path = Path::new(&file.canonical_path);
    let Some((root, is_vault)) = vault::index_root_for(path, &watched_folders(&store)) else { return Ok(None) };
    let mut all = vaults.0.lock().map_err(|_| "Index is busy".to_string())?;
    let index = all.entry(root.clone()).or_insert_with(|| vault::VaultIndex::new(root.clone(), is_vault));
    index.refresh();
    if index.index_of(path).is_none() {
        return Ok(None);
    }
    let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
    Ok(Some(AskScopes {
        vault_name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        is_vault,
        folder_name: dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        folder_notes: index.notes.iter().filter(|n| n.path.starts_with(&dir)).count(),
        vault_notes: index.notes.len(),
    }))
}

/// Finds the passages of the note's folder or vault that best match a question. Read-only and local: nothing is sent
/// anywhere. The text returned is what the Context Receipt will show before any of it goes to the model.
#[tauri::command(async)]
fn ask_retrieve(id: String, scope: String, question: String, store: State<Store>, vaults: State<vault::VaultState>) -> Result<AskPassages, String> {
    let scope = match scope.as_str() {
        "folder" => vault::AskScope::Folder,
        "vault" => vault::AskScope::Vault,
        _ => return Err("Unknown scope".into()),
    };
    let file = store.get(&id).ok_or("Unknown tracker")?;
    let path = Path::new(&file.canonical_path);
    let (root, is_vault) = vault::index_root_for(path, &watched_folders(&store)).ok_or("This note is not in a vault or watched folder")?;
    let mut all = vaults.0.lock().map_err(|_| "Index is busy".to_string())?;
    let index = all.entry(root.clone()).or_insert_with(|| vault::VaultIndex::new(root.clone(), is_vault));
    index.refresh();
    let from = index.index_of(path).ok_or("This note is not indexed")?;
    let got = index.retrieve(&question, from, scope);
    Ok(AskPassages {
        passages: got
            .passages
            .into_iter()
            .map(|p| PassageOut { path: p.path.to_string_lossy().into_owned(), rel: p.rel, name: p.name, heading: p.heading, text: p.text })
            .collect(),
        notes_in_scope: got.notes_in_scope,
        excluded: got.excluded,
    })
}

/// Opens a note listed by `note_context`. Only notes the index knows in the same vault can be opened this way.
#[tauri::command(async)]
fn open_vault_note(app: AppHandle, id: String, path: String, store: State<Store>, vaults: State<vault::VaultState>) -> Result<(), String> {
    let from = store.get(&id).ok_or("Unknown tracker")?;
    let (root, _) = vault::index_root_for(Path::new(&from.canonical_path), &watched_folders(&store)).ok_or("This note is not in a vault")?;
    {
        let all = vaults.0.lock().map_err(|_| "Index is busy".to_string())?;
        let known = all.get(&root).is_some_and(|ix| ix.index_of(Path::new(&path)).is_some());
        if !known {
            return Err("That note is not part of this vault's index.".into());
        }
    }
    let file = store.register(&path)?;
    open_tracker_impl(&app, &file.id)
}

// ---- Open tasks ----

#[derive(Serialize)]
struct TaskRow {
    path: String,
    note: String,
    rel: String,
    source: String,
    offset: usize,
    line: usize,
    title: String,
    raw: String,
    due: Option<String>,
    scheduled: Option<String>,
    recurring: bool,
}

#[derive(Serialize)]
struct TasksView {
    rows: Vec<TaskRow>,
    /// Names of the vaults and folders searched.
    sources: Vec<String>,
    /// More tasks exist than are shown.
    truncated: bool,
}

const MAX_TASK_ROWS: usize = 1500;

/// The vault or watched-folder roots to search, plus tracked files that sit in neither.
fn task_sources(store: &Store) -> (Vec<(std::path::PathBuf, bool)>, Vec<std::path::PathBuf>) {
    let watched = watched_folders(store);
    let mut roots: Vec<(std::path::PathBuf, bool)> = Vec::new();
    let mut add = |r: (std::path::PathBuf, bool)| {
        if !roots.iter().any(|(p, _)| *p == r.0) {
            roots.push(r);
        }
    };
    for w in &watched {
        add(match discovery::vault_root(&w.join("_")) {
            Some(v) => (v, true),
            None => (w.clone(), false),
        });
    }
    let mut loose = Vec::new();
    for f in store.files() {
        let p = std::path::PathBuf::from(&f.canonical_path);
        match vault::index_root_for(&p, &watched) {
            Some(r) => add(r),
            None => loose.push(p),
        }
    }
    (roots, loose)
}

/// Collects unchecked tasks from the given roots (indexed, refreshed first) and loose files (parsed directly).
fn collect_tasks(
    roots: Vec<(std::path::PathBuf, bool)>,
    loose: Vec<std::path::PathBuf>,
    indexes: &mut std::collections::HashMap<std::path::PathBuf, vault::VaultIndex>,
) -> TasksView {
    let mut rows: Vec<TaskRow> = Vec::new();
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    let mut truncated = false;
    let mut push = |rows: &mut Vec<TaskRow>, path: &Path, note: &str, rel: &str, source: &str, t: &vault::TaskItem| {
        if t.done || !seen.insert((path.to_path_buf(), t.offset)) {
            return;
        }
        if rows.len() >= MAX_TASK_ROWS {
            truncated = true;
            return;
        }
        rows.push(TaskRow {
            path: path.to_string_lossy().into_owned(), note: note.into(), rel: rel.into(), source: source.into(),
            offset: t.offset, line: t.line, title: t.title.clone(), raw: t.raw.clone(),
            due: t.due.clone(), scheduled: t.scheduled.clone(), recurring: t.recurring,
        });
    };
    for (root, is_vault) in roots {
        let index = indexes.entry(root.clone()).or_insert_with(|| vault::VaultIndex::new(root.clone(), is_vault));
        index.refresh();
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        sources.push(name.clone());
        for n in &index.notes {
            for t in &n.parsed.tasks {
                push(&mut rows, &n.path, &n.name, &n.rel, &name, t);
            }
        }
    }
    for path in loose {
        let Ok(content) = std::fs::read_to_string(&path) else { continue };
        let name = path.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        for t in &vault::parse_note(&content).tasks {
            push(&mut rows, &path, &name, &name, "Tracked files", t);
        }
    }
    TasksView { rows, sources, truncated }
}

/// Unchecked tasks from every vault, watched folder and tracked file. Read-only; refreshes the indexes first.
#[tauri::command(async)]
fn open_tasks(store: State<Store>, vaults: State<vault::VaultState>) -> Result<TasksView, String> {
    let (roots, loose) = task_sources(&store);
    let mut all = vaults.0.lock().map_err(|_| "Index is busy".to_string())?;
    Ok(collect_tasks(roots, loose, &mut all))
}

/// A note the app may touch: tracked, or part of an index it has built. Prevents the UI from naming arbitrary paths.
fn is_known_note(path: &Path, store: &Store, vaults: &vault::VaultState) -> bool {
    let tracked = store.files().iter().any(|f| Path::new(&f.canonical_path) == path);
    tracked || vaults.0.lock().is_ok_and(|all| all.values().any(|ix| ix.index_of(path).is_some()))
}

/// Result of a task toggle: `done`, or `stale` when the note changed since it was listed (nothing was written).
#[tauri::command(async)]
fn toggle_vault_task(
    path: String,
    offset: usize,
    expect: String,
    checked: bool,
    store: State<Store>,
    vaults: State<vault::VaultState>,
    locks: State<FileLocks>,
) -> Result<&'static str, String> {
    let p = Path::new(&path);
    if !is_known_note(p, &store, &vaults) {
        return Err("That note is not part of your tasks list.".into());
    }
    match locks.toggle_task_verified(p, offset, &expect, checked) {
        Ok(_) => Ok("done"),
        Err(ToggleError::Stale { .. }) => Ok("stale"),
        Err(ToggleError::Failed { message }) => Err(message),
    }
}

/// Opens a note from the tasks list in its own window.
#[tauri::command(async)]
fn open_note_by_path(app: AppHandle, path: String, store: State<Store>, vaults: State<vault::VaultState>) -> Result<(), String> {
    if !is_known_note(Path::new(&path), &store, &vaults) {
        return Err("That note is not part of your tasks list.".into());
    }
    let file = store.register(&path)?;
    open_tracker_impl(&app, &file.id)
}

#[tauri::command]
fn open_tasks_window(app: AppHandle) -> Result<(), String> {
    windows::open_tasks(&app)
}

// ---- Notion ----

/// Runs a blocking Notion call off the UI thread, with the stored token.
async fn notion_call<T: Send + 'static>(
    state: &std::sync::Arc<notion::NotionState>,
    f: impl FnOnce(&notion::Client) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let token = state.require_token()?;
    tauri::async_runtime::spawn_blocking(move || f(&notion::Client::new(&notion::Network, &token)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn notion_connected(state: State<std::sync::Arc<notion::NotionState>>) -> Result<bool, String> {
    Ok(state.token()?.is_some())
}

/// Checks the token with Notion and stores it in the credential store only if Notion accepts it.
#[tauri::command]
async fn notion_connect(token: String, state: State<'_, std::sync::Arc<notion::NotionState>>) -> Result<notion::Me, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.connect(&notion::Network, &token))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn notion_disconnect(state: State<std::sync::Arc<notion::NotionState>>) -> Result<(), String> {
    state.disconnect()
}

#[tauri::command]
async fn notion_test(state: State<'_, std::sync::Arc<notion::NotionState>>) -> Result<notion::Me, String> {
    notion_call(state.inner(), |c| c.me()).await
}

#[tauri::command]
async fn notion_search(query: String, state: State<'_, std::sync::Arc<notion::NotionState>>) -> Result<Vec<notion::PageHit>, String> {
    notion_call(state.inner(), move |c| c.search_pages(&query)).await
}

/// Where the note being sent came from, so the new page can be linked to it.
#[derive(Deserialize)]
struct SendSource {
    file_id: String,
    content: String,
}

#[derive(Serialize)]
struct SentPage {
    id: String,
    url: String,
    /// False if Notion created the page but linking it to the local file failed (nothing is lost; just not tracked).
    linked: bool,
}

#[derive(Serialize)]
struct SentRow {
    id: String,
    url: String,
    warnings: Vec<String>,
    linked: bool,
}

#[tauri::command]
async fn notion_create_page(
    parent: String,
    title: String,
    markdown: String,
    source: Option<SendSource>,
    section: Option<String>,
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<SentPage, String> {
    let store = store.inner().clone();
    notion_call(state.inner(), move |c| {
        // A section (notes, meetings, …) is looked up or created under the home page; otherwise the chosen parent is used.
        let parent = match &section {
            Some(key) => notion::home::ensure_section(c, &store, key)?,
            None => parent,
        };
        let made = c.create_page(&parent, &title, &markdown)?;
        let linked = match &source {
            Some(s) => notion::sync::link_created(c, &store, &s.file_id, &s.content, &made, title.trim()),
            None => false,
        };
        Ok(SentPage { id: made.id, url: made.url, linked })
    })
    .await
}

/// Fetches a Notion page into a new local file (or opens the file already linked to it) and opens it.
#[tauri::command]
async fn notion_pull(
    app: AppHandle,
    page: String,
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<notion::sync::Pulled, String> {
    let dir = save_dir(&app, &store)?;
    let st = store.inner().clone();
    let pulled = notion_call(state.inner(), move |c| notion::sync::pull(c, &st, &dir, &page)).await?;
    open_tracker_impl(&app, &pulled.file_id)?;
    Ok(pulled)
}

#[tauri::command]
fn notion_destination_fields(destination: String) -> Result<&'static [notion::db::Field], String> {
    notion::db::fields_for(&destination).ok_or_else(|| "Unknown destination.".to_string())
}

#[tauri::command]
async fn notion_search_databases(query: String, state: State<'_, std::sync::Arc<notion::NotionState>>) -> Result<Vec<notion::PageHit>, String> {
    notion_call(state.inner(), move |c| c.search_data_sources(&query)).await
}

#[tauri::command]
async fn notion_schema(data_source: String, state: State<'_, std::sync::Arc<notion::NotionState>>) -> Result<notion::db::Schema, String> {
    notion_call(state.inner(), move |c| c.data_source_schema(&data_source)).await
}

/// What CREATE FOR ME would make: the database title and its columns. Reads nothing from Notion.
#[tauri::command]
fn notion_template(key: String, store: State<Store>) -> Result<notion::db::Template, String> {
    let meetings = store.notion_destination("meetings").map(|d| d.data_source_id);
    notion::db::template_for(&key, meetings.as_deref()).ok_or_else(|| "Unknown destination.".to_string())
}

/// Creates the database for a destination inside the home page and maps it. Runs only when the user confirms.
#[tauri::command]
async fn notion_create_destination(
    key: String,
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<store::NotionDestination, String> {
    let st = store.inner().clone();
    notion_call(state.inner(), move |c| notion::dest::create_destination(c, &st, &key)).await
}

#[tauri::command]
fn notion_destination(key: String, store: State<Store>) -> Option<store::NotionDestination> {
    store.notion_destination(&key)
}

#[tauri::command]
async fn notion_set_destination(
    key: String,
    data_source: String,
    mapping: Vec<notion::db::MapEntry>,
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<store::NotionDestination, String> {
    let st = store.inner().clone();
    notion_call(state.inner(), move |c| notion::dest::set_destination(c, &st, &key, &data_source, mapping)).await
}

#[tauri::command]
fn notion_clear_destination(key: String, store: State<Store>) -> Result<(), String> {
    store.set_notion_destination(&key, None)
}

/// What a new row would contain, without creating it.
#[tauri::command]
async fn notion_preview_row(
    key: String,
    title: String,
    values: serde_json::Map<String, serde_json::Value>,
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<notion::dest::RowPreview, String> {
    let st = store.inner().clone();
    notion_call(state.inner(), move |c| notion::dest::preview_row(c, &st, &key, &title, &values)).await
}

#[tauri::command]
async fn notion_create_row(
    key: String,
    title: String,
    markdown: String,
    values: serde_json::Map<String, serde_json::Value>,
    source: Option<SendSource>,
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<SentRow, String> {
    let st = store.inner().clone();
    notion_call(state.inner(), move |c| {
        let made = notion::dest::create_row(c, &st, &key, &title, &markdown, &values)?;
        // When the row came from a note, link them so the note can be refreshed and pushed later.
        let linked = match &source {
            Some(s) => notion::sync::link_created(c, &st, &s.file_id, &s.content, &notion::Created { id: made.id.clone(), url: made.url.clone() }, title.trim()),
            None => false,
        };
        Ok(SentRow { id: made.id, url: made.url, warnings: made.warnings, linked })
    })
    .await
}

/// Open tasks from the Tasks database. Read only.
#[tauri::command]
async fn notion_tasks(
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<notion::tasks::NotionTasksView, String> {
    let st = store.inner().clone();
    notion_call(state.inner(), move |c| notion::tasks::open_tasks(c, &st)).await
}

/// Sets a task's Status after checking it still has the status the user saw. Used to tick a task off and to undo that.
#[tauri::command]
async fn notion_task_set_status(
    page: String,
    expect: Option<String>,
    to: String,
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<notion::tasks::StatusOutcome, String> {
    let st = store.inner().clone();
    notion_call(state.inner(), move |c| notion::tasks::set_status(c, &st, &page, expect.as_deref(), &to)).await
}

#[tauri::command]
fn notion_home(store: State<Store>) -> Option<store::NotionHome> {
    store.notion_home()
}

/// Makes a page (a link or id) the home page for everything MC creates in Notion.
#[tauri::command]
async fn notion_set_home(
    page: String,
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<store::NotionHome, String> {
    let st = store.inner().clone();
    notion_call(state.inner(), move |c| notion::home::set_home(c, &st, &page)).await
}

#[tauri::command]
fn notion_clear_home(store: State<Store>) -> Result<(), String> {
    store.set_notion_home(None)
}

#[tauri::command]
fn notion_link(file_id: String, store: State<Store>) -> Result<Option<notion::sync::LinkInfo>, String> {
    notion::sync::link_info(&store, &file_id)
}

/// What a push would change in Notion. Reads only; nothing is written.
#[tauri::command]
async fn notion_push_plan(
    file_id: String,
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<notion::sync::PushPlan, String> {
    let st = store.inner().clone();
    notion_call(state.inner(), move |c| notion::sync::plan_push(c, &st, &file_id)).await
}

/// Sends the previewed edit to Notion, after re-checking that neither side changed.
#[tauri::command]
async fn notion_push(
    file_id: String,
    expected_hash: String,
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<notion::sync::Pushed, String> {
    let st = store.inner().clone();
    notion_call(state.inner(), move |c| notion::sync::push(c, &st, &file_id, &expected_hash)).await
}

/// Brings Notion's changes into a linked file when the local file has no unsynced edits.
#[tauri::command]
async fn notion_refresh(
    app: AppHandle,
    file_id: String,
    state: State<'_, std::sync::Arc<notion::NotionState>>,
    store: State<'_, Store>,
) -> Result<notion::sync::Refreshed, String> {
    let st = store.inner().clone();
    notion_call(state.inner(), move |c| {
        let locks = app.state::<FileLocks>();
        notion::sync::refresh(c, &st, &locks, &file_id)
    })
    .await
}

#[tauri::command]
async fn notion_read_page(page: String, state: State<'_, std::sync::Arc<notion::NotionState>>) -> Result<notion::PageMarkdown, String> {
    notion_call(state.inner(), move |c| c.read_page(&page)).await
}

// ---- AI file creation ----

#[tauri::command]
fn get_groq_key(store: State<Store>) -> Option<String> {
    store.groq_api_key()
}

#[tauri::command]
fn groq_key_storage(store: State<Store>) -> store::KeyStorage {
    store.key_storage()
}

#[tauri::command]
fn set_groq_key(key: String, store: State<Store>) -> Result<store::KeyStorage, String> {
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

/// Creates `<dir>/<name>.md` without ever overwriting an existing file, and registers it.
fn write_new_markdown(dir: &std::path::Path, name: &str, content: &str, store: &Store) -> Result<TrackedFile, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stem = safe_stem(name);
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

/// Writes generated Markdown to the save folder as `<name>.md` (never overwriting) and registers it.
#[tauri::command(async)]
fn create_markdown_file(app: AppHandle, name: String, content: String, store: State<Store>) -> Result<TrackedFile, String> {
    let dir = save_dir(&app, &store)?;
    write_new_markdown(&dir, &name, &content, &store)
}

/// Same as `create_markdown_file`, but into a folder chosen for this one export.
#[tauri::command(async)]
fn create_markdown_file_in(dir: String, name: String, content: String, store: State<Store>) -> Result<TrackedFile, String> {
    let dir = std::path::PathBuf::from(dir);
    if !dir.is_absolute() {
        return Err("Choose a folder.".into());
    }
    write_new_markdown(&dir, &name, &content, &store)
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
fn open_voice(app: AppHandle) -> Result<(), String> {
    windows::open_voice(&app)
}

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
            app.manage(std::sync::Arc::new(notion::NotionState::new(std::sync::Arc::new(secrets::Keychain::notion()))));
            app.manage(voice::VoiceState::default());
            voice::recover(app.handle());
            app.manage(FileLocks::default());
            app.manage(vault::VaultState::default());
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
                    &item("tasks", "Open tasks…")?,
                    &item("voice", "Voice Intelligence…")?,
                    &item("settings", "Settings…")?,
                    &PredefinedMenuItem::separator(app)?,
                    &item("quit", "Quit")?,
                ],
            )?;
            let mut tray = TrayIconBuilder::with_id("main").menu(&menu).on_menu_event(|app, event| match event.id.as_ref() {
                "show" => windows::show_launcher(app, "list"),
                "settings" => windows::show_launcher(app, "settings"),
                "voice" => {
                    let _ = windows::open_voice(app);
                }
                "tasks" => {
                    let _ = windows::open_tasks(app);
                }
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
            open_voice,
            open_tasks_window,
            open_tasks,
            toggle_vault_task,
            open_note_by_path,
            open_external,
            open_wikilink,
            note_context,
            ask_scopes,
            ask_retrieve,
            open_vault_note,
            launcher_info,
            get_settings,
            set_settings,
            set_shortcut,
            list_folders,
            add_folder,
            remove_folder,
            list_discovered,
            get_groq_key,
            groq_key_storage,
            set_groq_key,
            notion_connected,
            notion_connect,
            notion_disconnect,
            notion_test,
            notion_search,
            notion_create_page,
            notion_read_page,
            notion_pull,
            notion_link,
            notion_refresh,
            notion_destination_fields,
            notion_search_databases,
            notion_schema,
            notion_template,
            notion_create_destination,
            notion_destination,
            notion_set_destination,
            notion_clear_destination,
            notion_preview_row,
            notion_create_row,
            notion_tasks,
            notion_task_set_status,
            notion_home,
            notion_set_home,
            notion_clear_home,
            notion_push_plan,
            notion_push,
            create_markdown_file,
            create_markdown_file_in,
            get_save_dir,
            set_save_dir,
            voice::voice_list_devices,
            voice::voice_start,
            voice::voice_pause,
            voice::voice_resume,
            voice::voice_stop,
            voice::voice_status,
            voice::voice_read_chunk,
            voice::voice_list_sessions,
            voice::voice_save_transcript,
            voice::voice_save_analysis,
            voice::voice_list_analyses,
            voice::voice_load_transcript,
            voice::voice_delete_audio,
            voice::voice_delete_session
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Keep running in the tray when the last window closes.
            RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
            RunEvent::Exit => {
                voice::shutdown(app);
                app.state::<Store>().flush();
            }
            _ => {}
        });
}

#[cfg(test)]
mod task_tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("mdc-tasks-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(d).unwrap()
    }

    #[test]
    fn gathers_open_tasks_across_vaults_and_loose_files_without_duplicates() {
        let vault = dir("vault");
        fs::create_dir_all(vault.join(".obsidian")).unwrap();
        fs::create_dir_all(vault.join("Meetings")).unwrap();
        fs::write(vault.join("Meetings/Sprint.md"), "- [ ] send notes 📅 2026-11-01\n- [x] done already\n- [ ] water plants 🔁 every week\n").unwrap();
        fs::write(vault.join("Inbox.md"), "- [ ] no date\n").unwrap();
        let loose_dir = dir("loose");
        let loose = loose_dir.join("todo.md");
        fs::write(&loose, "- [ ] standalone task\n").unwrap();

        let mut indexes = HashMap::new();
        // the same vault listed twice (a watched folder and a tracked note's vault) must not duplicate rows
        let roots = vec![(vault.clone(), true), (vault.clone(), true)];
        let view = collect_tasks(roots, vec![loose.clone()], &mut indexes);

        let mut titles: Vec<&str> = view.rows.iter().map(|r| r.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, vec!["no date", "send notes", "standalone task", "water plants"]);
        let sprint = view.rows.iter().find(|r| r.title == "send notes").unwrap();
        assert_eq!((sprint.due.as_deref(), sprint.note.as_str(), sprint.recurring), (Some("2026-11-01"), "Sprint", false));
        assert!(view.rows.iter().find(|r| r.title == "water plants").unwrap().recurring);
        assert_eq!(view.sources.len(), 2); // the vault is listed once per root entry given; callers dedupe roots
        assert!(!view.truncated);
    }

    #[test]
    fn a_task_listed_here_can_be_toggled_with_the_offset_and_text_it_came_with() {
        let vault = dir("toggle");
        fs::create_dir_all(vault.join(".obsidian")).unwrap();
        let note = vault.join("n.md");
        fs::write(&note, "# T\n- [ ] first\n- [ ] second\n").unwrap();
        let mut indexes = HashMap::new();
        let view = collect_tasks(vec![(vault.clone(), true)], vec![], &mut indexes);
        let t = view.rows.iter().find(|r| r.title == "second").unwrap();
        let locks = FileLocks::default();
        locks.toggle_task_verified(&note, t.offset, &t.raw, true).unwrap();
        assert_eq!(fs::read_to_string(&note).unwrap(), "# T\n- [ ] first\n- [x] second\n");
        // after the next refresh the completed task is no longer listed
        let again = collect_tasks(vec![(vault, true)], vec![], &mut indexes);
        assert_eq!(again.rows.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), vec!["first"]);
    }
}
