//! Voice Intelligence, phase 1: microphone recording with crash-safe storage.
//!
//! `capture` (cpal stream) → worker thread (WAV on disk + chunker + level/timer events) → events to the UI.
//! Transcription and analysis live in the frontend; this module only records and stores audio.

mod capture;
mod chunker;
mod session;
pub mod wav;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

use capture::{Capture, DeviceInfo, Msg};
use session::SessionMeta;

const TRAY_ID: &str = "main";

struct Active {
    meta: SessionMeta,
    capture: Capture,
    tx: Sender<Msg>,
    worker: JoinHandle<SessionMeta>,
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    paused: AtomicBool,
    active_ms: AtomicU64,
}

#[derive(Default)]
pub struct VoiceState(Mutex<Option<Active>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LevelEvent {
    session_id: String,
    level: f32,
    active_ms: u64,
    paused: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChunkEvent {
    session_id: String,
    index: u32,
    start_ms: u64,
    end_ms: u64,
    voiced_ms: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NoticeEvent {
    session_id: String,
    kind: &'static str, // "error" | "warning"
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    session_id: String,
    title: String,
    mode: String,
    paused: bool,
    active_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn voice_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?.join("voice");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(root)
}

fn fmt_clock(ms: u64) -> String {
    let s = ms / 1000;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

/// The macOS menu-bar title doubles as a recording indicator that stays visible from every window.
fn set_tray_title(app: &AppHandle, text: Option<&str>) {
    #[cfg(target_os = "macos")]
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_title(text);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, text);
}

fn notice(app: &AppHandle, id: &str, kind: &'static str, message: impl Into<String>) {
    let _ = app.emit("voice-notice", NoticeEvent { session_id: id.into(), kind, message: message.into() });
}

/// Records into the session folder until `Msg::Stop` arrives, then returns the final metadata.
fn run_worker(app: AppHandle, dir: PathBuf, rx: mpsc::Receiver<Msg>, shared: Arc<Shared>, mut meta: SessionMeta) -> SessionMeta {
    let mut chunker = chunker::Chunker::new();
    let mut wav = match wav::WavWriter::create(&dir.join("audio.wav")) {
        Ok(w) => Some(w),
        Err(e) => {
            notice(&app, &meta.id, "error", format!("Cannot write the recording: {e}"));
            None
        }
    };
    let _ = std::fs::create_dir_all(dir.join("chunks"));
    let mut paused = false;
    let mut last_level = Instant::now();
    let mut last_tray = Instant::now() - Duration::from_secs(5);
    let mut level = 0.0f32;
    let mut silent_warned = false;
    let mut peak = 0i16;

    let emit_chunk = |c: chunker::Chunk, meta: &mut SessionMeta| {
        let path = dir.join("chunks").join(format!("{:04}.wav", c.index));
        if std::fs::write(&path, wav::encode(&c.samples)).is_ok() {
            meta.chunks = meta.chunks.max(c.index + 1);
            let _ = app.emit(
                "voice-chunk",
                ChunkEvent { session_id: meta.id.clone(), index: c.index, start_ms: c.start_ms, end_ms: c.end_ms, voiced_ms: c.voiced_ms },
            );
        }
    };

    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(Msg::Samples(s)) => {
                if paused {
                    continue;
                }
                if let Some(Err(e)) = wav.as_mut().map(|w| w.write(&s)) {
                    notice(&app, &meta.id, "error", format!("Disk write failed: {e}"));
                    wav = None;
                }
                level = level * 0.5 + chunker::rms(&s).min(1.0) * 0.5;
                peak = peak.max(s.iter().map(|v| v.saturating_abs()).max().unwrap_or(0));
                for c in chunker.push(&s) {
                    emit_chunk(c, &mut meta);
                }
                shared.active_ms.store(chunker.active_ms(), Ordering::Relaxed);
                // macOS records pure silence when microphone access was denied, without any error.
                if !silent_warned && chunker.active_ms() > 3000 && peak == 0 {
                    silent_warned = true;
                    notice(&app, &meta.id, "warning", "No sound is coming in. Check Microphone access in System Settings → Privacy & Security.");
                }
            }
            Ok(Msg::Pause) | Ok(Msg::Error(_)) if paused => {}
            Ok(Msg::Pause) => {
                paused = true;
                if let Some(c) = chunker.flush() {
                    emit_chunk(c, &mut meta);
                }
                level = 0.0;
                meta.status = "paused".into();
                let _ = session::write_meta(&dir, &meta);
            }
            Ok(Msg::Error(e)) => {
                // Device lost: keep everything recorded so far and stop in a paused state the user can resume.
                paused = true;
                if let Some(c) = chunker.flush() {
                    emit_chunk(c, &mut meta);
                }
                shared.paused.store(true, Ordering::Relaxed);
                level = 0.0;
                meta.status = "paused".into();
                let _ = session::write_meta(&dir, &meta);
                notice(&app, &meta.id, "error", format!("The microphone stopped: {e}. Your audio so far is saved; resume to continue."));
            }
            Ok(Msg::Resume) => {
                paused = false;
                meta.status = "recording".into();
                let _ = session::write_meta(&dir, &meta);
            }
            Ok(Msg::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        shared.paused.store(paused, Ordering::Relaxed);
        if last_level.elapsed() >= Duration::from_millis(100) {
            last_level = Instant::now();
            let _ = app.emit(
                "voice-level",
                LevelEvent { session_id: meta.id.clone(), level, active_ms: chunker.active_ms(), paused },
            );
        }
        if last_tray.elapsed() >= Duration::from_millis(900) {
            last_tray = Instant::now();
            let mark = if paused { "❚❚" } else { "●" };
            set_tray_title(&app, Some(&format!("{mark} {}", fmt_clock(chunker.active_ms()))));
        }
    }

    if let Some(c) = chunker.flush() {
        emit_chunk(c, &mut meta);
    }
    if let Some(w) = wav {
        let _ = w.finish();
    }
    meta.duration_ms = chunker.active_ms();
    meta.status = "stopped".into();
    let _ = session::write_meta(&dir, &meta);
    set_tray_title(&app, None);
    meta
}

#[tauri::command]
pub fn voice_list_devices() -> Vec<DeviceInfo> {
    capture::list_devices()
}

#[tauri::command(async)]
pub fn voice_start(app: AppHandle, state: State<VoiceState>, title: String, mode: String, device: Option<String>) -> Result<SessionMeta, String> {
    if !matches!(mode.as_str(), "meeting" | "practice" | "note") {
        return Err("Unknown recording mode".into());
    }
    let mut slot = state.0.lock().map_err(|_| "Recorder is busy".to_string())?;
    if slot.is_some() {
        return Err("A recording is already in progress.".into());
    }
    let root = voice_root(&app)?;
    let id = now_ms().to_string();
    let dir = session::session_dir(&root, &id)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let (tx, rx) = mpsc::channel::<Msg>();
    let capture = Capture::start(device.as_deref(), tx.clone()).inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&dir);
    })?;
    let meta = SessionMeta {
        id,
        title: if title.trim().is_empty() { "Untitled recording".into() } else { title.trim().chars().take(120).collect() },
        mode,
        created_at_ms: now_ms(),
        duration_ms: 0,
        status: "recording".into(),
        device: capture.device_name.clone(),
        chunks: 0,
    };
    session::write_meta(&dir, &meta)?;
    let shared = Arc::new(Shared::default());
    let worker = {
        let (app, shared, meta) = (app.clone(), shared.clone(), meta.clone());
        std::thread::spawn(move || run_worker(app, dir, rx, shared, meta))
    };
    *slot = Some(Active { meta: meta.clone(), capture, tx, worker, shared });
    Ok(meta)
}

