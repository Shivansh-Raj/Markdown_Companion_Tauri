//! Saving and using a database destination: validate the user's mapping against the live database, then build and
//! create rows with it.

use serde::Serialize;
use serde_json::{Map, Value};

use super::db::{MapEntry, build_properties, validate_mapping};
use super::{Client, Created};
use crate::store::{NotionDestination, Store};

/// Saves the database and mapping for a destination, after checking them against the database's current properties.
pub fn set_destination(client: &Client, store: &Store, key: &str, data_source: &str, mapping: Vec<MapEntry>) -> Result<NotionDestination, String> {
    super::db::fields_for(key).ok_or("Unknown destination.")?;
    let schema = client.data_source_schema(data_source)?;
    validate_mapping(key, &schema, &mapping)?;
    let dest = NotionDestination { data_source_id: schema.id.clone(), title: schema.title.clone(), mapping };
    store.set_notion_destination(key, Some(dest.clone()))?;
    Ok(dest)
}

/// Creates the database for a destination under the home page and saves the mapping to its columns.
/// Refuses if a database with that name is already there, so nothing is duplicated.
pub fn create_destination(client: &Client, store: &Store, key: &str) -> Result<NotionDestination, String> {
    let home = store.notion_home().ok_or("Choose a home page first (Settings → Notion).")?;
    let meetings = store.notion_destination("meetings").map(|d| d.data_source_id);
    let t = super::db::template_for(key, meetings.as_deref()).ok_or("Unknown destination.")?;
    if client.child_database_titles(&home.page_id)?.iter().any(|n| n == t.title) {
        return Err(format!("A database called \"{}\" is already in your home page. Use CHOOSE DATABASE to pick it instead.", t.title));
    }
    let data_source = client.create_database(&home.page_id, t.title, t.properties.clone())?;
    set_destination(client, store, key, &data_source, t.mapping)
}

#[derive(Serialize, Debug, PartialEq)]
pub struct RowPreview {
    pub database: String,
    /// The property JSON that would be sent.
    pub properties: Value,
    /// Values that were left out, and why.
    pub warnings: Vec<String>,
}

fn load(store: &Store, key: &str) -> Result<NotionDestination, String> {
    store.notion_destination(key).ok_or_else(|| "Choose a Notion database for this first (Settings → Notion).".to_string())
}

/// What a new row would contain. Reads the database's current properties; changes nothing in Notion.
pub fn preview_row(client: &Client, store: &Store, key: &str, title: &str, values: &Map<String, Value>) -> Result<RowPreview, String> {
    let dest = load(store, key)?;
    let schema = client.data_source_schema(&dest.data_source_id)?;
    let (properties, warnings) = build_properties(&schema, key, &dest.mapping, title, values)?;
    Ok(RowPreview { database: dest.title, properties, warnings })
}

#[derive(Serialize, Debug, PartialEq)]
pub struct RowCreated {
    pub id: String,
    pub url: String,
    pub warnings: Vec<String>,
}

