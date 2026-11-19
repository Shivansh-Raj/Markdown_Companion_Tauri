import { useEffect, useState } from "react";
import { api } from "../../services/api";
import { fits, sampleValues, suggestMapping } from "../../services/notionMapping";
import type { NotionTemplate, NotionDestination, NotionField, NotionHit, NotionMapEntry, NotionRowPreview, NotionSchema } from "../../types";
import "./notion.css";

const KINDS: { key: string; label: string; help: string }[] = [
  { key: "meetings", label: "Meetings", help: "Where meeting summaries and action items are saved." },
  { key: "practice", label: "Practice sessions", help: "Where speaking-practice results (pace, fillers, pauses) are saved." },
  { key: "tasks", label: "Tasks", help: "Where approved action items become task rows." },
];

/** One destination: pick a database, then say which property each MC field goes into. */
function Destination({ kind }: { kind: (typeof KINDS)[number] }) {
  const [saved, setSaved] = useState<NotionDestination | null | undefined>(undefined);
  const [fields, setFields] = useState<NotionField[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<NotionHit[] | null>(null);
  const [schema, setSchema] = useState<NotionSchema | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<NotionRowPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [template, setTemplate] = useState<NotionTemplate | null>(null);
  const [hasHome, setHasHome] = useState(false);

  useEffect(() => {
    api.notionHome().then((h) => setHasHome(!!h)).catch(() => {});
    api.notionDestination(kind.key).then(setSaved).catch(() => setSaved(null));
    api.notionDestinationFields(kind.key).then(setFields).catch(() => {});
  }, [kind.key]);

  const run = async (f: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await f(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const find = () => run(async () => setHits(await api.notionSearchDatabases(query)));

  const choose = (hit: NotionHit, existing?: NotionMapEntry[]) => run(async () => {
    const s = await api.notionSchema(hit.id);
    setSchema(s); setHits(null); setPreview(null);
    const start = existing ?? suggestMapping(fields, s.properties);
    setMapping(Object.fromEntries(start.map((m) => [m.field, m.property])));
  });

  const entries = (): NotionMapEntry[] => Object.entries(mapping).filter(([, p]) => p).map(([field, property]) => ({ field, property }));

  const save = () => run(async () => {
    if (!schema) return;
    setSaved(await api.notionSetDestination(kind.key, schema.id, entries()));
    setSchema(null); setOpen(false);
  });

  const showPreview = () => run(async () => {
    if (!schema) return;
    // Preview uses the saved mapping, so save first when it changed.
    await api.notionSetDestination(kind.key, schema.id, entries());
    setSaved(await api.notionDestination(kind.key));
    setPreview(await api.notionPreviewRow(kind.key, "Sample row", sampleValues(kind.key)));
  });

  const titleProp = schema?.properties.find((p) => p.type === "title");

  return (
    <div className="notion-dest">
      <h3 className="voice-h">{kind.label.toUpperCase()}</h3>
      <p className="note">{kind.help}</p>
      {saved && !open && (
        <div className="folder">
          <span title={saved.data_source_id}>{saved.title} · {saved.mapping.length} field{saved.mapping.length === 1 ? "" : "s"} mapped</span>
          <button className="btn" disabled={busy} onClick={() => { setOpen(true); void choose({ id: saved.data_source_id, title: saved.title, url: "" }, saved.mapping); }}>EDIT</button>
          <button className="btn" disabled={busy} onClick={() => void run(async () => { await api.notionClearDestination(kind.key); setSaved(null); })}>CLEAR</button>
        </div>
      )}
      {!saved && !open && !template && (
        <div className="voice-actions">
          <button className="btn primary" disabled={!hasHome || busy} title={hasHome ? "Makes a new database with the right columns" : "Choose a home page first"}
            onClick={() => void run(async () => setTemplate(await api.notionTemplate(kind.key)))}>CREATE FOR ME</button>
          <button className="btn" onClick={() => setOpen(true)}>CHOOSE EXISTING</button>
          {!hasHome && <span className="note">Choose a home page first to create one.</span>}
        </div>
      )}
      {template && !saved && (
        <div className="notion-diff">
          <p className="note">This creates a new database called “{template.title}” inside your home page, with these columns. Nothing existing is changed. If a database with that name is already there, nothing is created.</p>
          <pre className="notion-diff-new">{template.columns.map(([n, t]) => `${n}  (${t.replace("_", " ")})`).join("\n")}</pre>
          <div className="voice-actions">
            <button className="btn primary" disabled={busy} onClick={() => void run(async () => { setSaved(await api.notionCreateDestination(kind.key)); setTemplate(null); })}>{busy ? "CREATING…" : "CREATE"}</button>
            <button className="btn" disabled={busy} onClick={() => setTemplate(null)}>CANCEL</button>
          </div>
        </div>
      )}
      {open && !schema && (
        <>
          <div className="voice-actions">
            <input className="search" style={{ flex: 1, margin: 0 }} aria-label="Find a Notion database" placeholder="Search databases by title"
              value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void find()} />
            <button className="btn" disabled={busy} onClick={() => void find()}>{query.trim() ? "FIND" : "LIST ALL"}</button>
            <button className="btn" onClick={() => { setOpen(false); setHits(null); }}>CANCEL</button>
          </div>
          {hits && (
            <ul className="notion-hits">
              {hits.length === 0 && <li className="note">No databases found. With a connection token, share the database with it first (••• → Add connections).</li>}
              {hits.map((h) => <li key={h.id}><button className="btn" disabled={busy} onClick={() => void choose(h)}>{h.title}</button></li>)}
            </ul>
          )}
        </>
      )}
      {open && schema && (
        <div className="notion-map">
          <p className="note">Database: <strong>{schema.title}</strong>. The title always goes into “{titleProp?.name ?? "the title property"}”. Choose where each of the others goes, or leave it unfilled.</p>
          {fields.map((f) => (
            <label key={f.key} className="notion-map-row">
              <span>{f.label}</span>
              <select value={mapping[f.key] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value }))}>
                <option value="">Don't fill</option>
                {schema.properties.filter((p) => p.type !== "title" && fits(f, p)).map((p) => (
                  <option key={p.id} value={p.name}
                    disabled={Object.entries(mapping).some(([k, v]) => v === p.name && k !== f.key)}>{p.name} ({p.type.replace("_", " ")})</option>
                ))}
              </select>
            </label>
          ))}
          <div className="voice-actions">
            <button className="btn primary" disabled={busy} onClick={() => void save()}>SAVE</button>
            <button className="btn" disabled={busy} onClick={() => void showPreview()} title="Shows what a row would contain, using example values. Nothing is created in Notion.">PREVIEW</button>
            <button className="btn" onClick={() => { setSchema(null); setOpen(false); setPreview(null); }}>CANCEL</button>
          </div>
          {preview && (
            <div className="notion-diff">
              <p className="note">A sample row in “{preview.database}” would contain this. Nothing was created.</p>
              <pre className="notion-diff-new">{JSON.stringify(preview.properties, null, 2)}</pre>
              {preview.warnings.map((w) => <p key={w} className="error">{w}</p>)}
            </div>
          )}
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
    </div>
  );
}

export function NotionDestinations() {
  return (
    <>
      <h2>NOTION DATABASES</h2>
      <p className="note">Optional. Choose a database for each kind of export and say which of its properties each piece of information goes into. Nothing is sent until an export uses it.</p>
      {KINDS.map((k) => <Destination key={k.key} kind={k} />)}
    </>
  );
}
