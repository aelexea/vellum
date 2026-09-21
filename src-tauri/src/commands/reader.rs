//! Reader commands (§4.8 `reader:`) — owned by B3 (open/save), B4 (tick).
//!
//! `open_book` assembles the whole reader payload in one short db-lock pass (§11.3), then
//! triggers B5's auto-index hook **outside** the lock (`maybe_reindex` takes its own short
//! lock; `std::sync::Mutex` is not reentrant, so nesting would deadlock).
//!
//! The highlights/notes/bookmarks reads are local private queries, not calls into B4's
//! `db::annotations` — open_book only needs a read-all-by-uid snapshot and must not couple
//! to B4's mutation semantics.

use std::sync::MutexGuard;

use rusqlite::Connection;
use tauri::{AppHandle, State};

use crate::db::{library, progress};
use crate::dto::{Bookmark, Highlight, Note, OpenBook, ReadingPosition};
use crate::error::{AppError, CmdResult};
use crate::state::AppState;

/// Short-lived lock on the shared connection (§11.3).
fn lock_db<'r>(state: &State<'r, AppState>) -> CmdResult<MutexGuard<'r, rusqlite::Connection>> {
    state
        .inner()
        .db
        .lock()
        .map_err(|_| AppError::msg("database is busy"))
}

/// Read all highlights for a book (hasNote derived exactly as B4's `db::annotations`:
/// a note covering the same range). Chapter/creation order for the panel (§5.6).
const HL_HAS_NOTE: &str = "EXISTS(SELECT 1 FROM notes n \
     WHERE n.book_uid = h.book_uid AND n.chapter_idx = h.chapter_idx \
       AND n.cfi_start = h.cfi_start AND n.cfi_end = h.cfi_end)";

