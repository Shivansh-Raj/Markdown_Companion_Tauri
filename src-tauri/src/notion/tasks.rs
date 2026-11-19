//! Open tasks from the Notion Tasks database, and setting a task's status.
//!
//! Reads use the field mapping chosen in Settings, so any database layout works. A task is "done" when its status is
//! one of the usual finished names; ticking one sets the mapped status property to such an option, only after checking
//! that the task still has the status the user saw. Nothing else on the page is touched.

use serde::Serialize;
use serde_json::{Value, json};

use super::db::{PropSchema as Prop, Schema};
use super::{Client, parse_page_id};
use crate::store::Store;

const DONE_NAMES: &[&str] = &["done", "complete", "completed", "finished", "closed"];
const MAX_PAGES: usize = 3;

fn is_done_name(s: &str) -> bool {
    DONE_NAMES.contains(&s.trim().to_lowercase().as_str())
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct NotionTask {
    pub id: String,
    pub title: String,
    pub due: Option<String>,
    pub status: Option<String>,
    pub owner: Option<String>,
    pub url: String,
    /// Ids of the meeting pages this task is linked to (the mapped "Meeting" relation), dashed.
    pub meeting_ids: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct NotionTasksView {
    pub database: String,
    pub rows: Vec<NotionTask>,
    pub truncated: bool,
    /// The option that ticking a task sets, when the Status column is mapped and has a "done" option.
    pub done_status: Option<String>,
    /// Why ticking is not available, if it is not.
    pub read_only_reason: Option<String>,
    /// Whether the Meeting column is mapped, so tasks can be tied to meetings.
    pub links_meetings: bool,
}

struct Columns<'a> {
    title: &'a Prop,
    due: Option<&'a Prop>,
    status: Option<&'a Prop>,
    owner: Option<&'a Prop>,
    meeting: Option<&'a Prop>,
}

fn columns<'a>(schema: &'a Schema, mapping: &[super::db::MapEntry]) -> Result<Columns<'a>, String> {
    let find = |field: &str| mapping.iter().find(|m| m.field == field).and_then(|m| schema.properties.iter().find(|p| p.name == m.property));
    Ok(Columns {
        title: schema.properties.iter().find(|p| p.kind == "title").ok_or("The tasks database has no title column.")?,
        due: find("due").filter(|p| p.kind == "date"),
        status: find("status").filter(|p| matches!(p.kind.as_str(), "status" | "select")),
        owner: find("owner"),
        meeting: find("meeting").filter(|p| p.kind == "relation"),
    })
}

fn plain(parts: &Value) -> String {
    parts.as_array().map(|a| a.iter().filter_map(|t| t.get("plain_text").and_then(Value::as_str)).collect::<String>()).unwrap_or_default()
}

fn status_of(page: &Value, col: &Prop) -> Option<String> {
    page.get("properties")?.get(&col.name)?.get(&col.kind)?.get("name")?.as_str().map(str::to_string)
}

fn task_from(page: &Value, c: &Columns) -> Option<NotionTask> {
    let id = page.get("id")?.as_str()?.to_string();
    if page.get("in_trash").and_then(Value::as_bool).unwrap_or(false) || page.get("archived").and_then(Value::as_bool).unwrap_or(false) {
        return None;
    }
    // Property names are looked up directly, not as a JSON pointer, so a name containing "/" or "~" works.
    let get = |name: &str| page.get("properties").and_then(|p| p.get(name));
    let title = get(&c.title.name).and_then(|p| p.get("title")).map(plain).unwrap_or_default();
    let due = c.due.and_then(|p| get(&p.name)).and_then(|p| p.pointer("/date/start")).and_then(Value::as_str).map(|s| s.chars().take(10).collect());
    let owner = c.owner.and_then(|p| get(&p.name)).and_then(|p| match p.get("type").and_then(Value::as_str) {
        Some("rich_text") => Some(plain(p.get("rich_text")?)),
        Some("select") => p.pointer("/select/name").and_then(Value::as_str).map(str::to_string),
        _ => None,
    });
    Some(NotionTask {
        id,
        title: if title.trim().is_empty() { "Untitled".into() } else { title },
        due,
        status: c.status.and_then(|p| status_of(page, p)),
        owner: owner.filter(|o| !o.trim().is_empty()),
        url: page.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
        meeting_ids: c
            .meeting
            .and_then(|p| get(&p.name))
            .and_then(|p| p.get("relation"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|r| r.get("id").and_then(Value::as_str)).filter_map(parse_page_id).collect())
            .unwrap_or_default(),
    })
}

fn done_option(p: &Prop) -> Option<String> {
    p.options.iter().find(|o| is_done_name(o)).cloned()
}

