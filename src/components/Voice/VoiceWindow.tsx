import { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "../../services/api";
import { streamChat, stripFence, titleFromMarkdown } from "../../services/ai";
import { useReceipt } from "../Receipt/ReceiptProvider";
import {
  buildNoteSystemPrompt, buildNoteUserPrompt, formatClock, suggestFileName, transcriptMarkdown, transcriptText, wordCount,
} from "../../services/voice/transcript";
import { MODE_LABELS, type SessionMeta, type VoiceDevice, type VoiceMode } from "../../services/voice/types";
import { AnalysisPanel } from "./AnalysisPanel";
import { FollowUpPanel } from "./FollowUpPanel";
import { PracticePanel } from "./PracticePanel";
import { useQuestions } from "./useQuestions";
import { useVoiceSession } from "./useVoiceSession";

const CONSENT_KEY = "voice-cloud-consent";
const readConsent = () => {
  try { return localStorage.getItem(CONSENT_KEY) === "yes"; } catch { return false; }
};
const writeConsent = () => {
  try { localStorage.setItem(CONSENT_KEY, "yes"); } catch { /* private mode: asked again next time */ }
};

const MODE_HINT: Record<VoiceMode, string> = {
  meeting: "Capture a meeting or call, then get a summary, key takeaways and action items.",
  practice: "Rehearse a talk and get pace, filler and pause stats plus coaching on your wording.",
  note: "Say it out loud; get a tidy Markdown note.",
};

export function VoiceWindow() {
  const approve = useReceipt();
  const v = useVoiceSession();
  const [mode, setMode] = useState<VoiceMode | null>(null);
  const [title, setTitle] = useState("");
  const [devices, setDevices] = useState<VoiceDevice[]>([]);
  const [device, setDevice] = useState<string>("");
  const [consent, setConsent] = useState(readConsent);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [armed, setArmed] = useState<"audio" | "session" | null>(null);
  const [query, setQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<VoiceMode | "all">("all");
  const [rowArmed, setRowArmed] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const refreshSessions = () => api.voiceSessions().then(setSessions).catch(() => {});
  useEffect(() => {
    api.voiceDevices().then((d) => { setDevices(d); setDevice(d.find((x) => x.is_default)?.name ?? ""); }).catch(() => {});
    void refreshSessions();
  }, []);
  useEffect(() => { if (v.phase === "idle") void refreshSessions(); }, [v.phase]);
  useEffect(() => {
    const el = scroller.current;
    if (el && v.phase !== "stopped") el.scrollTop = el.scrollHeight;
  }, [v.chunks, v.phase]);

  const full = useMemo(() => transcriptText(v.chunks), [v.chunks]);
  const failed = v.chunks.filter((c) => c.status === "failed");
  const recording = v.phase === "recording" || v.phase === "paused";
  const q = useQuestions({ active: recording && v.meta?.mode === "meeting", paused: v.phase === "paused", chunks: v.chunks, transcribing: v.pending });
  const shown = sessions.filter((s) => (modeFilter === "all" || s.mode === modeFilter) && s.title.toLowerCase().includes(query.trim().toLowerCase()));

  const deleteRow = async (id: string) => {
    if (rowArmed !== id) { setRowArmed(id); return; }
    setRowArmed(null);
    await guard(async () => { await api.voiceDeleteSession(id); await refreshSessions(); });
  };

  const begin = async () => {
    if (!mode) return;
    setError(null);
    try {
      await v.start(title.trim() || MODE_LABELS[mode], mode, device || null);
    } catch (e) {
      setError(String(e));
    }
  };
  const guard = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); } catch (e) { setError(String(e)); }
  };

  const saveMarkdown = async (name: string, content: string) => {
    setBusy(true);
    await guard(async () => {
      const file = await api.createMarkdownFile(name, content.endsWith("\n") ? content : content + "\n");
      await api.openTracker(file.id);
    });
    setBusy(false);
  };

  const makeNote = async () => {
    if (!full) return;
    setNoting(true);
    setNote("");
    setError(null);
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const key = await api.getGroqKey();
      if (!key) throw new Error("No Groq API key. Add one in the launcher: AI → key.");
      const approved = await approve([{
        purpose: "Turn the recording into a note", system: buildNoteSystemPrompt(), user: buildNoteUserPrompt(full), mode: "review",
        items: [{ label: "Transcript of this recording", text: full }],
      }]);
      if (!approved) return;
      const out = await streamChat({
        apiKey: key, approval: approved[0], signal: ctl.signal, onText: setNote,
      });
      setNote(stripFence(out));
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNoting(false);
      abort.current = null;
    }
  };

  const backHome = () => {
    abort.current?.abort();
    setNote("");
    setArmed(null);
    setMode(null);
    v.reset();
  };

  const confirmDelete = async (kind: "audio" | "session") => {
    if (!v.meta) return;
    if (armed !== kind) { setArmed(kind); return; }
    setArmed(null);
    await guard(async () => {
      if (kind === "audio") await api.voiceDeleteAudio(v.meta!.id);
      else { await api.voiceDeleteSession(v.meta!.id); backHome(); }
    });
  };

  return (
    <div className="launcher voice">
      <div className="titlebar" data-tauri-drag-region>
        <span className="title" data-tauri-drag-region>VOICE INTELLIGENCE</span>
        {recording && (
          <span className={v.phase === "paused" ? "rec-pill paused" : "rec-pill"} role="status" aria-live="polite">
            {v.phase === "paused" ? "❚❚ PAUSED" : "● REC"} {formatClock(v.activeMs)}
          </span>
        )}
        <button className="btn" onClick={() => void getCurrentWindow().hide()} aria-label="Hide voice window (recording continues)">✕</button>
      </div>

      <div className="voice-body">
        {error && <div className="error" role="alert">{error}</div>}
        {v.notice && <div className={v.notice.kind === "error" ? "error" : "voice-warn"} role="alert">{v.notice.message}</div>}

        {v.phase === "idle" && !mode && (
          <>
            <div className="voice-cards">
              {(Object.keys(MODE_LABELS) as VoiceMode[]).map((m) => (
                <button key={m} className="voice-card" onClick={() => setMode(m)}>
                  <strong>{m === "meeting" ? "MEETING" : m === "practice" ? "PRACTICE" : "QUICK NOTE"}</strong>
                  <span>{MODE_HINT[m]}</span>
                </button>
              ))}
            </div>
            <h3 className="voice-h">RECENT SESSIONS</h3>
            <div className="voice-actions">
              <input className="search" style={{ flex: 1, minWidth: 140, margin: 0 }} placeholder="Search sessions…" aria-label="Search sessions"
                value={query} onChange={(e) => setQuery(e.target.value)} />
              <select className="search" style={{ margin: 0, width: "auto" }} aria-label="Filter by type" value={modeFilter}
                onChange={(e) => setModeFilter(e.target.value as VoiceMode | "all")}>
                <option value="all">All types</option>
                {(Object.keys(MODE_LABELS) as VoiceMode[]).map((m) => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
              </select>
            </div>
            <ul className="results voice-sessions" aria-label="Recent voice sessions">
              {shown.map((s) => (
                <li key={s.id} className="row" onClick={() => void v.open(s)}>
                  <span className="name">{s.title}</span>
                  <span>
                    <span className="badge">{MODE_LABELS[s.mode]}{s.status === "interrupted" ? " · RECOVERED" : ""}</span>
                    <button className="btn" style={{ marginLeft: 6, padding: "0 5px" }} aria-label={`Delete ${s.title}`}
                      title="Delete this session (audio, transcript and analyses)" tabIndex={-1}
                      onClick={(e) => { e.stopPropagation(); void deleteRow(s.id); }}>
                      {rowArmed === s.id ? "SURE?" : "✕"}
                    </button>
                  </span>
                  <span className="path">{new Date(s.createdAtMs).toLocaleString()} · {formatClock(s.durationMs)}</span>
                </li>
              ))}
              {shown.length === 0 && <li className="empty" role="presentation">{sessions.length ? "No sessions match." : "No recordings yet."}</li>}
            </ul>
          </>
        )}

        {v.phase === "idle" && mode && (
          <div className="voice-setup">
            <h2>{MODE_LABELS[mode].toUpperCase()}</h2>
            <p className="note">{MODE_HINT[mode]}</p>
            {!consent ? (
              <>
                <p className="note">
                  Speech is turned into text by Groq (api.groq.com): short audio chunks are sent there while you record, and the text is sent there when you ask for analysis.
                  Nothing is recorded until you press START, and a REC indicator stays visible the whole time.
                </p>
                <button className="btn primary" onClick={() => { writeConsent(); setConsent(true); }}>I UNDERSTAND</button>
              </>
            ) : (
              <>
                <input className="search" style={{ margin: "6px 0" }} placeholder="Title (optional)" aria-label="Session title"
                  value={title} onChange={(e) => setTitle(e.target.value)} />
                <label className="note" htmlFor="mic">MICROPHONE</label>
                <select id="mic" className="search" style={{ margin: "4px 0 10px" }} value={device} onChange={(e) => setDevice(e.target.value)}>
                  {devices.length === 0 && <option value="">No microphone found</option>}
                  {devices.map((d) => <option key={d.name} value={d.name}>{d.name}{d.is_default ? " (default)" : ""}</option>)}
                </select>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn primary" onClick={() => void begin()}>● START RECORDING</button>
                  <button className="btn" onClick={() => setMode(null)}>BACK</button>
                </div>
              </>
            )}
          </div>
        )}

        {(recording || v.phase === "stopped") && v.meta && (
          <>
            {recording && (
              <div className="voice-controls">
                <span className="voice-clock" aria-label="Elapsed recording time">{formatClock(v.activeMs)}</span>
                <span className="voice-meter" aria-hidden="true">
                  {Array.from({ length: 16 }, (_, i) => (
                    <i key={i} className={i < Math.round(Math.min(1, v.level * 9) * 16) ? "on" : ""} />
                  ))}
                </span>
                {v.phase === "recording"
                  ? <button className="btn" onClick={() => void guard(v.pause)}>❚❚ PAUSE</button>
                  : <button className="btn primary" onClick={() => void guard(v.resume)}>▶ RESUME</button>}
                <button className="btn" onClick={() => void guard(v.stop)}>■ STOP</button>
              </div>
            )}
            {v.phase === "stopped" && (
              <div className="voice-controls">
                <strong>{v.meta.title}</strong>
                <span className="note">{MODE_LABELS[v.meta.mode]} · {formatClock(v.meta.durationMs)} · {wordCount(full)} words</span>
                <button className="btn" onClick={backHome}>← BACK</button>
              </div>
            )}

            <div className="voice-transcript" ref={scroller} aria-live="polite" aria-label="Live transcript">
              {v.chunks.filter((c) => c.status !== "final" || c.text.trim()).map((c) => (
                <p key={c.index} className={c.status === "pending" ? "voice-chunk pending" : c.status === "failed" ? "voice-chunk failed" : "voice-chunk"}>
                  <span className="voice-time">{formatClock(c.startMs)}</span>{" "}
                  {c.status === "pending" && "…transcribing"}
                  {c.status === "final" && c.text}
                  {c.status === "failed" && (<>Could not transcribe this part ({c.error}) <button className="btn" onClick={() => v.retry(c.index)}>RETRY</button></>)}
                </p>
              ))}
              {v.chunks.length === 0 && <p className="note">{recording ? "Listening… text appears a few seconds after you speak." : "No speech was captured."}</p>}
            </div>

            {recording && v.meta.mode === "meeting" && (
              <div className="voice-ideas">
                <label className="voice-check" title="Sends the most recent part of the transcript to Groq about once a minute">
                  <input type="checkbox" checked={q.enabled} onChange={(e) => q.setEnabled(e.target.checked)} /> Suggest questions I could ask
                  {q.enabled && q.thinking && <span className="note"> · thinking…</span>}
                </label>
                {q.enabled && (
                  <div className="voice-actions">
                    <button className="btn" disabled={q.thinking || v.pending > 0 || v.phase === "paused"} onClick={q.rethink}
                      title="Not what you wanted? Get different suggestions">↻ RETHINK</button>
                  </div>
                )}
                {q.enabled && q.ideas.map((i) => (
                  <div key={i.id} className="voice-idea">
                    <span className="voice-tag">{i.kind.toUpperCase()}</span> {i.question}
                    {i.reason && <span className="note"> — {i.reason}</span>}
                    <button className="btn" onClick={() => void navigator.clipboard?.writeText(i.question)}>COPY</button>
                    <button className="btn" onClick={() => q.dismiss(i.id)} aria-label="Dismiss suggestion">✕</button>
                  </div>
                ))}
                {q.enabled && <p className="note">Only if you want them. Nothing here interrupts the recording.</p>}
              </div>
            )}

            {v.phase === "stopped" && (
              <div className="voice-actions">
                {v.chunks.length === 0 && v.meta.chunks > 0 && v.pending === 0 && (
                  <button className="btn primary" onClick={() => void guard(v.retranscribe)}>TRANSCRIBE RECORDING</button>
                )}
                {v.pending > 0 && <span className="note">Transcribing the last part… ({v.pending})</span>}
                {failed.length > 0 && v.pending === 0 && <span className="note">{failed.length} part(s) failed. Use RETRY above.</span>}
                <button className="btn primary" disabled={busy || !full || v.pending > 0}
                  onClick={() => void saveMarkdown(suggestFileName(v.meta!, "transcript"), transcriptMarkdown(v.meta!, v.chunks))}>
                  SAVE TRANSCRIPT .MD
                </button>
                {v.meta.mode === "note" && (
                  <button className="btn" disabled={noting || !full || v.pending > 0} onClick={() => void makeNote()}>✎ MAKE NOTE</button>
                )}
                <button className="btn" onClick={() => void confirmDelete("audio")}>{armed === "audio" ? "SURE? DELETE AUDIO" : "DELETE AUDIO"}</button>
                <button className="btn" onClick={() => void confirmDelete("session")}>{armed === "session" ? "SURE? DELETE ALL" : "DELETE SESSION"}</button>
              </div>
            )}

            {v.phase === "stopped" && v.meta.mode === "meeting" && (
              <>
                <AnalysisPanel meta={v.meta} chunks={v.chunks} ready={!!full && v.pending === 0} />
                <FollowUpPanel meta={v.meta} chunks={v.chunks} ready={!!full && v.pending === 0} />
              </>
            )}

            {v.phase === "stopped" && v.meta.mode === "practice" && (
              <PracticePanel meta={v.meta} chunks={v.chunks} ready={!!full && v.pending === 0} />
            )}

            {(note || noting) && (
              <div className="voice-note">
                <pre className="voice-pre">{note || "Writing the note…"}</pre>
                <div style={{ display: "flex", gap: 8 }}>
                  {noting
                    ? <button className="btn" onClick={() => abort.current?.abort()}>STOP</button>
                    : <button className="btn primary" disabled={busy || !note.trim()}
                        onClick={() => void saveMarkdown(titleFromMarkdown(note, suggestFileName(v.meta!, "note")), note)}>
                        SAVE NOTE .MD
                      </button>}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
