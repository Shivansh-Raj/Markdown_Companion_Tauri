//! Pure window-placement logic: validates saved geometry against the monitors that exist now.

use crate::store::WindowState;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, PartialEq)]
pub struct Placement {
    /// Logical size.
    pub width: f64,
    pub height: f64,
    /// Physical position; `None` means "use the default placement".
    pub position: Option<(i32, i32)>,
}

/// The title-bar strip must be reachable, otherwise the window can't be dragged back.
const TITLE_STRIP: i64 = 32;
const MIN_VISIBLE_W: i64 = 80;
const MIN_VISIBLE_H: i64 = 24;

fn overlap(a: (i64, i64, i64, i64), m: &Rect) -> (i64, i64) {
    let ow = (a.0 + a.2).min(m.x as i64 + m.w as i64) - a.0.max(m.x as i64);
    let oh = (a.1 + a.3).min(m.y as i64 + m.h as i64) - a.1.max(m.y as i64);
    (ow.max(0), oh.max(0))
}

/// Keeps the saved position when it is still reachable; otherwise recenters the window on
/// `fallback` (shrinking it if it no longer fits).
pub fn resolve(saved: &WindowState, scale: f64, monitors: &[Rect], fallback: Option<Rect>) -> Placement {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let (mut w, mut h) = (saved.width, saved.height);
    let (Some(x), Some(y)) = (saved.x, saved.y) else {
        return Placement { width: w, height: h, position: None };
    };
    if monitors.is_empty() {
        return Placement { width: w, height: h, position: Some((x, y)) };
    }

    let (pw, ph) = ((w * scale).round() as i64, (h * scale).round() as i64);
    let strip = (x as i64, y as i64, pw, ph.min(TITLE_STRIP));
    let reachable = monitors.iter().any(|m| {
        let (ow, oh) = overlap(strip, m);
        ow >= MIN_VISIBLE_W.min(pw) && oh >= MIN_VISIBLE_H.min(strip.3)
    });
    if reachable {
        return Placement { width: w, height: h, position: Some((x, y)) };
    }

    let target = fallback.unwrap_or(monitors[0]);
    w = w.min(target.w as f64 / scale);
    h = h.min(target.h as f64 / scale);
    let (pw, ph) = ((w * scale).round() as i64, (h * scale).round() as i64);
    let nx = target.x as i64 + (target.w as i64 - pw) / 2;
    let ny = target.y as i64 + (target.h as i64 - ph) / 2;
    Placement { width: w, height: h, position: Some((nx as i32, ny as i32)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAIN: Rect = Rect { x: 0, y: 0, w: 1920, h: 1080 };

    fn saved(w: f64, h: f64, x: Option<i32>, y: Option<i32>) -> WindowState {
        WindowState { width: w, height: h, x, y, open: false }
    }

    #[test]
    fn visible_position_is_kept() {
        let p = resolve(&saved(360.0, 480.0, Some(100), Some(80)), 1.0, &[MAIN], Some(MAIN));
        assert_eq!(p.position, Some((100, 80)));
    }

    #[test]
    fn window_from_a_disconnected_monitor_is_recovered() {
        let p = resolve(&saved(360.0, 480.0, Some(2500), Some(100)), 1.0, &[MAIN], Some(MAIN));
        let (x, y) = p.position.unwrap();
        assert!((0..=1920 - 360).contains(&x) && (0..=1080 - 480).contains(&y));
    }

    #[test]
    fn secondary_monitor_with_negative_coordinates_is_valid() {
        let left = Rect { x: -1920, y: 0, w: 1920, h: 1080 };
        let p = resolve(&saved(360.0, 480.0, Some(-1500), Some(50)), 1.0, &[left, MAIN], Some(MAIN));
        assert_eq!(p.position, Some((-1500, 50)));
        // ...but the same position is recovered once that monitor is gone.
        let p = resolve(&saved(360.0, 480.0, Some(-1500), Some(50)), 1.0, &[MAIN], Some(MAIN));
        assert!(p.position.unwrap().0 >= 0);
    }

    #[test]
    fn title_bar_off_the_top_or_barely_visible_is_recovered() {
        assert_ne!(resolve(&saved(360.0, 480.0, Some(100), Some(-500)), 1.0, &[MAIN], None).position, Some((100, -500)));
        // Only 70px of width visible at the right edge: too little to grab.
        assert_ne!(resolve(&saved(360.0, 480.0, Some(1850), Some(100)), 1.0, &[MAIN], None).position, Some((1850, 100)));
        // 120px visible is enough.
        assert_eq!(resolve(&saved(360.0, 480.0, Some(1800), Some(100)), 1.0, &[MAIN], None).position, Some((1800, 100)));
    }

    #[test]
    fn oversized_windows_shrink_when_recovered() {
        let p = resolve(&saved(5000.0, 4000.0, Some(9000), Some(0)), 1.0, &[MAIN], Some(MAIN));
        assert_eq!((p.width, p.height), (1920.0, 1080.0));
        assert_eq!(p.position, Some((0, 0)));
    }

    #[test]
    fn hidpi_scale_is_respected() {
        let hidpi = Rect { x: 0, y: 0, w: 3840, h: 2160 };
        // Logical 360x480 at 2x is 720x960 physical; 140px visible at the edge is enough.
        let p = resolve(&saved(360.0, 480.0, Some(3700), Some(100)), 2.0, &[hidpi], Some(hidpi));
        assert_eq!(p.position, Some((3700, 100)));
    }

    #[test]
    fn missing_position_or_monitor_info_falls_back_gracefully() {
        assert_eq!(resolve(&saved(300.0, 300.0, None, None), 1.0, &[MAIN], None).position, None);
        assert_eq!(resolve(&saved(300.0, 300.0, Some(5), Some(5)), 1.0, &[], None).position, Some((5, 5)));
    }
}
