//! Annotation commands (§4.8 `annotations:`) — owned by B4.
//!
//! Thin wrappers over [`crate::db::annotations`]: take the `state.db` lock for the duration
//! of one short query, map `anyhow::Error` → `AppError` (§4.2), return the DTOs unchanged.
//! No `.await` inside a locked scope (§11.3).

use tauri::State;

use crate::db::annotations as db;
use crate::dto::{Bookmark, Highlight, Note};
use crate::error::{AppError, CmdResult};
use crate::state::AppState;

/// Short-lived db lock (§11.3). A poisoned mutex means another command panicked while
/// holding it — surface that as an error instead of panicking the async runtime.
fn lock_db<'a>(
    state: &'a State<'_, AppState>,
) -> CmdResult<std::sync::MutexGuard<'a, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::msg("database is busy (lock poisoned)"))
}

// ---------------------------------------------------------------------------
// Highlights
// ---------------------------------------------------------------------------

/// All highlights of a book, or only one chapter when `chapterIdx` is given.
#[tauri::command]
pub async fn list_highlights(
    state: State<'_, AppState>,
    uid: String,
    chapter_idx: Option<i64>,
) -> CmdResult<Vec<Highlight>> {
    let c = lock_db(&state)?;
    Ok(db::list_highlights(&c, &uid, chapter_idx)?)
}

#[tauri::command]
pub async fn add_highlight(
    state: State<'_, AppState>,
    book_uid: String,
    chapter_idx: i64,
    cfi_start: String,
    cfi_end: String,
    color: String,
    text: String,
) -> CmdResult<Highlight> {
    let c = lock_db(&state)?;
    Ok(db::add_highlight(
        &c,
        &book_uid,
        chapter_idx,
        &cfi_start,
        &cfi_end,
        &color,
        &text,
    )?)
}

/// Recolor only — the range and creation time never change (§4.8).
#[tauri::command]
pub async fn update_highlight(state: State<'_, AppState>, id: i64, color: String) -> CmdResult<()> {
    let c = lock_db(&state)?;
    Ok(db::update_highlight(&c, id, &color)?)
}

#[tauri::command]
pub async fn delete_highlight(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let c = lock_db(&state)?;
    Ok(db::delete_highlight(&c, id)?)
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/// Notes for one book, or every book when `uid` is null (annotations panel).
#[tauri::command]
pub async fn list_notes(state: State<'_, AppState>, uid: Option<String>) -> CmdResult<Vec<Note>> {
    let c = lock_db(&state)?;
    Ok(db::list_notes(&c, uid.as_deref())?)
}

#[tauri::command]
pub async fn add_note(
    state: State<'_, AppState>,
    book_uid: String,
    chapter_idx: i64,
    cfi_start: String,
    cfi_end: String,
    selected_text: String,
    note_text: String,
) -> CmdResult<Note> {
    let c = lock_db(&state)?;
    Ok(db::add_note(
        &c,
        &book_uid,
        chapter_idx,
        &cfi_start,
        &cfi_end,
        &selected_text,
        &note_text,
    )?)
}

#[tauri::command]
pub async fn update_note(state: State<'_, AppState>, id: i64, note_text: String) -> CmdResult<()> {
    let c = lock_db(&state)?;
    Ok(db::update_note(&c, id, &note_text)?)
}

#[tauri::command]
pub async fn delete_note(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let c = lock_db(&state)?;
    Ok(db::delete_note(&c, id)?)
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn list_bookmarks(
    state: State<'_, AppState>,
    uid: Option<String>,
) -> CmdResult<Vec<Bookmark>> {
    let c = lock_db(&state)?;
    Ok(db::list_bookmarks(&c, uid.as_deref())?)
}

#[tauri::command]
pub async fn add_bookmark(
    state: State<'_, AppState>,
    book_uid: String,
    chapter_idx: i64,
    cfi: String,
    label: Option<String>,
) -> CmdResult<Bookmark> {
    let c = lock_db(&state)?;
    Ok(db::add_bookmark(
        &c,
        &book_uid,
        chapter_idx,
        &cfi,
        label.as_deref(),
    )?)
}

#[tauri::command]
pub async fn delete_bookmark(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let c = lock_db(&state)?;
    Ok(db::delete_bookmark(&c, id)?)
}
