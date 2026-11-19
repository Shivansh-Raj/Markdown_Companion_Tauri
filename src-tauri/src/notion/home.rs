//! The "Markdown Companion" home page and the section pages under it (Notes, Meetings, …).
//!
//! The user picks the home page once. Section pages are created the first time they are needed, and an existing
//! child page with the same title is reused, so nothing is duplicated even if the saved record is lost.

use super::Client;
use crate::store::{NotionHome, Store};

/// (key, page title). The keys are stable; the titles are what appears in Notion.
pub const SECTIONS: &[(&str, &str)] = &[
    ("notes", "Notes"),
    ("meetings", "Meetings"),
    ("practice", "Practice sessions"),
    ("answers", "AI answers"),
];

pub fn section_title(key: &str) -> Option<&'static str> {
    SECTIONS.iter().find(|(k, _)| *k == key).map(|(_, t)| *t)
}

/// Checks the page is visible to the connection, then makes it the home page.
pub fn set_home(client: &Client, store: &Store, page: &str) -> Result<NotionHome, String> {
    let info = client.page_info(page)?;
    let home = NotionHome { page_id: super::parse_page_id(&info.id).unwrap_or(info.id), title: info.title, url: info.url };
    store.set_notion_home(Some(home.clone()))?;
    Ok(home)
}

/// The page id for a section, creating it under the home page if it does not exist yet.
pub fn ensure_section(client: &Client, store: &Store, key: &str) -> Result<String, String> {
    let title = section_title(key).ok_or("Unknown section.")?;
    let home = store.notion_home().ok_or("Choose a home page first (Settings → Notion).")?;
    if let Some(id) = store.notion_section(key)
        && client.page_exists(&id)?
    {
        return Ok(id);
    }
    let id = match client.find_child_page(&home.page_id, title)? {
        Some(id) => id,
        None => client.create_empty_page(&home.page_id, title)?.id,
    };
    store.set_notion_section(key, &id)?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notion::{Http, Request, Response};
    use crate::secrets::MemorySecrets;
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};

    const HOME: &str = "1429989f-e8ac-4eff-bc8f-57f56486db54";

    /// A tiny Notion: the home page has some children; creating a page adds one.
    struct Fake {
        children: Mutex<Vec<(String, String)>>, // (id, title)
        trashed: Mutex<Vec<String>>,
        created: Mutex<u32>,
    }

    impl Http for Fake {
        fn send(&self, _t: &str, req: &Request) -> Result<Response, String> {
            let ok = |body: Value| Ok(Response { status: 200, retry_after: None, body });
            if req.method == "POST" && req.path == "/v1/pages" {
                let n = {
                    let mut c = self.created.lock().unwrap();
                    *c += 1;
                    *c
                };
                let title = req.body.as_ref().unwrap()["properties"]["title"]["title"][0]["text"]["content"].as_str().unwrap().to_string();
                let id = format!("{n:08x}-0000-0000-0000-000000000000");
                self.children.lock().unwrap().push((id.clone(), title));
                return ok(json!({"id": id, "url": "https://notion.so/new"}));
            }
            if req.path.starts_with(&format!("/v1/blocks/{HOME}/children")) {
                let results: Vec<Value> = self.children.lock().unwrap().iter().map(|(id, t)| json!({"type": "child_page", "id": id, "child_page": {"title": t}})).collect();
                return ok(json!({"results": results, "has_more": false}));
            }
            if let Some(id) = req.path.strip_prefix("/v1/pages/") {
                if id == HOME {
                    return ok(json!({"object": "page", "id": HOME, "url": "https://notion.so/home", "properties": {"title": {"type": "title", "title": [{"plain_text": "Markdown Companion"}]}}}));
                }
                if self.children.lock().unwrap().iter().any(|(c, _)| c == id) {
                    let trashed = self.trashed.lock().unwrap().contains(&id.to_string());
                    return ok(json!({"object": "page", "id": id, "in_trash": trashed}));
                }
                return Ok(Response { status: 404, retry_after: None, body: json!({}) });
            }
            panic!("unexpected request {} {}", req.method, req.path);
        }
    }

    fn setup(name: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("mdc-home-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Store::load_with(dir.join("store.json"), Arc::new(MemorySecrets::default()))
    }

    fn fake(children: &[(&str, &str)]) -> Fake {
        Fake { children: Mutex::new(children.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()), trashed: Mutex::new(vec![]), created: Mutex::new(0) }
    }

    #[test]
    fn the_four_sections_have_stable_keys_and_titles() {
        assert_eq!(SECTIONS.iter().map(|s| s.0).collect::<Vec<_>>(), vec!["notes", "meetings", "practice", "answers"]);
        assert_eq!(section_title("practice"), Some("Practice sessions"));
        assert_eq!(section_title("other"), None);
    }

    #[test]
    fn needs_a_home_page_first() {
        let store = setup("nohome");
        let http = fake(&[]);
        assert!(ensure_section(&Client::new(&http, "t"), &store, "notes").unwrap_err().contains("home page"));
        assert_eq!(*http.created.lock().unwrap(), 0);
    }

    #[test]
    fn creates_a_section_once_and_reuses_it() {
        let store = setup("create");
        let http = fake(&[]);
        let c = Client::new(&http, "t");
        let home = set_home(&c, &store, HOME).unwrap();
        assert_eq!((home.title.as_str(), home.page_id.as_str()), ("Markdown Companion", HOME));
        let a = ensure_section(&c, &store, "notes").unwrap();
        let b = ensure_section(&c, &store, "notes").unwrap();
        assert_eq!(a, b);
        assert_eq!(*http.created.lock().unwrap(), 1);
        let m = ensure_section(&c, &store, "meetings").unwrap();
        assert_ne!(a, m);
        assert_eq!(*http.created.lock().unwrap(), 2);
    }

    #[test]
    fn reuses_a_page_that_already_exists_instead_of_duplicating() {
        let store = setup("reuse");
        let http = fake(&[("0000aaaa-0000-0000-0000-000000000000", "Notes")]);
        let c = Client::new(&http, "t");
        set_home(&c, &store, HOME).unwrap();
        // no saved record, but a "Notes" page is already there
        assert_eq!(ensure_section(&c, &store, "notes").unwrap(), "0000aaaa-0000-0000-0000-000000000000");
        assert_eq!(*http.created.lock().unwrap(), 0);
    }

    #[test]
    fn a_trashed_section_is_replaced_not_used() {
        let store = setup("trash");
        let http = fake(&[]);
        let c = Client::new(&http, "t");
        set_home(&c, &store, HOME).unwrap();
        let first = ensure_section(&c, &store, "notes").unwrap();
        http.trashed.lock().unwrap().push(first.clone());
        http.children.lock().unwrap().retain(|(_, t)| t != "Notes"); // gone from the listing too
        let again = ensure_section(&c, &store, "notes").unwrap();
        assert_ne!(first, again);
    }

    #[test]
    fn changing_the_home_page_forgets_the_old_sections() {
        let store = setup("change");
        let http = fake(&[]);
        let c = Client::new(&http, "t");
        set_home(&c, &store, HOME).unwrap();
        ensure_section(&c, &store, "notes").unwrap();
        assert!(store.notion_section("notes").is_some());
        set_home(&c, &store, HOME).unwrap();
        assert!(store.notion_section("notes").is_none());
    }
}
