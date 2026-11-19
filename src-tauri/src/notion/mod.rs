//! Notion connection: a small client for the official REST API (https://developers.notion.com).
//!
//! All requests are made here, in Rust, so the token never reaches the web view. The client retries rate limits
//! (429/529) using `Retry-After`, turns API errors into plain messages, and never sends anything that could
//! delete content (no `allow_deleting_content`). Network access goes through the `Http` trait so tests use a fake.

use serde::Serialize;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub mod db;
pub mod dest;
pub mod edit;
pub mod home;
pub mod tasks;
pub mod sync;

use crate::secrets::SecretStore;

pub const API_VERSION: &str = "2026-03-11";
const BASE: &str = "https://api.notion.com";
const MAX_ATTEMPTS: u32 = 3;
/// Longest single wait we accept. Notion says a connection-level `Retry-After` is at most 60 seconds.
const MAX_WAIT_SECS: u64 = 30;
/// Notion rejects requests over 500 KB; stay under it so the error is ours and clear.
const MAX_MARKDOWN_BYTES: usize = 400_000;
const MAX_TITLE_CHARS: usize = 2_000;

pub struct Request {
    pub method: &'static str,
    pub path: String,
    pub body: Option<Value>,
}

pub struct Response {
    pub status: u16,
    pub retry_after: Option<u64>,
    pub body: Value,
}

pub trait Http: Send + Sync {
    fn send(&self, token: &str, req: &Request) -> Result<Response, String>;
}

/// The real network.
pub struct Network;

impl Http for Network {
    fn send(&self, token: &str, req: &Request) -> Result<Response, String> {
        let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(30)).build();
        let r = agent
            .request(req.method, &format!("{BASE}{}", req.path))
            .set("Authorization", &format!("Bearer {token}"))
            .set("Notion-Version", API_VERSION)
            .set("User-Agent", "markdown-companion");
        let result = match &req.body {
            Some(b) => r.send_json(b.clone()),
            None => r.call(),
        };
        let resp = match result {
            Ok(resp) => resp,
            Err(ureq::Error::Status(_, resp)) => resp,
            Err(ureq::Error::Transport(_)) => return Err("Could not reach Notion. Check your internet connection.".into()),
        };
        let status = resp.status();
        let retry_after = resp.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok());
        let body = resp.into_json::<Value>().unwrap_or(Value::Null);
        Ok(Response { status, retry_after, body })
    }
}

/// A plain-language message for an error response. The API's own message is kept when it has one.
fn describe(status: u16, body: &Value) -> String {
    let api = body.get("message").and_then(Value::as_str).unwrap_or("").trim();
    let base = match status {
        401 => "Notion rejected the token. It may be wrong or revoked.".to_string(),
        403 => "The Notion connection does not have permission for that. Check its capabilities in Notion.".to_string(),
        404 => "Notion could not find that page, or it has not been shared with the connection.".to_string(),
        400 => "Notion refused the request.".to_string(),
        429 | 529 => "Notion is busy and asked us to slow down. Try again in a moment.".to_string(),
        s if s >= 500 => "Notion had a problem on its side. Try again in a moment.".to_string(),
        s => format!("Notion returned an unexpected error ({s})."),
    };
    if api.is_empty() || matches!(status, 401 | 403 | 404) { base } else { format!("{base} ({api})") }
}

pub struct Client<'a> {
    http: &'a dyn Http,
    token: String,
    sleep: Box<dyn Fn(Duration) + Send + Sync + 'a>,
}

impl<'a> Client<'a> {
    pub fn new(http: &'a dyn Http, token: &str) -> Self {
        Client { http, token: token.to_string(), sleep: Box::new(std::thread::sleep) }
    }

    #[cfg(test)]
    fn with_sleep(mut self, f: impl Fn(Duration) + Send + Sync + 'a) -> Self {
        self.sleep = Box::new(f);
        self
    }

    /// Sends a request, retrying rate limits and brief server trouble. Returns the body of a 2xx response.
    fn call(&self, method: &'static str, path: &str, body: Option<Value>) -> Result<Value, String> {
        let req = Request { method, path: path.to_string(), body };
        let mut attempt = 0;
        loop {
            attempt += 1;
            let resp = self.http.send(&self.token, &req)?;
            if (200..300).contains(&resp.status) {
                return Ok(resp.body);
            }
            let wait = match resp.status {
                429 | 529 => Some(resp.retry_after.unwrap_or(1).clamp(1, MAX_WAIT_SECS)),
                503 => Some(u64::from(attempt)),
                _ => None,
            };
            match wait {
                Some(secs) if attempt < MAX_ATTEMPTS => (self.sleep)(Duration::from_secs(secs)),
                _ => return Err(describe(resp.status, &resp.body)),
            }
        }
    }

