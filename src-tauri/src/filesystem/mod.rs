//! Safe reading and minimal-edit writing of Markdown files.
//!
//! Task toggles replace exactly the 3-byte `[ ]` / `[x]` marker at a verified
//! offset. They are applied only when the file's content hash still matches the
//! version the caller derived the offset from.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct FileSnapshot {
    pub content: String,
    pub hash: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToggleError {
    /// The file changed since the caller read it; nothing was written.
    Stale { content: String, hash: String },
    Failed { message: String },
}

fn failed(message: impl Into<String>) -> ToggleError {
    ToggleError::Failed { message: message.into() }
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn snapshot_from_bytes(bytes: Vec<u8>) -> Result<FileSnapshot, String> {
    let hash = hash_bytes(&bytes);
    let content = String::from_utf8(bytes).map_err(|_| "File is not valid UTF-8".to_string())?;
    Ok(FileSnapshot { content, hash })
}

pub fn read_snapshot(path: &Path) -> Result<FileSnapshot, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read file: {e}"))?;
    snapshot_from_bytes(bytes)
}

/// Pure edit: swaps the marker at `offset` (byte offset) to the requested state.
pub fn apply_toggle(content: &str, offset: usize, checked: bool) -> Result<String, String> {
    let end = offset.checked_add(3).ok_or("Invalid task position")?;
    let found = content.get(offset..end).ok_or("Task position is out of range")?;
    let matches = if checked { found == "[ ]" } else { found == "[x]" || found == "[X]" };
    if !matches {
        return Err("Task marker not found at the expected position".into());
    }
    let mut out = String::with_capacity(content.len());
    out.push_str(&content[..offset]);
    out.push_str(if checked { "[x]" } else { "[ ]" });
    out.push_str(&content[end..]);
    Ok(out)
}

/// One lock per file path so writes to the same file are serialized.
#[derive(Default)]
pub struct FileLocks(Mutex<HashMap<String, Arc<Mutex<()>>>>);

impl FileLocks {
    fn lock_for(&self, path: &Path) -> Arc<Mutex<()>> {
        let mut map = self.0.lock().unwrap();
        map.entry(path.to_string_lossy().to_string()).or_default().clone()
    }

    pub fn toggle_task(
        &self,
        path: &Path,
        expected_hash: &str,
        offset: usize,
        checked: bool,
    ) -> Result<FileSnapshot, ToggleError> {
        let lock = self.lock_for(path);
        let _guard = lock.lock().unwrap();

        let meta = std::fs::metadata(path).map_err(|e| failed(format!("Cannot access file: {e}")))?;
        // A rename would succeed over a read-only file in a writable folder, so check explicitly.
        if meta.permissions().readonly() {
            return Err(failed("File is read-only"));
        }
        let bytes = std::fs::read(path).map_err(|e| failed(format!("Cannot read file: {e}")))?;
        let current = snapshot_from_bytes(bytes).map_err(failed)?;
        if current.hash != expected_hash {
            return Err(ToggleError::Stale { content: current.content, hash: current.hash });
        }

        let updated = apply_toggle(&current.content, offset, checked).map_err(failed)?;
        write_atomic(path, updated.as_bytes(), &meta).map_err(|e| failed(format!("Cannot save file: {e}")))?;
        Ok(FileSnapshot { hash: hash_bytes(updated.as_bytes()), content: updated })
    }
}

