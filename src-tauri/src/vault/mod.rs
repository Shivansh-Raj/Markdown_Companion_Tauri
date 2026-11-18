//! Read-only vault index: for every Markdown note under a root it keeps the tags, aliases and wikilinks, and
//! derives backlinks. It is a disposable in-memory cache; the files remain the only source of truth, nothing
//! here ever writes to a vault, and nothing leaves the machine.
//!
//! Link resolution follows Obsidian: a bare name matches a note by file name or alias anywhere in the vault, a
//! path matches the tail of a note's path, and ties go to the note beside the linking one, then the shallowest.

use crate::discovery;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_PARSE_BYTES: u64 = 2_000_000;

#[derive(Clone, Debug, PartialEq)]
pub struct Link {
    /// Normalised target used for matching: lower-case, no heading, alias or extension.
    pub key: String,
    /// What to show: the target as written, without heading or alias.
    pub label: String,
}

/// A `- [ ]` / `- [x]` task line. Only the default statuses are recognised, as in the note window.
#[derive(Clone, Debug, PartialEq)]
pub struct TaskItem {
    /// Byte offset of the `[` of the marker in the file.
    pub offset: usize,
    /// 1-based line number.
    pub line: usize,
    pub done: bool,
    /// The text after the marker, as written (used to verify the line before changing it).
    pub raw: String,
    /// `raw` up to the first Obsidian Tasks marker (due date, recurrence, priority…), for display.
    pub title: String,
    pub due: Option<String>,
    pub scheduled: Option<String>,
    /// Has a `🔁` rule. Completing it creates the next occurrence in Obsidian, so MC never toggles these.
    pub recurring: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Parsed {
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub links: Vec<Link>,
    pub tasks: Vec<TaskItem>,
}

// ---- Parsing ----

fn unquote(s: &str) -> String {
    let t = s.trim();
    let b = t.as_bytes();
    if b.len() >= 2 && ((b[0] == b'"' && b[b.len() - 1] == b'"') || (b[0] == b'\'' && b[b.len() - 1] == b'\'')) {
        t[1..t.len() - 1].trim().to_string()
    } else {
        t.to_string()
    }
}

/// Splits a leading `---` frontmatter block from the body. Returns (frontmatter lines, body).
fn split_frontmatter(content: &str) -> (Vec<&str>, &str) {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut lines = content.split_inclusive('\n');
    match lines.next() {
        Some(first) if first.trim_end() == "---" => {}
        _ => return (Vec::new(), content),
    }
    let mut consumed = content.find('\n').map_or(content.len(), |i| i + 1);
    let mut fm = Vec::new();
    for line in lines {
        consumed += line.len();
        let t = line.trim_end();
        if t == "---" || t == "..." {
            return (fm, &content[consumed..]);
        }
        fm.push(t);
    }
    (Vec::new(), content) // never closed: not frontmatter
}

/// Reads `tags` and `aliases` from a flat YAML subset: scalars, `[a, b]` and block lists.
fn frontmatter_lists(lines: &[&str]) -> (Vec<String>, Vec<String>) {
    let (mut tags, mut aliases) = (Vec::new(), Vec::new());
    let mut current: Option<bool> = None; // Some(true) = tags, Some(false) = aliases
    for raw in lines {
        if let Some(item) = raw.trim_start().strip_prefix("- ").filter(|_| raw.starts_with(' ') || raw.starts_with('-')) {
            match current {
                Some(true) => tags.push(unquote(item)),
                Some(false) => aliases.push(unquote(item)),
                None => {}
            }
            continue;
        }
        let Some((key, rest)) = raw.split_once(':') else { continue };
        if raw.starts_with(' ') || raw.starts_with('\t') {
            continue; // nested map or continuation
        }
        let key = key.trim().to_lowercase();
        let is_tags = matches!(key.as_str(), "tags" | "tag");
        let is_aliases = matches!(key.as_str(), "aliases" | "alias");
        current = if is_tags { Some(true) } else if is_aliases { Some(false) } else { None };
        let rest = rest.trim();
        if current.is_none() || rest.is_empty() {
            continue;
        }
        let items: Vec<String> = if rest.starts_with('[') && rest.ends_with(']') {
            rest[1..rest.len() - 1].split(',').map(unquote).collect()
        } else if is_tags {
            rest.split([',', ' ']).map(unquote).collect() // `tags: a b` or `tags: a, b`
        } else {
            vec![unquote(rest)]
        };
        for i in items.into_iter().filter(|i| !i.is_empty()) {
            if is_tags { tags.push(i) } else { aliases.push(i) }
        }
        current = None;
    }
    let clean_tag = |t: String| t.trim_start_matches('#').trim_matches('/').to_string();
    (tags.into_iter().map(clean_tag).filter(|t| !t.is_empty()).collect(), aliases.into_iter().filter(|a| !a.is_empty()).collect())
}

/// Blanks out `` `code` `` spans with spaces so links and tags inside them are ignored.
fn blank_inline_code(line: &str) -> String {
    let b = line.as_bytes();
    let mut out = b.to_vec();
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'`' {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i] == b'`' {
            i += 1;
        }
        let run = i - start;
        let mut j = i;
        let mut close = None;
        while j < b.len() {
            if b[j] == b'`' {
                let s = j;
                while j < b.len() && b[j] == b'`' {
                    j += 1;
                }
                if j - s == run {
                    close = Some(j);
                    break;
                }
            } else {
                j += 1;
            }
        }
        if let Some(end) = close {
            out[start..end].fill(b' ');
            i = end;
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| line.to_string())
}

fn fence_marker(t: &str) -> Option<(u8, usize)> {
    let b = t.as_bytes();
    let c = *b.first()?;
    if c != b'`' && c != b'~' {
        return None;
    }
    let n = b.iter().take_while(|x| **x == c).count();
    (n >= 3).then_some((c, n))
}

/// If a `[[link]]` starts at `i`, records it, blanks it out of `s` and returns the index just past it.
fn take_link(s: &mut [u8], i: usize, links: &mut Vec<Link>) -> Option<usize> {
    let rel = s[i + 2..].windows(2).position(|w| w == b"]]")?;
    let inner = &s[i + 2..i + 2 + rel];
    if inner.is_empty() || inner.contains(&b'[') || inner.contains(&b']') {
        return None;
    }
    let text = String::from_utf8_lossy(inner).to_string();
    let target = text.split('|').next().unwrap_or("");
    let key = discovery::link_path(target);
    if !key.is_empty() {
        let label = target.split('#').next().unwrap_or("").trim().trim_end_matches(".md").to_string();
        links.push(Link { key, label });
    }
    let end = i + 2 + rel + 2;
    s[i..end].fill(b' ');
    Some(end)
}

/// Extracts `[[links]]` (and `![[embeds]]`, which also reference a note) and `#tags` from one line of prose.
fn scan_line(line: &str, links: &mut Vec<Link>, tags: &mut Vec<String>) {
    let mut s = blank_inline_code(line).into_bytes();
    let mut i = 0;
    while i + 1 < s.len() {
        if s[i] == b'[' && s[i + 1] == b'['
            && let Some(end) = take_link(&mut s, i, links)
        {
            i = end;
            continue;
        }
        i += 1;
    }
    let text = String::from_utf8_lossy(&s).to_string();
    let chars: Vec<char> = text.chars().collect();
    for (idx, c) in chars.iter().enumerate() {
        if *c != '#' || !(idx == 0 || chars[idx - 1].is_whitespace() || chars[idx - 1] == '(') {
            continue;
        }
        let tag: String = chars[idx + 1..].iter().take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/')).collect();
        let tag = tag.trim_end_matches('/').to_string();
        // Obsidian requires at least one non-numeric character, so `#12` is not a tag.
        if !tag.is_empty() && tag.chars().any(|c| !c.is_ascii_digit()) {
            tags.push(tag);
        }
    }
}

const TASK_MARKERS: [&str; 11] = ["📅", "⏳", "🛫", "➕", "✅", "❌", "🔁", "🔺", "⏫", "🔼", "🔽"];

fn date_after(text: &str, marker: &str) -> Option<String> {
    let rest = text[text.find(marker)? + marker.len()..].trim_start();
    let d = rest.get(..10)?;
    let ok = d.bytes().enumerate().all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });
    ok.then(|| d.to_string())
}

