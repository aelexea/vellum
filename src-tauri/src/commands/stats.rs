//! Stats commands (§4.8 `stats:` + the reader heartbeat tick) — owned by B4.
//!
//! Thin wrappers over [`crate::db::stats`], short-lived db lock (§11.3), `anyhow` →
//! `AppError` (§4.2). The only logic here is heartbeat clamping: the frontend ticks every
//! 30 s while the reader is visible (§5.2), so values far outside that are artifacts of a
//! suspended laptop or a resumed timer and must not pollute the stats.
//!
//! NOTE (see FROZEN-CHANGE-REQUEST in the B4 report): frozen `lib.rs` currently wires
//! `commands::reader::record_reading_tick` (B3's stub file). This module provides the
//! real implementation with the **same** signature, so it is a drop-in once `lib.rs`
//! points at `commands::stats::record_reading_tick`.

use tauri::State;

use crate::db::stats as db;
use crate::dto::{BookStats, ReadingStats};
use crate::error::{AppError, CmdResult};
use crate::state::AppState;

/// One heartbeat may credit at most this many seconds (§4.8: 30 s interval, generous slack).
pub const MAX_TICK_SECONDS: i64 = 300;
/// One heartbeat may credit at most this many page turns.
pub const MAX_TICK_PAGES: i64 = 10_000;

/// Clamp a heartbeat to sane bounds: seconds → `0..=300`, pages → `0..=10_000`.
///
/// Non-finite or negative seconds become 0 (a tick that means nothing is dropped rather
/// than rejected — the reader must never see an error toast from the heartbeat).
pub fn clamp_tick(seconds: f64, pages_turned: i64) -> (i64, i64) {
    let secs = if seconds.is_finite() {
        seconds.round() as i64
    } else {
        0
    };
    (
        secs.clamp(0, MAX_TICK_SECONDS),
        pages_turned.clamp(0, MAX_TICK_PAGES),
    )
}

/// Short-lived db lock (§11.3); poisoned mutex → error, never a panic in async context.
fn lock_db<'a>(
    state: &'a State<'_, AppState>,
) -> CmdResult<std::sync::MutexGuard<'a, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::msg("database is busy (lock poisoned)"))
}

/// Reader heartbeat (§7.7): clamp, then upsert today's `sessions` row for this book.
///
/// §4.8 lists this command under `reader:`, but the implementation lives here with the rest
/// of the stats surface; `lib.rs` registers `commands::stats::record_reading_tick` and the
/// duplicate stub in `commands/reader.rs` is removed (two annotated copies of one command
/// name cannot coexist — E0428).
#[tauri::command]
pub async fn record_reading_tick(
    state: State<'_, AppState>,
    uid: String,
    seconds: f64,
    pages_turned: i64,
) -> CmdResult<()> {
    let (seconds, pages_turned) = clamp_tick(seconds, pages_turned);
    if seconds == 0 && pages_turned == 0 {
        return Ok(()); // nothing to record — skip the lock entirely
    }
    let c = lock_db(&state)?;
    Ok(db::record_tick(&c, &uid, seconds, pages_turned)?)
}

/// Aggregate reading stats. `range` ∈ day|week|month|all (§4.8); unknown → `all`.
#[tauri::command]
pub async fn get_stats(state: State<'_, AppState>, range: String) -> CmdResult<ReadingStats> {
    let c = lock_db(&state)?;
    Ok(db::get_stats(&c, &range)?)
}

/// Per-book totals + first/last opened + progress (§4.8).
#[tauri::command]
pub async fn get_book_stats(state: State<'_, AppState>, uid: String) -> CmdResult<BookStats> {
    let c = lock_db(&state)?;
    Ok(db::get_book_stats(&c, &uid)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b4_clamp_tick_passes_normal_heartbeats_through() {
        assert_eq!(clamp_tick(30.0, 3), (30, 3));
        assert_eq!(clamp_tick(0.0, 0), (0, 0));
        assert_eq!(clamp_tick(300.0, 10_000), (300, 10_000), "bounds inclusive");
    }

    #[test]
    fn b4_clamp_tick_caps_absurd_values() {
        assert_eq!(clamp_tick(99_999.0, 5), (300, 5), "seconds capped at 300");
        assert_eq!(clamp_tick(1e18, 5), (300, 5), "finite but absurd → capped");
        assert_eq!(clamp_tick(30.0, 999_999), (30, 10_000), "pages capped");
        assert_eq!(clamp_tick(30.0, i64::MAX), (30, 10_000));
    }

    #[test]
    fn b4_clamp_tick_drops_nonsense() {
        assert_eq!(clamp_tick(-5.0, 2), (0, 2), "negative seconds dropped");
        assert_eq!(clamp_tick(30.0, -2), (30, 0), "negative pages dropped");
        assert_eq!(clamp_tick(f64::NAN, 2), (0, 2), "NaN dropped");
        // non-finite comes from a broken timer: crediting the cap would invent 5 minutes of
        // reading, so it drops to zero like NaN instead of clamping to 300
        assert_eq!(clamp_tick(f64::INFINITY, 5), (0, 5));
        assert_eq!(clamp_tick(f64::NEG_INFINITY, 0), (0, 0));
    }

    #[test]
    fn b4_clamp_tick_rounds_fractional_seconds() {
        assert_eq!(clamp_tick(29.5, 0), (30, 0));
        assert_eq!(clamp_tick(29.4, 0), (29, 0));
        assert_eq!(clamp_tick(0.4, 0), (0, 0));
    }

    /// End-to-end clamp → store: the db layer must hold exactly the clamped value.
    #[test]
    fn b4_clamped_tick_stored_value() {
        use crate::db::stats as dbstats;
        let c = crate::db::annotations::testutil::conn();
        let (s, p) = clamp_tick(99_999.0, 999_999);
        dbstats::record_tick(&c, "uid", s, p).unwrap();
        let stored: (i64, i64) = c
            .query_row(
                "SELECT seconds, pages_turned FROM sessions WHERE book_uid = 'uid'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(stored, (300, 10_000));
    }
}
