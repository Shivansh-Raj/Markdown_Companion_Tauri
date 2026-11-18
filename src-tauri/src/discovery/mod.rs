//! Opt-in Markdown discovery inside user-chosen folders. Deliberately bounded so it can never
//! turn into a scan of the whole computer.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};

pub const MAX_DEPTH: usize = 3;
pub const MAX_FILES: usize = 500;
const SKIP_DIRS: [&str; 2] = ["node_modules", "target"];

fn is_markdown(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref(),
        Some("md") | Some("markdown")
    )
}

/// Breadth-first scan: at most `MAX_DEPTH` levels below `root` and `MAX_FILES` results.
/// Hidden entries, dependency folders and symlinks are skipped; symlinks are never followed.
pub fn scan_folder(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                if depth < MAX_DEPTH && !SKIP_DIRS.contains(&name.as_str()) {
                    queue.push_back((path, depth + 1));
                }
            } else if kind.is_file() && is_markdown(&path) {
                found.push(path);
                if found.len() >= MAX_FILES {
                    return found;
                }
            }
        }
    }
    found
}

// ---- Wikilink resolution ----

const LINK_MAX_DEPTH: usize = 10;
pub const LINK_MAX_ENTRIES: usize = 20_000;

/// The nearest ancestor of `file` that contains an `.obsidian` folder (an Obsidian vault root).
pub fn vault_root(file: &Path) -> Option<PathBuf> {
    file.ancestors().skip(1).find(|d| d.join(".obsidian").is_dir()).map(Path::to_path_buf)
}

/// Splits `Folder/Note#Heading|alias` into the lower-cased path part (no extension, no heading, no alias).
pub fn link_path(target: &str) -> String {
    let t = target.split('|').next().unwrap_or("");
    let t = t.split('#').next().unwrap_or("").trim().replace('\\', "/");
    let lower = t.to_lowercase();
    let t = lower.strip_suffix(".md").or_else(|| lower.strip_suffix(".markdown")).unwrap_or(&lower);
    t.trim_matches('/').to_string()
}

/// Bounded, symlink-free walk collecting Markdown files under `root`.
pub fn walk_markdown(root: &Path) -> Vec<PathBuf> {
    walk_markdown_limited(root).0
}

/// Like `walk_markdown`, also reporting whether the entry limit cut the walk short.
pub fn walk_markdown_limited(root: &Path) -> (Vec<PathBuf>, bool) {
    let mut out = Vec::new();
    let mut seen = 0usize;
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            seen += 1;
            if seen > LINK_MAX_ENTRIES {
                return (out, true);
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            let path = entry.path();
            if kind.is_dir() {
                if depth < LINK_MAX_DEPTH && !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push((path, depth + 1));
                }
            } else if kind.is_file() && is_markdown(&path) {
                out.push(path);
            }
        }
    }
    (out, false)
}