/// Parses one line as a task: optional quote markers and indent, a list bullet, then `[ ]`, `[x]` or `[X]`.
/// Returns (marker offset in the line, done, text after the marker).
fn parse_task_line(line: &str) -> Option<(usize, bool, &str)> {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'>') {
        i += 1;
    }
    if i < b.len() && matches!(b[i], b'-' | b'*' | b'+') {
        i += 1;
    } else {
        let digits = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 || digits > 9 || !matches!(b.get(i + digits), Some(b'.' | b')')) {
            return None;
        }
        i += digits + 1;
    }
    let gap = b[i..].iter().take_while(|c| matches!(c, b' ' | b'\t')).count();
    if gap == 0 {
        return None;
    }
    i += gap;
    if b.get(i) != Some(&b'[') || b.get(i + 2) != Some(&b']') {
        return None;
    }
    let done = match b.get(i + 1)? {
        b' ' => false,
        b'x' | b'X' => true,
        _ => return None,
    };
    let after = line.get(i + 3..)?;
    // Obsidian needs a space after `]`; an empty task text is not a task.
    let text = after.strip_prefix([' ', '\t'])?;
    (!text.trim().is_empty()).then_some((i, done, text))
}

fn task_from(line_no: usize, offset: usize, done: bool, text: &str) -> TaskItem {
    let raw = text.trim().to_string();
    let cut = TASK_MARKERS.iter().filter_map(|m| raw.find(m)).min().unwrap_or(raw.len());
    let mut title = raw[..cut].trim();
    // a trailing Obsidian block id (`^abc-1`) is not part of the title
    if let Some(pos) = title.rfind(" ^")
        && title[pos + 2..].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        && title.len() > pos + 2
    {
        title = title[..pos].trim_end();
    }
    TaskItem {
        offset,
        line: line_no,
        done,
        title: title.to_string(),
        due: date_after(&raw, "📅"),
        scheduled: date_after(&raw, "⏳"),
        recurring: raw.contains("🔁"),
        raw,
    }
}

