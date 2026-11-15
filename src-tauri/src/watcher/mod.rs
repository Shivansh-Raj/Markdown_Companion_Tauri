//! Native file watching with debounce, content-hash filtering and self-write suppression.
//!
//! The *parent directory* of each tracked file is watched, because many editors save by
//! writing a temp file and renaming it over the original, which breaks per-file watches.
//! No polling is used. Events are collapsed by a debounce window, then the file is re-read
//! and compared with the last version this app knows about (loaded or written by itself).

use crate::filesystem::hash_bytes;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const DEBOUNCE: Duration = Duration::from_millis(150);
/// Upper bound so a constantly-written file still refreshes periodically.
const MAX_DEBOUNCE: Duration = Duration::from_secs(1);

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SyncEvent {
    Changed { content: String, hash: String },
    Missing,
    Unreadable { message: String },
}

#[derive(Clone, PartialEq, Debug)]
enum Status {
    Ok,
    Missing,
    Unreadable(String),
}

struct Entry {
    hash: Option<String>,
    status: Status,
}

/// What this app last saw for each path. Decides whether a filesystem event is news.
#[derive(Default)]
pub struct SyncState {
    entries: Mutex<HashMap<PathBuf, Entry>>,
}

impl SyncState {
    /// Records a version the UI already has (initial load, reload, or our own write).
    pub fn note_snapshot(&self, path: &Path, hash: &str) {
        self.entries
            .lock()
            .unwrap()
            .insert(path.to_path_buf(), Entry { hash: Some(hash.into()), status: Status::Ok });
    }

    /// Re-reads `path` and returns an event only if the UI needs to know something new.
    pub fn check(&self, path: &Path) -> Option<SyncEvent> {
        let read = std::fs::read(path);
        let mut map = self.entries.lock().unwrap();
        let entry = map.entry(path.to_path_buf()).or_insert(Entry { hash: None, status: Status::Ok });

        let set_error = |entry: &mut Entry, status: Status, event: SyncEvent| {
            if entry.status == status {
                None
            } else {
                entry.status = status;
                Some(event)
            }
        };

        match read {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                set_error(entry, Status::Missing, SyncEvent::Missing)
            }
            Err(e) => {
                let message = format!("Cannot read file: {e}");
                set_error(entry, Status::Unreadable(message.clone()), SyncEvent::Unreadable { message })
            }
            Ok(bytes) => {
                let hash = hash_bytes(&bytes);
                match String::from_utf8(bytes) {
                    Err(_) => {
                        let message = "File is not valid UTF-8".to_string();
                        set_error(entry, Status::Unreadable(message.clone()), SyncEvent::Unreadable { message })
                    }
                    Ok(content) => {
                        if entry.status == Status::Ok && entry.hash.as_deref() == Some(hash.as_str()) {
                            None // unchanged content, or an event caused by our own write
                        } else {
                            entry.status = Status::Ok;
                            entry.hash = Some(hash.clone());
                            Some(SyncEvent::Changed { content, hash })
                        }
                    }
                }
            }
        }
    }
}

pub type Emit = Arc<dyn Fn(&str, SyncEvent) + Send + Sync>;

struct Inner {
    watcher: RecommendedWatcher,
    ids: HashMap<String, PathBuf>,
    dirs: HashMap<PathBuf, usize>,
}

pub struct WatchService {
    pub state: Arc<SyncState>,
    files: Arc<Mutex<HashMap<PathBuf, Vec<String>>>>,
    inner: Mutex<Inner>,
}