/// Server-side filter that leaves out finished tasks, built from the status column's actual options.
fn open_filter(status: &Prop) -> Option<Value> {
    let clauses: Vec<Value> = status.options.iter().filter(|o| is_done_name(o)).map(|o| json!({ "property": status.name, status.kind.clone(): { "does_not_equal": o } })).collect();
    match clauses.len() {
        0 => None,
        1 => clauses.into_iter().next(),
        _ => Some(json!({ "and": clauses })),
    }
}

fn load(store: &Store) -> Result<crate::store::NotionDestination, String> {
    store.notion_destination("tasks").ok_or_else(|| "Set up a Tasks database first (Settings → Notion).".to_string())
}

/// The open tasks (up to 300), oldest due date first.
pub fn open_tasks(client: &Client, store: &Store) -> Result<NotionTasksView, String> {
    let dest = load(store)?;
    let schema = client.data_source_schema(&dest.data_source_id)?;
    let cols = columns(&schema, &dest.mapping)?;
    let filter = cols.status.and_then(open_filter);
    let mut rows = Vec::new();
    let mut cursor: Option<String> = None;
    let mut truncated = false;
    for page_no in 0..MAX_PAGES {
        let (results, next, incomplete) = client.query_data_source(&dest.data_source_id, filter.clone(), cursor.as_deref())?;
        rows.extend(results.iter().filter_map(|r| task_from(r, &cols)));
        truncated |= incomplete;
        cursor = next;
        if cursor.is_none() {
            break;
        }
        if page_no + 1 == MAX_PAGES {
            truncated = true;
        }
    }
    // With no server-side filter (unmapped or no "done" option), finished tasks are dropped here.
    rows.retain(|t| t.status.as_deref().is_none_or(|s| !is_done_name(s)));
    rows.sort_by(|a, b| a.due.is_none().cmp(&b.due.is_none()).then_with(|| a.due.cmp(&b.due)).then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase())));
    let done_status = cols.status.and_then(done_option);
    let read_only_reason = match (cols.status, &done_status) {
        (None, _) => Some("Map a Status column in Settings → Notion → Tasks to tick tasks off here.".to_string()),
        (Some(_), None) => Some("The Status column has no \"Done\" option, so tasks cannot be ticked off here.".to_string()),
        _ => None,
    };
    Ok(NotionTasksView { database: dest.title, rows, truncated, done_status, read_only_reason, links_meetings: cols.meeting.is_some() })
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StatusOutcome {
    Done,
    /// The task changed in Notion since it was shown, or is not in the Tasks database. Nothing was written.
    Stale,
}

