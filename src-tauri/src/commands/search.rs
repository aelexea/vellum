//! Search commands (§4.8 `search:`) — owned by B5.
//!
//! All three take the app handle as well as the state: `reindex_book` and the
//! auto-index fallback in `search_in_book` need it to spawn work via
//! [`crate::search::index`], and command arguments are injected by Tauri so this does not
//! change the frozen §4.8 call signatures seen from JS.

use tauri::{AppHandle, State};

use crate::dto::{IndexStatus, SearchHit};
use crate::error::{AppError, CmdResult};
use crate::search::{self, index, query};
use crate::state::AppState;

/// Lock the shared connection, refusing to block forever on a poisoned mutex.
fn lock_db<'r>(
    state: &State<'r, AppState>,
) -> CmdResult<std::sync::MutexGuard<'r, rusqlite::Connection>> {
    // inner() borrows for the command's lifetime, not for &self, so the guard can
    // outlive this helper.
    state
        .inner()
        .db
        .lock()
        .map_err(|_| AppError::msg("database is busy"))
}

/// Index state + chapter progress for the search panel header (§5.6 "Indexing… 34/120").
#[tauri::command]
pub async fn get_index_status(state: State<'_, AppState>, uid: String) -> CmdResult<IndexStatus> {
    let conn = lock_db(&state)?;
    let indexed = search::read_indexed(&conn, &uid).unwrap_or(-1);
    Ok(search::index_status(&conn, &uid, indexed))
}

/// Force (or first-time) index build. Returns immediately — the work is on a blocking
/// thread, progress arrives as `index-progress` / `index-done` / `index-error` events.
#[tauri::command]
pub async fn reindex_book(
    app: AppHandle,
    state: State<'_, AppState>,
    uid: String,
    force: bool,
) -> CmdResult<()> {
    // Validate the book exists so a typo'd uid reports an error instead of silently
    // spawning nothing.
    {
        let conn = lock_db(&state)?;
        if search::read_indexed(&conn, &uid).is_none() {
            return Err(AppError::msg(format!("book not found: {uid}")));
        }
    }
    index::reindex_book(&app, &uid, force);
    Ok(())
}

/// Full-text search in one book (§4.5).
///
/// Returns `[]` while the index is not ready, and kickstarts indexing when the book has
/// never been indexed so the first search does not require a manual "Build index".
#[tauri::command]
pub async fn search_in_book(
    app: AppHandle,
    state: State<'_, AppState>,
    uid: String,
    query: String,
    limit: Option<i64>,
) -> CmdResult<Vec<SearchHit>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let limit = limit.unwrap_or(query::DEFAULT_LIMIT);

    // Short lock: read the state, then decide, without holding it across the search.
    let indexed = {
        let conn = lock_db(&state)?;
        search::read_indexed(&conn, &uid).unwrap_or(-1)
    };

    if indexed != 2 {
        if indexed == 0 {
            // First search on a never-indexed book starts the build (§4.5 auto-index).
            index::maybe_reindex(&app, &uid);
        }
        return Ok(Vec::new());
    }

    query::search_in_book(&state, &uid, &query, limit).map_err(AppError::from)
}
