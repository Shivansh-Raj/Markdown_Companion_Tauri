//! Window management layer: launcher toggling and tracker windows.
//! Platform-specific behaviour should live here.

pub mod geometry;

use crate::store::WindowState;
use geometry::Rect;
use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, Monitor, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, Window,
};

pub const LAUNCHER: &str = "launcher";
const TRACKER_PREFIX: &str = "tracker-";

#[derive(Serialize, Clone)]
struct LauncherShown {
    view: &'static str,
}

pub fn is_tracker(label: &str) -> bool {
    label.starts_with(TRACKER_PREFIX)
}

pub fn toggle_launcher(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LAUNCHER) {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_launcher(app, "list");
        }
    }
}

/// `view` is "list" or "settings".
pub fn show_launcher(app: &AppHandle, view: &'static str) {
    if let Some(w) = app.get_webview_window(LAUNCHER) {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit_to(LAUNCHER, "launcher-shown", LauncherShown { view });
    }
}

fn trackers(app: &AppHandle) -> Vec<WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| is_tracker(l)).map(|(_, w)| w).collect()
}

pub fn show_all_trackers(app: &AppHandle) {
    for w in trackers(app) {
        let _ = w.unminimize();
        let _ = w.show();
    }
}

pub fn hide_all_trackers(app: &AppHandle) {
    for w in trackers(app) {
        let _ = w.hide();
    }
}

fn rect_of(m: &Monitor) -> Rect {
    // The work area excludes the macOS menu bar / Windows taskbar.
    let wa = m.work_area();
    Rect { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height }
}

/// Applies saved size/position, recovering windows that would be off-screen now.
fn apply_saved(app: &AppHandle, win: &WebviewWindow, saved: &WindowState) {
    let monitors: Vec<Rect> = app.available_monitors().unwrap_or_default().iter().map(rect_of).collect();
    let fallback = app.primary_monitor().ok().flatten().map(|m| rect_of(&m));
    let placement = geometry::resolve(saved, win.scale_factor().unwrap_or(1.0), &monitors, fallback);
    let _ = win.set_size(LogicalSize::new(placement.width, placement.height));
    if let Some((x, y)) = placement.position {
        let _ = win.set_position(PhysicalPosition::new(x, y));
    }
}

/// Current (logical width, logical height, physical x, physical y), or `None` when the window
/// is minimized or has no meaningful geometry (e.g. Windows reports -32000 when minimized).
pub fn capture_geometry(window: &Window) -> Option<(f64, f64, i32, i32)> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let size = window.inner_size().ok()?;
    let pos = window.outer_position().ok()?;
    if size.width == 0 || size.height == 0 || pos.x <= -30000 || pos.y <= -30000 {
        return None;
    }
    Some((size.width as f64 / scale, size.height as f64 / scale, pos.x, pos.y))
}

/// Opens the tracker for `id`, or shows and focuses the existing window.
/// Window labels are derived from the tracker ID, which maps 1:1 to a
/// canonical path, so duplicates cannot be created.
pub fn open_tracker(app: &AppHandle, id: &str, title: &str, saved: Option<&WindowState>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(id) {
        let _ = w.unminimize();
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    // New windows without saved geometry cascade so they don't stack exactly.
    let step = (trackers(app).len() % 8) as f64 * 28.0;
    let win = WebviewWindowBuilder::new(app, id, WebviewUrl::App(format!("index.html?view=tracker&id={id}").into()))
        .title(title)
        .inner_size(360.0, 480.0)
        .position(80.0 + step, 80.0 + step)
        .min_inner_size(260.0, 200.0)
        .decorations(false)
        .resizable(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    if let Some(saved) = saved {
        apply_saved(app, &win, saved);
    }
    win.show().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(())
}

pub fn is_open(app: &AppHandle, id: &str) -> bool {
    app.get_webview_window(id).is_some()
}