    /// The connection's own bot user: proves the token works and names the workspace.
    pub fn me(&self) -> Result<Me, String> {
        let v = self.call("GET", "/v1/users/me", None)?;
        Ok(Me {
            name: v.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
            workspace: v.pointer("/bot/workspace_name").and_then(Value::as_str).unwrap_or("").to_string(),
        })
    }

    /// Pages the connection can see, matched by title (Notion search does not look inside page text).
    pub fn search_pages(&self, query: &str) -> Result<Vec<PageHit>, String> {
        let mut body = json!({ "filter": { "property": "object", "value": "page" }, "page_size": 20 });
        // An empty query lists whatever the connection can see, which also shows what has been shared with it.
        if !query.trim().is_empty() {
            body["query"] = json!(query.trim());
        }
        let v = self.call("POST", "/v1/search", Some(body))?;
        Ok(v.get("results").and_then(Value::as_array).map(|a| a.iter().filter_map(page_hit).collect()).unwrap_or_default())
    }

    /// Creates a child page with the Markdown as its content. Never overwrites anything.
    pub fn create_page(&self, parent_page_id: &str, title: &str, markdown: &str) -> Result<Created, String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("Give the page a title.".into());
        }
        if title.chars().count() > MAX_TITLE_CHARS {
            return Err("That title is too long for Notion.".into());
        }
        if markdown.len() > MAX_MARKDOWN_BYTES {
            return Err("That note is too large to send to Notion in one go.".into());
        }
        let id = parse_page_id(parent_page_id).ok_or("That is not a Notion page link or id.")?;
        let v = self.call(
            "POST",
            "/v1/pages",
            Some(json!({
                "parent": { "page_id": id },
                "properties": { "title": { "title": [{ "text": { "content": title } }] } },
                "markdown": markdown,
                "markdown_version": "v2",
            })),
        )?;
        Ok(Created {
            id: v.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
            url: v.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
        })
    }

    /// Databases (data sources) the connection can see, by title.
    pub fn search_data_sources(&self, query: &str) -> Result<Vec<PageHit>, String> {
        let mut body = json!({ "filter": { "property": "object", "value": "data_source" }, "page_size": 20 });
        if !query.trim().is_empty() {
            body["query"] = json!(query.trim());
        }
        let v = self.call("POST", "/v1/search", Some(body))?;
        Ok(v.get("results")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter(|r| r.get("object").and_then(Value::as_str) == Some("data_source"))
                    .filter_map(|r| {
                        let schema = db::schema_from(r)?;
                        Some(PageHit { id: schema.id, title: schema.title, url: r.get("url").and_then(Value::as_str).unwrap_or("").to_string() })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    /// One page of rows from a database. Returns the rows, the cursor for the next page, and whether Notion says the
    /// result is incomplete (it caps a query at 10,000 rows).
    pub fn query_data_source(&self, ds: &str, filter: Option<Value>, cursor: Option<&str>) -> Result<(Vec<Value>, Option<String>, bool), String> {
        let id = parse_page_id(ds).ok_or("That is not a Notion database link or id.")?;
        let mut body = json!({ "page_size": 100 });
        if let Some(f) = filter {
            body["filter"] = f;
        }
        if let Some(c) = cursor {
            body["start_cursor"] = json!(c);
        }
        let v = self.call("POST", &format!("/v1/data_sources/{id}/query"), Some(body))?;
        let rows = v.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
        let next = if v.get("has_more").and_then(Value::as_bool) == Some(true) { v.get("next_cursor").and_then(Value::as_str).map(str::to_string) } else { None };
        let incomplete = v.pointer("/request_status/type").and_then(Value::as_str) == Some("incomplete");
        Ok((rows, next, incomplete))
    }

    /// The whole page object (properties, parent, trash flag).
    pub fn get_page(&self, page: &str) -> Result<Value, String> {
        let id = parse_page_id(page).ok_or("That is not a Notion page link or id.")?;
        self.call("GET", &format!("/v1/pages/{id}"), None)
    }

    /// Changes only the properties given; every other property and the page's content are left alone.
    pub fn update_properties(&self, page: &str, properties: Value) -> Result<(), String> {
        let id = parse_page_id(page).ok_or("That is not a Notion page link or id.")?;
        self.call("PATCH", &format!("/v1/pages/{id}"), Some(json!({ "properties": properties })))?;
        Ok(())
    }

    /// A database's current properties, limited to the ones MC can write.
    pub fn data_source_schema(&self, id: &str) -> Result<db::Schema, String> {
        let id = parse_page_id(id).ok_or("That is not a Notion database link or id.")?;
        let v = self.call("GET", &format!("/v1/data_sources/{id}"), None)?;
        db::schema_from(&v).ok_or_else(|| "Notion did not return a database.".to_string())
    }

    /// Adds a row (a page) to a database with the given properties and Markdown content.
    pub fn create_row(&self, data_source_id: &str, properties: Value, markdown: &str) -> Result<Created, String> {
        let id = parse_page_id(data_source_id).ok_or("That is not a Notion database link or id.")?;
        if markdown.len() > MAX_MARKDOWN_BYTES {
            return Err("That is too large to send to Notion in one go.".into());
        }
        let mut body = json!({ "parent": { "type": "data_source_id", "data_source_id": id }, "properties": properties });
        if !markdown.trim().is_empty() {
            body["markdown"] = json!(markdown);
            body["markdown_version"] = json!("v2");
        }
        let v = self.call("POST", "/v1/pages", Some(body))?;
        Ok(Created { id: v.get("id").and_then(Value::as_str).unwrap_or("").to_string(), url: v.get("url").and_then(Value::as_str).unwrap_or("").to_string() })
    }

    /// Creates an inline database under a page, with the given properties. Returns the data source id, which is what
    /// rows are added to. Only ever called when the user presses a button; it creates something new and changes nothing.
    pub fn create_database(&self, parent_page_id: &str, title: &str, properties: Value) -> Result<String, String> {
        let parent = parse_page_id(parent_page_id).ok_or("That is not a Notion page link or id.")?;
        let v = self.call(
            "POST",
            "/v1/databases",
            Some(json!({
                "parent": { "type": "page_id", "page_id": parent },
                "title": [{ "type": "text", "text": { "content": title } }],
                "is_inline": true,
                "initial_data_source": { "properties": properties },
            })),
        )?;
        let first = |v: &Value| v.pointer("/data_sources/0/id").and_then(Value::as_str).map(str::to_string);
        if let Some(id) = first(&v) {
            return Ok(id);
        }
        // A short response carries only the database id; ask for the database to learn its data source.
        let db_id = v.get("id").and_then(Value::as_str).ok_or("Notion did not return the new database.")?.to_string();
        let full = self.call("GET", &format!("/v1/databases/{db_id}"), None)?;
        first(&full).ok_or_else(|| "The database was created, but Notion did not say which data source it has. Choose it with CHOOSE DATABASE.".to_string())
    }

    /// Titles of the databases directly inside a page (looks at up to 300 children).
    pub fn child_database_titles(&self, parent_page_id: &str) -> Result<Vec<String>, String> {
        let id = parse_page_id(parent_page_id).ok_or("That is not a Notion page link or id.")?;
        let mut cursor: Option<String> = None;
        let mut out = Vec::new();
        for _ in 0..3 {
            let path = match &cursor {
                Some(c) => format!("/v1/blocks/{id}/children?page_size=100&start_cursor={c}"),
                None => format!("/v1/blocks/{id}/children?page_size=100"),
            };
            let v = self.call("GET", &path, None)?;
            for b in v.get("results").and_then(Value::as_array).into_iter().flatten() {
                if b.get("type").and_then(Value::as_str) == Some("child_database")
                    && let Some(t) = b.pointer("/child_database/title").and_then(Value::as_str)
                {
                    out.push(t.to_string());
                }
            }
            cursor = v.get("next_cursor").and_then(Value::as_str).map(str::to_string);
            if v.get("has_more").and_then(Value::as_bool) != Some(true) || cursor.is_none() {
                break;
            }
        }
        Ok(out)
    }

    /// A new, empty page under a page. Used for the section pages (Notes, Meetings, …).
    pub fn create_empty_page(&self, parent_page_id: &str, title: &str) -> Result<Created, String> {
        let id = parse_page_id(parent_page_id).ok_or("That is not a Notion page link or id.")?;
        let v = self.call(
            "POST",
            "/v1/pages",
            Some(json!({ "parent": { "page_id": id }, "properties": { "title": { "title": [{ "text": { "content": title.trim() } }] } } })),
        )?;
        Ok(Created { id: v.get("id").and_then(Value::as_str).unwrap_or("").to_string(), url: v.get("url").and_then(Value::as_str).unwrap_or("").to_string() })
    }

    /// The id of a direct child page with exactly this title, if there is one. Scans up to 300 children.
    pub fn find_child_page(&self, parent_page_id: &str, title: &str) -> Result<Option<String>, String> {
        let id = parse_page_id(parent_page_id).ok_or("That is not a Notion page link or id.")?;
        let mut cursor: Option<String> = None;
        for _ in 0..3 {
            let path = match &cursor {
                Some(c) => format!("/v1/blocks/{id}/children?page_size=100&start_cursor={c}"),
                None => format!("/v1/blocks/{id}/children?page_size=100"),
            };
            let v = self.call("GET", &path, None)?;
            for b in v.get("results").and_then(Value::as_array).into_iter().flatten() {
                if b.get("type").and_then(Value::as_str) == Some("child_page") && b.pointer("/child_page/title").and_then(Value::as_str) == Some(title) {
                    return Ok(b.get("id").and_then(Value::as_str).map(str::to_string));
                }
            }
            if v.get("has_more").and_then(Value::as_bool) != Some(true) {
                break;
            }
            cursor = v.get("next_cursor").and_then(Value::as_str).map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(None)
    }

    /// False when the page was deleted. A page in the trash still answers, so check that flag too.
    pub fn page_exists(&self, page: &str) -> Result<bool, String> {
        let id = parse_page_id(page).ok_or("That is not a Notion page link or id.")?;
        match self.call("GET", &format!("/v1/pages/{id}"), None) {
            Ok(v) => Ok(!(v.get("in_trash").and_then(Value::as_bool).unwrap_or(false) || v.get("archived").and_then(Value::as_bool).unwrap_or(false))),
            Err(e) if e.contains("could not find") => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// One targeted search-and-replace edit. `old_str` must match exactly one place. Never allows deleting child
    /// pages or databases (that stays at Notion's default of refusing). Returns the page's Markdown afterwards.
    pub fn update_content(&self, page: &str, old_str: &str, new_str: &str) -> Result<Updated, String> {
        let id = parse_page_id(page).ok_or("That is not a Notion page link or id.")?;
        let v = self.call(
            "PATCH",
            &format!("/v1/pages/{id}/markdown"),
            Some(json!({
                "type": "update_content",
                "update_content": { "content_updates": [{ "old_str": old_str, "new_str": new_str }] },
                "markdown_version": "v2",
            })),
        )?;
        let warnings = v
            .get("warnings")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .map(|w| w.as_str().map(str::to_string).or_else(|| w.get("message").and_then(Value::as_str).map(str::to_string)).unwrap_or_else(|| w.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        Ok(Updated { markdown: v.get("markdown").and_then(Value::as_str).unwrap_or("").to_string(), truncated: v.get("truncated").and_then(Value::as_bool).unwrap_or(false), warnings })
    }

    /// The page's title and link.
    pub fn page_info(&self, page: &str) -> Result<PageHit, String> {
        let id = parse_page_id(page).ok_or("That is not a Notion page link or id.")?;
        let v = self.call("GET", &format!("/v1/pages/{id}"), None)?;
        page_hit(&v).ok_or_else(|| "Notion did not return a page.".to_string())
    }

    /// The page's content as Markdown. `unknown_block_ids` lists blocks Markdown cannot show.
    pub fn read_page(&self, page: &str) -> Result<PageMarkdown, String> {
        let id = parse_page_id(page).ok_or("That is not a Notion page link or id.")?;
        let v = self.call("GET", &format!("/v1/pages/{id}/markdown?markdown_version=v2"), None)?;
        Ok(PageMarkdown {
            markdown: v.get("markdown").and_then(Value::as_str).unwrap_or("").to_string(),
            truncated: v.get("truncated").and_then(Value::as_bool).unwrap_or(false),
            unknown_block_ids: v
                .get("unknown_block_ids")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
        })
    }
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Me {
    pub name: String,
    pub workspace: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct PageHit {
    pub id: String,
    pub title: String,
    pub url: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Created {
    pub id: String,
    pub url: String,
}

#[derive(Debug, PartialEq)]
pub struct Updated {
    pub markdown: String,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct PageMarkdown {
    pub markdown: String,
    pub truncated: bool,
    pub unknown_block_ids: Vec<String>,
}

fn page_hit(v: &Value) -> Option<PageHit> {
    if v.get("object").and_then(Value::as_str) != Some("page") {
        return None;
    }
    let id = v.get("id")?.as_str()?.to_string();
    let title = v
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|props| props.values().find(|p| p.get("type").and_then(Value::as_str) == Some("title")))
        .and_then(|p| p.get("title"))
        .and_then(Value::as_array)
        .map(|parts| parts.iter().filter_map(|t| t.get("plain_text").and_then(Value::as_str)).collect::<String>())
        .unwrap_or_default();
    let url = v.get("url").and_then(Value::as_str).unwrap_or("").to_string();
    Some(PageHit { id, title: if title.trim().is_empty() { "Untitled".into() } else { title }, url })
}

/// Pulls a page id out of a pasted Notion link or a bare id (with or without dashes) and returns it dashed.
/// A Notion URL ends with the id: `https://www.notion.so/Workspace/My-Page-1429989fe8ac4effbc8f57f56486db54`.
pub fn parse_page_id(input: &str) -> Option<String> {
    let s = input.trim();
    let s = s.split(['?', '#']).next().unwrap_or(s);
    let tail = s.rsplit('/').next().unwrap_or(s);
    let hex: String = tail.chars().filter(|c| *c != '-').collect();
    let id: String = if hex.len() >= 32 && hex.is_char_boundary(hex.len() - 32) { hex[hex.len() - 32..].to_string() } else { return None };
    if !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let id = id.to_lowercase();
    Some(format!("{}-{}-{}-{}-{}", &id[0..8], &id[8..12], &id[12..16], &id[16..20], &id[20..32]))
}

/// What changed since the last sync, judged by content hashes (not timestamps).
#[derive(Serialize, Debug, PartialEq, Clone, Copy)]
#[serde(rename_all = "snake_case")]
pub enum SyncState {
    InSync,
    LocalChanged,
    RemoteChanged,
    Both,
}

pub fn sync_state(link: &crate::store::NotionLink, local_hash: &str, remote_hash: &str) -> SyncState {
    match (local_hash != link.local_hash, remote_hash != link.remote_hash) {
        (false, false) => SyncState::InSync,
        (true, false) => SyncState::LocalChanged,
        (false, true) => SyncState::RemoteChanged,
        (true, true) => SyncState::Both,
    }
}

fn snapshot_path(dir: &std::path::Path, file_id: &str) -> Result<std::path::PathBuf, String> {
    if file_id.is_empty() || !file_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Unknown file.".into());
    }
    Ok(dir.join(format!("{file_id}.md")))
}

/// Keeps the Notion Markdown as of the last sync. It is the base for a later three-way comparison.
pub fn save_snapshot(dir: &std::path::Path, file_id: &str, markdown: &str) -> Result<(), String> {
    let path = snapshot_path(dir, file_id)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, markdown).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn load_snapshot(dir: &std::path::Path, file_id: &str) -> Option<String> {
    std::fs::read_to_string(snapshot_path(dir, file_id).ok()?).ok()
}

/// A pasted token: one line, no spaces, a sane length. Whether Notion accepts it is checked with a real call.
pub fn clean_token(raw: &str) -> Result<String, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("Paste the connection token from Notion.".into());
    }
    if t.len() > 500 || t.chars().any(char::is_whitespace) {
        return Err("That does not look like a Notion token.".into());
    }
    Ok(t.to_string())
}

/// The stored connection. The token lives in the OS credential store; this keeps a copy in memory.
pub struct NotionState {
    secrets: Arc<dyn SecretStore>,
    cache: Mutex<Option<Option<String>>>,
}

impl NotionState {
    pub fn new(secrets: Arc<dyn SecretStore>) -> Self {
        NotionState { secrets, cache: Mutex::new(None) }
    }

    pub fn token(&self) -> Result<Option<String>, String> {
        let mut c = self.cache.lock().unwrap();
        if c.is_none() {
            *c = Some(self.secrets.get()?);
        }
        Ok(c.clone().flatten())
    }

    pub fn require_token(&self) -> Result<String, String> {
        self.token()?.ok_or_else(|| "Connect Notion first (Settings → Notion).".to_string())
    }

    /// Checks the token against Notion, then stores it. A rejected token is never stored.
    pub fn connect(&self, http: &dyn Http, raw: &str) -> Result<Me, String> {
        let token = clean_token(raw)?;
        let me = Client::new(http, &token).me()?;
        self.secrets.set(&token).map_err(|e| format!("Could not save the token in the system credential store: {e}"))?;
        *self.cache.lock().unwrap() = Some(Some(token));
        Ok(me)
    }

    pub fn disconnect(&self) -> Result<(), String> {
        self.secrets.delete()?;
        *self.cache.lock().unwrap() = Some(None);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecrets;
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// (method, path, body, token) of one request.
    type Seen = (String, String, Option<Value>, String);

    /// Plays back canned responses and records what was asked.
    struct Fake {
        replies: Mutex<VecDeque<Response>>,
        seen: Mutex<Vec<Seen>>,
    }

    impl Fake {
        fn new(replies: Vec<(u16, Option<u64>, Value)>) -> Self {
            Fake {
                replies: Mutex::new(replies.into_iter().map(|(status, retry_after, body)| Response { status, retry_after, body }).collect()),
                seen: Mutex::new(vec![]),
            }
        }
    }

    impl Http for Fake {
        fn send(&self, token: &str, req: &Request) -> Result<Response, String> {
            self.seen.lock().unwrap().push((req.method.into(), req.path.clone(), req.body.clone(), token.into()));
            Ok(self.replies.lock().unwrap().pop_front().expect("unexpected extra request"))
        }
    }

    const ID: &str = "1429989f-e8ac-4eff-bc8f-57f56486db54";

    #[test]
    fn extracts_ids_from_links_and_bare_ids() {
        assert_eq!(parse_page_id(&format!("https://www.notion.so/Work/My-Page-{}", ID.replace('-', ""))).as_deref(), Some(ID));
        assert_eq!(parse_page_id(&format!("https://www.notion.so/{}?v=abc#frag", ID.replace('-', ""))).as_deref(), Some(ID));
        assert_eq!(parse_page_id(ID).as_deref(), Some(ID));
        assert_eq!(parse_page_id(&ID.to_uppercase()).as_deref(), Some(ID));
        for bad in ["", "hello", "https://notion.so/abc", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", "é"] {
            assert_eq!(parse_page_id(bad), None, "{bad}");
        }
    }

    fn link(local: &str, remote: &str) -> crate::store::NotionLink {
        crate::store::NotionLink { page_id: "p".into(), url: "u".into(), title: "t".into(), local_hash: local.into(), remote_hash: remote.into(), synced_secs: 0 }
    }

    #[test]
    fn judges_sync_state_from_hashes() {
        let l = link("a", "b");
        assert_eq!(sync_state(&l, "a", "b"), SyncState::InSync);
        assert_eq!(sync_state(&l, "x", "b"), SyncState::LocalChanged);
        assert_eq!(sync_state(&l, "a", "y"), SyncState::RemoteChanged);
        assert_eq!(sync_state(&l, "x", "y"), SyncState::Both);
    }

    #[test]
    fn snapshots_round_trip_and_reject_unsafe_ids() {
        let dir = std::env::temp_dir().join(format!("mdc-snap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(load_snapshot(&dir, "f1"), None);
        save_snapshot(&dir, "f1", "# one").unwrap();
        save_snapshot(&dir, "f1", "# two").unwrap();
        assert_eq!(load_snapshot(&dir, "f1").as_deref(), Some("# two"));
        for bad in ["", "../x", "a/b", "a.b"] {
            assert!(save_snapshot(&dir, bad, "x").is_err(), "{bad}");
        }
    }

    #[test]
    fn updates_with_one_targeted_edit_and_never_allows_deleting() {
        let http = Fake::new(vec![(200, None, json!({"markdown": "# New\n", "truncated": false, "warnings": [{"message": "tag fixed"}, "plain"]}))]);
        let u = Client::new(&http, "t").update_content(ID, "# Old", "# New").unwrap();
        assert_eq!(u, Updated { markdown: "# New\n".into(), truncated: false, warnings: vec!["tag fixed".into(), "plain".into()] });
        let seen = http.seen.lock().unwrap();
        assert_eq!((seen[0].0.as_str(), seen[0].1.as_str()), ("PATCH", format!("/v1/pages/{ID}/markdown").as_str()));
        let body = seen[0].2.as_ref().unwrap();
        assert_eq!(body["type"], "update_content");
        assert_eq!(body["update_content"]["content_updates"].as_array().unwrap().len(), 1);
        assert_eq!(body["update_content"]["content_updates"][0]["old_str"], "# Old");
        assert!(!body.to_string().contains("allow_deleting_content"));
        assert!(!body.to_string().contains("replace_content"));
    }

    #[test]
    fn reads_a_page_title() {
        let http = Fake::new(vec![(200, None, json!({"object": "page", "id": "a", "properties": {"title": {"type": "title", "title": [{"plain_text": "Roadmap"}]}}}))]);
        let info = Client::new(&http, "t").page_info(ID).unwrap();
        assert_eq!(info.title, "Roadmap");
        assert_eq!(http.seen.lock().unwrap()[0].1, format!("/v1/pages/{ID}"));
    }

    #[test]
    fn cleans_tokens() {
        assert_eq!(clean_token("  ntn_abc  ").unwrap(), "ntn_abc");
        assert!(clean_token("  ").is_err());
        assert!(clean_token("two words").is_err());
        assert!(clean_token(&"x".repeat(501)).is_err());
    }

    #[test]
    fn retries_a_rate_limit_using_retry_after_then_succeeds() {
        let http = Fake::new(vec![(429, Some(7), json!({})), (200, None, json!({"name": "MC", "bot": {"workspace_name": "Acme"}}))]);
        let waits = Mutex::new(vec![]);
        let me = Client::new(&http, "tok").with_sleep(|d| waits.lock().unwrap().push(d)).me().unwrap();
        assert_eq!(me, Me { name: "MC".into(), workspace: "Acme".into() });
        assert_eq!(*waits.lock().unwrap(), vec![Duration::from_secs(7)]);
        assert_eq!(http.seen.lock().unwrap().len(), 2);
    }

    #[test]
    fn caps_the_wait_and_gives_up_after_three_attempts() {
        let http = Fake::new(vec![(429, Some(500), json!({})), (529, None, json!({})), (429, Some(1), json!({}))]);
        let waits = Mutex::new(vec![]);
        let err = Client::new(&http, "tok").with_sleep(|d| waits.lock().unwrap().push(d)).me().unwrap_err();
        assert!(err.contains("slow down"), "{err}");
        assert_eq!(*waits.lock().unwrap(), vec![Duration::from_secs(MAX_WAIT_SECS), Duration::from_secs(1)]);
    }

    #[test]
    fn does_not_retry_client_errors() {
        let calls = AtomicU32::new(0);
        for (status, needle) in [(401, "rejected the token"), (403, "permission"), (404, "not been shared")] {
            let http = Fake::new(vec![(status, None, json!({"message": "internal detail"}))]);
            let err = Client::new(&http, "tok").with_sleep(|_| { calls.fetch_add(1, Ordering::SeqCst); }).me().unwrap_err();
            assert!(err.contains(needle), "{err}");
            assert!(!err.contains("internal detail"), "{err}");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn keeps_notions_message_for_validation_errors() {
        let http = Fake::new(vec![(400, None, json!({"message": "body.markdown is too large"}))]);
        let err = Client::new(&http, "tok").me().unwrap_err();
        assert!(err.contains("body.markdown is too large"), "{err}");
    }

    #[test]
    fn creates_a_page_with_v2_markdown_and_never_allows_deleting() {
        let http = Fake::new(vec![(200, None, json!({"id": "new-id", "url": "https://notion.so/x"}))]);
        let made = Client::new(&http, "secret").create_page(&format!("https://notion.so/P-{}", ID.replace('-', "")), "  My note ", "# Hi\n\n- [ ] a").unwrap();
        assert_eq!(made, Created { id: "new-id".into(), url: "https://notion.so/x".into() });
        let seen = http.seen.lock().unwrap();
        let (method, path, body, token) = &seen[0];
        assert_eq!((method.as_str(), path.as_str(), token.as_str()), ("POST", "/v1/pages", "secret"));
        let body = body.as_ref().unwrap();
        assert_eq!(body["parent"]["page_id"], ID);
        assert_eq!(body["properties"]["title"]["title"][0]["text"]["content"], "My note");
        assert_eq!(body["markdown"], "# Hi\n\n- [ ] a");
        assert_eq!(body["markdown_version"], "v2");
        assert!(!body.to_string().contains("allow_deleting_content"));
        assert!(body.get("children").is_none());
    }

    #[test]
    fn rejects_bad_create_input_before_any_request() {
        let http = Fake::new(vec![]);
        let c = Client::new(&http, "t");
        assert!(c.create_page(ID, "  ", "x").is_err());
        assert!(c.create_page("nonsense", "T", "x").is_err());
        assert!(c.create_page(ID, "T", &"x".repeat(MAX_MARKDOWN_BYTES + 1)).unwrap_err().contains("too large"));
        assert!(c.create_page(ID, &"t".repeat(MAX_TITLE_CHARS + 1), "x").is_err());
        assert!(http.seen.lock().unwrap().is_empty());
    }

    #[test]
    fn reads_markdown_and_reports_unknown_blocks() {
        let http = Fake::new(vec![(200, None, json!({"markdown": "# T", "truncated": true, "unknown_block_ids": ["b1", "b2"]}))]);
        let p = Client::new(&http, "t").read_page(ID).unwrap();
        assert_eq!(p, PageMarkdown { markdown: "# T".into(), truncated: true, unknown_block_ids: vec!["b1".into(), "b2".into()] });
        assert_eq!(http.seen.lock().unwrap()[0].1, format!("/v1/pages/{ID}/markdown?markdown_version=v2"));
    }

    #[test]
    fn search_returns_only_pages_with_their_titles() {
        let http = Fake::new(vec![(200, None, json!({"results": [
            {"object": "page", "id": "a", "url": "u1", "properties": {"Name": {"type": "title", "title": [{"plain_text": "Sprint "}, {"plain_text": "plan"}]}}},
            {"object": "page", "id": "b", "url": "u2", "properties": {}},
            {"object": "data_source", "id": "c"}
        ]}))]);
        let hits = Client::new(&http, "t").search_pages(" sprint ").unwrap();
        assert_eq!(hits, vec![PageHit { id: "a".into(), title: "Sprint plan".into(), url: "u1".into() }, PageHit { id: "b".into(), title: "Untitled".into(), url: "u2".into() }]);
        assert_eq!(http.seen.lock().unwrap()[0].2.as_ref().unwrap()["query"], "sprint");
        let all = Fake::new(vec![(200, None, json!({"results": []}))]);
        Client::new(&all, "t").search_pages("  ").unwrap();
        assert!(all.seen.lock().unwrap()[0].2.as_ref().unwrap().get("query").is_none());
    }

    #[test]
    fn a_rejected_token_is_never_stored_and_an_accepted_one_is() {
        let secrets = Arc::new(MemorySecrets::default());
        let state = NotionState::new(secrets.clone());
        let bad = Fake::new(vec![(401, None, json!({}))]);
        assert!(state.connect(&bad, "ntn_bad").is_err());
        assert_eq!(state.token().unwrap(), None);
        assert_eq!(secrets.get().unwrap(), None);

        let good = Fake::new(vec![(200, None, json!({"name": "MC", "bot": {"workspace_name": "Acme"}}))]);
        assert_eq!(state.connect(&good, " ntn_ok ").unwrap().workspace, "Acme");
        assert_eq!(state.token().unwrap().as_deref(), Some("ntn_ok"));
        assert_eq!(secrets.get().unwrap().as_deref(), Some("ntn_ok"));

        state.disconnect().unwrap();
        assert_eq!(state.token().unwrap(), None);
        assert_eq!(secrets.get().unwrap(), None);
        assert!(state.require_token().unwrap_err().contains("Connect Notion"));
    }

    #[test]
    fn a_locked_credential_store_is_reported_not_swallowed() {
        let secrets = Arc::new(MemorySecrets::default());
        secrets.fail.store(true, Ordering::SeqCst);
        let state = NotionState::new(secrets);
        let ok = Fake::new(vec![(200, None, json!({}))]);
        assert!(state.connect(&ok, "ntn_x").unwrap_err().contains("credential store"));
        assert_eq!(state.token().ok().flatten(), None);
    }

    /// Talks to the real Notion API with a made-up token (sends no user data). Run manually:
    /// `cargo test --lib network_rejects_a_bad_token -- --ignored`
    #[test]
    #[ignore]
    fn network_rejects_a_bad_token() {
        let err = Client::new(&Network, "ntn_not_a_real_token").me().unwrap_err();
        assert!(err.contains("rejected the token"), "{err}");
    }
}
