//! Metadata store: registered files, folders, window state and settings.
//! Markdown content is never stored here; files remain the source of truth.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const DEFAULT_SHORTCUT: &str = "CommandOrControl+Shift+Space";
pub const THEMES: [&str; 2] = ["retro-red", "pixel-dark"];
/// Window move/resize events fire continuously; geometry is written to disk after this quiet period.
const SAVE_DELAY: Duration = Duration::from_millis(500);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TrackedFile {
    pub id: String,
    pub canonical_path: String,
    pub display_name: String,
    pub registered_at: u64,
    pub last_opened_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(default)]
pub struct Settings {
    pub shortcut: String,
    pub theme: String,
    /// Reopen the trackers that were open when the app last quit.
    pub reopen_on_launch: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { shortcut: DEFAULT_SHORTCUT.into(), theme: THEMES[0].into(), reopen_on_launch: false }
    }
}

/// Size is logical (DPI independent); position is physical screen pixels.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    pub x: Option<i32>,
    pub y: Option<i32>,
    #[serde(default)]
    pub open: bool,
}

#[derive(Serialize, Deserialize, Default, Clone, Debug)]
#[serde(default)]
pub struct Data {
    pub files: Vec<TrackedFile>,
    pub settings: Settings,
    pub folders: Vec<String>,
    /// Groq API key for AI file creation (stored locally in the app data file).
    pub groq_api_key: Option<String>,
    /// Folder for AI-created files; `None` means Documents/MarkdownCompanion.
    pub ai_save_dir: Option<String>,
    pub window_state: HashMap<String, WindowState>,
    next_id: u64,
}

struct Inner {
    path: PathBuf,
    data: Mutex<Data>,
    write_lock: Mutex<()>,
    save_pending: AtomicBool,
}

impl Inner {
    fn write(&self, data: &Data) -> Result<(), String> {
        let _guard = self.write_lock.lock().unwrap();
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }
}

