import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../services/api";
import "../Notion/notion.css";
import { appendFromSections, appendToContent, bodyFromSections, combinedFromSections, standaloneFromSection, type ExtraProperties, type Section } from "../../services/voice/templates";
import type { ActionItem } from "../../services/voice/analyses";
import { notionTargetFor, notionValues, taskRowsFor } from "../../services/voice/notionExport";
import { suggestFileName } from "../../services/voice/transcript";
import type { SessionMeta } from "../../services/voice/types";
import type { FileEntry, NotionDestination, NotionHome, NotionRowPreview } from "../../types";

const FRONTMATTER_KEY = "voice-frontmatter";
const FOLDER_KEY = "voice-export-folder";
const readPref = (k: string): string | null => { try { return localStorage.getItem(k); } catch { return null; } };
const writePref = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* optional */ } };

type Layout = "combined" | "separate";
type Dest = "new" | "append" | "notion";

/** Preview and save voice outputs as Markdown: new file(s), or appended to an existing file without touching it. */
export function ExportDialog({ meta, sections, docTitle, properties, actionItems, onClose }: { meta: SessionMeta; sections: Section[]; docTitle: string; properties?: ExtraProperties; actionItems?: ActionItem[]; onClose: () => void }) {
  const [include, setInclude] = useState<Set<string>>(new Set(sections.map((s) => s.id)));
  const [layout, setLayout] = useState<Layout>("combined");
  const [dest, setDest] = useState<Dest>("new");
  const [name, setName] = useState(suggestFileName(meta, docTitle));
  const [folder, setFolder] = useState<string | null>(() => readPref(FOLDER_KEY)); // null = the default save folder
  const [frontmatter, setFrontmatter] = useState(() => readPref(FRONTMATTER_KEY) === "1");
  const [watched, setWatched] = useState<string[]>([]);
  const [defaultDir, setDefaultDir] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  // Notion: a database row when one is set up for this kind of recording, else a page under the home page.
  const nTarget = useMemo(() => notionTargetFor(meta), [meta]);
  const [nConnected, setNConnected] = useState(false);
  const [nHome, setNHome] = useState<NotionHome | null>(null);
  const [nDb, setNDb] = useState<NotionDestination | null>(null);
  const [nTitle, setNTitle] = useState(meta.title.trim() || docTitle);
  const [nPreview, setNPreview] = useState<NotionRowPreview | null>(null);
  const [nUrl, setNUrl] = useState<string | null>(null);
  // Action items can also become task rows. Which were already sent is remembered per recording, so pressing the button twice
  // does not create the same tasks twice.
  const SENT_KEY = `notion-tasks-sent:${meta.id}`;
  const [tasksDb, setTasksDb] = useState<NotionDestination | null>(null);
  const [sentKeys, setSentKeys] = useState<Set<string>>(() => { try { return new Set<string>(JSON.parse(localStorage.getItem(SENT_KEY) ?? "[]")); } catch { return new Set<string>(); } });
  const [picked, setPicked] = useState<Set<string> | null>(null); // null = everything not yet sent

  useEffect(() => {
    api.notionConnected().then(setNConnected).catch(() => {});
    api.notionHome().then(setNHome).catch(() => {});
    if (nTarget.key !== "notes") api.notionDestination(nTarget.key).then(setNDb).catch(() => {});
    api.notionDestination("tasks").then(setTasksDb).catch(() => {});
  }, [nTarget.key]);

  useEffect(() => {
    api.getSaveDir().then(setDefaultDir).catch(() => {});
    api.listFolders().then(setWatched).catch(() => {});
    api.listFiles().then((f) => { setFiles(f); setTarget(f[0]?.id ?? ""); }).catch(() => {});
  }, []);

  const chosen = useMemo(() => sections.filter((s) => include.has(s.id)), [sections, include]);
  const preview = useMemo(() => {
    if (!chosen.length) return "";
    if (dest === "append") return appendFromSections(meta, chosen);
    if (layout === "combined") return combinedFromSections(meta, docTitle, chosen, frontmatter, properties);
    return chosen.map((s) => `<!-- ${suggestFileName(meta, s.suffix)}.md -->\n${standaloneFromSection(meta, s, frontmatter, properties)}`).join("\n\n");
  }, [chosen, dest, layout, meta, docTitle, frontmatter, properties]);

  const nBody = useMemo(() => bodyFromSections(chosen), [chosen]);
  const nValues = useMemo(() => notionValues(meta, properties), [meta, properties]);
  const meetingIsRow = !!nDb && nTarget.key === "meetings";
  const showTasks = dest === "notion" && meetingIsRow && !!tasksDb && !!actionItems?.length;
  const taskRows = useMemo(() => taskRowsFor(actionItems ?? [], meetingIsRow ? "(the meeting)" : null), [actionItems, meetingIsRow]);
  const isPicked = (key: string) => !sentKeys.has(key) && (picked === null || picked.has(key));
  const togglePick = (key: string) => setPicked((cur) => { const n = new Set(cur ?? taskRows.filter((r) => !sentKeys.has(r.key)).map((r) => r.key)); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const nReady = nConnected && (nDb !== null || nHome !== null);

  // Shows exactly which columns would be filled; reads the database's properties, creates nothing.
  useEffect(() => {
    setNPreview(null);
    if (dest !== "notion" || !nDb || nTarget.key === "notes") return;
    let cancelled = false;
    api.notionPreviewRow(nTarget.key, nTitle || "Untitled", nValues).then((p) => { if (!cancelled) setNPreview(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [dest, nDb, nTitle, nValues, nTarget.key]);

  const chooseFolder = (dir: string | null) => { setFolder(dir); writePref(FOLDER_KEY, dir); };
  const toggleFrontmatter = (on: boolean) => { setFrontmatter(on); writePref(FRONTMATTER_KEY, on ? "1" : "0"); };

  const pickFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") chooseFolder(dir);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const write = (n: string, c: string) => (folder ? api.createMarkdownFileIn(folder, n, c) : api.createMarkdownFile(n, c));
      if (dest === "notion") {
        const made = nDb && nTarget.key !== "notes"
          ? await api.notionCreateRow(nTarget.key, nTitle, nBody, nValues)
          : await api.notionCreatePage("", nTitle, nBody, undefined, nTarget.section);
        setNUrl(made.url || null);
        let taskNote = "";
        if (showTasks && tasksDb) {
          // Each task links to the meeting's row. They are created one at a time; a failure on one does not stop the rest.
          const todo = taskRowsFor(actionItems ?? [], made.id).filter((r) => isPicked(r.key));
          const sent = new Set(sentKeys);
          let ok = 0;
          const failed: string[] = [];
          for (const r of todo) {
            try {
              await api.notionCreateRow("tasks", r.title, r.body, r.values);
              sent.add(r.key);
              ok++;
            } catch (e) {
              failed.push(`“${r.title}”: ${typeof e === "string" ? e : e instanceof Error ? e.message : "failed"}`);
            }
          }
          setSentKeys(sent);
          try { localStorage.setItem(SENT_KEY, JSON.stringify([...sent])); } catch { /* optional */ }
          taskNote = ` ${ok} task${ok === 1 ? "" : "s"} created in ${tasksDb.title}.${failed.length ? ` Not created: ${failed.join(" ")}` : ""}`;
        }
        const warnings: string[] = "warnings" in made ? (made.warnings as string[]) : [];
        const warn = warnings.length ? ` Left empty: ${warnings.join(" ")}` : "";
        setDone(`Saved to Notion${nDb && nTarget.key !== "notes" ? ` (${nDb.title})` : ` (${nHome?.title} › ${nTarget.label})`}.${warn}${taskNote}`);
      } else if (dest === "append") {
        const entry = files.find((f) => f.id === target);
        if (!entry) throw new Error("Choose a file to append to.");
        const snap = await api.readTrackerFile(entry.id);
        // hash-checked save: refuses if the file changed since we read it, never overwrites other edits
        await api.saveTrackerContent(entry.id, snap.hash, appendToContent(snap.content, preview));
        await api.openTracker(entry.id);
        setDone(`Added to ${entry.display_name}.`);
      } else if (layout === "combined") {
        const f = await write(name.trim() || suggestFileName(meta, docTitle), preview.endsWith("\n") ? preview : preview + "\n");
        await api.openTracker(f.id);
        setDone(`Saved ${f.display_name}.`);
      } else {
        const made: string[] = [];
        for (const s of chosen) {
          const f = await write(suggestFileName(meta, s.suffix), standaloneFromSection(meta, s, frontmatter, properties));
          await api.openTracker(f.id);
          made.push(f.display_name);
        }
        setDone(`Saved ${made.join(", ")}.`);
      }
    } catch (e) {
      setError(typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e));
    }
    setBusy(false);
  };

  return (
    <div className="voice-export" role="dialog" aria-label="Export as Markdown">
      <h3 className="voice-h">EXPORT AS MARKDOWN</h3>
      <div className="voice-actions">
        {sections.map((s) => (
          <label key={s.id} className="voice-check">
            <input type="checkbox" checked={include.has(s.id)}
              onChange={() => setInclude((cur) => { const n = new Set(cur); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; })} /> {s.label}
          </label>
        ))}
      </div>
      <div className="voice-actions">
        <label className="voice-check" title="Adds a YAML properties block (date, type, duration, tags) at the top of new files.">
          <input type="checkbox" checked={frontmatter} onChange={(e) => toggleFrontmatter(e.target.checked)} /> Frontmatter properties
        </label>
      </div>
      <div className="voice-actions">
        <label className="voice-check"><input type="radio" name="dest" checked={dest === "new"} onChange={() => setDest("new")} /> New file</label>
        <label className="voice-check"><input type="radio" name="dest" checked={dest === "append"} onChange={() => setDest("append")} /> Add to an existing file</label>
        {nConnected && <label className="voice-check"><input type="radio" name="dest" checked={dest === "notion"} onChange={() => setDest("notion")} /> Notion</label>}
        {dest === "new" && (
          <>
            <label className="voice-check"><input type="radio" name="layout" checked={layout === "combined"} onChange={() => setLayout("combined")} /> One document</label>
            <label className="voice-check"><input type="radio" name="layout" checked={layout === "separate"} onChange={() => setLayout("separate")} /> One file per section</label>
          </>
        )}
      </div>
      {dest === "notion" ? (
        <div className="voice-actions">
          <input className="search" style={{ flex: 1, minWidth: 160, margin: 0 }} aria-label="Notion page title" value={nTitle} onChange={(e) => setNTitle(e.target.value)} />
          <span className="note">
            {nDb && nTarget.key !== "notes" ? `A new row in “${nDb.title}”, with its mapped columns filled.`
              : nHome ? `A new page in ${nHome.title} › ${nTarget.label}.`
              : "Choose a Notion home page or database in Settings first."}
          </span>
        </div>
      ) : dest === "new" ? (
        <div className="voice-actions">
          {layout === "combined" && <input className="search" style={{ flex: 1, minWidth: 160, margin: 0 }} aria-label="File name" value={name} onChange={(e) => setName(e.target.value)} />}
          <span className="note" title={folder ?? defaultDir}>Folder: {(folder ?? defaultDir) || "default"}</span>
          {watched.length > 0 && (
            <select className="search" style={{ margin: 0 }} aria-label="Watched folder" value={folder && watched.includes(folder) ? folder : ""} onChange={(e) => e.target.value && chooseFolder(e.target.value)}>
              <option value="">Watched folders…</option>
              {watched.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          )}
          <button className="btn" onClick={() => void pickFolder()}>CHOOSE FOLDER</button>
          {folder && <button className="btn" onClick={() => chooseFolder(null)}>DEFAULT</button>}
        </div>
      ) : (
        <div className="voice-actions">
          <select className="search" style={{ flex: 1, margin: 0 }} aria-label="File to add to" value={target} onChange={(e) => setTarget(e.target.value)}>
            {files.length === 0 && <option value="">No tracked files yet</option>}
            {files.map((f) => <option key={f.id} value={f.id}>{f.display_name}</option>)}
          </select>
          <span className="note">Added at the end; nothing already in the file is changed.</span>
        </div>
      )}
      {showTasks && (
        <div className="notion-tasks">
          <p className="note">Also create these as tasks in “{tasksDb!.title}”. Each links to this meeting. Tick the ones you want.</p>
          {taskRows.map((r) => (
            <label key={r.key} className="voice-check">
              <input type="checkbox" checked={isPicked(r.key)} disabled={sentKeys.has(r.key)} onChange={() => togglePick(r.key)} /> {r.title}
              <span className="note"> {sentKeys.has(r.key) ? "(already sent)" : r.summary}</span>
            </label>
          ))}
        </div>
      )}
      {dest === "notion" && !showTasks && !!actionItems?.length && nTarget.key === "meetings" && (
        <p className="note">{!meetingIsRow ? "To also create tasks, set up a Meetings database in Settings first, so each task can link to its meeting." : "To also create tasks, set up a Tasks database in Settings first."}</p>
      )}
      <textarea className="voice-preview" readOnly aria-label="Preview" value={dest === "notion" ? nBody : preview} />
      {dest === "notion" && nPreview && (
        <div className="notion-diff">
          <p className="note">Columns that will be filled in “{nPreview.database}”:</p>
          <pre className="notion-diff-new">{JSON.stringify(nPreview.properties, null, 2)}</pre>
          {nPreview.warnings.map((w) => <p key={w} className="error">{w}</p>)}
        </div>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      {done && <div className="voice-warn" role="status">{done}</div>}
      {dest === "notion" && nUrl && <button className="btn" onClick={() => void api.openExternal(nUrl).catch((e) => setError(String(e)))}>OPEN IN NOTION</button>}
      <div className="voice-actions">
        <button className="btn primary" disabled={busy || !chosen.length || (dest === "append" && !target) || (dest === "notion" && (!nReady || !nTitle.trim()))} onClick={() => void save()}>
          {dest === "new" ? "SAVE & OPEN" : dest === "notion" ? "SAVE TO NOTION" : "ADD TO FILE"}
        </button>
        <button className="btn" onClick={onClose}>CLOSE</button>
      </div>
    </div>
  );
}
