//! Asking a question across a Notion database: pick the few rows most likely to answer it, and read only those pages.
//!
//! Notion's search only matches titles, so rows are ranked by how many of the question's words their title shares,
//! then by how recently they were edited. At most `MAX_PAGES` pages are read; nothing else in the workspace is touched.
//! The text read here goes to the AI only after the user reviews it (the Ask panel's receipt).

use serde::Serialize;
use serde_json::Value;

use super::Client;

pub const MAX_PAGES: usize = 6;

#[derive(Serialize, Debug, PartialEq)]
pub struct DbPage {
    pub id: String,
    pub title: String,
    pub url: String,
    pub markdown: String,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct DbPages {
    pub database: String,
    pub pages: Vec<DbPage>,
    /// Rows looked at (the 100 most recently edited).
    pub rows: usize,
}

fn words(q: &str) -> Vec<String> {
    const FILLER: &[&str] = &["the", "and", "what", "this", "that", "with", "for", "from", "about", "who", "how", "why", "when", "where", "which", "does", "did", "are", "was", "were", "has", "have", "any", "all", "our", "there", "summarise", "summarize", "tell", "list", "give"];
    let mut out: Vec<String> = q.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3 && !FILLER.contains(w)).map(str::to_string).collect();
    out.sort();
    out.dedup();
    out
}

fn title_of(row: &Value) -> String {
    row.get("properties")
        .and_then(Value::as_object)
        .and_then(|p| p.values().find(|v| v.get("type").and_then(Value::as_str) == Some("title")))
        .and_then(|t| t.get("title"))
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.get("plain_text").and_then(Value::as_str)).collect::<String>())
        .unwrap_or_default()
}

/// The rows to read for a question: best title match first, then the most recently edited (the query's order).
pub fn rank(rows: &[Value], question: &str) -> Vec<usize> {
    let ws = words(question);
    let mut scored: Vec<(usize, usize)> = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| !r.get("in_trash").and_then(Value::as_bool).unwrap_or(false))
        .map(|(i, r)| {
            let t = title_of(r).to_lowercase();
            (i, ws.iter().filter(|w| t.contains(w.as_str())).count())
        })
        .collect();
    scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    scored.into_iter().take(MAX_PAGES).map(|(i, _)| i).collect()
}

pub fn pages_for(client: &Client, data_source: &str, question: &str) -> Result<DbPages, String> {
    let schema_v = client.data_source_schema(data_source)?;
    let rows = client.query_recent(&schema_v.id)?;
    let mut pages = Vec::new();
    for i in rank(&rows, question) {
        let r = &rows[i];
        let Some(id) = r.get("id").and_then(Value::as_str) else { continue };
        // A page that cannot be read is skipped; the others still answer.
        let Ok(md) = client.read_page(id) else { continue };
        let text = strip_unknown(&md.markdown);
        if text.trim().is_empty() {
            continue;
        }
        let title = title_of(r);
        pages.push(DbPage { id: id.to_string(), title: if title.trim().is_empty() { "Untitled".into() } else { title }, url: r.get("url").and_then(Value::as_str).unwrap_or("").to_string(), markdown: text });
    }
    Ok(DbPages { database: schema_v.title, rows: rows.len(), pages })
}

/// `<unknown …/>` tags stand for blocks Markdown cannot show; they carry links, not words, so they are not sent to the AI.
pub fn strip_unknown(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let mut rest = md;
    while let Some(start) = rest.find("<unknown") {
        out.push_str(&rest[..start]);
        match rest[start..].find("/>") {
            Some(end) => rest = &rest[start + end + 2..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notion::{Http, Request, Response};
    use serde_json::json;
    use std::sync::Mutex;

    const DS: &str = "1429989f-e8ac-4eff-bc8f-57f56486db54";

    fn row(id: &str, title: &str) -> Value {
        json!({"object": "page", "id": id, "url": format!("https://notion.so/{id}"), "properties": {"Name": {"type": "title", "title": [{"plain_text": title}]}}})
    }

    #[test]
    fn ranks_by_title_words_then_recency_and_reads_at_most_six() {
        let rows: Vec<Value> = (0..10).map(|i| row(&format!("r{i}"), &format!("Weekly sync {i}"))).chain([row("m", "Migration plan"), row("b", "Budget review")]).collect();
        let order = rank(&rows, "Who owns the migration plan?");
        assert_eq!(order[0], 10, "the title match comes first");
        assert_eq!(order.len(), MAX_PAGES);
        assert_eq!(&order[1..], &[0, 1, 2, 3, 4], "then the most recently edited");
    }

    #[test]
    fn strips_unknown_block_tags() {
        assert_eq!(strip_unknown("a <unknown url=\"https://x\" alt=\"form\"/> b"), "a  b");
        assert_eq!(strip_unknown("no tags"), "no tags");
        assert_eq!(strip_unknown("broken <unknown url="), "broken ");
    }

    struct Fake {
        reads: Mutex<Vec<String>>,
    }

    impl Http for Fake {
        fn send(&self, _t: &str, req: &Request) -> Result<Response, String> {
            let ok = |body: Value| Ok(Response { status: 200, retry_after: None, body });
            if req.path == format!("/v1/data_sources/{DS}") {
                return ok(json!({"id": DS, "title": [{"plain_text": "Meetings"}], "properties": {"Name": {"id": "t", "name": "Name", "type": "title", "title": {}}}}));
            }
            if req.path.ends_with("/query") {
                assert_eq!(req.body.as_ref().unwrap()["sorts"][0]["timestamp"], "last_edited_time");
                return ok(json!({"results": [row("aaaaaaaa-e8ac-4eff-bc8f-57f56486db54", "Retro"), row("bbbbbbbb-e8ac-4eff-bc8f-57f56486db54", "Sprint"), row("cccccccc-e8ac-4eff-bc8f-57f56486db54", "Empty")]}));
            }
            if let Some(id) = req.path.strip_prefix("/v1/pages/") {
                let id = id.split('/').next().unwrap().to_string();
                self.reads.lock().unwrap().push(id.clone());
                if id.starts_with("bbbb") {
                    return Ok(Response { status: 404, retry_after: None, body: json!({}) });
                }
                let md = if id.starts_with("cccc") { "<unknown url=\"x\"/>" } else { "# Retro\n\nWe agreed to ship Friday." };
                return ok(json!({"markdown": md, "truncated": false}));
            }
            panic!("unexpected {}", req.path);
        }
    }

    #[test]
    fn reads_only_the_chosen_pages_and_skips_unreadable_or_empty_ones() {
        let http = Fake { reads: Mutex::new(vec![]) };
        let got = pages_for(&Client::new(&http, "t"), DS, "what did the retro agree").unwrap();
        assert_eq!((got.database.as_str(), got.rows), ("Meetings", 3));
        assert_eq!(got.pages.len(), 1);
        assert_eq!(got.pages[0].title, "Retro");
        assert!(got.pages[0].markdown.contains("ship Friday"));
        assert_eq!(http.reads.lock().unwrap().len(), 3);
    }
}
