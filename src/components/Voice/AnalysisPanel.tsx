import { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api } from "../../services/api";
import { streamChat } from "../../services/ai";
import {
  ANALYSIS_LABELS, ANALYSIS_TYPES, buildSystemPrompt, buildUserPrompt, latestByType, limitTranscript, timedTranscript,
  toResult, type AnalysisResult, type AnalysisType,
} from "../../services/voice/analyses";
import { appendBlock, appendToContent, combinedMarkdown, standaloneMarkdown, typeFileSuffix } from "../../services/voice/templates";
import { suggestFileName } from "../../services/voice/transcript";
import type { FileEntry } from "../../types";
import type { SessionMeta, TranscriptChunk } from "../../services/voice/types";

type Layout = "combined" | "separate";
type Dest = "new" | "append";

/** Meeting analyses (summary, takeaways, action items) with Markdown export. Regenerable from the transcript. */
export function AnalysisPanel({ meta, chunks, ready }: { meta: SessionMeta; chunks: TranscriptChunk[]; ready: boolean }) {
  const [selected, setSelected] = useState<Set<AnalysisType>>(new Set(ANALYSIS_TYPES));
  const [results, setResults] = useState<Partial<Record<AnalysisType, AnalysisResult>>>({});
  const [errors, setErrors] = useState<Partial<Record<AnalysisType, string>>>({});
  const [live, setLive] = useState<Partial<Record<AnalysisType, string>>>({});
  const [running, setRunning] = useState<AnalysisType | null>(null);
  const [exporting, setExporting] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // earlier analyses of this session are loaded so nothing needs to be generated twice
  useEffect(() => {
    let alive = true;
    api.voiceListAnalyses(meta.id).then((rows) => {
      if (!alive) return;
      const parsed: AnalysisResult[] = [];
      for (const r of rows) {
        try { parsed.push(JSON.parse(r) as AnalysisResult); } catch { /* skip a damaged file */ }
      }
      setResults(latestByType(parsed));
    }).catch(() => {});
    return () => { alive = false; abort.current?.abort(); };
  }, [meta.id]);

  const toggle = (t: AnalysisType) =>
    setSelected((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });

  const run = async (types: AnalysisType[]) => {
    const apiKey = await api.getGroqKey();
    const ctl = new AbortController();
    abort.current = ctl;
    const { text, truncated } = limitTranscript(timedTranscript(chunks));
    for (const type of types) {
      if (ctl.signal.aborted) break;
      setRunning(type);
      setErrors((e) => ({ ...e, [type]: undefined }));
      setLive((l) => ({ ...l, [type]: "" }));
      try {
        if (!apiKey) throw new Error("No Groq API key. Add one in the launcher: AI → key.");
        const raw = await streamChat({
          apiKey, system: buildSystemPrompt(type), user: buildUserPrompt(meta, text), signal: ctl.signal,
          onText: (t) => setLive((l) => ({ ...l, [type]: t })),
        });
        const result = toResult(type, raw, truncated);
        await api.voiceSaveAnalysis(meta.id, type, JSON.stringify(result));
        setResults((r) => ({ ...r, [type]: result }));
      } catch (e) {
        if (!ctl.signal.aborted) setErrors((er) => ({ ...er, [type]: e instanceof Error ? e.message : String(e) }));
      }
      setLive((l) => ({ ...l, [type]: undefined }));
    }
    setRunning(null);
    abort.current = null;
  };

  const available = ANALYSIS_TYPES.filter((t) => results[t]);
  const disabled = !ready || running !== null;

  return (
    <div className="voice-analysis">
      <h3 className="voice-h">ANALYSE THIS MEETING</h3>
      <div className="voice-actions">
        {ANALYSIS_TYPES.map((t) => (
          <label key={t} className="voice-check">
            <input type="checkbox" checked={selected.has(t)} onChange={() => toggle(t)} disabled={running !== null} /> {ANALYSIS_LABELS[t]}
          </label>
        ))}
        {running
          ? <button className="btn" onClick={() => abort.current?.abort()}>STOP</button>
          : <button className="btn primary" disabled={disabled || selected.size === 0}
              onClick={() => void run(ANALYSIS_TYPES.filter((t) => selected.has(t)))}>GENERATE</button>}
        {available.length > 0 && <button className="btn" disabled={running !== null} onClick={() => setExporting(true)}>EXPORT AS MARKDOWN…</button>}
      </div>
      {!ready && <p className="note">Wait for the transcript to finish before analysing.</p>}

      {ANALYSIS_TYPES.filter((t) => results[t] || live[t] !== undefined || errors[t]).map((t) => (
        <div key={t} className="voice-result">
          <div className="voice-result-head">
            <strong>{ANALYSIS_LABELS[t].toUpperCase()}</strong>
            {results[t] && running === null && (
              <>
                <button className="btn" onClick={() => void navigator.clipboard?.writeText(results[t]!.markdown)}>COPY</button>
                <button className="btn" disabled={disabled} onClick={() => void run([t])}>REGENERATE</button>
              </>
            )}
          </div>
          {errors[t] && <div className="error" role="alert">{errors[t]}</div>}
          <pre className="voice-pre">{live[t] !== undefined ? live[t] || "Working…" : results[t]?.markdown}</pre>
          {results[t]?.truncated && <p className="note">The recording was very long, so only the first part was analysed.</p>}
        </div>
      ))}

      {exporting && <ExportDialog meta={meta} results={results} onClose={() => setExporting(false)} />}
    </div>
  );
}