#[tauri::command]
pub fn voice_pause(state: State<VoiceState>) -> Result<(), String> {
    let slot = state.0.lock().map_err(|_| "Recorder is busy".to_string())?;
    let a = slot.as_ref().ok_or("Not recording")?;
    a.capture.pause();
    a.shared.paused.store(true, Ordering::Relaxed);
    a.tx.send(Msg::Pause).map_err(|_| "Recorder stopped".to_string())
}

#[tauri::command]
pub fn voice_resume(state: State<VoiceState>) -> Result<(), String> {
    let slot = state.0.lock().map_err(|_| "Recorder is busy".to_string())?;
    let a = slot.as_ref().ok_or("Not recording")?;
    a.capture.resume();
    a.shared.paused.store(false, Ordering::Relaxed);
    a.tx.send(Msg::Resume).map_err(|_| "Recorder stopped".to_string())
}

#[tauri::command(async)]
pub fn voice_stop(state: State<VoiceState>) -> Result<SessionMeta, String> {
    let active = state.0.lock().map_err(|_| "Recorder is busy".to_string())?.take().ok_or("Not recording")?;
    active.capture.stop();
    let _ = active.tx.send(Msg::Stop);
    active.worker.join().map_err(|_| "Recorder crashed while stopping".to_string())
}