impl WatchService {
    /// `emit(tracker_id, event)` is called from a background thread.
    pub fn new(emit: Emit) -> notify::Result<Self> {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, EventKind::Access(_)) {
                    return;
                }
                for p in ev.paths {
                    let _ = tx.send(p);
                }
            }
        })?;

        let state = Arc::new(SyncState::default());
        let files: Arc<Mutex<HashMap<PathBuf, Vec<String>>>> = Arc::default();

        let (t_state, t_files) = (state.clone(), files.clone());
        std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut pending = HashSet::from([first]);
                let start = Instant::now();
                while let Some(left) = MAX_DEBOUNCE.checked_sub(start.elapsed()) {
                    match rx.recv_timeout(DEBOUNCE.min(left)) {
                        Ok(p) => {
                            pending.insert(p);
                        }
                        Err(_) => break,
                    }
                }
                for path in pending {
                    let ids = t_files.lock().unwrap().get(&path).cloned();
                    let Some(ids) = ids else { continue };
                    if let Some(event) = t_state.check(&path) {
                        for id in &ids {
                            emit(id, event.clone());
                        }
                    }
                }
            }
        });

        Ok(Self {
            state,
            files,
            inner: Mutex::new(Inner { watcher, ids: HashMap::new(), dirs: HashMap::new() }),
        })
    }

    /// Starts watching `path` on behalf of tracker `id`. The registration is kept even if
    /// the OS watch fails, so `rewatch` can recover later.
    pub fn watch(&self, path: &Path, id: &str) -> Result<(), String> {
        let mut inner = self.inner.lock().unwrap();
        self.remove_locked(&mut inner, id);
        let dir = path.parent().ok_or("File has no parent folder")?.to_path_buf();

        self.files.lock().unwrap().entry(path.to_path_buf()).or_default().push(id.to_string());
        inner.ids.insert(id.to_string(), path.to_path_buf());
        let count = inner.dirs.entry(dir.clone()).or_insert(0);
        *count += 1;
        if *count == 1 {
            inner.watcher.watch(&dir, RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Re-establishes the OS watch on the parent folder (e.g. after it was deleted and recreated).
    pub fn rewatch(&self, path: &Path) -> Result<(), String> {
        let dir = path.parent().ok_or("File has no parent folder")?;
        let mut inner = self.inner.lock().unwrap();
        let _ = inner.watcher.unwatch(dir);
        inner.watcher.watch(dir, RecursiveMode::NonRecursive).map_err(|e| e.to_string())
    }

    pub fn unwatch(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        self.remove_locked(&mut inner, id);
    }

    fn remove_locked(&self, inner: &mut Inner, id: &str) {
        let Some(path) = inner.ids.remove(id) else { return };
        let mut files = self.files.lock().unwrap();
        if let Some(ids) = files.get_mut(&path) {
            ids.retain(|i| i != id);
            if ids.is_empty() {
                files.remove(&path);
            }
        }
        if let Some((dir, count)) = path.parent().and_then(|d| inner.dirs.get_mut(d).map(|c| (d, c))) {
            *count -= 1;
            if *count == 0 {
                inner.dirs.remove(dir);
                let _ = inner.watcher.unwatch(dir);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filesystem::{read_snapshot, FileLocks};

    fn canonical_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mdc-watch-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::canonicalize(d).unwrap()
    }

    fn service() -> (WatchService, mpsc::Receiver<(String, SyncEvent)>) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let emit: Emit = Arc::new(move |id, ev| {
            let _ = tx.lock().unwrap().send((id.to_string(), ev));
        });
        (WatchService::new(emit).unwrap(), rx)
    }

    const WAIT: Duration = Duration::from_secs(5);
    const QUIET: Duration = Duration::from_millis(900);

    // ---- SyncState (no OS watcher involved) ----

    #[test]
    fn unchanged_content_and_known_versions_are_ignored() {
        let p = canonical_dir("state").join("a.md");
        std::fs::write(&p, "- [ ] a\n").unwrap();
        let state = SyncState::default();
        state.note_snapshot(&p, &read_snapshot(&p).unwrap().hash);
        assert_eq!(state.check(&p), None);
        std::fs::write(&p, "- [x] a\n").unwrap();
        assert!(matches!(state.check(&p), Some(SyncEvent::Changed { content, .. }) if content == "- [x] a\n"));
        assert_eq!(state.check(&p), None, "same version is reported once");
    }

    #[test]
    fn missing_is_reported_once_and_recovery_is_reported() {
        let p = canonical_dir("missing").join("a.md");
        std::fs::write(&p, "x").unwrap();
        let state = SyncState::default();
        state.note_snapshot(&p, &read_snapshot(&p).unwrap().hash);
        std::fs::remove_file(&p).unwrap();
        assert_eq!(state.check(&p), Some(SyncEvent::Missing));
        assert_eq!(state.check(&p), None);
        std::fs::write(&p, "x").unwrap(); // same bytes as before deletion
        assert!(matches!(state.check(&p), Some(SyncEvent::Changed { .. })), "recovery must clear the error state");
    }

    #[test]
    fn invalid_utf8_is_unreadable_not_a_crash() {
        let p = canonical_dir("utf8").join("a.md");
        std::fs::write(&p, [0xff, 0xfe, 0x00]).unwrap();
        assert!(matches!(SyncState::default().check(&p), Some(SyncEvent::Unreadable { .. })));
    }

    // ---- End-to-end with the real OS watcher ----

    #[test]
    fn external_edit_refreshes_only_the_matching_tracker() {
        let dir = canonical_dir("e2e");
        let (a, b) = (dir.join("a.md"), dir.join("b.md"));
        std::fs::write(&a, "a1").unwrap();
        std::fs::write(&b, "b1").unwrap();
        let (svc, rx) = service();
        for (p, id) in [(&a, "tracker-a"), (&b, "tracker-b")] {
            svc.watch(p, id).unwrap();
            svc.state.note_snapshot(p, &read_snapshot(p).unwrap().hash);
        }
        std::thread::sleep(Duration::from_millis(300)); // let the OS watch settle
        std::fs::write(&b, "b2").unwrap();
        let (id, ev) = rx.recv_timeout(WAIT).expect("event for b");
        assert_eq!(id, "tracker-b");
        assert!(matches!(ev, SyncEvent::Changed { content, .. } if content == "b2"));
        assert!(rx.recv_timeout(QUIET).is_err(), "tracker-a must not be notified");
    }

    #[test]
    fn rapid_writes_are_debounced_into_one_refresh() {
        let dir = canonical_dir("debounce");
        let p = dir.join("a.md");
        std::fs::write(&p, "v0").unwrap();
        let (svc, rx) = service();
        svc.watch(&p, "tracker-a").unwrap();
        svc.state.note_snapshot(&p, &read_snapshot(&p).unwrap().hash);
        std::thread::sleep(Duration::from_millis(300));
        for i in 1..=5 {
            std::fs::write(&p, format!("v{i}")).unwrap();
        }
        let (_, ev) = rx.recv_timeout(WAIT).expect("one refresh");
        assert!(matches!(ev, SyncEvent::Changed { content, .. } if content == "v5"));
        assert!(rx.recv_timeout(QUIET).is_err(), "no second refresh");
    }

    #[test]
    fn own_writes_do_not_trigger_a_refresh() {
        let dir = canonical_dir("self");
        let p = dir.join("a.md");
        std::fs::write(&p, "- [ ] a\n").unwrap();
        let (svc, rx) = service();
        svc.watch(&p, "tracker-a").unwrap();
        let snap = read_snapshot(&p).unwrap();
        svc.state.note_snapshot(&p, &snap.hash);
        std::thread::sleep(Duration::from_millis(300));

        let saved = FileLocks::default().toggle_task(&p, &snap.hash, 2, true).unwrap();
        svc.state.note_snapshot(&p, &saved.hash);
        assert!(rx.recv_timeout(QUIET).is_err(), "self-write must be suppressed");

        // ...but a later external change is still seen.
        std::fs::write(&p, "- [ ] external\n").unwrap();
        assert!(rx.recv_timeout(WAIT).is_ok());
    }

    #[test]
    fn atomic_replace_saves_are_detected() {
        let dir = canonical_dir("atomic");
        let p = dir.join("a.md");
        std::fs::write(&p, "old").unwrap();
        let (svc, rx) = service();
        svc.watch(&p, "tracker-a").unwrap();
        svc.state.note_snapshot(&p, &read_snapshot(&p).unwrap().hash);
        std::thread::sleep(Duration::from_millis(300));
        let tmp = dir.join("a.md.swp");
        std::fs::write(&tmp, "new").unwrap();
        std::fs::rename(&tmp, &p).unwrap(); // how many editors save
        let (_, ev) = rx.recv_timeout(WAIT).expect("replace detected");
        assert!(matches!(ev, SyncEvent::Changed { content, .. } if content == "new"));
    }

    #[test]
    fn deletion_then_recreation_is_reported_and_never_recreated_by_us() {
        let dir = canonical_dir("delete");
        let p = dir.join("a.md");
        std::fs::write(&p, "x").unwrap();
        let (svc, rx) = service();
        svc.watch(&p, "tracker-a").unwrap();
        svc.state.note_snapshot(&p, &read_snapshot(&p).unwrap().hash);
        std::thread::sleep(Duration::from_millis(300));
        std::fs::remove_file(&p).unwrap();
        let (_, ev) = rx.recv_timeout(WAIT).expect("missing");
        assert_eq!(ev, SyncEvent::Missing);
        assert!(!p.exists(), "the app must not recreate a deleted file");
        // Toggling a missing file fails without recreating it.
        assert!(FileLocks::default().toggle_task(&p, "h", 0, true).is_err());
        assert!(!p.exists());
        std::fs::write(&p, "x").unwrap();
        let (_, ev) = rx.recv_timeout(WAIT).expect("recovered");
        assert!(matches!(ev, SyncEvent::Changed { .. }));
    }

    #[test]
    fn unwatch_stops_events() {
        let dir = canonical_dir("unwatch");
        let p = dir.join("a.md");
        std::fs::write(&p, "x").unwrap();
        let (svc, rx) = service();
        svc.watch(&p, "tracker-a").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        svc.unwatch("tracker-a");
        std::fs::write(&p, "y").unwrap();
        assert!(rx.recv_timeout(QUIET).is_err());
    }
}
