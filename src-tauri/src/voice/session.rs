//! On-disk voice sessions: `<app data>/voice/<id>/{session.json, audio.wav, chunks/NNNN.wav}`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    /// "meeting" | "practice" | "note"
    pub mode: String,
    pub created_at_ms: u64,
    /// Active recording time only (paused time excluded).
    pub duration_ms: u64,
    /// "recording" | "paused" | "stopped" | "interrupted"
    pub status: String,
    pub device: String,
    pub chunks: u32,
}

pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn session_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_valid_id(id) {
        return Err("Invalid session id".into());
    }
    Ok(root.join(id))
}

pub fn write_meta(dir: &Path, meta: &SessionMeta) -> Result<(), String> {
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    let tmp = dir.join("session.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("session.json")).map_err(|e| e.to_string())
}

pub fn read_meta(dir: &Path) -> Option<SessionMeta> {
    serde_json::from_str(&std::fs::read_to_string(dir.join("session.json")).ok()?).ok()
}

/// Newest first.
pub fn list(root: &Path) -> Vec<SessionMeta> {
    let mut all: Vec<SessionMeta> = std::fs::read_dir(root)
        .map(|rd| rd.filter_map(|e| e.ok()).filter_map(|e| read_meta(&e.path())).collect())
        .unwrap_or_default();
    all.sort_by_key(|m| std::cmp::Reverse(m.created_at_ms));
    all
}

/// After a crash: repair the audio header of sessions left "recording"/"paused" and mark them interrupted.
pub fn recover_interrupted(root: &Path) -> Vec<String> {
    let mut fixed = vec![];
    let Ok(rd) = std::fs::read_dir(root) else { return fixed };
    for entry in rd.filter_map(|e| e.ok()) {
        let dir = entry.path();
        let Some(mut meta) = read_meta(&dir) else { continue };
        if meta.status != "recording" && meta.status != "paused" {
            continue;
        }
        let wav = dir.join("audio.wav");
        if let (true, Ok(ms)) = (wav.exists(), super::wav::repair(&wav)) {
            meta.duration_ms = ms;
        }
        meta.chunks = std::fs::read_dir(dir.join("chunks")).map(|r| r.count() as u32).unwrap_or(meta.chunks);
        meta.status = "interrupted".into();
        if write_meta(&dir, &meta).is_ok() {
            fixed.push(meta.id);
        }
    }
    fixed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("mdc-voice-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn meta(id: &str, status: &str) -> SessionMeta {
        SessionMeta {
            id: id.into(), title: "t".into(), mode: "meeting".into(), created_at_ms: 1,
            duration_ms: 0, status: status.into(), device: "mic".into(), chunks: 0,
        }
    }

    #[test]
    fn rejects_path_tricks_in_ids() {
        assert!(is_valid_id("1731000000000"));
        assert!(!is_valid_id("../etc"));
        assert!(!is_valid_id(""));
        assert!(session_dir(Path::new("/x"), "a/b").is_err());
    }

    #[test]
    fn recovery_marks_interrupted_and_repairs_audio() {
        let root = tmp("recover");
        let dir = root.join("abc");
        std::fs::create_dir_all(&dir).unwrap();
        let mut w = super::super::wav::WavWriter::create(&dir.join("audio.wav")).unwrap();
        w.write(&vec![1i16; 32_000]).unwrap();
        drop(w);
        write_meta(&dir, &meta("abc", "recording")).unwrap();
        write_meta(&root.join("abc"), &meta("abc", "recording")).unwrap();
        let fixed = recover_interrupted(&root);
        assert_eq!(fixed, vec!["abc".to_string()]);
        let m = read_meta(&dir).unwrap();
        assert_eq!(m.status, "interrupted");
        assert_eq!(m.duration_ms, 2000);
        assert!(recover_interrupted(&root).is_empty()); // idempotent
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn stopped_sessions_are_left_alone_and_list_is_newest_first() {
        let root = tmp("list");
        for (id, t) in [("a", 1u64), ("b", 5)] {
            let d = root.join(id);
            std::fs::create_dir_all(&d).unwrap();
            let mut m = meta(id, "stopped");
            m.created_at_ms = t;
            write_meta(&d, &m).unwrap();
        }
        assert!(recover_interrupted(&root).is_empty());
        let ids: Vec<_> = list(&root).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["b", "a"]);
        std::fs::remove_dir_all(root).ok();
    }
}
