import { useEffect, useRef, useState } from "react";
import { api } from "../../services/api";
import { streamChat } from "../../services/ai";
import {
  ANALYSIS_LABELS, ANALYSIS_TYPES, buildSystemPrompt, buildUserPrompt, latestByType, limitTranscript, timedTranscript,
  toResult, type AnalysisResult, type AnalysisType,
} from "../../services/voice/analyses";
import { meetingSections } from "../../services/voice/templates";
import { ExportDialog } from "./ExportDialog";
import type { SessionMeta, TranscriptChunk } from "../../services/voice/types";

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

      {exporting && <ExportDialog meta={meta} docTitle="meeting notes" sections={meetingSections(available.map((t) => results[t]!))} onClose={() => setExporting(false)} />}
    </div>
  );
}
