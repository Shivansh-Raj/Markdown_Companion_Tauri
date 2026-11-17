# Voice Intelligence — technical plan (V1, Tauri / macOS)

Target: **V1 only** (Tauri 2 + React + Rust, repo `Markdown_Companion_Tauri`). V2 (Python) is out of scope for now.

## 1. Existing architecture (what we build on)

| Area | What exists | Reuse |
|---|---|---|
| Windows | `launcher` (560×420, fixed, always-on-top) + one `tracker-*` window per file; `windows/` Rust module | New resizable `voice` window; launcher gets entry points |
| Storage | `store/mod.rs` JSON file (files, settings, folders, `groq_api_key`, `ai_save_dir`); Markdown stays source of truth | Add voice settings + consent flag; sessions live in their own folder (below) |
| AI | `services/ai.ts` — Groq via `fetch` (CSP allows `api.groq.com`), dynamic model pick, SSE streaming | Reuse key, `groqFetch`, `streamChat` for all text analysis |
| Markdown out | `create_markdown_file` (never overwrites, registers file), `open_tracker` | Generated reports use the same commands, then open in the floating window |
| AI edit safety | scope-only splice, `preserveProgress`, stale-hash refusal | "Append to existing file" reuses the same hash-checked save path |
| UI language | `theme.css`, pixel buttons, `TypingCat`, ProgressBar | Voice UI uses the same tokens; a recording "cat" mood can reuse the SVG |
| macOS | `LSUIElement` Info.plist (no Dock icon), tray icon | Add `NSMicrophoneUsageDescription`; tray title as the persistent REC indicator |

## 2. Key technical decisions

1. **Audio capture: native Rust (`cpal`), not the WebView.** `getUserMedia` inside WKWebView depends on WebView permission delegates that Tauri does not guarantee; cpal gives device listing, disconnect errors, and lets us write audio to disk continuously (crash-safe). Cost: a native dependency and a Rust audio module.
2. **Recording format on disk:** 16 kHz, mono, 16-bit PCM WAV, written incrementally (header patched on stop; a recovery routine repairs the header after a crash). ~1.9 MB/min.
3. **Speech-to-text: Groq Whisper (`whisper-large-v3-turbo`) via `/audio/transcriptions`** with `verbose_json` + word timestamps. It reuses the user's existing Groq key and gives timestamps needed for pace/pause analysis. It is a **separate capability** from chat models (the model picker already excludes whisper; we add a separate `pickSttModel`). Trade-off: audio leaves the machine → explicit one-time consent, clear UI, local-only is kept as an architectural option behind a `Transcriber` interface (whisper.cpp can be added later).
4. **"Live" transcription = rolling chunks.** The recorder cuts a chunk at a silence boundary (or at 15 s max), the UI shows it as *provisional* while the request is in flight and *final* when text returns. Latency is ~2–6 s behind speech. True streaming STT is not available from this provider; this is stated in the UI.
5. **Speech analytics are computed locally and deterministically** (words/min, pauses, fillers, repetition) from word timestamps. The AI is only used for judgement tasks (sentence improvement, clarity, structure, vocabulary). No personality/psychological inference.
6. **System audio is NOT promised.** macOS needs ScreenCaptureKit (macOS 13+, Screen Recording permission) — deferred. Workaround that works today with no code: install a loopback device (e.g. BlackHole), pick it in the microphone selector.
7. **Persistent recording indicator:** macOS tray title (`● 03:12`, paused `❚❚ 03:12`) works from any window, plus an in-window banner.

## 3. Proposed architecture

```
src-tauri/src/voice/
  mod.rs        commands + state (RecorderHandle), session store
  capture.rs    cpal input stream → ring → WAV writer + level meter + chunker
  wav.rs        incremental WAV writer + header recovery
  session.rs    on-disk session model (session.json, transcript.json)
src/services/voice/
  transcriber.ts   Transcriber interface + GroqWhisper implementation
  session.ts       chunk queue, offsets, transcript assembly, retry
  analytics.ts     WPM, pauses, fillers, repetition (pure functions, unit tested)
  analyses.ts      prompt builders + JSON parsing for each analysis type
  templates.ts     Markdown templates per output type
  followups.ts     follow-up detector + live question suggester
src/components/Voice/
  VoiceWindow.tsx  workspace: Meeting / Practice / Quick note + Recent sessions
  Recorder.tsx     controls, timer, device picker, live transcript
  Analysis*.tsx    results, diff-style "said / better / why", export dialog
```