/// Cheap to clone; all clones share the same state.
#[derive(Clone)]
pub struct Store(Arc<Inner>);

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Store {
    pub fn load(path: PathBuf) -> Self {
        let data = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self(Arc::new(Inner {
            path,
            data: Mutex::new(data),
            write_lock: Mutex::new(()),
            save_pending: AtomicBool::new(false),
        }))
    }

    /// Applies `f` and persists immediately.
    fn update<R>(&self, f: impl FnOnce(&mut Data) -> R) -> Result<R, String> {
        let mut data = self.0.data.lock().unwrap();
        let out = f(&mut data);
        self.0.write(&data)?;
        Ok(out)
    }

    /// Persists soon, coalescing bursts of calls into one write.
    pub fn schedule_save(&self) {
        if self.0.save_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let inner = self.0.clone();
        std::thread::spawn(move || {
            std::thread::sleep(SAVE_DELAY);
            inner.save_pending.store(false, Ordering::SeqCst);
            let data = inner.data.lock().unwrap().clone();
            let _ = inner.write(&data);
        });
    }

    pub fn flush(&self) {
        let data = self.0.data.lock().unwrap().clone();
        let _ = self.0.write(&data);
    }

    // ---- files ----

    pub fn files(&self) -> Vec<TrackedFile> {
        self.0.data.lock().unwrap().files.clone()
    }

    pub fn get(&self, id: &str) -> Option<TrackedFile> {
        self.0.data.lock().unwrap().files.iter().find(|f| f.id == id).cloned()
    }

    /// Registers a file by canonical path; returns the existing entry if already registered.
    pub fn register(&self, raw: &str) -> Result<TrackedFile, String> {
        let canonical = validate_markdown_path(Path::new(raw))?;
        let canonical_str = canonical.to_string_lossy().to_string();
        self.update(|data| {
            if let Some(f) = data.files.iter().find(|f| f.canonical_path == canonical_str) {
                return f.clone();
            }
            data.next_id += 1;
            let file = TrackedFile {
                id: format!("tracker-{:03}", data.next_id),
                display_name: canonical
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| canonical_str.clone()),
                canonical_path: canonical_str,
                registered_at: now(),
                last_opened_at: None,
            };
            data.files.push(file.clone());
            file
        })
    }

    /// Removes a file from the registry. The Markdown file itself is never touched.
    pub fn remove_file(&self, id: &str) -> Result<(), String> {
        self.update(|data| {
            data.files.retain(|f| f.id != id);
            data.window_state.remove(id);
        })
    }

    pub fn touch_opened(&self, id: &str) {
        let _ = self.update(|data| {
            if let Some(f) = data.files.iter_mut().find(|f| f.id == id) {
                f.last_opened_at = Some(now());
            }
        });
    }

    // ---- window state ----

    pub fn window_state(&self, id: &str) -> Option<WindowState> {
        self.0.data.lock().unwrap().window_state.get(id).cloned()
    }

    /// Records size/position (debounced write). Ignored for unregistered trackers.
    pub fn set_geometry(&self, id: &str, width: f64, height: f64, x: i32, y: i32) {
        {
            let mut data = self.0.data.lock().unwrap();
            if !data.files.iter().any(|f| f.id == id) {
                return;
            }
            let entry = data
                .window_state
                .entry(id.to_string())
                .or_insert(WindowState { width, height, x: None, y: None, open: false });
            entry.width = width;
            entry.height = height;
            entry.x = Some(x);
            entry.y = Some(y);
        }
        self.schedule_save();
    }

    pub fn set_open(&self, id: &str, open: bool) {
        let _ = self.update(|data| {
            if !data.files.iter().any(|f| f.id == id) {
                return;
            }
            data.window_state
                .entry(id.to_string())
                .or_insert(WindowState { width: 360.0, height: 480.0, x: None, y: None, open })
                .open = open;
        });
    }

    pub fn open_ids(&self) -> Vec<String> {
        let data = self.0.data.lock().unwrap();
        data.files
            .iter()
            .filter(|f| data.window_state.get(&f.id).is_some_and(|w| w.open))
            .map(|f| f.id.clone())
            .collect()
    }

    pub fn clear_open(&self) {
        let _ = self.update(|data| data.window_state.values_mut().for_each(|w| w.open = false));
    }

    // ---- AI ----

    pub fn groq_api_key(&self) -> Option<String> {
        self.0.data.lock().unwrap().groq_api_key.clone()
    }

    pub fn set_groq_api_key(&self, key: &str) -> Result<(), String> {
        let key = key.trim();
        self.update(|data| data.groq_api_key = if key.is_empty() { None } else { Some(key.to_string()) })
    }

    pub fn ai_save_dir(&self) -> Option<String> {
        self.0.data.lock().unwrap().ai_save_dir.clone()
    }

    /// `None` restores the default folder. The folder must already exist.
    pub fn set_ai_save_dir(&self, dir: Option<&str>) -> Result<(), String> {
        let value = match dir {
            Some(d) => {
                let canon = std::fs::canonicalize(d).map_err(|_| "That folder does not exist".to_string())?;
                if !canon.is_dir() {
                    return Err("That path is not a folder".into());
                }
                Some(canon.to_string_lossy().to_string())
            }
            None => None,
        };
        self.update(|data| data.ai_save_dir = value)
    }

    // ---- settings ----

    pub fn settings(&self) -> Settings {
        self.0.data.lock().unwrap().settings.clone()
    }

    pub fn shortcut(&self) -> String {
        self.settings().shortcut
    }

    pub fn update_settings(&self, theme: &str, reopen_on_launch: bool) -> Result<Settings, String> {
        if !THEMES.contains(&theme) {
            return Err(format!("Unknown theme: {theme}"));
        }
        self.update(|data| {
            data.settings.theme = theme.to_string();
            data.settings.reopen_on_launch = reopen_on_launch;
            data.settings.clone()
        })
    }

    pub fn set_shortcut(&self, accelerator: &str) -> Result<(), String> {
        self.update(|data| data.settings.shortcut = accelerator.to_string())
    }

    // ---- folders (opt-in discovery) ----

    pub fn folders(&self) -> Vec<String> {
        self.0.data.lock().unwrap().folders.clone()
    }

    pub fn add_folder(&self, raw: &str) -> Result<String, String> {
        let canonical = std::fs::canonicalize(raw).map_err(|e| format!("Cannot access folder: {e}"))?;
        if !canonical.is_dir() {
            return Err("Not a folder".into());
        }
        if canonical.parent().is_none() {
            return Err("Choose a specific folder, not a whole drive".into());
        }
        let s = canonical.to_string_lossy().to_string();
        self.update(|data| {
            if !data.folders.contains(&s) {
                data.folders.push(s.clone());
            }
        })?;
        Ok(s)
    }

    pub fn remove_folder(&self, path: &str) -> Result<(), String> {
        self.update(|data| data.folders.retain(|f| f != path))
    }
}

