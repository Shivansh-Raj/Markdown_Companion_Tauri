//! A meeting briefing: the earlier meetings that match a topic, the decisions written in them, and the open tasks linked to
//! them. Read-only, and built from the user's own Meetings and Tasks databases with no AI involved.

use serde::Serialize;
use serde_json::Value;

use super::tasks::{NotionTask, open_tasks};
use super::{Client, parse_page_id};
use crate::store::Store;

const MAX_MEETINGS: usize = 3;
const MAX_DECISIONS: usize = 5;
const MAX_TASKS: usize = 10;

#[derive(Serialize, Debug, PartialEq)]
pub struct BriefMeeting {
    pub title: String,
    pub date: String,
    pub url: String,
    pub decisions: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Briefing {
    pub database: String,
    pub meetings: Vec<BriefMeeting>,
    /// True when no meeting matched the topic and the latest ones are shown instead.
    pub latest_instead: bool,
    pub tasks: Vec<NotionTask>,
    /// Said when tasks cannot be tied to the meetings, or there is no Tasks database.
    pub tasks_note: Option<String>,
}

fn words(q: &str) -> Vec<String> {
    let mut w: Vec<String> = q.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(str::to_string).collect();
    w.sort();
    w.dedup();
    w
}

fn text_of(v: &Value) -> String {
    match v.get("type").and_then(Value::as_str) {
        Some("title") => v.get("title"),
        Some("rich_text") => v.get("rich_text"),
        _ => None,
    }
    .and_then(Value::as_array)
    .map(|a| a.iter().filter_map(|t| t.get("plain_text").and_then(Value::as_str)).collect::<String>())
    .or_else(|| v.pointer("/select/name").and_then(Value::as_str).map(str::to_string))
    .unwrap_or_default()
}

/// Bullets under headings about decisions, agreements or takeaways, with checkbox marks stripped.
pub fn extract_decisions(md: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_section = false;
    for line in md.lines() {
        let t = line.trim();
        if let Some(h) = t.strip_prefix('#') {
            let h = h.trim_start_matches('#').trim().to_lowercase();
            in_section = ["decision", "decided", "agreed", "agreement", "takeaway"].iter().any(|k| h.contains(k));
            continue;
        }
        if !in_section {
            continue;
        }
        let item = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")).or_else(|| t.strip_prefix("+ ")).or_else(|| {
            let d = t.chars().take_while(char::is_ascii_digit).count();
            (d > 0 && t[d..].starts_with(". ")).then(|| &t[d + 2..])
        });
        if let Some(i) = item {
            let i = i.trim().trim_start_matches("[ ]").trim_start_matches("[x]").trim_start_matches("[X]").trim();
            if !i.is_empty() && out.len() < MAX_DECISIONS {
                out.push(i.to_string());
            }
        }
    }
    out
}