function ExportDialog({ meta, results, onClose }: { meta: SessionMeta; results: Partial<Record<AnalysisType, AnalysisResult>>; onClose: () => void }) {
  const available = ANALYSIS_TYPES.filter((t) => results[t]);
  const [include, setInclude] = useState<Set<AnalysisType>>(new Set(available));
  const [layout, setLayout] = useState<Layout>("combined");
  const [dest, setDest] = useState<Dest>("new");
  const [name, setName] = useState(suggestFileName(meta, "notes"));
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

  const chosen = useMemo(() => available.filter((t) => include.has(t)).map((t) => results[t]!), [available, include, results]);
  const preview = useMemo(() => {
    if (!chosen.length) return "";
    if (dest === "append") return appendBlock(meta, chosen);
    if (layout === "combined") return combinedMarkdown(meta, chosen);
    return chosen.map((r) => `<!-- ${suggestFileName(meta, typeFileSuffix(r.type))}.md -->\n${standaloneMarkdown(meta, r)}`).join("\n\n");
  }, [chosen, dest, layout, meta]);

  const pickFolder = async () => {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") setFolder(dir);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const write = (n: string, c: string) =>
        folder ? api.createMarkdownFileIn(folder, n, c) : api.createMarkdownFile(n, c);
      if (dest === "append") {
        const entry = files.find((f) => f.id === target);
        if (!entry) throw new Error("Choose a file to append to.");
        const snap = await api.readTrackerFile(entry.id);
        // hash-checked save: refuses if the file changed since we read it, never overwrites other edits
        await api.saveTrackerContent(entry.id, snap.hash, appendToContent(snap.content, preview));
        await api.openTracker(entry.id);
        setDone(`Added to ${entry.display_name}.`);
      } else if (layout === "combined") {
        const f = await write(name.trim() || suggestFileName(meta, "notes"), preview.endsWith("\n") ? preview : preview + "\n");
        await api.openTracker(f.id);
        setDone(`Saved ${f.display_name}.`);
      } else {
        const made: string[] = [];
        for (const r of chosen) {
          const f = await write(suggestFileName(meta, typeFileSuffix(r.type)), standaloneMarkdown(meta, r));
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
        {available.map((t) => (
          <label key={t} className="voice-check">
            <input type="checkbox" checked={include.has(t)}
              onChange={() => setInclude((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; })} /> {ANALYSIS_LABELS[t]}
          </label>
        ))}
      </div>
      <div className="voice-actions">
        <label className="voice-check"><input type="radio" name="dest" checked={dest === "new"} onChange={() => setDest("new")} /> New file</label>
        <label className="voice-check"><input type="radio" name="dest" checked={dest === "append"} onChange={() => setDest("append")} /> Add to an existing file</label>
        {dest === "new" && (
          <>
            <label className="voice-check"><input type="radio" name="layout" checked={layout === "combined"} onChange={() => setLayout("combined")} /> One document</label>
            <label className="voice-check"><input type="radio" name="layout" checked={layout === "separate"} onChange={() => setLayout("separate")} /> One file per analysis</label>
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
