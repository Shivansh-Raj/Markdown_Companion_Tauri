import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../services/api";
import { streamChat } from "../../services/ai";
import { useReceipt } from "../Receipt/ReceiptProvider";
import { computeAnalytics, DELIVERY_CAVEAT, PACE_REFERENCE } from "../../services/voice/analytics";
import {
  buildCoachSystemPrompt, buildCoachUserPrompt, COACH_LABELS, COACH_TYPES, coachMarkdown, selectedSentencesMarkdown, sentenceBlock,
  speakingAnalysisMarkdown, STYLE_LABELS, toCoachResult, type CoachResult, type CoachType, type Style,
} from "../../services/voice/coach";
import { limitTranscript, timedTranscript } from "../../services/voice/analyses";
import { practiceProperties, type Section } from "../../services/voice/templates";
import { formatClock } from "../../services/voice/transcript";
import type { SessionMeta, TranscriptChunk } from "../../services/voice/types";
import { ExportDialog } from "./ExportDialog";

const STYLES: Style[] = ["natural", "professional", "concise"];

/** Practice mode: objective speaking numbers (computed locally) plus AI coaching grounded in what was said. */
export function PracticePanel({ meta, chunks, ready }: { meta: SessionMeta; chunks: TranscriptChunk[]; ready: boolean }) {
  const approve = useReceipt();
  const analytics = useMemo(() => computeAnalytics(chunks, meta.durationMs), [chunks, meta.durationMs]);
  const [selected, setSelected] = useState<Set<CoachType>>(new Set(COACH_TYPES));
  const [results, setResults] = useState<Partial<Record<CoachType, CoachResult>>>({});
  const [errors, setErrors] = useState<Partial<Record<CoachType, string>>>({});
  const [live, setLive] = useState<Partial<Record<CoachType, boolean>>>({});
  const [running, setRunning] = useState<CoachType | null>(null);
  const [styles, setStyles] = useState<Record<number, Style>>({}); // style shown per sentence card
  const [picked, setPicked] = useState<Record<number, Style>>({}); // improvements chosen for export
  const [exporting, setExporting] = useState(false);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let alive = true;
    api.voiceListAnalyses(meta.id).then((rows) => {
      if (!alive) return;
      const latest: Partial<Record<CoachType, CoachResult>> = {};
      for (const row of rows) {
        try {
          const r = JSON.parse(row) as CoachResult;
          if (COACH_TYPES.includes(r.type) && (!latest[r.type] || r.createdAtMs >= latest[r.type]!.createdAtMs)) latest[r.type] = r;
        } catch { /* skip a damaged file */ }
      }
      setResults(latest);
    }).catch(() => {});
    return () => { alive = false; abort.current?.abort(); };
  }, [meta.id]);

  const run = async (types: CoachType[]) => {
    const apiKey = await api.getGroqKey();
    const ctl = new AbortController();
    abort.current = ctl;
    const { text, truncated } = limitTranscript(timedTranscript(chunks));
    const plain = text.replace(/^\[\d+(?::\d+)+\]\s*/gm, ""); // quotes are checked against the spoken words only
    const approvals = apiKey
      ? await approve(types.map((type) => ({
          purpose: `Speaking coach (${type}) for "${meta.title}"`, system: buildCoachSystemPrompt(type), user: buildCoachUserPrompt(meta.title, plain), mode: "review" as const,
          items: [{ label: `Transcript of "${meta.title}"`, text: plain, note: truncated ? "The recording is very long, so only the first part is sent." : undefined }],
        })))
      : null;
    if (apiKey && !approvals) { abort.current = null; return; }
    for (const [n, type] of types.entries()) {
      if (ctl.signal.aborted) break;
      setRunning(type);
      setLive((l) => ({ ...l, [type]: true }));
      setErrors((e) => ({ ...e, [type]: undefined }));
      try {
        if (!apiKey) throw new Error("No Groq API key. Add one in the launcher: AI → key.");
        const raw = await streamChat({
          apiKey, approval: approvals![n], signal: ctl.signal, onText: () => {},
        });
        const result = toCoachResult(type, raw, plain, truncated);
        await api.voiceSaveAnalysis(meta.id, type, JSON.stringify(result));
        setResults((r) => ({ ...r, [type]: result }));
        if (type === "sentences") { setStyles({}); setPicked({}); }
      } catch (e) {
        if (!ctl.signal.aborted) setErrors((er) => ({ ...er, [type]: e instanceof Error ? e.message : String(e) }));
      }
      setLive((l) => ({ ...l, [type]: false }));
    }
    setRunning(null);
    abort.current = null;
  };

  const sections: Section[] = useMemo(() => {
    const out: Section[] = [{ id: "speaking", label: "Speaking analysis", suffix: "speaking analysis", markdown: speakingAnalysisMarkdown(analytics) }];
    const s = results.sentences;
    const picks = Object.entries(picked).map(([index, style]) => ({ index: Number(index), style }));
    if (s?.sentences?.length) {
      out.push({
        id: "sentences", label: "Sentence improvements", suffix: "sentence improvements",
        markdown: picks.length ? selectedSentencesMarkdown(s.sentences, picks) : coachMarkdown(s),
      });
    }
    for (const t of ["clarity", "structure", "vocabulary"] as CoachType[]) {
      const r = results[t];
      if (r) out.push({ id: t, label: COACH_LABELS[t], suffix: COACH_LABELS[t].toLowerCase(), markdown: coachMarkdown(r) });
    }
    return out;
  }, [analytics, results, picked]);

  const disabled = !ready || running !== null;
  const a = analytics;
  const maxWpm = Math.max(1, ...(a.pace?.windows.map((w) => w.wpm) ?? [1]));

  return (
    <div className="voice-analysis">
      <h3 className="voice-h">SPEAKING ANALYSIS</h3>
      {!ready ? <p className="note">Wait for the transcript to finish.</p> : a.wordCount === 0 ? <p className="note">No speech to analyse.</p> : (
        <>
          <div className="voice-stats">
            <div className="stat"><b>{a.wpm ?? "–"}</b><span>words / min overall</span></div>
            <div className="stat"><b>{a.articulationWpm ?? "–"}</b><span>while speaking</span></div>
            <div className="stat"><b>{a.fillerTotal}</b><span>filler words ({a.fillersPer100}/100)</span></div>
            <div className="stat"><b>{a.pauses?.long ?? "–"}</b><span>pauses ≥ 1.5 s</span></div>
          </div>
          {a.pace && (
            <div>
              <div className="pace-bars" role="img" aria-label={`Pace per half-minute, ${a.pace.min} to ${a.pace.max} words per minute`}>
                {a.pace.windows.map((w) => (
                  <i key={w.startMs} style={{ height: `${Math.max(6, (w.wpm / maxWpm) * 100)}%` }} title={`${formatClock(w.startMs)}: ${w.wpm} wpm`}
                    className={a.pace!.flagged.some((f) => f.startMs === w.startMs) ? "flag" : ""} />
                ))}
              </div>
              <p className="note">Pace per half-minute. Highlighted bars are noticeably faster or slower than your average. {PACE_REFERENCE}</p>
            </div>
          )}
          <div className="voice-cols">
            <div>
              <strong>FILLERS</strong>
              <ul className="voice-list">
                {a.fillers.length ? a.fillers.map((f) => <li key={f.term}>“{f.term}” × {f.count}</li>) : <li>None found</li>}
              </ul>
              <p className="note">“like” and “actually” are sometimes used on purpose.</p>
            </div>
            <div>
              <strong>REPETITION</strong>
              <ul className="voice-list">
                {[...a.repeatedWords.map((w) => `Word “${w.term}” × ${w.count}`), ...a.repeatedPhrases.map((p) => `Phrase “${p.term}” × ${p.count}`),
                  ...a.stutters.slice(0, 3).map((s) => `“${s.phrase}”${s.atMs !== null ? ` at ${formatClock(s.atMs)}` : ""}`)]
                  .map((t) => <li key={t}>{t}</li>)}
                {!a.repeatedWords.length && !a.repeatedPhrases.length && !a.stutters.length && <li>Nothing notable</li>}
              </ul>
            </div>
            <div>
              <strong>PAUSES</strong>
              <ul className="voice-list">
                {a.pauses?.longest.length ? a.pauses.longest.slice(0, 4).map((p) => (
                  <li key={p.startMs}>{formatClock(p.startMs)} · {(p.durationMs / 1000).toFixed(1)} s</li>
                )) : <li>{a.hasTimings ? "No long pauses" : "No timing data"}</li>}
              </ul>
            </div>
          </div>
          {a.notes.length > 0 && (
            <ul className="voice-list">{a.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          )}
          <p className="note">{DELIVERY_CAVEAT}</p>
        </>
      )}

      <h3 className="voice-h">COACH</h3>
      <div className="voice-actions">
        {COACH_TYPES.map((t) => (
          <label key={t} className="voice-check">
            <input type="checkbox" checked={selected.has(t)} disabled={running !== null}
              onChange={() => setSelected((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; })} /> {COACH_LABELS[t]}
          </label>
        ))}
        {running
          ? <button className="btn" onClick={() => abort.current?.abort()}>STOP</button>
          : <button className="btn primary" disabled={disabled || selected.size === 0 || a.wordCount === 0}
              onClick={() => void run(COACH_TYPES.filter((t) => selected.has(t)))}>GET FEEDBACK</button>}
        <button className="btn" disabled={running !== null || a.wordCount === 0} onClick={() => setExporting(true)}>EXPORT AS MARKDOWN…</button>
      </div>

      {COACH_TYPES.filter((t) => results[t] || live[t] || errors[t]).map((t) => {
        const r = results[t];
        return (
          <div key={t} className="voice-result">
            <div className="voice-result-head">
              <strong>{COACH_LABELS[t].toUpperCase()}</strong>
              {r && running === null && <button className="btn" disabled={disabled} onClick={() => void run([t])}>REGENERATE</button>}
            </div>
            {live[t] && <p className="note">Working…</p>}
            {errors[t] && <div className="error" role="alert">{errors[t]}</div>}
            {r?.sentences && (r.sentences.length === 0 ? <p className="note">No sentences needed improving.</p> : r.sentences.map((f, i) => {
              const style = styles[i] ?? "natural";
              return (
                <div key={i} className="voice-fix">
                  <p className="voice-said"><span className="voice-tag">YOU SAID</span> “{f.original}”</p>
                  <div className="voice-styles" role="tablist" aria-label="Style">
                    {STYLES.map((s) => (
                      <button key={s} role="tab" aria-selected={style === s} className={style === s ? "btn primary" : "btn"} onClick={() => setStyles((m) => ({ ...m, [i]: s }))}>{STYLE_LABELS[s]}</button>
                    ))}
                  </div>
                  <p className="voice-better"><span className="voice-tag">BETTER</span> {f[style]}</p>
                  {f.why && <p className="note"><b>Why:</b> {f.why}</p>}
                  <div className="voice-actions">
                    <label className="voice-check">
                      <input type="checkbox" checked={i in picked}
                        onChange={() => setPicked((p) => { const n = { ...p }; if (i in n) delete n[i]; else n[i] = style; return n; })} /> Include in Markdown
                    </label>
                    <button className="btn" onClick={() => void navigator.clipboard?.writeText(sentenceBlock(f, style))}>COPY</button>
                  </div>
                </div>
              );
            }))}
            {r && !r.sentences && <pre className="voice-pre">{coachMarkdown(r)}</pre>}
            {r?.dropped ? <p className="note">{r.dropped} suggestion(s) were left out because they did not match what you said.</p> : null}
          </div>
        );
      })}

      {exporting && <ExportDialog meta={meta} docTitle="presentation feedback" sections={sections} properties={practiceProperties(analytics)} onClose={() => setExporting(false)} />}
    </div>
  );
}