pub fn parse_note(content: &str) -> Parsed {
    let (fm, body) = split_frontmatter(content);
    let (mut tags, aliases) = frontmatter_lists(&fm);
    let mut links = Vec::new();
    let mut tasks = Vec::new();
    let mut fence: Option<(u8, usize)> = None;
    let body_start = body.as_ptr() as usize - content.as_ptr() as usize;
    let first_line = content[..body_start].bytes().filter(|b| *b == b'\n').count() + 1;
    for (n, line) in body.split('\n').enumerate() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let line_offset = body_start + (line.as_ptr() as usize - body.as_ptr() as usize);
        let t = line.trim_start();
        if let Some((c, n)) = fence_marker(t) {
            match fence {
                None => fence = Some((c, n)),
                Some((fc, fnn)) if fc == c && n >= fnn && t[n..].trim().is_empty() => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_none() {
            scan_line(line, &mut links, &mut tags);
            if let Some((at, done, text)) = parse_task_line(line) {
                tasks.push(task_from(first_line + n, line_offset + at, done, text));
            }
        }
    }
    let mut seen = HashSet::new();
    tags.retain(|t| seen.insert(t.to_lowercase()));
    Parsed { aliases, tags, links, tasks }
}

// ---- Index ----

struct Entry {
    mtime: u128,
    size: u64,
    parsed: Result<Parsed, String>,
}

pub struct Note {
    pub path: PathBuf,
    /// Path relative to the root, with `/` separators.
    pub rel: String,
    /// File name without extension.
    pub name: String,
    pub parsed: Parsed,
    rel_lower: String,
}

pub struct VaultIndex {
    pub root: PathBuf,
    /// True when the root is an Obsidian vault (has `.obsidian`); false for a plain watched folder.
    pub is_vault: bool,
    pub indexed_at_ms: u64,
    pub skipped: Vec<String>,
    truncated: bool,
    entries: HashMap<PathBuf, Entry>,
    pub notes: Vec<Note>,
    by_tail: HashMap<String, Vec<usize>>,
    by_alias: HashMap<String, Vec<usize>>,
    resolved: Vec<Vec<Option<usize>>>,
    backlinks: Vec<Vec<(usize, u32)>>,
}

fn mtime_ns(meta: &std::fs::Metadata) -> u128 {
    meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

impl VaultIndex {
    pub fn new(root: PathBuf, is_vault: bool) -> Self {
        VaultIndex {
            root, is_vault, indexed_at_ms: 0, skipped: Vec::new(), truncated: false, entries: HashMap::new(), notes: Vec::new(),
            by_tail: HashMap::new(), by_alias: HashMap::new(), resolved: Vec::new(), backlinks: Vec::new(),
        }
    }

    /// Re-reads only files whose size or modification time changed, drops deleted ones, and rebuilds the derived
    /// link tables when anything changed. Returns whether the index changed.
    pub fn refresh(&mut self) -> bool {
        let (files, truncated) = discovery::walk_markdown_limited(&self.root);
        let mut changed = truncated != self.truncated;
        self.truncated = truncated;
        let present: HashSet<&PathBuf> = files.iter().collect();
        let before = self.entries.len();
        self.entries.retain(|p, _| present.contains(p));
        changed |= self.entries.len() != before;
        for path in &files {
            let Ok(meta) = std::fs::metadata(path) else { continue };
            let (mtime, size) = (mtime_ns(&meta), meta.len());
            if self.entries.get(path).is_some_and(|e| e.mtime == mtime && e.size == size) {
                continue;
            }
            let parsed = if size > MAX_PARSE_BYTES {
                Err("larger than 2 MB, not indexed".to_string())
            } else {
                std::fs::read_to_string(path).map(|c| parse_note(&c)).map_err(|e| format!("could not be read as text ({e})"))
            };
            self.entries.insert(path.clone(), Entry { mtime, size, parsed });
            changed = true;
        }
        if changed || self.indexed_at_ms == 0 {
            self.rebuild();
        }
        changed
    }

    fn rebuild(&mut self) {
        let mut paths: Vec<&PathBuf> = self.entries.keys().collect();
        paths.sort();
        self.skipped.clear();
        self.notes.clear();
        if self.truncated {
            self.skipped.push(format!("The vault has more than {} files and folders, so some notes are not indexed.", discovery::LINK_MAX_ENTRIES));
        }
        for p in paths {
            let rel = p.strip_prefix(&self.root).unwrap_or(p).to_string_lossy().replace('\\', "/");
            match &self.entries[p].parsed {
                Ok(parsed) => {
                    let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                    let rel_lower = rel.rsplit_once('.').map_or(rel.clone(), |(a, _)| a.to_string()).to_lowercase();
                    self.notes.push(Note { path: p.clone(), rel, name, parsed: parsed.clone(), rel_lower });
                }
                Err(why) => self.skipped.push(format!("{rel}: {why}")),
            }
        }
        self.by_tail.clear();
        self.by_alias.clear();
        for (i, n) in self.notes.iter().enumerate() {
            // every path suffix on a `/` boundary: "a/b/c" is reachable as "c", "b/c" and "a/b/c"
            let mut start = 0;
            loop {
                self.by_tail.entry(n.rel_lower[start..].to_string()).or_default().push(i);
                match n.rel_lower[start..].find('/') {
                    Some(k) => start += k + 1,
                    None => break,
                }
            }
            for a in &n.parsed.aliases {
                self.by_alias.entry(a.to_lowercase()).or_default().push(i);
            }
        }
        self.resolved = (0..self.notes.len())
            .map(|i| self.notes[i].parsed.links.iter().map(|l| self.resolve(i, &l.key)).collect())
            .collect();
        let mut counts: Vec<HashMap<usize, u32>> = vec![HashMap::new(); self.notes.len()];
        for (from, targets) in self.resolved.iter().enumerate() {
            for t in targets.iter().flatten().filter(|t| **t != from) {
                *counts[*t].entry(from).or_default() += 1;
            }
        }
        self.backlinks = counts
            .into_iter()
            .map(|m| {
                let mut v: Vec<(usize, u32)> = m.into_iter().collect();
                v.sort_by(|a, b| self.notes[a.0].rel.cmp(&self.notes[b.0].rel));
                v
            })
            .collect();
        self.indexed_at_ms = now_ms();
    }

    fn resolve(&self, from: usize, key: &str) -> Option<usize> {
        let mut cands: Vec<usize> = self.by_tail.get(key).cloned().unwrap_or_default();
        if !key.contains('/') {
            cands.extend(self.by_alias.get(key).into_iter().flatten().copied());
        }
        let from_dir = self.notes[from].path.parent();
        cands.into_iter().min_by_key(|&i| {
            let n = &self.notes[i];
            (u8::from(n.path.parent() != from_dir), n.rel.matches('/').count(), n.rel.clone())
        })
    }

    pub fn index_of(&self, path: &Path) -> Option<usize> {
        self.notes.iter().position(|n| n.path == path)
    }

    pub fn backlinks(&self, i: usize) -> &[(usize, u32)] {
        &self.backlinks[i]
    }

    /// Outgoing links in document order, de-duplicated by target text, each with its resolved note if any.
    pub fn outgoing(&self, i: usize) -> Vec<(&Link, Option<usize>)> {
        let mut seen = HashSet::new();
        self.notes[i]
            .parsed
            .links
            .iter()
            .zip(&self.resolved[i])
            .filter(|(l, _)| seen.insert(l.key.clone()))
            .map(|(l, r)| (l, *r))
            .collect()
    }
}

/// Indexes by root; one entry per vault or watched folder in use.
#[derive(Default)]
pub struct VaultState(pub Mutex<HashMap<PathBuf, VaultIndex>>);

/// The index root for a note: its Obsidian vault if it has one, else the watched folder containing it.
pub fn index_root_for(file: &Path, watched: &[PathBuf]) -> Option<(PathBuf, bool)> {
    if let Some(v) = discovery::vault_root(file) {
        return Some((v, true));
    }
    watched.iter().filter(|w| file.starts_with(w)).max_by_key(|w| w.components().count()).map(|w| (w.clone(), false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tree(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("mdc-vault-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".obsidian")).unwrap();
        fs::canonicalize(root).unwrap()
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn parses_links_tags_and_aliases_but_not_code() {
        let p = parse_note(
            "---\ntags: [work, \"#plan\"]\naliases:\n  - Sprint\n  - 'The Sprint'\n---\n# Title\n\nSee [[Roadmap#Goals|goals]] and ![[img.png]] #proj/x and issue #12.\n`[[inline]] #nope` text\n\n```\n[[fenced]] #nope\n```\n\n[[#Same]] [[ ]] [[a]]b #Done\n",
        );
        assert_eq!(p.aliases, vec!["Sprint", "The Sprint"]);
        assert_eq!(p.tags, vec!["work", "plan", "proj/x", "Done"]);
        let keys: Vec<_> = p.links.iter().map(|l| l.key.as_str()).collect();
        assert_eq!(keys, vec!["roadmap", "img.png", "a"]); // [[#Same]] and [[ ]] point at nothing
        assert_eq!(p.links[0].label, "Roadmap");
    }

    #[test]
    fn headings_and_unclosed_frontmatter_are_not_tags_or_properties() {
        let p = parse_note("---\ntags: [hidden]\n# Heading\n\n# Another\ntext #real");
        assert_eq!(p.tags, vec!["real"]); // never closed, so not frontmatter
    }

    #[test]
    fn backlinks_resolve_by_name_path_and_alias() {
        let r = tree("links");
        write(&r, "Projects/Roadmap.md", "---\naliases: [plan]\n---\n# Roadmap");
        write(&r, "Meetings/Sprint.md", "See [[Roadmap]] and [[projects/roadmap#x]] and [[plan]] and [[Missing]].");
        write(&r, "Other/Idea.md", "Back to [[Roadmap|r]]");
        write(&r, "Self.md", "[[Self]] [[roadmap]]");
        let mut idx = VaultIndex::new(r.clone(), true);
        assert!(idx.refresh());
        let road = idx.index_of(&r.join("Projects/Roadmap.md")).unwrap();
        let back: Vec<(String, u32)> = idx.backlinks(road).iter().map(|(i, c)| (idx.notes[*i].rel.clone(), *c)).collect();
        assert_eq!(back, vec![("Meetings/Sprint.md".to_string(), 3), ("Other/Idea.md".to_string(), 1), ("Self.md".to_string(), 1)]);
        let sprint = idx.index_of(&r.join("Meetings/Sprint.md")).unwrap();
        let out = idx.outgoing(sprint);
        assert_eq!(out.len(), 4); // roadmap, projects/roadmap, plan, missing
        assert_eq!(out.iter().filter(|(_, r)| r.is_none()).count(), 1); // only [[Missing]] is unresolved
    }

    #[test]
    fn ties_prefer_the_neighbour_then_the_shallowest() {
        let r = tree("ties");
        write(&r, "a/Idea.md", "x");
        write(&r, "b/deep/Idea.md", "x");
        write(&r, "b/Here.md", "[[Idea]]");
        write(&r, "c/Here.md", "[[Idea]]");
        let mut idx = VaultIndex::new(r.clone(), true);
        idx.refresh();
        let a = idx.index_of(&r.join("a/Idea.md")).unwrap();
        let deep = idx.index_of(&r.join("b/deep/Idea.md")).unwrap();
        assert_eq!(idx.backlinks(a).len(), 2); // both Here.md pick the shallowest
        assert!(idx.backlinks(deep).is_empty());
        write(&r, "b/Idea.md", "x");
        idx.refresh();
        let near = idx.index_of(&r.join("b/Idea.md")).unwrap();
        assert_eq!(idx.backlinks(near).len(), 1); // b/Here.md now has a neighbour
    }

    #[test]
    fn refresh_is_incremental_and_reports_unreadable_notes() {
        let r = tree("refresh");
        write(&r, "One.md", "[[Two]]");
        write(&r, "Two.md", "x");
        fs::write(r.join("Bad.md"), [0xff, 0xfe, 0x00, 0x41]).unwrap();
        let mut idx = VaultIndex::new(r.clone(), true);
        assert!(idx.refresh());
        assert_eq!(idx.notes.len(), 2);
        assert_eq!(idx.skipped.len(), 1);
        assert!(idx.skipped[0].starts_with("Bad.md"));
        assert!(!idx.refresh()); // nothing changed
        let two = idx.index_of(&r.join("Two.md")).unwrap();
        assert_eq!(idx.backlinks(two).len(), 1);
        std::thread::sleep(std::time::Duration::from_millis(20));
        write(&r, "One.md", "no links now, #tag");
        assert!(idx.refresh());
        let two = idx.index_of(&r.join("Two.md")).unwrap();
        assert!(idx.backlinks(two).is_empty());
        fs::remove_file(r.join("Two.md")).unwrap();
        assert!(idx.refresh());
        assert_eq!(idx.notes.len(), 1);
        assert_eq!(idx.notes[0].parsed.tags, vec!["tag"]);
    }

    #[test]
    fn indexes_five_thousand_notes_quickly_and_refreshes_cheaply() {
        let r = tree("big");
        for i in 0..5000 {
            let links = (1..=5).map(|k| format!("[[Note {}]]", (i * 7 + k * 13) % 5000)).collect::<Vec<_>>().join(" ");
            write(&r, &format!("f{}/Note {i}.md", i % 50), &format!("---\ntags: [t{}]\n---\n# Note {i}\n{links} #topic\n", i % 20));
        }
        let mut idx = VaultIndex::new(r.clone(), true);
        let t = std::time::Instant::now();
        assert!(idx.refresh());
        let first = t.elapsed();
        assert_eq!(idx.notes.len(), 5000);
        let t = std::time::Instant::now();
        assert!(!idx.refresh());
        let second = t.elapsed();
        eprintln!("5000 notes: first index {first:?}, unchanged refresh {second:?} (debug build)");
        assert!(first < std::time::Duration::from_secs(15), "{first:?}");
        assert!(second < std::time::Duration::from_secs(3), "{second:?}");
    }

    #[test]
    fn the_index_agrees_with_click_resolution() {
        let r = tree("agree");
        write(&r, "Projects/Roadmap.md", "x");
        write(&r, "Archive/old/Roadmap.md", "x");
        write(&r, "Meetings/Sprint.md", "[[Roadmap]]");
        let from = r.join("Meetings/Sprint.md");
        let clicked = discovery::resolve_wikilink(&from, &[], "Roadmap").unwrap();
        let mut idx = VaultIndex::new(r.clone(), true);
        idx.refresh();
        let target = idx.index_of(&clicked).unwrap();
        assert_eq!(idx.backlinks(target).len(), 1);
    }

    #[test]
    fn index_root_prefers_the_vault_then_the_longest_watched_folder() {
        let r = tree("roots");
        write(&r, "n.md", "x");
        assert_eq!(index_root_for(&r.join("n.md"), &[]), Some((r.clone(), true)));
        let plain = std::env::temp_dir().join(format!("mdc-vault-plain-{}", std::process::id()));
        fs::create_dir_all(plain.join("sub")).unwrap();
        fs::write(plain.join("sub/n.md"), "x").unwrap();
        let w = vec![plain.clone(), plain.join("sub")];
        assert_eq!(index_root_for(&plain.join("sub/n.md"), &w), Some((plain.join("sub"), false)));
        assert_eq!(index_root_for(&plain.join("elsewhere.md"), &[]), None);
    }

    #[test]
    fn finds_tasks_with_byte_offsets_that_point_at_the_marker() {
        let md = "---\ntags: [x]\n---\n# T\n- [ ] plain\n  * [x] nested done\n> - [ ] in a callout\n1. [ ] numbered 📅 2026-12-01 ⏳ 2026-11-30\n- [/] custom status\n- [ ]\n- [ ]no space\n- not a task\n```\n- [ ] in code\n```\n- [ ] with id ^abc-1\n";
        let p = parse_note(md);
        let got: Vec<(&str, bool, usize)> = p.tasks.iter().map(|t| (t.title.as_str(), t.done, t.line)).collect();
        assert_eq!(got, vec![("plain", false, 5), ("nested done", true, 6), ("in a callout", false, 7), ("numbered", false, 8), ("with id", false, 16)]);
        for t in &p.tasks {
            let marker = &md[t.offset..t.offset + 3];
            assert!(marker == "[ ]" || marker == "[x]", "{marker:?} at {}", t.offset);
        }
        let n = &p.tasks[3];
        assert_eq!((n.due.as_deref(), n.scheduled.as_deref(), n.recurring), (Some("2026-12-01"), Some("2026-11-30"), false));
    }

    #[test]
    fn recurring_and_crlf_and_bom_are_handled() {
        let md = "\u{feff}- [ ] water plants 🔁 every week 📅 2026-12-02\r\n- [ ] second\r\n";
        let p = parse_note(md);
        assert_eq!(p.tasks.len(), 2);
        assert!(p.tasks[0].recurring);
        assert_eq!(p.tasks[0].title, "water plants");
        assert_eq!(p.tasks[0].due.as_deref(), Some("2026-12-02"));
        for t in &p.tasks {
            assert_eq!(&md[t.offset..t.offset + 3], "[ ]");
        }
        assert_eq!(p.tasks[1].line, 2);
    }

    #[test]
    fn invalid_dates_are_ignored() {
        let p = parse_note("- [ ] a 📅 tomorrow\n- [ ] b 📅 2026-1-5\n");
        assert!(p.tasks.iter().all(|t| t.due.is_none()));
    }
}