/// Sets a task's status to `to`, but only if its current status is still `expect` (what the user saw) and `to` is one of
/// the column's real options. Only the status property is written.
pub fn set_status(client: &Client, store: &Store, page: &str, expect: Option<&str>, to: &str) -> Result<StatusOutcome, String> {
    let dest = load(store)?;
    let schema = client.data_source_schema(&dest.data_source_id)?;
    let cols = columns(&schema, &dest.mapping)?;
    let status = cols.status.ok_or("Map a Status column in Settings → Notion → Tasks first.")?;
    let option = status.options.iter().find(|o| o.as_str() == to).ok_or_else(|| format!("\"{to}\" is not one of the Status options."))?;
    let id = parse_page_id(page).ok_or("That is not a Notion page id.")?;
    let current = client.get_page(&id)?;
    let in_db = [current.pointer("/parent/data_source_id"), current.pointer("/parent/database_id")]
        .iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .any(|p| parse_page_id(p).as_deref() == parse_page_id(&dest.data_source_id).as_deref());
    let trashed = current.get("in_trash").and_then(Value::as_bool).unwrap_or(false);
    if !in_db || trashed || status_of(&current, status).as_deref() != expect {
        return Ok(StatusOutcome::Stale);
    }
    client.update_properties(&id, json!({ status.name.clone(): { status.kind.clone(): { "name": option } } }))?;
    Ok(StatusOutcome::Done)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notion::{Http, Request, Response};
    use crate::secrets::MemorySecrets;
    use crate::store::NotionDestination;
    use crate::notion::db::MapEntry;
    use std::sync::{Arc, Mutex};

    const DS: &str = "1429989f-e8ac-4eff-bc8f-57f56486db54";

    fn schema_json(status_kind: &str, with_done: bool) -> Value {
        let opts: Vec<Value> = if with_done { vec![json!({"name": "Not started"}), json!({"name": "In progress"}), json!({"name": "Done"})] } else { vec![json!({"name": "Open"}), json!({"name": "Waiting"})] };
        json!({"id": DS, "title": [{"plain_text": "Tasks"}], "properties": {
            "Name": {"id": "title", "name": "Name", "type": "title", "title": {}},
            "Due date": {"id": "d", "name": "Due date", "type": "date", "date": {}},
            "Status": {"id": "s", "name": "Status", "type": status_kind, status_kind: {"options": opts}},
            "Owner": {"id": "o", "name": "Owner", "type": "rich_text", "rich_text": {}}}})
    }

    fn row(id: &str, title: &str, due: Option<&str>, status: &str, kind: &str) -> Value {
        json!({"object": "page", "id": id, "url": format!("https://notion.so/{id}"), "parent": {"type": "data_source_id", "data_source_id": DS}, "properties": {
            "Name": {"type": "title", "title": [{"plain_text": title}]},
            "Due date": {"type": "date", "date": due.map(|d| json!({"start": d}))},
            "Status": {"type": kind, kind: {"name": status}},
            "Owner": {"type": "rich_text", "rich_text": [{"plain_text": "Sam"}]}}})
    }

    struct Fake {
        schema: Value,
        rows: Mutex<Vec<Value>>,
        queries: Mutex<Vec<Value>>,
        patches: Mutex<Vec<(String, Value)>>,
        pages: usize,
    }

    impl Http for Fake {
        fn send(&self, _t: &str, req: &Request) -> Result<Response, String> {
            let ok = |body: Value| Ok(Response { status: 200, retry_after: None, body });
            if req.method == "GET" && req.path == format!("/v1/data_sources/{DS}") {
                return ok(self.schema.clone());
            }
            if req.method == "POST" && req.path.ends_with("/query") {
                let body = req.body.clone().unwrap();
                let n = self.queries.lock().unwrap().len();
                self.queries.lock().unwrap().push(body);
                let rows = self.rows.lock().unwrap().clone();
                let more = n + 1 < self.pages;
                return ok(json!({"results": rows, "has_more": more, "next_cursor": if more { json!("c") } else { Value::Null }}));
            }
            if req.method == "GET" && req.path.starts_with("/v1/pages/") {
                let id = req.path.rsplit('/').next().unwrap();
                return match self.rows.lock().unwrap().iter().find(|r| r["id"] == id) {
                    Some(r) => ok(r.clone()),
                    None => Ok(Response { status: 404, retry_after: None, body: json!({}) }),
                };
            }
            if req.method == "PATCH" {
                self.patches.lock().unwrap().push((req.path.clone(), req.body.clone().unwrap()));
                return ok(json!({}));
            }
            panic!("unexpected {} {}", req.method, req.path);
        }
    }

    fn fake(kind: &str, with_done: bool, rows: Vec<Value>, pages: usize) -> Fake {
        Fake { schema: schema_json(kind, with_done), rows: Mutex::new(rows), queries: Mutex::new(vec![]), patches: Mutex::new(vec![]), pages }
    }

    fn store(name: &str, mapping: Vec<(&str, &str)>) -> Store {
        let dir = std::env::temp_dir().join(format!("mdc-ntasks-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let s = Store::load_with(dir.join("store.json"), Arc::new(MemorySecrets::default()));
        s.set_notion_destination("tasks", Some(NotionDestination { data_source_id: DS.into(), title: "Tasks".into(), mapping: mapping.into_iter().map(|(f, p)| MapEntry { field: f.into(), property: p.into() }).collect() })).unwrap();
        s
    }

    const FULL: [(&str, &str); 3] = [("due", "Due date"), ("status", "Status"), ("owner", "Owner")];

    #[test]
    fn lists_open_tasks_soonest_first_and_filters_finished_ones_on_the_server() {
        let http = fake("select", true, vec![row("b", "later", Some("2026-12-05"), "Not started", "select"), row("a", "soon", Some("2026-11-20T09:00:00"), "In progress", "select"), row("n", "no date", None, "Not started", "select"), row("d", "finished", Some("2026-11-01"), "Done", "select")], 1);
        let v = open_tasks(&Client::new(&http, "t"), &store("list", FULL.to_vec())).unwrap();
        assert_eq!(v.rows.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), vec!["soon", "later", "no date"], "finished is dropped, undated last");
        assert_eq!(v.rows[0].due.as_deref(), Some("2026-11-20"));
        assert_eq!((v.rows[0].owner.as_deref(), v.rows[0].status.as_deref()), (Some("Sam"), Some("In progress")));
        assert_eq!((v.done_status.as_deref(), v.read_only_reason.as_deref()), (Some("Done"), None));
        let sent = &http.queries.lock().unwrap()[0];
        assert_eq!(sent["filter"], json!({"property": "Status", "select": {"does_not_equal": "Done"}}));
    }

    #[test]
    fn works_with_a_native_status_column() {
        let http = fake("status", true, vec![row("a", "t", None, "Not started", "status")], 1);
        let v = open_tasks(&Client::new(&http, "t"), &store("status", FULL.to_vec())).unwrap();
        assert_eq!(v.rows[0].status.as_deref(), Some("Not started"));
        assert_eq!(http.queries.lock().unwrap()[0]["filter"]["status"], json!({"does_not_equal": "Done"}));
    }

    #[test]
    fn explains_why_ticking_is_unavailable() {
        let http = fake("select", false, vec![row("a", "t", None, "Open", "select")], 1);
        let v = open_tasks(&Client::new(&http, "t"), &store("nodone", FULL.to_vec())).unwrap();
        assert!(v.done_status.is_none() && v.read_only_reason.unwrap().contains("no \"Done\" option"));
        assert!(http.queries.lock().unwrap()[0].get("filter").is_none());
        let http = fake("select", true, vec![row("a", "t", None, "Not started", "select")], 1);
        let v = open_tasks(&Client::new(&http, "t"), &store("nostatus", vec![("due", "Due date")])).unwrap();
        assert!(v.read_only_reason.unwrap().contains("Map a Status column"));
        assert_eq!(v.rows.len(), 1);
    }

    #[test]
    fn follows_the_cursor_up_to_three_pages_and_says_when_it_stopped() {
        let http = fake("select", true, vec![row("a", "t", None, "Not started", "select")], 5);
        let v = open_tasks(&Client::new(&http, "t"), &store("pages", FULL.to_vec())).unwrap();
        assert_eq!(http.queries.lock().unwrap().len(), 3);
        assert!(v.truncated);
    }

    #[test]
    fn needs_a_tasks_database() {
        let dir = std::env::temp_dir().join(format!("mdc-ntasks-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = Store::load_with(dir.join("store.json"), Arc::new(MemorySecrets::default()));
        let http = fake("select", true, vec![], 1);
        assert!(open_tasks(&Client::new(&http, "t"), &s).unwrap_err().contains("Set up a Tasks database"));
    }

    #[test]
    fn ticking_writes_only_the_status_property_and_only_if_unchanged() {
        let http = fake("select", true, vec![row("1429989f-e8ac-4eff-bc8f-57f56486db55", "t", Some("2026-11-20"), "In progress", "select")], 1);
        let st = store("tick", FULL.to_vec());
        let c = Client::new(&http, "t");
        let id = "1429989f-e8ac-4eff-bc8f-57f56486db55";
        assert_eq!(set_status(&c, &st, id, Some("In progress"), "Done").unwrap(), StatusOutcome::Done);
        let patches = http.patches.lock().unwrap();
        assert_eq!(patches.len(), 1);
        assert_eq!(patches[0].1, json!({"properties": {"Status": {"select": {"name": "Done"}}}}));
    }

    #[test]
    fn a_changed_or_foreign_task_is_never_written() {
        let id = "1429989f-e8ac-4eff-bc8f-57f56486db55";
        let http = fake("select", true, vec![row(id, "t", None, "Done", "select")], 1);
        let st = store("stale", FULL.to_vec());
        let c = Client::new(&http, "t");
        // someone already finished it in Notion
        assert_eq!(set_status(&c, &st, id, Some("In progress"), "Done").unwrap(), StatusOutcome::Stale);
        // a page from another database
        let mut other = row(id, "t", None, "In progress", "select");
        other["parent"] = json!({"type": "data_source_id", "data_source_id": "aaaaaaaa-e8ac-4eff-bc8f-57f56486db54"});
        *http.rows.lock().unwrap() = vec![other];
        assert_eq!(set_status(&c, &st, id, Some("In progress"), "Done").unwrap(), StatusOutcome::Stale);
        // a made-up option
        assert!(set_status(&c, &st, id, Some("In progress"), "Banana").is_err());
        assert!(http.patches.lock().unwrap().is_empty());
    }

    #[test]
    fn undo_sets_the_previous_status_back() {
        let id = "1429989f-e8ac-4eff-bc8f-57f56486db55";
        let http = fake("select", true, vec![row(id, "t", None, "Done", "select")], 1);
        let st = store("undo", FULL.to_vec());
        assert_eq!(set_status(&Client::new(&http, "t"), &st, id, Some("Done"), "In progress").unwrap(), StatusOutcome::Done);
        assert_eq!(http.patches.lock().unwrap()[0].1["properties"]["Status"]["select"]["name"], "In progress");
    }
}
