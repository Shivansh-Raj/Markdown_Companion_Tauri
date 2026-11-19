//! Linked copies: pulling a Notion page into a local file and keeping track of what changed since.
//!
//! A link remembers the local text and the Notion Markdown as they were at the last sync (as hashes, plus the
//! Notion text as a snapshot file). Nothing here writes to Notion's existing pages; refresh only changes the local
//! file, and only when the local file has not changed since the last sync.

use serde::Serialize;
use std::path::Path;

use super::edit::{Edit, single_edit};
use super::{Client, Created, SyncState, load_snapshot, parse_page_id, save_snapshot, sync_state};
use crate::filesystem::{FileLocks, ToggleError, hash_bytes, read_snapshot};
use crate::store::{NotionLink, Store};

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Pulled {
    pub file_id: String,
    pub title: String,
    /// Blocks Markdown cannot show. They appear in the text as `<unknown …/>` tags and must be left alone.
    pub unknown_blocks: usize,
    /// The page was already linked to a local file, so that file is opened instead of making a duplicate.
    pub existing: bool,
}

/// Fetches a page and writes it as a new local file, then records the link.
pub fn pull(client: &Client, store: &Store, dir: &Path, page: &str) -> Result<Pulled, String> {
    let id = parse_page_id(page).ok_or("That is not a Notion page link or id.")?;
    if let Some(file_id) = store.file_for_notion_page(&id)
        && let Some(file) = store.get(&file_id)
        && Path::new(&file.canonical_path).exists()
    {
        let link = store.notion_link(&file_id).ok_or("Link missing")?;
        return Ok(Pulled { file_id, title: link.title, unknown_blocks: 0, existing: true });
    }
    let md = client.read_page(&id)?;
    if md.truncated {
        return Err("This page is too large, or part of it is not shared with the connection, so it cannot be opened safely. Open it in Notion.".into());
    }
    let info = client.page_info(&id)?;
    let title = info.title;
    let file = crate::write_new_markdown(dir, &title, &md.markdown, store)?;
    let link = NotionLink {
        page_id: id,
        url: info.url,
        title: title.clone(),
        local_hash: hash_bytes(md.markdown.as_bytes()),
        remote_hash: hash_bytes(md.markdown.as_bytes()),
        synced_secs: now_secs(),
    };
    save_snapshot(&store.snapshot_dir(), &file.id, &md.markdown)?;
    store.set_notion_link(&file.id, link)?;
    Ok(Pulled { file_id: file.id, title, unknown_blocks: md.unknown_block_ids.len(), existing: false })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct LinkInfo {
    pub page_id: String,
    pub url: String,
    pub title: String,
    pub synced_secs: u64,
    /// The local file differs from what it was at the last sync.
    pub local_changed: bool,
}

pub fn link_info(store: &Store, file_id: &str) -> Result<Option<LinkInfo>, String> {
    let Some(link) = store.notion_link(file_id) else { return Ok(None) };
    let file = store.get(file_id).ok_or("Unknown file")?;
    let local = read_snapshot(Path::new(&file.canonical_path))?;
    Ok(Some(LinkInfo {
        local_changed: local.hash != link.local_hash,
        page_id: link.page_id,
        url: link.url,
        title: link.title,
        synced_secs: link.synced_secs,
    }))
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Refreshed {
    pub state: SyncState,
    /// The local file was replaced with the newer Notion text.
    pub updated: bool,
}

/// Brings Notion's changes into the local file, but only when the local file is unchanged since the last sync.
/// If both sides changed, nothing is written.
pub fn refresh(client: &Client, store: &Store, locks: &FileLocks, file_id: &str) -> Result<Refreshed, String> {
    let link = store.notion_link(file_id).ok_or("This file is not linked to a Notion page.")?;
    let file = store.get(file_id).ok_or("Unknown file")?;
    let path = Path::new(&file.canonical_path);
    let local = read_snapshot(path)?;
    let remote = client.read_page(&link.page_id)?;
    if remote.truncated {
        return Err("The Notion page is too large, or partly unshared, to compare safely.".into());
    }
    let remote_hash = hash_bytes(remote.markdown.as_bytes());
    let state = sync_state(&link, &local.hash, &remote_hash);
    if state != SyncState::RemoteChanged {
        return Ok(Refreshed { state, updated: false });
    }
    let saved = locks.save_content(path, &local.hash, &remote.markdown).map_err(|e| match e {
        ToggleError::Stale { .. } => "The file changed while refreshing. Nothing was overwritten; try again.".to_string(),
        ToggleError::Failed { message } => message,
    })?;
    save_snapshot(&store.snapshot_dir(), file_id, &remote.markdown)?;
    store.set_notion_link(file_id, NotionLink { local_hash: saved.hash, remote_hash, synced_secs: now_secs(), ..link })?;
    Ok(Refreshed { state, updated: true })
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PushPlan {
    /// The local file is the same as at the last sync.
    NothingToSend,
    /// Notion changed since the last sync, so sending would risk overwriting that work. Nothing is sent.
    RemoteChanged { both: bool },
    /// What will change in Notion, as the text now there and the text it will become.
    Ready { old_str: String, new_str: String, local_hash: String },
}

fn load_base(store: &Store, file_id: &str) -> Result<String, String> {
    load_snapshot(&store.snapshot_dir(), file_id).ok_or_else(|| "The saved copy from the last sync is missing, so changes cannot be compared safely. Refresh from Notion first.".to_string())
}

/// Works out what a push would do, without changing anything in Notion.
pub fn plan_push(client: &Client, store: &Store, file_id: &str) -> Result<PushPlan, String> {
    let link = store.notion_link(file_id).ok_or("This file is not linked to a Notion page.")?;
    let file = store.get(file_id).ok_or("Unknown file")?;
    let local = read_snapshot(Path::new(&file.canonical_path))?;
    let remote = client.read_page(&link.page_id)?;
    if remote.truncated {
        return Err("The Notion page is too large, or partly unshared, to update safely. Edit it in Notion.".into());
    }
    let remote_hash = hash_bytes(remote.markdown.as_bytes());
    match sync_state(&link, &local.hash, &remote_hash) {
        SyncState::InSync => Ok(PushPlan::NothingToSend),
        SyncState::RemoteChanged => Ok(PushPlan::RemoteChanged { both: false }),
        SyncState::Both => Ok(PushPlan::RemoteChanged { both: true }),
        SyncState::LocalChanged => {
            let base = load_base(store, file_id)?;
            if hash_bytes(base.as_bytes()) != link.remote_hash {
                return Err("The saved copy from the last sync does not match its record. Refresh from Notion first.".into());
            }
            match single_edit(&base, &local.content)? {
                Some(Edit { old_str, new_str }) => Ok(PushPlan::Ready { old_str, new_str, local_hash: local.hash }),
                None => Ok(PushPlan::NothingToSend),
            }
        }
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Pushed {
    /// Notes from Notion about content it adjusted (for example a tag it fixed).
    pub warnings: Vec<String>,
}

/// Sends the planned edit. It re-checks everything first: the file must still be what was previewed and Notion must
/// still be unchanged. The Notion text is saved to a backup file before anything is written.
pub fn push(client: &Client, store: &Store, file_id: &str, expected_local_hash: &str) -> Result<Pushed, String> {
    let PushPlan::Ready { old_str, new_str, local_hash } = plan_push(client, store, file_id)? else {
        return Err("Notion or this note changed since the preview. Nothing was sent; review it again.".into());
    };
    if local_hash != expected_local_hash {
        return Err("This note changed since the preview. Nothing was sent; review it again.".into());
    }
    let link = store.notion_link(file_id).ok_or("This file is not linked to a Notion page.")?;
    let base = load_base(store, file_id)?;
    let backups = store.snapshot_dir().join("backups");
    std::fs::create_dir_all(&backups).map_err(|e| format!("Could not save a backup, so nothing was sent: {e}"))?;
    std::fs::write(backups.join(format!("{file_id}-{}.md", now_secs())), &base).map_err(|e| format!("Could not save a backup, so nothing was sent: {e}"))?;

    let updated = client.update_content(&link.page_id, &old_str, &new_str)?;
    if updated.truncated {
        return Err("Notion applied the edit, but the page is too large to confirm it. Check it in Notion.".into());
    }
    save_snapshot(&store.snapshot_dir(), file_id, &updated.markdown)?;
    store.set_notion_link(
        file_id,
        NotionLink { local_hash, remote_hash: hash_bytes(updated.markdown.as_bytes()), synced_secs: now_secs(), ..link },
    )?;
    Ok(Pushed { warnings: updated.warnings })
}

/// After a page was created from a local file: read it back (this also checks Notion accepted the Markdown) and
/// record the link. Returns false when the read-back failed, in which case no link is made.
pub fn link_created(client: &Client, store: &Store, file_id: &str, local_content: &str, created: &Created, title: &str) -> bool {
    let Ok(back) = client.read_page(&created.id) else { return false };
    if save_snapshot(&store.snapshot_dir(), file_id, &back.markdown).is_err() {
        return false;
    }
    let link = NotionLink {
        page_id: created.id.clone(),
        url: created.url.clone(),
        title: title.to_string(),
        local_hash: hash_bytes(local_content.as_bytes()),
        remote_hash: hash_bytes(back.markdown.as_bytes()),
        synced_secs: now_secs(),
    };
    store.set_notion_link(file_id, link).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notion::load_snapshot;
    use crate::notion::{Http, Request, Response};
    use crate::secrets::MemorySecrets;
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};

    /// Answers by path: the markdown endpoint returns the current `remote` text.
    struct Notion {
        remote: Mutex<String>,
        truncated: bool,
        writes: Mutex<u32>,
    }

    impl Http for Notion {
        fn send(&self, _t: &str, req: &Request) -> Result<Response, String> {
            let body: Value = if req.path.ends_with("/markdown?markdown_version=v2") {
                json!({"markdown": *self.remote.lock().unwrap(), "truncated": self.truncated, "unknown_block_ids": ["u1"]})
            } else if req.path.starts_with("/v1/pages/") {
                json!({"object": "page", "id": "x", "url": "https://notion.so/x", "properties": {"title": {"type": "title", "title": [{"plain_text": "Team notes"}]}}})
            } else {
                *self.writes.lock().unwrap() += 1;
                json!({})
            };
            Ok(Response { status: 200, retry_after: None, body })
        }
    }

    const PAGE: &str = "1429989f-e8ac-4eff-bc8f-57f56486db54";

    fn setup(name: &str) -> (Store, FileLocks, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("mdc-sync-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::load_with(dir.join("store.json"), Arc::new(MemorySecrets::default()));
        (store, FileLocks::default(), dir)
    }

    fn notion(text: &str) -> Notion {
        Notion { remote: Mutex::new(text.into()), truncated: false, writes: Mutex::new(0) }
    }

    #[test]
    fn pulls_a_page_into_a_new_file_and_never_twice() {
        let (store, _, dir) = setup("pull");
        let http = notion("# Team notes\n\n- [ ] a\n");
        let client = Client::new(&http, "t");
        let first = pull(&client, &store, &dir.join("notes"), PAGE).unwrap();
        assert!(!first.existing);
        assert_eq!((first.title.as_str(), first.unknown_blocks), ("Team notes", 1));
        let file = store.get(&first.file_id).unwrap();
        assert_eq!(std::fs::read_to_string(&file.canonical_path).unwrap(), "# Team notes\n\n- [ ] a\n");
        assert_eq!(load_snapshot(&store.snapshot_dir(), &first.file_id).as_deref(), Some("# Team notes\n\n- [ ] a\n"));
        let info = link_info(&store, &first.file_id).unwrap().unwrap();
        assert!(!info.local_changed);
        assert_eq!(info.url, "https://notion.so/x");
        // pulling the same page again opens the existing file instead of making a copy
        let second = pull(&client, &store, &dir.join("notes"), &format!("https://notion.so/Team-{}", PAGE.replace('-', ""))).unwrap();
        assert_eq!((second.file_id.as_str(), second.existing), (first.file_id.as_str(), true));
        assert_eq!(std::fs::read_dir(dir.join("notes")).unwrap().count(), 1);
        assert_eq!(*http.writes.lock().unwrap(), 0, "pulling must never write to Notion");
    }

    #[test]
    fn refuses_to_pull_a_truncated_page() {
        let (store, _, dir) = setup("trunc");
        let mut http = notion("# big");
        http.truncated = true;
        let err = pull(&Client::new(&http, "t"), &store, &dir.join("n"), PAGE).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert!(!dir.join("n").exists());
    }

    #[test]
    fn refresh_updates_the_local_file_only_when_just_notion_changed() {
        let (store, locks, dir) = setup("refresh");
        let http = notion("# v1\n");
        let client = Client::new(&http, "t");
        let id = pull(&client, &store, &dir.join("n"), PAGE).unwrap().file_id;
        let path = std::path::PathBuf::from(store.get(&id).unwrap().canonical_path);

        assert_eq!(refresh(&client, &store, &locks, &id).unwrap(), Refreshed { state: SyncState::InSync, updated: false });

        *http.remote.lock().unwrap() = "# v2\n".into();
        assert_eq!(refresh(&client, &store, &locks, &id).unwrap(), Refreshed { state: SyncState::RemoteChanged, updated: true });
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# v2\n");
        assert_eq!(load_snapshot(&store.snapshot_dir(), &id).as_deref(), Some("# v2\n"));
        assert_eq!(refresh(&client, &store, &locks, &id).unwrap().state, SyncState::InSync);
    }

    #[test]
    fn refresh_never_overwrites_local_edits() {
        let (store, locks, dir) = setup("conflict");
        let http = notion("# v1\n");
        let client = Client::new(&http, "t");
        let id = pull(&client, &store, &dir.join("n"), PAGE).unwrap().file_id;
        let path = std::path::PathBuf::from(store.get(&id).unwrap().canonical_path);
        std::fs::write(&path, "# my edit\n").unwrap();

        assert!(link_info(&store, &id).unwrap().unwrap().local_changed);
        assert_eq!(refresh(&client, &store, &locks, &id).unwrap(), Refreshed { state: SyncState::LocalChanged, updated: false });
        *http.remote.lock().unwrap() = "# remote edit\n".into();
        assert_eq!(refresh(&client, &store, &locks, &id).unwrap(), Refreshed { state: SyncState::Both, updated: false });
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# my edit\n");
        assert_eq!(load_snapshot(&store.snapshot_dir(), &id).as_deref(), Some("# v1\n"), "snapshot stays at the last sync");
    }

    #[test]
    fn linking_after_create_records_the_read_back_text() {
        let (store, _, dir) = setup("link");
        let path = dir.join("a.md");
        std::fs::write(&path, "# A\n").unwrap();
        let file = store.register(&path.to_string_lossy()).unwrap();
        let http = notion("# A\n\n");
        let created = Created { id: PAGE.into(), url: "https://notion.so/a".into() };
        assert!(link_created(&Client::new(&http, "t"), &store, &file.id, "# A\n", &created, "A"));
        let info = link_info(&store, &file.id).unwrap().unwrap();
        assert_eq!((info.url.as_str(), info.local_changed), ("https://notion.so/a", false));
        assert_eq!(load_snapshot(&store.snapshot_dir(), &file.id).as_deref(), Some("# A\n\n"));
    }

    /// Applies update_content like Notion would, so push can be tested end to end.
    struct Applying {
        remote: Mutex<String>,
        patches: Mutex<u32>,
    }

    impl Http for Applying {
        fn send(&self, _t: &str, req: &Request) -> Result<Response, String> {
            let body = if req.method == "PATCH" {
                *self.patches.lock().unwrap() += 1;
                let b = req.body.as_ref().unwrap();
                let c = &b["update_content"]["content_updates"][0];
                let (old, new) = (c["old_str"].as_str().unwrap(), c["new_str"].as_str().unwrap());
                let mut r = self.remote.lock().unwrap();
                assert_eq!(r.matches(old).count(), 1, "Notion would refuse a non-unique old_str");
                *r = r.replacen(old, new, 1);
                json!({"markdown": *r, "truncated": false})
            } else if req.path.ends_with("/markdown?markdown_version=v2") {
                json!({"markdown": *self.remote.lock().unwrap(), "truncated": false, "unknown_block_ids": []})
            } else {
                json!({"object": "page", "id": "x", "url": "u", "properties": {"title": {"type": "title", "title": [{"plain_text": "T"}]}}})
            };
            Ok(Response { status: 200, retry_after: None, body })
        }
    }

    fn pulled(name: &str, text: &str) -> (Store, Applying, String, std::path::PathBuf, std::path::PathBuf) {
        let (store, _, dir) = setup(name);
        let http = Applying { remote: Mutex::new(text.into()), patches: Mutex::new(0) };
        let id = pull(&Client::new(&http, "t"), &store, &dir.join("n"), PAGE).unwrap().file_id;
        let path = std::path::PathBuf::from(store.get(&id).unwrap().canonical_path);
        (store, http, id, path, dir)
    }

    #[test]
    fn pushes_a_local_edit_as_one_targeted_change_with_a_backup() {
        let (store, http, id, path, _) = pulled("push", &format!("# Plan\n\n- [ ] write\n- [ ] ship\n\n{}end\n", "A long untouched paragraph that stays as it is.\n\n".repeat(20)));
        let client = Client::new(&http, "t");
        assert_eq!(plan_push(&client, &store, &id).unwrap(), PushPlan::NothingToSend);

        let body = "A long untouched paragraph that stays as it is.\n\n".repeat(20);
        std::fs::write(&path, format!("# Plan\n\n- [x] write\n- [ ] ship\n\n{body}end\n")).unwrap();
        let PushPlan::Ready { old_str, new_str, local_hash } = plan_push(&client, &store, &id).unwrap() else { panic!("expected a plan") };
        assert!(old_str.len() < 150 && new_str.contains("[x] write"), "{old_str:?}");
        assert_eq!(*http.patches.lock().unwrap(), 0, "planning must not write to Notion");

        let done = push(&client, &store, &id, &local_hash).unwrap();
        assert!(done.warnings.is_empty());
        assert_eq!(*http.remote.lock().unwrap(), format!("# Plan\n\n- [x] write\n- [ ] ship\n\n{body}end\n"));
        let backups: Vec<_> = std::fs::read_dir(store.snapshot_dir().join("backups")).unwrap().collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(backups[0].as_ref().unwrap().path()).unwrap(), format!("# Plan\n\n- [ ] write\n- [ ] ship\n\n{body}end\n"));
        // now in sync, and a second push has nothing to do
        assert_eq!(plan_push(&client, &store, &id).unwrap(), PushPlan::NothingToSend);
        assert!(!link_info(&store, &id).unwrap().unwrap().local_changed);
    }

    #[test]
    fn will_not_push_over_changes_made_in_notion() {
        let (store, http, id, path, _) = pulled("pushconflict", "# A\n\nline\n");
        let client = Client::new(&http, "t");
        std::fs::write(&path, "# A\n\nline mine\n").unwrap();
        *http.remote.lock().unwrap() = "# A\n\nline theirs\n".into();
        assert_eq!(plan_push(&client, &store, &id).unwrap(), PushPlan::RemoteChanged { both: true });
        assert!(push(&client, &store, &id, "whatever").is_err());
        assert_eq!(*http.patches.lock().unwrap(), 0);
        assert_eq!(*http.remote.lock().unwrap(), "# A\n\nline theirs\n");
    }

    #[test]
    fn will_not_push_if_the_note_changed_after_the_preview() {
        let (store, http, id, path, _) = pulled("pushstale", "# A\n\nline\n");
        let client = Client::new(&http, "t");
        std::fs::write(&path, "# A\n\nfirst\n").unwrap();
        let PushPlan::Ready { local_hash, .. } = plan_push(&client, &store, &id).unwrap() else { panic!() };
        std::fs::write(&path, "# A\n\nsecond\n").unwrap();
        let err = push(&client, &store, &id, &local_hash).unwrap_err();
        assert!(err.contains("changed since the preview"), "{err}");
        assert_eq!(*http.patches.lock().unwrap(), 0);
    }

    #[test]
    fn stops_when_the_saved_copy_is_missing() {
        let (store, http, id, path, _) = pulled("pushnosnap", "# A\n\nline\n");
        std::fs::write(&path, "# A\n\nchanged\n").unwrap();
        std::fs::remove_file(store.snapshot_dir().join(format!("{id}.md"))).unwrap();
        let err = plan_push(&Client::new(&http, "t"), &store, &id).unwrap_err();
        assert!(err.contains("Refresh from Notion first"), "{err}");
    }
}