/// Adds a row with the mapped properties and the Markdown as the page body. Always a new row; nothing is changed.
pub fn create_row(client: &Client, store: &Store, key: &str, title: &str, markdown: &str, values: &Map<String, Value>) -> Result<RowCreated, String> {
    if title.trim().is_empty() {
        return Err("Give it a title.".into());
    }
    let dest = load(store, key)?;
    let schema = client.data_source_schema(&dest.data_source_id)?;
    let (properties, warnings) = build_properties(&schema, key, &dest.mapping, title, values)?;
    let Created { id, url } = client.create_row(&dest.data_source_id, properties, markdown)?;
    Ok(RowCreated { id, url, warnings })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notion::{Http, Request, Response};
    use crate::secrets::MemorySecrets;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    const DS: &str = "1429989f-e8ac-4eff-bc8f-57f56486db54";

    struct Fake {
        posts: Mutex<Vec<Value>>,
    }

    impl Http for Fake {
        fn send(&self, _t: &str, req: &Request) -> Result<Response, String> {
            let ok = |body: Value| Ok(Response { status: 200, retry_after: None, body });
            if req.method == "GET" && req.path == format!("/v1/data_sources/{DS}") {
                return ok(json!({"id": DS, "title": [{"plain_text": "Meetings DB"}], "properties": {
                    "Name": {"id": "title", "name": "Name", "type": "title", "title": {}},
                    "When": {"id": "w", "name": "When", "type": "date", "date": {}},
                    "Minutes": {"id": "m", "name": "Minutes", "type": "number", "number": {}}
                }}));
            }
            if req.method == "POST" && req.path == "/v1/pages" {
                self.posts.lock().unwrap().push(req.body.clone().unwrap());
                return ok(json!({"id": "row-1", "url": "https://notion.so/row"}));
            }
            panic!("unexpected {} {}", req.method, req.path);
        }
    }

    fn setup(name: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("mdc-dest-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Store::load_with(dir.join("store.json"), Arc::new(MemorySecrets::default()))
    }

    fn map(pairs: &[(&str, &str)]) -> Vec<MapEntry> {
        pairs.iter().map(|(f, p)| MapEntry { field: (*f).into(), property: (*p).into() }).collect()
    }

    fn vals() -> Map<String, Value> {
        json!({"date": "2026-11-19", "duration_min": 12.5, "type": "meeting"}).as_object().unwrap().clone()
    }

    #[test]
    fn saves_a_valid_mapping_and_rejects_a_bad_one() {
        let store = setup("save");
        let http = Fake { posts: Mutex::new(vec![]) };
        let c = Client::new(&http, "t");
        assert!(set_destination(&c, &store, "meetings", DS, map(&[("date", "Minutes")])).is_err());
        assert!(store.notion_destination("meetings").is_none(), "a bad mapping is never saved");
        assert!(set_destination(&c, &store, "bogus", DS, vec![]).is_err());
        let d = set_destination(&c, &store, "meetings", DS, map(&[("date", "When"), ("duration_min", "Minutes")])).unwrap();
        assert_eq!(d.title, "Meetings DB");
        assert_eq!(store.notion_destination("meetings").unwrap(), d);
    }

    #[test]
    fn previews_without_creating_anything() {
        let store = setup("preview");
        let http = Fake { posts: Mutex::new(vec![]) };
        let c = Client::new(&http, "t");
        assert!(preview_row(&c, &store, "meetings", "T", &vals()).unwrap_err().contains("Choose a Notion database"));
        set_destination(&c, &store, "meetings", DS, map(&[("date", "When"), ("duration_min", "Minutes")])).unwrap();
        let p = preview_row(&c, &store, "meetings", "Sprint", &vals()).unwrap();
        assert_eq!(p.properties["When"]["date"]["start"], "2026-11-19");
        assert_eq!(p.properties["Minutes"]["number"], 12.5);
        assert!(http.posts.lock().unwrap().is_empty());
    }

    #[test]
    fn creates_a_row_in_the_data_source_with_properties_and_markdown() {
        let store = setup("create");
        let http = Fake { posts: Mutex::new(vec![]) };
        let c = Client::new(&http, "t");
        set_destination(&c, &store, "meetings", DS, map(&[("date", "When"), ("duration_min", "Minutes")])).unwrap();
        let made = create_row(&c, &store, "meetings", "Sprint review", "## Summary\n\nok", &vals()).unwrap();
        assert_eq!((made.id.as_str(), made.warnings.len()), ("row-1", 0));
        let posts = http.posts.lock().unwrap();
        let body = &posts[0];
        assert_eq!(body["parent"]["data_source_id"], DS);
        assert_eq!(body["properties"]["Name"]["title"][0]["text"]["content"], "Sprint review");
        assert_eq!(body["markdown"], "## Summary\n\nok");
        assert!(body["properties"].get("type").is_none(), "unmapped fields are not sent");
        assert!(!body.to_string().contains("allow_deleting_content"));
    }

    #[test]
    fn refuses_an_untitled_row_before_any_request() {
        let store = setup("untitled");
        let http = Fake { posts: Mutex::new(vec![]) };
        let c = Client::new(&http, "t");
        set_destination(&c, &store, "meetings", DS, vec![]).unwrap();
        assert!(create_row(&c, &store, "meetings", "  ", "x", &Map::new()).is_err());
        assert!(http.posts.lock().unwrap().is_empty());
    }

    /// A Notion that has a home page, can list its children, and creates databases (answering briefly, as Notion may).
    struct Creating {
        existing: Vec<&'static str>,
        created: Mutex<Vec<Value>>,
    }

    const HOME: &str = "aaaaaaaa-e8ac-4eff-bc8f-57f56486db54";
    const NEW_DS: &str = "bbbbbbbb-e8ac-4eff-bc8f-57f56486db54";

    impl Http for Creating {
        fn send(&self, _t: &str, req: &Request) -> Result<Response, String> {
            let ok = |body: Value| Ok(Response { status: 200, retry_after: None, body });
            if req.path.starts_with(&format!("/v1/blocks/{HOME}/children")) {
                let results: Vec<Value> = self.existing.iter().map(|t| json!({"type": "child_database", "child_database": {"title": t}})).collect();
                return ok(json!({"results": results, "has_more": false}));
            }
            if req.method == "POST" && req.path == "/v1/databases" {
                self.created.lock().unwrap().push(req.body.clone().unwrap());
                return ok(json!({"object": "database", "id": "db-1"})); // short answer: no data_sources
            }
            if req.path == "/v1/databases/db-1" {
                return ok(json!({"id": "db-1", "data_sources": [{"id": NEW_DS, "name": "Meetings"}]}));
            }
            if req.path == format!("/v1/data_sources/{NEW_DS}") {
                let props = self.created.lock().unwrap()[0]["initial_data_source"]["properties"].clone();
                let shaped: Map<String, Value> = props.as_object().unwrap().iter().map(|(name, cfg)| {
                    let kind = cfg.as_object().unwrap().keys().next().unwrap().clone();
                    (name.clone(), json!({"id": name, "name": name, "type": kind, kind.clone(): cfg[&kind].clone()}))
                }).collect();
                return ok(json!({"id": NEW_DS, "title": [{"plain_text": "Meetings"}], "properties": shaped}));
            }
            panic!("unexpected {} {}", req.method, req.path);
        }
    }

    fn with_home(name: &str) -> Store {
        let store = setup(name);
        store.set_notion_home(Some(crate::store::NotionHome { page_id: HOME.into(), title: "Markdown Companion".into(), url: String::new() })).unwrap();
        store
    }

    #[test]
    fn creates_the_database_under_the_home_page_and_maps_it() {
        let store = with_home("mk");
        let http = Creating { existing: vec!["Something else"], created: Mutex::new(vec![]) };
        let d = create_destination(&Client::new(&http, "t"), &store, "meetings").unwrap();
        assert_eq!((d.data_source_id.as_str(), d.title.as_str()), (NEW_DS, "Meetings"));
        assert!(d.mapping.iter().any(|m| m.field == "date" && m.property == "Date"));
        let body = &http.created.lock().unwrap()[0];
        assert_eq!(body["parent"], json!({"type": "page_id", "page_id": HOME}));
        assert_eq!(body["is_inline"], true);
        assert_eq!(body["title"][0]["text"]["content"], "Meetings");
        assert_eq!(body["initial_data_source"]["properties"]["Name"], json!({"title": {}}));
        assert_eq!(store.notion_destination("meetings").unwrap(), d);
    }

    #[test]
    fn will_not_create_a_second_database_with_the_same_name() {
        let store = with_home("dup");
        let http = Creating { existing: vec!["Meetings"], created: Mutex::new(vec![]) };
        let err = create_destination(&Client::new(&http, "t"), &store, "meetings").unwrap_err();
        assert!(err.contains("already in your home page"), "{err}");
        assert!(http.created.lock().unwrap().is_empty());
        assert!(store.notion_destination("meetings").is_none());
    }

    #[test]
    fn needs_a_home_page_first() {
        let store = setup("nohome");
        let http = Creating { existing: vec![], created: Mutex::new(vec![]) };
        assert!(create_destination(&Client::new(&http, "t"), &store, "meetings").unwrap_err().contains("home page"));
    }
}