/// Writes to a temp file beside the target, then atomically renames over it.
fn write_atomic(path: &Path, bytes: &[u8], meta: &std::fs::Metadata) -> std::io::Result<()> {
    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = path.with_file_name(format!(".{name}.mdc-tmp"));
    let result = (|| {
        std::fs::write(&tmp, bytes)?;
        std::fs::set_permissions(&tmp, meta.permissions())?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("mdc-fs-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn setup(name: &str, content: &str) -> (PathBuf, FileSnapshot) {
        let p = dir(name).join("t.md");
        std::fs::write(&p, content).unwrap();
        let snap = read_snapshot(&p).unwrap();
        (p, snap)
    }

    const DOC: &str = "# T\n\n- [ ] one\n  - [x] nested\n- plain\n- [ ] two\n";

    fn offset_of(s: &str, needle: &str) -> usize {
        s.find(needle).unwrap()
    }

    #[test]
    fn checks_and_unchecks_only_the_marker() {
        let (p, snap) = setup("toggle", DOC);
        let locks = FileLocks::default();
        let off = offset_of(DOC, "[ ] one");
        let after = locks.toggle_task(&p, &snap.hash, off, true).unwrap();
        assert_eq!(after.content, DOC.replacen("[ ] one", "[x] one", 1));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), after.content);

        let off = offset_of(&after.content, "[x] nested");
        let back = locks.toggle_task(&p, &after.hash, off, false).unwrap();
        assert_eq!(back.content, after.content.replacen("[x] nested", "[ ] nested", 1));
    }

    #[test]
    fn preserves_crlf_and_unicode() {
        let doc = "# Ünï 日本\r\n\r\n- [ ] café ☕\r\n- [ ] b\r\n";
        let (p, snap) = setup("crlf", doc);
        let off = offset_of(doc, "[ ] b");
        let after = FileLocks::default().toggle_task(&p, &snap.hash, off, true).unwrap();
        assert_eq!(after.content, doc.replacen("[ ] b", "[x] b", 1));
        assert!(std::fs::read(&p).unwrap().windows(2).any(|w| w == b"\r\n"));
    }

    #[test]
    fn stale_hash_writes_nothing_and_returns_fresh_content() {
        let (p, snap) = setup("stale", DOC);
        let external = format!("intro\n{DOC}");
        std::fs::write(&p, &external).unwrap();
        let err = FileLocks::default().toggle_task(&p, &snap.hash, offset_of(DOC, "[ ] one"), true).unwrap_err();
        match err {
            ToggleError::Stale { content, .. } => assert_eq!(content, external),
            other => panic!("expected stale, got {other:?}"),
        }
        assert_eq!(std::fs::read_to_string(&p).unwrap(), external);
    }

    #[test]
    fn wrong_offset_or_state_is_rejected() {
        let (p, snap) = setup("badoff", DOC);
        let locks = FileLocks::default();
        // Offset points at plain text.
        assert!(matches!(locks.toggle_task(&p, &snap.hash, 0, true), Err(ToggleError::Failed { .. })));
        // Already unchecked, asking to uncheck.
        assert!(matches!(
            locks.toggle_task(&p, &snap.hash, offset_of(DOC, "[ ] one"), false),
            Err(ToggleError::Failed { .. })
        ));
        // Out of range / mid-character offsets never panic.
        assert!(locks.toggle_task(&p, &snap.hash, 10_000, true).is_err());
        assert!(apply_toggle("é[ ]", 1, true).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), DOC);
    }

    #[test]
    fn read_only_and_missing_files_fail_cleanly() {
        let (p, snap) = setup("ro", DOC);
        let mut perms = std::fs::metadata(&p).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&p, perms).unwrap();
        let locks = FileLocks::default();
        let err = locks.toggle_task(&p, &snap.hash, offset_of(DOC, "[ ] one"), true).unwrap_err();
        assert!(matches!(&err, ToggleError::Failed { message } if message.contains("read-only")));
        assert_eq!(std::fs::read_to_string(&p).unwrap(), DOC);

        let gone = dir("gone").join("missing.md");
        assert!(matches!(locks.toggle_task(&gone, "x", 0, true), Err(ToggleError::Failed { .. })));
    }

    #[test]
    fn concurrent_toggles_on_one_file_are_serialized() {
        let doc: String = (0..20).map(|i| format!("- [ ] t{i}\n")).collect();
        let (p, snap) = setup("conc", &doc);
        let locks = Arc::new(FileLocks::default());
        let handles: Vec<_> = (0..20)
            .map(|i| {
                let (locks, p, hash, doc) = (locks.clone(), p.clone(), snap.hash.clone(), doc.clone());
                std::thread::spawn(move || locks.toggle_task(&p, &hash, offset_of(&doc, &format!("[ ] t{i}\n")), true))
            })
            .collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        // Every call used the same stale-able hash: exactly one can win, the rest must see Stale.
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert!(results.iter().filter(|r| r.is_err()).all(|r| matches!(r, Err(ToggleError::Stale { .. }))));
        let final_text = std::fs::read_to_string(&p).unwrap();
        assert_eq!(final_text.matches("[x]").count(), 1);
    }
}