/// Resolves an Obsidian-style `[[wikilink]]` target to a Markdown file, or None.
///
/// Like Obsidian, a bare name matches by file name anywhere in the vault; a path matches by its tail.
/// Ties go to the file next to the linking note, then to the shallowest path. Nothing outside the search
/// roots (the vault root or the note's folder, plus watched folders) can ever be returned.
pub fn resolve_wikilink(from_file: &Path, watched: &[PathBuf], target: &str) -> Option<PathBuf> {
    let wanted = link_path(target);
    if wanted.is_empty() {
        return Some(from_file.to_path_buf()); // [[#Heading]]: the same note
    }
    if wanted.split('/').any(|c| c == ".." || c == "." || c.is_empty()) || wanted.contains(':') {
        return None;
    }
    let from_dir = from_file.parent()?;
    let mut roots: Vec<PathBuf> = vec![vault_root(from_file).unwrap_or_else(|| from_dir.to_path_buf())];
    for w in watched {
        if !roots.contains(w) {
            roots.push(w.clone());
        }
    }
    let tail = format!("/{wanted}");
    let mut best: Option<(u8, usize, PathBuf)> = None;
    for root in &roots {
        for path in walk_markdown(root) {
            let Ok(rel) = path.strip_prefix(root) else { continue };
            let rel_lower = format!("/{}", rel.with_extension("").to_string_lossy().replace('\\', "/").to_lowercase());
            if !rel_lower.ends_with(&tail) {
                continue;
            }
            let rank = (u8::from(path.parent() != Some(from_dir)), rel.components().count(), path.clone());
            if best.as_ref().is_none_or(|b| (rank.0, rank.1, &rank.2) < (b.0, b.1, &b.2)) {
                best = Some(rank);
            }
        }
    }
    best.map(|b| b.2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tree(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("mdc-disc-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::canonicalize(root).unwrap()
    }

    fn touch(p: PathBuf) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }

    fn names(root: &Path, found: &[PathBuf]) -> Vec<String> {
        let mut v: Vec<_> = found.iter().map(|p| p.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/")).collect();
        v.sort();
        v
    }

    #[test]
    fn finds_markdown_and_skips_everything_else() {
        let r = tree("basic");
        touch(r.join("a.md"));
        touch(r.join("B.MARKDOWN"));
        touch(r.join("notes.txt"));
        touch(r.join("sub/c.md"));
        touch(r.join(".hidden/d.md"));
        touch(r.join(".dot.md"));
        touch(r.join("node_modules/e.md"));
        touch(r.join("target/f.md"));
        assert_eq!(names(&r, &scan_folder(&r)), ["B.MARKDOWN", "a.md", "sub/c.md"]);
    }

    #[test]
    fn depth_is_bounded() {
        let r = tree("depth");
        touch(r.join("l1/l2/l3/ok.md")); // directory depth 3: included
        touch(r.join("l1/l2/l3/l4/too_deep.md")); // depth 4: excluded
        assert_eq!(names(&r, &scan_folder(&r)), ["l1/l2/l3/ok.md"]);
    }

    #[test]
    fn result_count_is_capped() {
        let r = tree("cap");
        for i in 0..(MAX_FILES + 50) {
            touch(r.join(format!("f{i:04}.md")));
        }
        assert_eq!(scan_folder(&r).len(), MAX_FILES);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_not_followed() {
        let r = tree("symlink");
        let outside = tree("symlink-outside");
        touch(outside.join("secret.md"));
        touch(r.join("real.md"));
        std::os::unix::fs::symlink(&outside, r.join("link")).unwrap();
        std::os::unix::fs::symlink(outside.join("secret.md"), r.join("linked.md")).unwrap();
        assert_eq!(names(&r, &scan_folder(&r)), ["real.md"]);
    }

    #[test]
    fn missing_folder_yields_nothing() {
        assert!(scan_folder(Path::new("/definitely/not/here")).is_empty());
    }

    #[test]
    fn wikilinks_resolve_by_name_across_the_vault() {
        let r = tree("links");
        fs::create_dir_all(r.join(".obsidian")).unwrap();
        touch(r.join("Daily/2026-11-19.md"));
        touch(r.join("Projects/Roadmap.md"));
        touch(r.join("Archive/old/Roadmap.md"));
        touch(r.join("Meetings/Sprint.md"));
        let from = r.join("Meetings/Sprint.md");
        assert_eq!(resolve_wikilink(&from, &[], "Roadmap"), Some(r.join("Projects/Roadmap.md"))); // shallowest wins
        assert_eq!(resolve_wikilink(&from, &[], "roadmap#Goals|the plan"), Some(r.join("Projects/Roadmap.md")));
        assert_eq!(resolve_wikilink(&from, &[], "old/Roadmap.md"), Some(r.join("Archive/old/Roadmap.md")));
        assert_eq!(resolve_wikilink(&from, &[], "Missing"), None);
        assert_eq!(resolve_wikilink(&from, &[], "#Heading"), Some(from.clone()));
    }

    #[test]
    fn a_note_next_to_the_link_wins_ties() {
        let r = tree("near");
        fs::create_dir_all(r.join(".obsidian")).unwrap();
        touch(r.join("a/Idea.md"));
        touch(r.join("b/deep/Idea.md"));
        touch(r.join("b/Here.md"));
        let from = r.join("b/Here.md");
        assert_eq!(resolve_wikilink(&from, &[], "Idea"), Some(r.join("a/Idea.md")));
        touch(r.join("b/Idea.md"));
        assert_eq!(resolve_wikilink(&from, &[], "Idea"), Some(r.join("b/Idea.md")));
    }

    #[test]
    fn wikilinks_cannot_escape_the_search_roots() {
        let r = tree("escape");
        touch(r.join("vault/.obsidian/x"));
        touch(r.join("vault/n.md"));
        touch(r.join("secret.md"));
        let from = r.join("vault/n.md");
        for t in ["../secret", "..\\secret", "/etc/passwd", "a/../../secret", "C:/x", "./n"] {
            assert_eq!(resolve_wikilink(&from, &[], t), None, "{t}");
        }
        assert_eq!(resolve_wikilink(&from, &[], "secret"), None); // outside the vault root
    }

    #[test]
    fn without_a_vault_the_search_stays_in_the_notes_folder() {
        let r = tree("novault");
        touch(r.join("a/Idea.md"));
        touch(r.join("b/Here.md"));
        assert_eq!(resolve_wikilink(&r.join("b/Here.md"), &[], "Idea"), None);
    }

    #[test]
    fn watched_folders_extend_the_search() {
        let r = tree("watched");
        touch(r.join("notes/Here.md"));
        touch(r.join("other/Elsewhere.md"));
        let from = r.join("notes/Here.md");
        assert_eq!(resolve_wikilink(&from, &[], "Elsewhere"), None);
        assert_eq!(resolve_wikilink(&from, &[r.join("other")], "Elsewhere"), Some(r.join("other/Elsewhere.md")));
    }
}
