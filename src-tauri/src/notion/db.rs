//! Database destinations: choosing a Notion database (a "data source"), mapping MC's fields onto its properties,
//! and turning a row of values into the property JSON Notion expects.
//!
//! No schema is hardcoded. The user maps each field once; the mapping is checked against the database's live
//! properties every time a row is built, and anything that no longer fits is skipped with a warning rather than failing.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    Text,
    Number,
    Date,
    List,
    Relation,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Field {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: FieldKind,
}

const MEETINGS: &[Field] = &[
    Field { key: "date", label: "Date", kind: FieldKind::Date },
    Field { key: "type", label: "Type", kind: FieldKind::Text },
    Field { key: "duration_min", label: "Duration (minutes)", kind: FieldKind::Number },
    Field { key: "tags", label: "Tags", kind: FieldKind::List },
    Field { key: "project", label: "Project", kind: FieldKind::Text },
    Field { key: "source", label: "Source", kind: FieldKind::Text },
];

const PRACTICE: &[Field] = &[
    Field { key: "date", label: "Date", kind: FieldKind::Date },
    Field { key: "duration_min", label: "Duration (minutes)", kind: FieldKind::Number },
    Field { key: "words", label: "Words", kind: FieldKind::Number },
    Field { key: "pace_wpm", label: "Pace (words per minute)", kind: FieldKind::Number },
    Field { key: "speaking_wpm", label: "Speaking pace (words per minute)", kind: FieldKind::Number },
    Field { key: "filler_count", label: "Filler words", kind: FieldKind::Number },
    Field { key: "fillers_per_100_words", label: "Fillers per 100 words", kind: FieldKind::Number },
    Field { key: "long_pauses", label: "Long pauses", kind: FieldKind::Number },
];

const TASKS: &[Field] = &[
    Field { key: "due", label: "Due date", kind: FieldKind::Date },
    Field { key: "status", label: "Status", kind: FieldKind::Text },
    Field { key: "owner", label: "Owner (as text)", kind: FieldKind::Text },
    Field { key: "meeting", label: "Meeting page", kind: FieldKind::Relation },
];

/// A database MC can create for a destination: its title, columns, and which column each field goes into.
#[derive(Serialize, Debug, PartialEq)]
pub struct Template {
    pub title: &'static str,
    /// (column name, Notion type) for display. The title column comes first.
    pub columns: Vec<(String, String)>,
    #[serde(skip)]
    pub properties: Value,
    #[serde(skip)]
    pub mapping: Vec<MapEntry>,
}

/// The database to create for a destination. `meetings_source` is the Meetings database's data source id; when
/// there is one, the Tasks database gets a relation column pointing at it.
pub fn template_for(destination: &str, meetings_source: Option<&str>) -> Option<Template> {
    // (field key, column name, property config)
    let mut cols: Vec<(&str, &str, Value)> = match destination {
        "meetings" => vec![
            ("date", "Date", json!({ "date": {} })),
            ("type", "Type", json!({ "select": {} })),
            ("duration_min", "Duration (min)", json!({ "number": { "format": "number" } })),
            ("tags", "Tags", json!({ "multi_select": {} })),
            ("project", "Project", json!({ "rich_text": {} })),
            ("source", "Source", json!({ "rich_text": {} })),
        ],
        "practice" => vec![
            ("date", "Date", json!({ "date": {} })),
            ("duration_min", "Duration (min)", json!({ "number": { "format": "number" } })),
            ("words", "Words", json!({ "number": { "format": "number" } })),
            ("pace_wpm", "Pace (wpm)", json!({ "number": { "format": "number" } })),
            ("speaking_wpm", "Speaking pace (wpm)", json!({ "number": { "format": "number" } })),
            ("filler_count", "Filler words", json!({ "number": { "format": "number" } })),
            ("fillers_per_100_words", "Fillers per 100 words", json!({ "number": { "format": "number" } })),
            ("long_pauses", "Long pauses", json!({ "number": { "format": "number" } })),
        ],
        "tasks" => vec![
            ("due", "Due date", json!({ "date": {} })),
            // Notion's API does not create "status" columns, so a select with the usual options is used.
            ("status", "Status", json!({ "select": { "options": [{ "name": "Not started" }, { "name": "In progress" }, { "name": "Done" }] } })),
            ("owner", "Owner", json!({ "rich_text": {} })),
        ],
        _ => return None,
    };
    if destination == "tasks"
        && let Some(src) = meetings_source
    {
        cols.push(("meeting", "Meeting", json!({ "relation": { "data_source_id": src, "single_property": {} } })));
    }
    let title = match destination {
        "meetings" => "Meetings",
        "practice" => "Practice sessions",
        _ => "Tasks",
    };
    let mut properties = Map::new();
    properties.insert("Name".into(), json!({ "title": {} }));
    let mut columns = vec![("Name".to_string(), "title".to_string())];
    let mut mapping = Vec::new();
    for (key, name, cfg) in cols {
        let kind = cfg.as_object().and_then(|o| o.keys().next()).cloned().unwrap_or_default();
        columns.push((name.to_string(), kind));
        mapping.push(MapEntry { field: key.to_string(), property: name.to_string() });
        properties.insert(name.to_string(), cfg);
    }
    Some(Template { title, columns, properties: Value::Object(properties), mapping })
}