Each layer talks through interfaces: `AudioSource` (Rust events) → `Transcriber` → `Analyzer` → `MarkdownExporter`.

## 4. Data model (all under `<app data>/voice/<session-id>/`)

- `session.json` — id, title, mode (meeting|practice|note), createdAt, durationMs (active time only), status (`recording|paused|stopped|interrupted|transcribed`), device, retention.
- `audio.wav` — raw recording (optional, per retention setting).
- `transcript.json` — `[{ start, end, text, words:[{w,start,end}], final:boolean }]` — never edited by analyses.
- `analyses/<type>-<timestamp>.json|md` — each generated output, regenerable from the transcript without re-recording.

Original audio/transcript are **separate from** and never modified by summaries. Generated Markdown is written through existing safe commands.

## 5. UX

- Home (launcher footer): **OPEN MARKDOWN**, **VOICE**, and **RECENT SESSIONS** inside the voice window. No other redesign.
- Voice window: three quick-start cards (Meeting, Practice, Quick note) → recorder view with ● REC / paused states, timer (active time), level meter, device picker, live transcript (provisional text dimmed), suggested-questions side strip (Meeting).
- After stop: analysis picker (multi-select), results with copy / include-in-Markdown, export dialog (preview, folder, new file vs append, filename suggestion `YYYY-MM-DD-title`), open in floating window.

## 6. Phases (each independently testable and committed)

| # | Scope | Testable by |
|---|---|---|
| 1 | Rust capture: devices, start/pause/resume/stop, WAV on disk, level events, tray indicator, mic permission string, crash recovery | `cargo test` (WAV/chunker), manual mic test |
| 2 | Voice window + Recorder UI + Groq Whisper transcription (live chunks) + session storage + consent + **Quick voice note → Markdown** | vitest (queue/assembly), manual |
| 3 | Meeting analyses (summary, takeaways, action items — no invented owners/dates) + Markdown templates + export (new/append, preview) | vitest prompt/JSON parsing, manual |
| 4 | Practice mode: analytics + coach (sentence improvement with said/better/why, 3 styles, structure, vocabulary, delivery) | vitest analytics |
| 5 | Follow-up detector, live question suggestions, Recent sessions | vitest, manual |

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Mic permission dialog / unsigned local build | `NSMicrophoneUsageDescription` in Info.plist; clear in-app "permission needed" state; notarised distribution later needs the `audio-input` entitlement |
| Word cut at chunk boundary | Cut at silence; small overlap; dedupe on assembly |
| Whisper hallucination on silence | Skip near-silent chunks (RMS gate) |
| Groq rate/size limits | Chunks are small (≤15 s ≈ 0.5 MB); retry with backoff; failures keep audio and allow "retranscribe" |
| App crash mid-recording | WAV written continuously; header repaired on next launch; session marked `interrupted` |
| Device unplugged | cpal error callback → pause + visible error, audio so far kept |
| Privacy | No auto-recording; explicit consent before first cloud transcription; per-session retention (keep / delete audio after transcription); status always visible |
| Live questions add load | Throttled (≥ 30 s), runs on a separate request, failures are silent, never blocks recording |
| Hard/OS-dependent | System audio, true streaming STT, local whisper — **not implemented in phases 1–5**; documented above |

## 8. Testing strategy

- Rust: unit tests for WAV writer/recovery, chunker (silence cut, max length), session JSON.
- TS: vitest for analytics (WPM, pause, filler, repetition), transcript assembly/dedupe, prompt+JSON parsing, templates, follow-up matching.
- Manual (needs real mic, cannot run in CI): permission flow, pause/resume timer accuracy, device unplug, long recording, app kill + recovery.

## 9. Dependencies / licensing / packaging

- New Rust crates: `cpal` (Apache-2.0), `hound` (Apache-2.0) for WAV (or hand-rolled header to avoid the dep).
- No new JS runtime dependencies planned.
- Info.plist gains `NSMicrophoneUsageDescription`; CSP unchanged (Groq already allowed; transcription uses the same host).
- Bundle size +~1 MB; macOS 11+ unchanged.
