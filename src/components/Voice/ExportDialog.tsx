import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../services/api";
import { appendFromSections, appendToContent, combinedFromSections, standaloneFromSection, type Section } from "../../services/voice/templates";
import { suggestFileName } from "../../services/voice/transcript";
import type { SessionMeta } from "../../services/voice/types";
import type { FileEntry } from "../../types";

type Layout = "combined" | "separate";
type Dest = "new" | "append";

/** Preview and save voice outputs as Markdown: new file(s), or appended to an existing file without touching it. */
export function ExportDialog({ meta, sections, docTitle, onClose }: { meta: SessionMeta; sections: Section[]; docTitle: string; onClose: () => void }) {
  const [include, setInclude] = useState<Set<string>>(new Set(sections.map((s) => s.id)));
  const [layout, setLayout] = useState<Layout>("combined");
  const [dest, setDest] = useState<Dest>("new");
  const [name, setName] = useState(suggestFileName(meta, docTitle));
  const [folder, setFolder] = useState<string | null>(null); // null = the default save folder
  const [defaultDir, setDefaultDir] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    api.getSaveDir().then(setDefaultDir).catch(() => {});
    api.listFiles().then((f) => { setFiles(f); setTarget(f[0]?.id ?? ""); }).catch(() => {});
  }, []);

  const chosen = useMemo(() => sections.filter((s) => include.has(s.id)), [sections, include]);
  const preview = useMemo(() => {
    if (!chosen.length) return "";
    if (dest === "append") return appendFromSections(meta, chosen);
    if (layout === "combined") return combinedFromSections(meta, docTitle, chosen);
    return chosen.map((s) => `<!-- ${suggestFileName(meta, s.suffix)}.md -->\n${standaloneFromSection(meta, s)}`).join("\n\n");
  }, [chosen, dest, layout, meta, docTitle]);

  const pickFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setFolder(dir);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const write = (n: string, c: string) => (folder ? api.createMarkdownFileIn(folder, n, c) : api.createMarkdownFile(n, c));
      if (dest === "append") {
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
          const f = await write(suggestFileName(meta, s.suffix), standaloneFromSection(meta, s));
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
        <label className="voice-check"><input type="radio" name="dest" checked={dest === "new"} onChange={() => setDest("new")} /> New file</label>
        <label className="voice-check"><input type="radio" name="dest" checked={dest === "append"} onChange={() => setDest("append")} /> Add to an existing file</label>
        {dest === "new" && (
          <>
            <label className="voice-check"><input type="radio" name="layout" checked={layout === "combined"} onChange={() => setLayout("combined")} /> One document</label>
            <label className="voice-check"><input type="radio" name="layout" checked={layout === "separate"} onChange={() => setLayout("separate")} /> One file per section</label>
          </>
        )}
      </div>
      {dest === "new" ? (
        <div className="voice-actions">
          {layout === "combined" && <input className="search" style={{ flex: 1, minWidth: 160, margin: 0 }} aria-label="File name" value={name} onChange={(e) => setName(e.target.value)} />}
          <span className="note" title={folder ?? defaultDir}>Folder: {(folder ?? defaultDir) || "default"}</span>
          <button className="btn" onClick={() => void pickFolder()}>CHOOSE FOLDER</button>
          {folder && <button className="btn" onClick={() => setFolder(null)}>DEFAULT</button>}
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
      <textarea className="voice-preview" readOnly aria-label="Preview" value={preview} />
      {error && <div className="error" role="alert">{error}</div>}
      {done && <div className="voice-warn" role="status">{done}</div>}
      <div className="voice-actions">
        <button className="btn primary" disabled={busy || !chosen.length || (dest === "append" && !target)} onClick={() => void save()}>
          {dest === "append" ? "ADD TO FILE" : "SAVE & OPEN"}
        </button>
        <button className="btn" onClick={onClose}>CLOSE</button>
      </div>
    </div>
  );
}