/// The destinations MC can write to, and the fields each offers. The page title is always filled and not listed.
pub fn fields_for(destination: &str) -> Option<&'static [Field]> {
    match destination {
        "meetings" => Some(MEETINGS),
        "practice" => Some(PRACTICE),
        "tasks" => Some(TASKS),
        _ => None,
    }
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct PropSchema {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// Allowed values for select, multi-select and status properties.
    pub options: Vec<String>,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Schema {
    pub id: String,
    pub title: String,
    pub properties: Vec<PropSchema>,
}

/// The property types MC can write to. Formulas, rollups, ids and timestamps are set by Notion.
const WRITABLE: &[&str] = &["title", "rich_text", "number", "select", "multi_select", "status", "date", "url", "relation"];

pub fn schema_from(v: &Value) -> Option<Schema> {
    let id = v.get("id")?.as_str()?.to_string();
    let title = v.get("title").and_then(Value::as_array).map(|a| a.iter().filter_map(|t| t.get("plain_text").and_then(Value::as_str)).collect::<String>()).unwrap_or_default();
    let mut properties: Vec<PropSchema> = v
        .get("properties")?
        .as_object()?
        .values()
        .filter_map(|p| {
            let kind = p.get("type")?.as_str()?;
            if !WRITABLE.contains(&kind) {
                return None;
            }
            let options = p
                .get(kind)
                .and_then(|c| c.get("options"))
                .and_then(Value::as_array)
                .map(|o| o.iter().filter_map(|x| x.get("name").and_then(Value::as_str).map(str::to_string)).collect())
                .unwrap_or_default();
            Some(PropSchema { id: p.get("id")?.as_str()?.to_string(), name: p.get("name")?.as_str()?.to_string(), kind: kind.to_string(), options })
        })
        .collect();
    properties.sort_by_key(|p| p.name.to_lowercase());
    Some(Schema { id, title: if title.trim().is_empty() { "Untitled database".into() } else { title }, properties })
}

/// Which Notion property types a field can fill.
pub fn compatible(field: FieldKind, prop_type: &str) -> bool {
    match field {
        FieldKind::Text => matches!(prop_type, "rich_text" | "select" | "status" | "url"),
        FieldKind::Number => matches!(prop_type, "number" | "rich_text"),
        FieldKind::Date => matches!(prop_type, "date" | "rich_text"),
        FieldKind::List => matches!(prop_type, "multi_select" | "rich_text"),
        FieldKind::Relation => prop_type == "relation",
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct MapEntry {
    pub field: String,
    /// The Notion property's name.
    pub property: String,
}

/// Checks a mapping against the database's current properties. Returns the entries that are valid; errors name
/// the first problem so the settings screen can show it.
pub fn validate_mapping(destination: &str, schema: &Schema, mapping: &[MapEntry]) -> Result<(), String> {
    let fields = fields_for(destination).ok_or("Unknown destination.")?;
    let mut used = std::collections::HashSet::new();
    for m in mapping {
        let f = fields.iter().find(|f| f.key == m.field).ok_or_else(|| format!("\"{}\" is not a field of this destination.", m.field))?;
        let p = schema.properties.iter().find(|p| p.name == m.property).ok_or_else(|| format!("The database has no property \"{}\".", m.property))?;
        if p.kind == "title" {
            return Err("The title property is always filled with the title; it cannot be mapped to another field.".into());
        }
        if !compatible(f.kind, &p.kind) {
            return Err(format!("{} cannot be written into \"{}\" ({}).", f.label, p.name, p.kind));
        }
        if !used.insert(m.property.clone()) {
            return Err(format!("\"{}\" is used for more than one field.", m.property));
        }
    }
    Ok(())
}

fn rich(text: &str) -> Value {
    // Notion allows 2,000 characters per text segment, so longer values are split.
    let chars: Vec<char> = text.chars().collect();
    Value::Array(chars.chunks(2000).map(|c| json!({ "text": { "content": c.iter().collect::<String>() } })).collect())
}

fn as_text(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::Array(a) => {
            let parts: Vec<String> = a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect();
            if parts.is_empty() { None } else { Some(parts.join(", ")) }
        }
        _ => None,
    }
}

fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    let day = b.len() >= 10 && b[..10].iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    day && (b.len() == 10 || b[10] == b'T')
}

/// Builds the `properties` object for a new row. `values` maps field keys to JSON values (string, number or list).
/// Returns the properties and a list of things that were skipped, with the reason.
pub fn build_properties(schema: &Schema, destination: &str, mapping: &[MapEntry], title: &str, values: &Map<String, Value>) -> Result<(Value, Vec<String>), String> {
    let title_prop = schema.properties.iter().find(|p| p.kind == "title").ok_or("This database has no title property.")?;
    let fields = fields_for(destination).ok_or("Unknown destination.")?;
    let mut props = Map::new();
    let mut warnings = Vec::new();
    props.insert(title_prop.name.clone(), json!({ "title": rich(title.trim()) }));

    for m in mapping {
        let Some(value) = values.get(&m.field) else { continue };
        if value.is_null() {
            continue;
        }
        let Some(field) = fields.iter().find(|f| f.key == m.field) else { continue };
        let Some(p) = schema.properties.iter().find(|p| p.name == m.property) else {
            warnings.push(format!("{}: the database no longer has \"{}\", so it was left empty.", field.label, m.property));
            continue;
        };
        if p.kind == "title" || !compatible(field.kind, &p.kind) {
            warnings.push(format!("{}: \"{}\" is now a {} property, which does not fit, so it was left empty.", field.label, p.name, p.kind));
            continue;
        }
        let out: Option<Value> = match p.kind.as_str() {
            "rich_text" => as_text(value).map(|t| json!({ "rich_text": rich(&t) })),
            "number" => value.as_f64().map(|n| json!({ "number": n })),
            "select" => as_text(value).map(|t| json!({ "select": { "name": t.replace(',', " ") } })),
            "status" => match as_text(value) {
                Some(t) => match p.options.iter().find(|o| o.eq_ignore_ascii_case(&t)) {
                    Some(o) => Some(json!({ "status": { "name": o } })),
                    None => {
                        warnings.push(format!("{}: \"{t}\" is not one of the options of \"{}\" ({}), so it was left empty.", field.label, p.name, p.options.join(", ")));
                        None
                    }
                },
                None => None,
            },
            "multi_select" => value.as_array().map(|a| {
                let mut names: Vec<String> = a.iter().filter_map(|x| x.as_str()).map(|s| s.replace(',', " ").trim().to_string()).filter(|s| !s.is_empty()).collect();
                let mut seen = std::collections::HashSet::new();
                names.retain(|n| seen.insert(n.to_lowercase()));
                names.truncate(100);
                json!({ "multi_select": names.into_iter().map(|n| json!({ "name": n })).collect::<Vec<_>>() })
            }),
            "date" => match value.as_str().map(str::trim) {
                Some(s) if is_iso_date(s) => Some(json!({ "date": { "start": s } })),
                Some(s) => {
                    warnings.push(format!("{}: \"{s}\" is not a date, so it was left empty.", field.label));
                    None
                }
                None => None,
            },
            "url" => match as_text(value) {
                Some(t) if t.starts_with("http://") || t.starts_with("https://") => Some(json!({ "url": t })),
                Some(_) => {
                    warnings.push(format!("{}: only web links fit a URL property, so it was left empty.", field.label));
                    None
                }
                None => None,
            },
            "relation" => value.as_str().and_then(super::parse_page_id).map(|id| json!({ "relation": [{ "id": id }] })),
            _ => None,
        };
        if let Some(v) = out {
            props.insert(p.name.clone(), v);
        }
    }
    Ok((Value::Object(props), warnings))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(name: &str, kind: &str, options: &[&str]) -> PropSchema {
        PropSchema { id: name.to_lowercase(), name: name.into(), kind: kind.into(), options: options.iter().map(|s| s.to_string()).collect() }
    }

    fn schema() -> Schema {
        Schema {
            id: "ds1".into(),
            title: "Meetings".into(),
            properties: vec![
                p("Name", "title", &[]),
                p("When", "date", &[]),
                p("Minutes", "number", &[]),
                p("Kind", "select", &["meeting", "call"]),
                p("Labels", "multi_select", &[]),
                p("Notes", "rich_text", &[]),
                p("Stage", "status", &["Not started", "Done"]),
                p("Link", "url", &[]),
                p("Project", "relation", &[]),
            ],
        }
    }

    fn map(pairs: &[(&str, &str)]) -> Vec<MapEntry> {
        pairs.iter().map(|(f, pr)| MapEntry { field: (*f).into(), property: (*pr).into() }).collect()
    }

    fn vals(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn every_destination_lists_fields_and_unknown_ones_do_not() {
        for d in ["meetings", "practice", "tasks"] {
            assert!(!fields_for(d).unwrap().is_empty());
        }
        assert!(fields_for("nope").is_none());
    }

    #[test]
    fn reads_a_data_source_and_keeps_only_writable_properties() {
        let v = json!({"id": "ds1", "title": [{"plain_text": "Meet"}, {"plain_text": "ings"}], "properties": {
            "Name": {"id": "title", "name": "Name", "type": "title", "title": {}},
            "Mood": {"id": "a", "name": "Mood", "type": "select", "select": {"options": [{"name": "Good"}, {"name": "Bad"}]}},
            "Total": {"id": "b", "name": "Total", "type": "formula", "formula": {"expression": "1"}},
            "Made": {"id": "c", "name": "Made", "type": "created_time", "created_time": {}}
        }});
        let s = schema_from(&v).unwrap();
        assert_eq!(s.title, "Meetings");
        assert_eq!(s.properties.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["Mood", "Name"]);
        assert_eq!(s.properties[0].options, vec!["Good", "Bad"]);
    }

    #[test]
    fn checks_which_fields_fit_which_properties() {
        assert!(compatible(FieldKind::Date, "date") && compatible(FieldKind::Number, "number"));
        assert!(compatible(FieldKind::List, "multi_select") && compatible(FieldKind::Relation, "relation"));
        assert!(!compatible(FieldKind::Number, "date") && !compatible(FieldKind::Text, "number") && !compatible(FieldKind::Date, "status"));
    }

    #[test]
    fn validates_a_mapping_against_the_live_schema() {
        let s = schema();
        assert!(validate_mapping("meetings", &s, &map(&[("date", "When"), ("duration_min", "Minutes"), ("type", "Kind"), ("tags", "Labels")])).is_ok());
        assert!(validate_mapping("meetings", &s, &map(&[("date", "Missing")])).unwrap_err().contains("no property"));
        assert!(validate_mapping("meetings", &s, &map(&[("date", "Minutes")])).unwrap_err().contains("cannot be written"));
        assert!(validate_mapping("meetings", &s, &map(&[("date", "Name")])).unwrap_err().contains("title"));
        assert!(validate_mapping("meetings", &s, &map(&[("date", "Notes"), ("type", "Notes")])).unwrap_err().contains("more than one"));
        assert!(validate_mapping("meetings", &s, &map(&[("bogus", "Notes")])).unwrap_err().contains("not a field"));
        assert!(validate_mapping("meetings", &s, &map(&[])).is_ok());
    }

    #[test]
    fn builds_the_properties_for_a_row() {
        let m = map(&[("date", "When"), ("duration_min", "Minutes"), ("type", "Kind"), ("tags", "Labels"), ("project", "Notes"), ("source", "Link")]);
        let (props, warnings) = build_properties(
            &schema(), "meetings", &m, " Sprint review ",
            &vals(json!({"date": "2026-11-19", "duration_min": 12.5, "type": "meeting", "tags": ["voice", "meeting", "voice", "a,b"], "project": "Apollo", "source": "https://example.com"})),
        ).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(props["Name"]["title"][0]["text"]["content"], "Sprint review");
        assert_eq!(props["When"]["date"]["start"], "2026-11-19");
        assert_eq!(props["Minutes"]["number"], 12.5);
        assert_eq!(props["Kind"]["select"]["name"], "meeting");
        assert_eq!(props["Labels"]["multi_select"].as_array().unwrap().len(), 3, "duplicates dropped");
        assert_eq!(props["Labels"]["multi_select"][2]["name"], "a b", "commas are not allowed in option names");
        assert_eq!(props["Notes"]["rich_text"][0]["text"]["content"], "Apollo");
        assert_eq!(props["Link"]["url"], "https://example.com");
    }

    #[test]
    fn unmapped_or_missing_values_are_simply_left_out() {
        let (props, w) = build_properties(&schema(), "meetings", &map(&[("date", "When")]), "T", &vals(json!({"duration_min": 5, "tags": ["x"]}))).unwrap();
        assert_eq!(props.as_object().unwrap().keys().collect::<Vec<_>>(), vec!["Name"]);
        assert!(w.is_empty());
    }

    #[test]
    fn problems_become_warnings_not_failures() {
        let m = map(&[("date", "When"), ("type", "Stage"), ("project", "Gone"), ("source", "Link")]);
        let (props, w) = build_properties(&schema(), "meetings", &m, "T", &vals(json!({"date": "next friday", "type": "Open", "project": "x", "source": "not a url"}))).unwrap();
        assert_eq!(props.as_object().unwrap().len(), 1, "only the title is written");
        let all = w.join("\n");
        assert!(all.contains("not a date") && all.contains("not one of the options") && all.contains("no longer has") && all.contains("web links"), "{all}");
    }

    #[test]
    fn a_status_value_matches_options_ignoring_case() {
        let (props, w) = build_properties(&schema(), "meetings", &map(&[("type", "Stage")]), "T", &vals(json!({"type": "done"}))).unwrap();
        assert!(w.is_empty());
        assert_eq!(props["Stage"]["status"]["name"], "Done");
    }

    #[test]
    fn long_text_is_split_into_segments_under_the_limit() {
        let (props, _) = build_properties(&schema(), "meetings", &map(&[("project", "Notes")]), "T", &vals(json!({"project": "x".repeat(4500)}))).unwrap();
        let segs = props["Notes"]["rich_text"].as_array().unwrap();
        assert_eq!(segs.len(), 3);
        assert!(segs.iter().all(|s| s["text"]["content"].as_str().unwrap().chars().count() <= 2000));
    }

    #[test]
    fn relation_values_become_page_references() {
        let s = Schema { id: "t".into(), title: "Tasks".into(), properties: vec![p("Name", "title", &[]), p("Meeting", "relation", &[])] };
        let (props, _) = build_properties(&s, "tasks", &map(&[("meeting", "Meeting")]), "Do it", &vals(json!({"meeting": "https://notion.so/Page-1429989fe8ac4effbc8f57f56486db54"}))).unwrap();
        assert_eq!(props["Meeting"]["relation"][0]["id"], "1429989f-e8ac-4eff-bc8f-57f56486db54");
    }

    #[test]
    fn a_database_without_a_title_property_is_refused() {
        let s = Schema { id: "x".into(), title: "x".into(), properties: vec![p("A", "rich_text", &[])] };
        assert!(build_properties(&s, "meetings", &[], "T", &Map::new()).is_err());
    }

    #[test]
    fn every_template_maps_only_real_fields_to_compatible_columns() {
        for d in ["meetings", "practice", "tasks"] {
            let t = template_for(d, Some("ds-meetings")).unwrap();
            let fields = fields_for(d).unwrap();
            for m in &t.mapping {
                let f = fields.iter().find(|f| f.key == m.field).unwrap_or_else(|| panic!("{d}: no field {}", m.field));
                let kind = &t.columns.iter().find(|(n, _)| *n == m.property).unwrap().1;
                assert!(compatible(f.kind, kind), "{d}: {} -> {} ({kind})", m.field, m.property);
            }
            assert_eq!(t.properties["Name"], json!({ "title": {} }));
            assert_eq!(t.columns[0], ("Name".to_string(), "title".to_string()));
            // the mapping must validate against the schema Notion would report for these columns
            let schema = Schema { id: "x".into(), title: t.title.into(), properties: t.columns.iter().map(|(n, k)| p(n, k, &[])).collect() };
            assert_eq!(validate_mapping(d, &schema, &t.mapping), Ok(()), "{d}");
        }
        assert!(template_for("other", None).is_none());
    }

    #[test]
    fn the_tasks_database_only_links_to_meetings_when_there_is_one() {
        let without = template_for("tasks", None).unwrap();
        assert!(without.columns.iter().all(|(_, k)| k != "relation"));
        let with = template_for("tasks", Some("ds-m")).unwrap();
        assert_eq!(with.properties["Meeting"]["relation"]["data_source_id"], "ds-m");
        assert!(with.mapping.iter().any(|m| m.field == "meeting"));
    }

    #[test]
    fn dates_accept_a_day_or_a_date_time() {
        assert!(is_iso_date("2026-11-19") && is_iso_date("2026-11-19T10:30:00"));
        assert!(!is_iso_date("19/11/2026") && !is_iso_date("2026-11-1") && !is_iso_date("2026-11-19 10:30"));
    }
}