fn read_highlights(c: &Connection, uid: &str) -> anyhow::Result<Vec<Highlight>> {
    // Column order mirrors B4's HL_COLS with the v1.3 `text` column between color and
    // created_at; has_note is the trailing derived EXISTS.
    let sql = format!(
        "SELECT h.id, h.book_uid, h.chapter_idx, h.cfi_start, h.cfi_end, h.color, \
                h.text, h.created_at, {HL_HAS_NOTE} \
         FROM highlights h WHERE h.book_uid = ?1 \
         ORDER BY h.chapter_idx, h.created_at, h.id"
    );
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map([uid], |r| {
        Ok(Highlight {
            id: r.get(0)?,
            book_uid: r.get(1)?,
            chapter_idx: r.get(2)?,
            cfi_start: r.get(3)?,
            cfi_end: r.get(4)?,
            color: r.get(5)?,
            text: r.get(6)?,
            created_at: r.get(7)?,
            has_note: r.get::<_, i64>(8)? != 0,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn read_notes(c: &Connection, uid: &str) -> anyhow::Result<Vec<Note>> {
    let mut stmt = c.prepare(
        "SELECT id, book_uid, chapter_idx, cfi_start, cfi_end, selected_text, note_text, \
                created_at, updated_at \
         FROM notes WHERE book_uid = ?1 ORDER BY chapter_idx, created_at, id",
    )?;
    let rows = stmt.query_map([uid], |r| {
        Ok(Note {
            id: r.get(0)?,
            book_uid: r.get(1)?,
            chapter_idx: r.get(2)?,
            cfi_start: r.get(3)?,
            cfi_end: r.get(4)?,
            selected_text: r.get(5)?,
            note_text: r.get(6)?,
            created_at: r.get(7)?,
            updated_at: r.get(8)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn read_bookmarks(c: &Connection, uid: &str) -> anyhow::Result<Vec<Bookmark>> {
    let mut stmt = c.prepare(
        "SELECT id, book_uid, chapter_idx, cfi, label, created_at \
         FROM bookmarks WHERE book_uid = ?1 ORDER BY chapter_idx, created_at, id",
    )?;
    let rows = stmt.query_map([uid], |r| {
        Ok(Bookmark {
            id: r.get(0)?,
            book_uid: r.get(1)?,
            chapter_idx: r.get(2)?,
            cfi: r.get(3)?,
            label: r.get(4)?,
            created_at: r.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Open a book for reading (§7.2). Returns the full [`OpenBook`] payload; a missing file
/// still yields cached data with `missing = true` so the UI can explain and offer rescan.
#[tauri::command]
pub async fn open_book(
    app: AppHandle,
    state: State<'_, AppState>,
    uid: String,
) -> CmdResult<OpenBook> {
    // One short lock for every read; nothing held across the index hook below.
    let (detail, position, highlights, notes, bookmarks, index_status) = {
        let conn = lock_db(&state)?;

        let mut detail =
            library::get_book(&conn, &uid)?.ok_or_else(|| AppError::msg("Book not found"))?;

        // Live fs stat overrides the stored flag: a book opened after its file vanished
        // must report missing even if no rescan ran yet.
        let present = std::fs::metadata(&detail.meta.path)
            .map(|m| m.is_file())
            .unwrap_or(false);
        detail.meta.missing = !present;

        let position = progress::load_position(&conn, &uid)?;
        let highlights = read_highlights(&conn, &uid).map_err(AppError::from)?;
        let notes = read_notes(&conn, &uid).map_err(AppError::from)?;
        let bookmarks = read_bookmarks(&conn, &uid).map_err(AppError::from)?;

        let indexed = crate::search::read_indexed(&conn, &uid).unwrap_or(-1);
        let index_status = crate::search::index_status(&conn, &uid, indexed);

        // Opening marks the book recently-opened even before the first debounced save.
        let _ = progress::touch_last_opened(&conn, &uid);

        (detail, position, highlights, notes, bookmarks, index_status)
    };

    // Auto-index hook (§4.5): spawns a background build only when indexed == 0;
    // skipped for a missing file — there is nothing to index.
    if !detail.meta.missing {
        crate::search::index::maybe_reindex(&app, &uid);
    }

    Ok(OpenBook {
        book: detail,
        position,
        highlights,
        notes,
        bookmarks,
        index_status,
    })
}

/// Persist a reading position (§7.3). Validates `chapterIdx` against the book's chapter
/// count so a corrupt/stale frontend position can't write an out-of-range index.
#[tauri::command]
pub async fn save_position(
    state: State<'_, AppState>,
    uid: String,
    position: ReadingPosition,
) -> CmdResult<()> {
    let conn = lock_db(&state)?;

    let total: Option<i64> = conn
        .query_row(
            "SELECT total_chapters FROM books WHERE uid = ?1",
            [&uid],
            |r| r.get(0),
        )
        .ok();
    let Some(total) = total else {
        return Err(AppError::msg("Book not found"));
    };

    // Validate the chapter index. Reader indices are full-spine positions (B2's
    // serve_chapter indexes spine[idx]; B1 resolves toc targets the same way), while
    // books.total_chapters is the *linear* count (§4.8) — for a spine with non-linear
    // items a legitimate index can exceed it. So the upper bound is the larger of
    // total_chapters and the cached chapter count; only reject when the index is beyond
    // both (or negative). total==0 with no cached rows means "count unknown" → accept.
    if position.chapter_idx < 0 {
        return Err(AppError::msg(format!(
            "Invalid chapter index: {}",
            position.chapter_idx
        )));
    }
    let cached_chapters: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM chapters WHERE book_uid = ?1",
            [&uid],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let upper = total.max(cached_chapters);
    if upper > 0 && position.chapter_idx >= upper {
        return Err(AppError::msg(format!(
            "Invalid chapter index: {} (of {})",
            position.chapter_idx, upper
        )));
    }

    progress::save_position(&conn, &uid, &position).map_err(AppError::from)
}

// record_reading_tick (§4.8 reader:) is implemented by B4 in commands/stats.rs and
// registered there in the frozen lib.rs invoke_handler — this module must not define it
// (duplicate command symbols are an E0428 at the generate_handler! expansion).
