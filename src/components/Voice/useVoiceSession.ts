import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../../services/api";
import { groqWhisper } from "../../services/voice/transcriber";
import { isPhantom, upsertChunk } from "../../services/voice/transcript";
import type { ChunkEvent, SessionMeta, TranscriptChunk, VoiceMode } from "../../services/voice/types";

export type Phase = "idle" | "recording" | "paused" | "stopped";
interface LevelEvent { sessionId: string; level: number; activeMs: number; paused: boolean }
interface NoticeEvent { sessionId: string; kind: "error" | "warning"; message: string }

const MIN_VOICED_MS = 300;
const ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Owns one voice session: recorder controls, live events and the chunk → transcript queue. */
export function useVoiceSession() {
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [activeMs, setActiveMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [chunks, setChunks] = useState<TranscriptChunk[]>([]);
  const [notice, setNotice] = useState<{ kind: "error" | "warning"; message: string } | null>(null);
  const [pending, setPending] = useState(0);

  const metaRef = useRef<SessionMeta | null>(null);
  const chunksRef = useRef<TranscriptChunk[]>([]);
  const keyRef = useRef<string | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const setChunkList = useCallback((fn: (c: TranscriptChunk[]) => TranscriptChunk[]) => {
    chunksRef.current = fn(chunksRef.current);
    setChunks(chunksRef.current);
  }, []);

  const persist = useCallback(() => {
    const id = metaRef.current?.id;
    if (!id) return;
    api.voiceSaveTranscript(id, JSON.stringify({ version: 1, chunks: chunksRef.current })).catch(() => {});
  }, []);

  const transcribeChunk = useCallback(
    async (sessionId: string, base: TranscriptChunk) => {
      const apiKey = keyRef.current ?? (await api.getGroqKey());
      keyRef.current = apiKey;
      let error = "Transcription failed.";
      if (!apiKey) {
        error = "No Groq API key. Add one in the launcher: AI → key.";
      } else {
        for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
          try {
            const wav = await api.voiceReadChunk(sessionId, base.index);
            const r = await groqWhisper.transcribe(wav, { apiKey, offsetMs: base.startMs });
            const text = isPhantom(r.text, base.voicedMs ?? Number.MAX_SAFE_INTEGER) ? "" : r.text;
            setChunkList((c) => upsertChunk(c, { ...base, text, words: r.words, status: "final", error: undefined }));
            persist();
            return;
          } catch (e) {
            error = e instanceof Error ? e.message : String(e);
            if (attempt < ATTEMPTS) await sleep(1000 * attempt);
          }
        }
      }
      setChunkList((c) => upsertChunk(c, { ...base, status: "failed", error }));
      persist();
    },
    [persist, setChunkList],
  );

  const enqueue = useCallback(
    (sessionId: string, base: TranscriptChunk) => {
      setPending((n) => n + 1);
      queue.current = queue.current
        .then(() => transcribeChunk(sessionId, base))
        .catch(() => {})
        .finally(() => setPending((n) => n - 1));
    },
    [transcribeChunk],
  );

  // live events from the Rust recorder
  useEffect(() => {
    const un = [
      listen<LevelEvent>("voice-level", (e) => {
        if (e.payload.sessionId !== metaRef.current?.id) return;
        setLevel(e.payload.level);
        setActiveMs(e.payload.activeMs);
        setPhase((p) => (p === "recording" || p === "paused" ? (e.payload.paused ? "paused" : "recording") : p));
      }),
      listen<ChunkEvent>("voice-chunk", (e) => {
        const ev = e.payload;
        if (ev.sessionId !== metaRef.current?.id) return;
        const base: TranscriptChunk = { index: ev.index, startMs: ev.startMs, endMs: ev.endMs, text: "", words: [], status: "pending", voicedMs: ev.voicedMs };
        if (ev.voicedMs < MIN_VOICED_MS) {
          setChunkList((c) => upsertChunk(c, { ...base, status: "final" })); // silence: nothing to transcribe
          return;
        }
        setChunkList((c) => upsertChunk(c, base));
        enqueue(ev.sessionId, { ...base });
      }),
      listen<NoticeEvent>("voice-notice", (e) => {
        if (e.payload.sessionId === metaRef.current?.id) setNotice({ kind: e.payload.kind, message: e.payload.message });
      }),
    ];
    return () => {
      un.forEach((p) => p.then((f) => f()));
    };
  }, [enqueue, setChunkList]);

  // the window may be reopened while a recording is still running
  useEffect(() => {
    api.voiceStatus().then(async (s) => {
      if (!s) return;
      const sessions = await api.voiceSessions();
      const m = sessions.find((x) => x.id === s.sessionId);
      if (!m) return;
      metaRef.current = m;
      setMeta(m);
      setPhase(s.paused ? "paused" : "recording");
      setActiveMs(s.activeMs);
      const saved = await api.voiceLoadTranscript(m.id).catch(() => null);
      if (saved) setChunkList(() => (JSON.parse(saved).chunks ?? []) as TranscriptChunk[]);
    }).catch(() => {});
  }, [setChunkList]);

  const start = useCallback(async (title: string, mode: VoiceMode, device: string | null) => {
    setNotice(null);
    chunksRef.current = [];
    setChunks([]);
    setActiveMs(0);
    const m = await api.voiceStart(title, mode, device);
    metaRef.current = m;
    setMeta(m);
    setPhase("recording");
  }, []);

  const pause = useCallback(async () => { await api.voicePause(); setPhase("paused"); }, []);
  const resume = useCallback(async () => { setNotice(null); await api.voiceResume(); setPhase("recording"); }, []);
  const stop = useCallback(async () => {
    const m = await api.voiceStop();
    metaRef.current = m;
    setMeta(m);
    setPhase("stopped");
    setLevel(0);
    setActiveMs(m.durationMs);
  }, []);

  const retry = useCallback((index: number) => {
    const c = chunksRef.current.find((x) => x.index === index);
    const id = metaRef.current?.id;
    if (!c || !id) return;
    const base = { ...c, status: "pending" as const, error: undefined };
    setChunkList((list) => upsertChunk(list, base));
    enqueue(id, base);
  }, [enqueue, setChunkList]);

  const open = useCallback(async (m: SessionMeta) => {
    metaRef.current = m;
    setMeta(m);
    setNotice(null);
    setPhase("stopped");
    setActiveMs(m.durationMs);
    const saved = await api.voiceLoadTranscript(m.id).catch(() => null);
    const list = saved ? ((JSON.parse(saved).chunks ?? []) as TranscriptChunk[]) : [];
    chunksRef.current = list;
    setChunks(list);
  }, []);

  const reset = useCallback(() => {
    metaRef.current = null;
    chunksRef.current = [];
    setMeta(null);
    setChunks([]);
    setPhase("idle");
    setActiveMs(0);
    setNotice(null);
  }, []);

  return { meta, phase, activeMs, level, chunks, notice, pending, start, pause, resume, stop, retry, open, reset, setNotice };
}
