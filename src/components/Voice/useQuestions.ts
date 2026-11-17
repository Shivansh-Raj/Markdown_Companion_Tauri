import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../services/api";
import { streamChat } from "../../services/ai";
import {
  buildQuestionSystemPrompt, buildQuestionUserPrompt, parseQuestions, recentContext, shouldSuggest, type Suggestion,
} from "../../services/voice/followups";
import { transcriptText, wordCount } from "../../services/voice/transcript";
import type { TranscriptChunk } from "../../services/voice/types";

const KEY = "voice-question-ideas";
const read = () => { try { return localStorage.getItem(KEY) === "on"; } catch { return false; } };
const write = (on: boolean) => { try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* preference simply is not remembered */ } };

/**
 * Live "questions you could ask" for meetings. Opt-in (it sends the recent transcript to Groq), throttled,
 * runs beside the recording and never blocks or interrupts it: any failure is swallowed.
 */
export function useQuestions(opts: { active: boolean; paused: boolean; chunks: TranscriptChunk[]; transcribing: number }) {
  const [enabled, setEnabledState] = useState(read);
  const [ideas, setIdeas] = useState<(Suggestion & { id: number })[]>([]);
  const [thinking, setThinking] = useState(false);
  const lastAt = useRef(0);
  const lastWords = useRef(0);
  const inFlight = useRef(false);
  const seq = useRef(0);
  const asked = useRef<string[]>([]);
  const latest = useRef(opts);
  latest.current = opts;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const setEnabled = useCallback((on: boolean) => {
    write(on);
    setEnabledState(on);
    if (on) { lastAt.current = Date.now() - 30_000; } // first suggestions shortly after enabling
  }, []);

  /** One suggestion round. `force` skips the timing rules (used by RETHINK) but never runs two at once. */
  const generate = useCallback(async (rethink: boolean) => {
    const o = latest.current;
    const text = transcriptText(o.chunks);
    if (inFlight.current || !wordCount(text)) return;
    inFlight.current = true;
    setThinking(true);
    lastAt.current = Date.now();
    lastWords.current = wordCount(text);
    try {
      const key = await api.getGroqKey();
      if (!key) return;
      const raw = await streamChat({
        apiKey: key, system: buildQuestionSystemPrompt(), user: buildQuestionUserPrompt(recentContext(text), asked.current, rethink),
        signal: new AbortController().signal, onText: () => {},
      });
      const fresh = parseQuestions(raw, asked.current);
      if (fresh.length) {
        asked.current = [...asked.current, ...fresh.map((f) => f.question)].slice(-30);
        const next = fresh.map((f) => ({ ...f, id: ++seq.current }));
        setIdeas((cur) => (rethink ? next : [...next, ...cur]).slice(0, 6));
      } else if (rethink) {
        setIdeas([]);
      }
    } catch {
      /* suggestions are a bonus: never disturb the recording */
    } finally {
      inFlight.current = false;
      setThinking(false);
    }
  }, []);

  useEffect(() => {
    if (!opts.active) { setIdeas([]); asked.current = []; lastAt.current = 0; lastWords.current = 0; return; }
    const timer = setInterval(() => {
      const o = latest.current;
      const words = wordCount(transcriptText(o.chunks));
      const now = Date.now();
      if (!lastAt.current) lastAt.current = now;
      if (shouldSuggest({
        enabled: enabledRef.current, paused: o.paused, inFlight: inFlight.current, transcribing: o.transcribing,
        sinceMs: now - lastAt.current, newWords: words - lastWords.current,
      })) void generate(false);
    }, 5000);
    return () => clearInterval(timer);
  }, [opts.active, generate]);

  const dismiss = useCallback((id: number) => setIdeas((cur) => cur.filter((i) => i.id !== id)), []);
  const rethink = useCallback(() => void generate(true), [generate]);
  return { enabled, setEnabled, ideas, thinking, dismiss, rethink };
}
