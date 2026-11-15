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
}