#[tauri::command]
pub fn voice_status(state: State<VoiceState>) -> Option<Status> {
    let slot = state.0.lock().ok()?;
    slot.as_ref().map(|a| Status {
        session_id: a.meta.id.clone(),
        title: a.meta.title.clone(),
        mode: a.meta.mode.clone(),
        paused: a.shared.paused.load(Ordering::Relaxed),
        active_ms: a.shared.active_ms.load(Ordering::Relaxed),
    })
}

/// Raw WAV bytes of one chunk, sent to the speech-to-text service by the frontend.
#[tauri::command]
pub fn voice_read_chunk(app: AppHandle, session_id: String, index: u32) -> Result<tauri::ipc::Response, String> {
    let dir = session::session_dir(&voice_root(&app)?, &session_id)?;
    let bytes = std::fs::read(dir.join("chunks").join(format!("{index:04}.wav"))).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn voice_list_sessions(app: AppHandle) -> Result<Vec<SessionMeta>, String> {
    Ok(session::list(&voice_root(&app)?))
}

/// Transcripts are stored next to the audio and are never rewritten by analyses.
#[tauri::command]
pub fn voice_save_transcript(app: AppHandle, session_id: String, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|_| "Transcript is not valid JSON".to_string())?;
    let dir = session::session_dir(&voice_root(&app)?, &session_id)?;
    let tmp = dir.join("transcript.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dir.join("transcript.json")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn voice_load_transcript(app: AppHandle, session_id: String) -> Result<Option<String>, String> {
    let dir = session::session_dir(&voice_root(&app)?, &session_id)?;
    match std::fs::read_to_string(dir.join("transcript.json")) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Deletes the recording and its chunks but keeps the transcript and notes (retention control).
#[tauri::command]
pub fn voice_delete_audio(app: AppHandle, session_id: String) -> Result<(), String> {
    let dir = session::session_dir(&voice_root(&app)?, &session_id)?;
    let _ = std::fs::remove_file(dir.join("audio.wav"));
    let _ = std::fs::remove_dir_all(dir.join("chunks"));
    Ok(())
}

/// Deletes a whole session (audio, transcript and metadata). Refuses the one being recorded.
#[tauri::command]
pub fn voice_delete_session(app: AppHandle, state: State<VoiceState>, session_id: String) -> Result<(), String> {
    if state.0.lock().map(|s| s.as_ref().is_some_and(|a| a.meta.id == session_id)).unwrap_or(false) {
        return Err("Stop the recording before deleting it.".into());
    }
    let dir = session::session_dir(&voice_root(&app)?, &session_id)?;
    std::fs::remove_dir_all(dir).map_err(|e| e.to_string())
}

/// Called once at startup: repairs recordings that were interrupted by a crash or force-quit.
pub fn recover(app: &AppHandle) {
    if let Ok(root) = voice_root(app) {
        let fixed = session::recover_interrupted(&root);
        if !fixed.is_empty() {
            eprintln!("voice: recovered {} interrupted recording(s)", fixed.len());
        }
    }
}

/// Stops an in-progress recording when the app quits, so the audio file is finalised.
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<VoiceState>();
    let active = state.0.lock().ok().and_then(|mut s| s.take());
    if let Some(a) = active {
        a.capture.stop();
        let _ = a.tx.send(Msg::Stop);
        let _ = a.worker.join();
    }
}