pub fn briefing(client: &Client, store: &Store, topic: &str) -> Result<Briefing, String> {
    let dest = store.notion_destination("meetings").ok_or("Set up a Meetings database first (Settings → Notion).")?;
    let rows = client.query_recent(&dest.data_source_id)?;
    let mapped = |field: &str| dest.mapping.iter().find(|m| m.field == field).map(|m| m.property.clone());
    let (project_col, date_col) = (mapped("project"), mapped("date"));
    let ws = words(topic);
    let hay = |r: &Value| -> String {
        let props = r.get("properties");
        let title = props.and_then(|p| p.as_object()).and_then(|o| o.values().find(|v| v.get("type").and_then(Value::as_str) == Some("title"))).map(text_of).unwrap_or_default();
        let project = project_col.as_ref().and_then(|c| props.and_then(|p| p.get(c))).map(text_of).unwrap_or_default();
        format!("{title} {project}").to_lowercase()
    };
    let live: Vec<&Value> = rows.iter().filter(|r| !r.get("in_trash").and_then(Value::as_bool).unwrap_or(false)).collect();
    let mut scored: Vec<(usize, usize)> = live.iter().enumerate().map(|(i, r)| (i, { let h = hay(r); ws.iter().filter(|w| h.contains(w.as_str())).count() })).collect();
    let matched = scored.iter().any(|s| s.1 > 0);
    if matched {
        scored.retain(|s| s.1 > 0);
        scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    }
    let chosen: Vec<&Value> = scored.iter().take(MAX_MEETINGS).map(|(i, _)| live[*i]).collect();
    let mut meetings = Vec::new();
    let mut ids = Vec::new();
    for r in &chosen {
        let Some(id) = r.get("id").and_then(Value::as_str) else { continue };
        let title = r.get("properties").and_then(|p| p.as_object()).and_then(|o| o.values().find(|v| v.get("type").and_then(Value::as_str) == Some("title"))).map(text_of).unwrap_or_default();
        let date = date_col
            .as_ref()
            .and_then(|c| r.pointer(&format!("/properties/{}/date/start", c.replace('~', "~0").replace('/', "~1"))))
            .and_then(Value::as_str)
            .or_else(|| r.get("created_time").and_then(Value::as_str))
            .map(|s| s.chars().take(10).collect::<String>())
            .unwrap_or_default();
        let decisions = client.read_page(id).map(|p| extract_decisions(&p.markdown)).unwrap_or_default();
        ids.extend(parse_page_id(id));
        meetings.push(BriefMeeting { title: if title.trim().is_empty() { "Untitled".into() } else { title }, date, url: r.get("url").and_then(Value::as_str).unwrap_or("").to_string(), decisions });
    }
    let (tasks, tasks_note) = if store.notion_destination("tasks").is_none() {
        (vec![], Some("Set up a Tasks database to see open tasks here.".to_string()))
    } else {
        match open_tasks(client, store) {
            Err(e) => (vec![], Some(e)),
            Ok(v) if v.links_meetings => (v.rows.into_iter().filter(|t| t.meeting_ids.iter().any(|m| ids.contains(m))).take(MAX_TASKS).collect(), None),
            Ok(v) => (v.rows.into_iter().take(MAX_TASKS).collect(), Some("Tasks are not linked to meetings in your database, so these are all open tasks.".to_string())),
        }
    };
    Ok(Briefing { database: dest.title, meetings, latest_instead: !matched && !ws.is_empty(), tasks, tasks_note })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notion::db::MapEntry;
    use crate::notion::{Http, Request, Response};
    use crate::secrets::MemorySecrets;
    use crate::store::NotionDestination;
    use serde_json::json;
    use std::sync::Arc;

    const MEET: &str = "aaaaaaaa-e8ac-4eff-bc8f-57f56486db54";
    const TASKS: &str = "bbbbbbbb-e8ac-4eff-bc8f-57f56486db54";
    const M1: &str = "11111111-e8ac-4eff-bc8f-57f56486db54";
    const M2: &str = "22222222-e8ac-4eff-bc8f-57f56486db54";

    #[test]
    fn extracts_decisions_from_the_usual_headings_only() {
        let md = "## Summary\n\n- not this\n\n## Key takeaways\n\n- Ship on Friday\n- [ ] Priya owns it\n\n## Other\n\n- nor this\n\n## Decisions made\n\n1. Use Postgres\n";
        assert_eq!(extract_decisions(md), vec!["Ship on Friday", "Priya owns it", "Use Postgres"]);
        assert!(extract_decisions("no headings\n- a bullet").is_empty());
    }

    fn meeting_row(id: &str, title: &str, project: &str, date: &str) -> Value {
        json!({"object": "page", "id": id, "url": format!("https://notion.so/{id}"), "created_time": "2026-01-01T00:00:00Z", "properties": {
            "Name": {"type": "title", "title": [{"plain_text": title}]}, "Project": {"type": "rich_text", "rich_text": [{"plain_text": project}]},
            "Date": {"type": "date", "date": {"start": date}}}})
    }

    fn task_row(id: &str, title: &str, meeting: Option<&str>) -> Value {
        json!({"object": "page", "id": id, "url": "u", "properties": {"Name": {"type": "title", "title": [{"plain_text": title}]},
            "Status": {"type": "select", "select": {"name": "Not started"}},
            "Meeting": {"type": "relation", "relation": meeting.map(|m| vec![json!({"id": m})]).unwrap_or_default()}}})
    }

    struct Fake;

    impl Http for Fake {
        fn send(&self, _t: &str, req: &Request) -> Result<Response, String> {
            let ok = |body: Value| Ok(Response { status: 200, retry_after: None, body });
            if req.path == format!("/v1/data_sources/{TASKS}") {
                return ok(json!({"id": TASKS, "title": [{"plain_text": "Tasks"}], "properties": {
                    "Name": {"id": "t", "name": "Name", "type": "title", "title": {}},
                    "Status": {"id": "s", "name": "Status", "type": "select", "select": {"options": [{"name": "Not started"}, {"name": "Done"}]}},
                    "Meeting": {"id": "m", "name": "Meeting", "type": "relation", "relation": {}}}}));
            }
            if req.path == format!("/v1/data_sources/{MEET}") {
                return ok(json!({"id": MEET, "title": [{"plain_text": "Meetings"}], "properties": {"Name": {"id": "t", "name": "Name", "type": "title", "title": {}}}}));
            }
            if req.path == format!("/v1/data_sources/{MEET}/query") {
                return ok(json!({"results": [meeting_row(M2, "Budget review", "Finance", "2026-11-10"), meeting_row(M1, "Apollo sync", "Apollo", "2026-11-03")]}));
            }
            if req.path == format!("/v1/data_sources/{TASKS}/query") {
                return ok(json!({"results": [task_row("cccccccc-e8ac-4eff-bc8f-57f56486db54", "Send notes", Some(M1)), task_row("dddddddd-e8ac-4eff-bc8f-57f56486db54", "Pay invoice", Some(M2)), task_row("eeeeeeee-e8ac-4eff-bc8f-57f56486db54", "Loose", None)]}));
            }
            if req.path.ends_with("/markdown?markdown_version=v2") {
                return ok(json!({"markdown": "## Decisions\n\n- Ship on Friday\n", "truncated": false}));
            }
            panic!("unexpected {}", req.path);
        }
    }

    fn store(link_tasks: bool) -> Store {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!("mdc-brief-{}-{}", N.fetch_add(1, std::sync::atomic::Ordering::SeqCst), std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = Store::load_with(dir.join("store.json"), Arc::new(MemorySecrets::default()));
        let m = |f: &str, p: &str| MapEntry { field: f.into(), property: p.into() };
        s.set_notion_destination("meetings", Some(NotionDestination { data_source_id: MEET.into(), title: "Meetings".into(), mapping: vec![m("project", "Project"), m("date", "Date")] })).unwrap();
        let mut tm = vec![m("status", "Status")];
        if link_tasks {
            tm.push(m("meeting", "Meeting"));
        }
        s.set_notion_destination("tasks", Some(NotionDestination { data_source_id: TASKS.into(), title: "Tasks".into(), mapping: tm })).unwrap();
        s
    }

    #[test]
    fn picks_matching_meetings_with_their_decisions_and_linked_tasks() {
        let b = briefing(&Client::new(&Fake, "t"), &store(true), "Apollo roadmap").unwrap();
        assert_eq!(b.meetings.len(), 1);
        assert_eq!((b.meetings[0].title.as_str(), b.meetings[0].date.as_str(), b.meetings[0].decisions.clone()), ("Apollo sync", "2026-11-03", vec!["Ship on Friday".to_string()]));
        assert!(!b.latest_instead);
        assert_eq!(b.tasks.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), vec!["Send notes"], "only tasks linked to the chosen meetings");
        assert!(b.tasks_note.is_none());
    }

    #[test]
    fn falls_back_to_the_latest_meetings_and_says_so() {
        let b = briefing(&Client::new(&Fake, "t"), &store(true), "quantum computing").unwrap();
        assert!(b.latest_instead && b.meetings.len() == 2);
        assert_eq!(b.tasks.len(), 2);
        let none = briefing(&Client::new(&Fake, "t"), &store(true), "").unwrap();
        assert!(!none.latest_instead && none.meetings.len() == 2, "no topic is just the latest, not a miss");
    }

    #[test]
    fn without_a_meeting_column_it_shows_open_tasks_with_a_note() {
        let b = briefing(&Client::new(&Fake, "t"), &store(false), "Apollo").unwrap();
        assert_eq!(b.tasks.len(), 3);
        assert!(b.tasks_note.unwrap().contains("not linked to meetings"));
    }
}