/// Only existing regular Markdown files are accepted; symlinks are resolved.
pub fn validate_markdown_path(path: &Path) -> Result<PathBuf, String> {
    let canonical = std::fs::canonicalize(path).map_err(|e| format!("Cannot access file: {e}"))?;
    if !canonical.is_file() {
        return Err("Not a file".into());
    }
    match canonical.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("md") | Some("markdown") => Ok(canonical),
        _ => Err("Only .md files can be registered".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mdc-test-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn registered(name: &str) -> (Store, PathBuf, TrackedFile) {
        let dir = temp_dir(name);
        let md = dir.join("a.md");
        std::fs::write(&md, "# hi").unwrap();
        let store = Store::load(dir.join("store.json"));
        let file = store.register(md.to_str().unwrap()).unwrap();
        (store, dir, file)
    }

    #[test]
    fn register_is_idempotent_and_persists() {
        let (store, dir, a) = registered("reg");
        let b = store.register(dir.join("a.md").to_str().unwrap()).unwrap();
        assert_eq!(a.id, b.id);
        assert_eq!(store.files().len(), 1);
        let reloaded = Store::load(dir.join("store.json"));
        assert_eq!(reloaded.get(&a.id).unwrap().display_name, "a.md");
    }

    #[test]
    fn rejects_non_markdown_and_missing() {
        let dir = temp_dir("rej");
        let txt = dir.join("a.txt");
        std::fs::write(&txt, "x").unwrap();
        assert!(validate_markdown_path(&txt).is_err());
        assert!(validate_markdown_path(&dir.join("missing.md")).is_err());
    }

    #[test]
    fn everything_survives_a_restart() {
        let (store, dir, file) = registered("restart");
        store.update_settings("pixel-dark", true).unwrap();
        store.set_shortcut("Alt+Shift+K").unwrap();
        let folder = store.add_folder(dir.to_str().unwrap()).unwrap();
        store.set_open(&file.id, true);
        store.set_geometry(&file.id, 400.0, 500.0, 120, 90);
        store.flush();

        let again = Store::load(dir.join("store.json"));
        assert_eq!(again.settings(), Settings { shortcut: "Alt+Shift+K".into(), theme: "pixel-dark".into(), reopen_on_launch: true });
        assert_eq!(again.folders(), vec![folder]);
        assert_eq!(
            again.window_state(&file.id),
            Some(WindowState { width: 400.0, height: 500.0, x: Some(120), y: Some(90), open: true })
        );
        assert_eq!(again.open_ids(), vec![file.id.clone()]);
        again.clear_open();
        assert!(again.open_ids().is_empty());
    }

    #[test]
    fn geometry_writes_are_debounced_to_disk() {
        let (store, dir, file) = registered("debounce");
        for i in 0..50 {
            store.set_geometry(&file.id, 300.0 + i as f64, 400.0, i, i);
        }
        std::thread::sleep(SAVE_DELAY + Duration::from_millis(500));
        let again = Store::load(dir.join("store.json"));
        assert_eq!(again.window_state(&file.id).unwrap().width, 349.0);
    }

    #[test]
    fn old_store_files_without_new_fields_still_load() {
        let dir = temp_dir("compat");
        let json = r#"{"files":[{"id":"tracker-001","canonical_path":"/x/a.md","display_name":"a.md","registered_at":1,"last_opened_at":null}],"settings":{"shortcut":"Alt+Space"},"next_id":1}"#;
        std::fs::write(dir.join("store.json"), json).unwrap();
        let store = Store::load(dir.join("store.json"));
        assert_eq!(store.files().len(), 1);
        assert_eq!(store.settings().shortcut, "Alt+Space");
        assert_eq!(store.settings().theme, "retro-red");
        assert!(store.folders().is_empty());
    }

    #[test]
    fn invalid_theme_and_unknown_trackers_are_rejected() {
        let (store, _dir, _f) = registered("invalid");
        assert!(store.update_settings("neon", false).is_err());
        store.set_geometry("tracker-999", 1.0, 1.0, 0, 0);
        assert!(store.window_state("tracker-999").is_none());
        store.set_open("tracker-999", true);
        assert!(store.open_ids().is_empty());
    }

    #[test]
    fn removing_a_file_clears_its_state_but_not_the_file() {
        let (store, dir, file) = registered("remove");
        store.set_geometry(&file.id, 300.0, 300.0, 1, 1);
        store.remove_file(&file.id).unwrap();
        assert!(store.get(&file.id).is_none());
        assert!(store.window_state(&file.id).is_none());
        assert!(dir.join("a.md").exists());
    }

    #[test]
    fn folders_are_validated_and_deduplicated() {
        let (store, dir, _f) = registered("folders");
        let a = store.add_folder(dir.to_str().unwrap()).unwrap();
        let b = store.add_folder(dir.to_str().unwrap()).unwrap();
        assert_eq!(a, b);
        assert_eq!(store.folders().len(), 1);
        assert!(store.add_folder(dir.join("a.md").to_str().unwrap()).is_err());
        assert!(store.add_folder(dir.join("nope").to_str().unwrap()).is_err());
        assert!(store.add_folder("/").is_err());
        store.remove_folder(&a).unwrap();
        assert!(store.folders().is_empty());
    }
}
