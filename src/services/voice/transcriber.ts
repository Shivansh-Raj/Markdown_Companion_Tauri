import { API, groqFetch } from "../ai";
import type { Word } from "./types";

export interface TranscribeResult {
  text: string;
  words: Word[];
}

/** Speech-to-text is a separate capability from text generation, so it sits behind its own interface. */
export interface Transcriber {
  transcribe(wav: ArrayBuffer, opts: { apiKey: string; offsetMs: number; signal?: AbortSignal; language?: string }): Promise<TranscribeResult>;
}

/** Best first. Chat models are never used here; only the whisper family. */
const STT_PREFERRED = [/whisper-large-v3-turbo/, /whisper-large-v3$/, /whisper/];

export function pickSttModel(ids: string[]): string | null {
  for (const re of STT_PREFERRED) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  return null;
}

/** Converts Whisper's verbose_json into our shape, shifting times onto the recording timeline. */
export function parseWhisper(json: unknown, offsetMs: number): TranscribeResult {
  const j = (json ?? {}) as { text?: string; words?: { word?: string; start?: number; end?: number }[] };
  const words: Word[] = (j.words ?? [])
    .filter((w) => typeof w.word === "string" && typeof w.start === "number" && typeof w.end === "number")
    .map((w) => ({
      w: (w.word as string).trim(),
      start: Math.round((w.start as number) * 1000) + offsetMs,
      end: Math.round((w.end as number) * 1000) + offsetMs,
    }))
    .filter((w) => w.w.length > 0);
  return { text: (j.text ?? "").trim(), words };
}

let cachedModel: { key: string; model: string } | null = null;

async function resolveSttModel(apiKey: string, signal?: AbortSignal): Promise<string> {
  if (cachedModel?.key === apiKey) return cachedModel.model;
  const res = await groqFetch(`${API}/models`, { signal, headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 401) throw new Error("Groq rejected the API key. Check it in Settings.");
  if (!res.ok) throw new Error(`Could not list Groq models (${res.status}).`);
  const data = await res.json();
  const ids: string[] = (data?.data ?? []).map((m: { id: string }) => m.id);
  const model = pickSttModel(ids);
  if (!model) throw new Error("Your Groq key has no speech-to-text model available.");
  cachedModel = { key: apiKey, model };
  return model;
}

export const groqWhisper: Transcriber = {
  async transcribe(wav, { apiKey, offsetMs, signal, language }) {
    const model = await resolveSttModel(apiKey, signal);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "chunk.wav");
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    form.append("temperature", "0");
    if (language) form.append("language", language);
    const res = await groqFetch(`${API}/audio/transcriptions`, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.json())?.error?.message ?? "";
      } catch {
        /* no body */
      }
      if (res.status === 401) throw new Error("Groq rejected the API key. Check it in Settings.");
      if (res.status === 429) throw new Error("Groq rate limit reached; retrying.");
      throw new Error(`Transcription failed (${res.status}). ${detail}`.trim());
    }
    return parseWhisper(await res.json(), offsetMs);
  },
};
