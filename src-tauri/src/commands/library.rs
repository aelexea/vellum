//! Library commands (§4.8 `library:`) — owned by B3.
//!
//! Import/scan/rescan do real fs + zip work, so they run on a blocking thread via
//! `tauri::async_runtime::spawn_blocking` and never hold the `state.db` lock across an
//! `.await` (§11.3). The DB connection is `!Send`, so the blocking closure opens its own
//! connection to the same WAL path (same pattern B5's indexer uses) and the commands keep
//! only `Send` data (paths, clones) across the await.
//!
//! All three import entry points share [`import_paths_blocking`], which emits
//! `import-progress {done,total,current}` per file (§4.8 event).

use std::path::Path;
use std::sync::MutexGuard;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::db::{self, library};
use crate::dto::{BookDetail, BookMeta, ImportReport, LibraryFilter, Tag};
use crate::error::{AppError, CmdResult};
use crate::state::AppState;

/// `import-progress` payload (§4.8 / frozen FE `ImportProgressEvent`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress<'a> {
    done: usize,
    total: usize,
    current: &'a str,
}

/// Short-lived lock on the shared connection, never held across an await (§11.3).
/// `inner()` borrows for the command's lifetime, so the guard can outlive this helper
/// (same pattern B5's `commands::search::lock_db` uses).
fn lock_db<'r>(state: &State<'r, AppState>) -> CmdResult<MutexGuard<'r, rusqlite::Connection>> {
    state
        .inner()
        .db
        .lock()
        .map_err(|_| AppError::msg("database is busy"))
}

/// Import a list of `.epub` paths on a blocking thread. Owns the fs/zip work, opens a
/// second WAL connection, emits progress. Returns the merged report.
async fn import_paths_blocking(
    app: AppHandle,
    db_path: std::path::PathBuf,
    covers_dir: std::path::PathBuf,
    files: Vec<String>,
) -> CmdResult<ImportReport> {
    // Only .epub (case-insensitive) paths are considered; others are dropped silently
    // here — callers that pass explicit non-epub files (import_books) report them instead.
    let emitter = app.clone();
    let handle = tauri::async_runtime::spawn_blocking(move || {
        let conn = db::open_at(&db_path)?;
        library::import_many(&conn, &covers_dir, &files, &|done, total, current| {
            let _ = emitter.emit(
                "import-progress",
                ImportProgress {
                    done,
                    total,
                    current,
                },
            );
        })
    })
    .await
    .map_err(|e| AppError::msg(format!("import task failed: {e}")))?;

    handle.map_err(AppError::from)
}

/// Partition arbitrary user-picked paths into epub files (imported) and non-epub files
/// (reported as failed with a clear reason), preserving order.
fn split_epubs(paths: &[String]) -> (Vec<String>, Vec<crate::dto::ImportIssue>) {
    let mut epubs = Vec::new();
    let mut rejected = Vec::new();
    for p in paths {
        let is_epub = Path::new(p)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("epub"))
            .unwrap_or(false);
        if is_epub {
            epubs.push(p.clone());
        } else {
            rejected.push(crate::dto::ImportIssue {
                path: p.clone(),
                reason: "not an EPUB file".to_owned(),
            });
        }
    }
    (epubs, rejected)
}

#[tauri::command]
pub async fn import_books(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> CmdResult<ImportReport> {
    let (db_path, covers_dir) = {
        let s = state.inner();
        (s.paths.db_path.clone(), s.paths.covers_dir.clone())
    };

    let (epubs, mut rejected) = split_epubs(&paths);
    let mut report = if epubs.is_empty() {
        ImportReport::default()
    } else {
        import_paths_blocking(app, db_path, covers_dir, epubs).await?
    };
    // Non-epub selections surface as failed so the UI toast explains them.
    report.failed.append(&mut rejected);
    Ok(report)
}

#[tauri::command]
pub async fn scan_directory(
    app: AppHandle,
    state: State<'_, AppState>,
    dir: String,
) -> CmdResult<ImportReport> {
    let (db_path, covers_dir) = {
        let s = state.inner();
        (s.paths.db_path.clone(), s.paths.covers_dir.clone())
    };

    let root = dir.clone();
    // Collect on a blocking thread: read_dir recursion touches the disk.
    let files =
        tauri::async_runtime::spawn_blocking(move || library::collect_epubs(Path::new(&root)))
            .await
            .map_err(|e| AppError::msg(format!("scan failed: {e}")))?;

    if files.is_empty() {
        return Ok(ImportReport::default());
    }
    import_paths_blocking(app, db_path, covers_dir, files).await
}

#[tauri::command]
pub async fn rescan_library(app: AppHandle, state: State<'_, AppState>) -> CmdResult<ImportReport> {
    let (db_path, covers_dir) = {
        let s = state.inner();
        (s.paths.db_path.clone(), s.paths.covers_dir.clone())
    };
    // Watched dirs come from live settings (§4.8); read under the short settings lock.
    let watched: Vec<String> = {
        let s = state.inner();
        let guard = s.settings.read();
        guard.library.watched_dirs.clone()
    };

    let watched_for_task = watched;
    let db_path_task = db_path.clone();

    // Step 1 (blocking): mark missing, then collect new epubs across all watched dirs.
    let new_files = tauri::async_runtime::spawn_blocking(move || {
        let conn = db::open_at(&db_path_task)?;
        library::mark_missing(&conn)?;
        let mut found = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for d in &watched_for_task {
            for f in library::collect_epubs(Path::new(d)) {
                if seen.insert(f.clone()) {
                    found.push(f);
                }
            }
        }
        anyhow::Ok(found)
    })
    .await
    .map_err(|e| AppError::msg(format!("rescan failed: {e}")))?
    .map_err(AppError::from)?;

    if new_files.is_empty() {
        return Ok(ImportReport::default());
    }
    import_paths_blocking(app, db_path, covers_dir, new_files).await
}

#[tauri::command]
pub async fn list_books(
    state: State<'_, AppState>,
    filter: LibraryFilter,
) -> CmdResult<Vec<BookMeta>> {
    let conn = lock_db(&state)?;
    library::list_books(&conn, &filter).map_err(AppError::from)
}

#[tauri::command]
pub async fn list_tags(state: State<'_, AppState>) -> CmdResult<Vec<Tag>> {
    let conn = lock_db(&state)?;
    library::list_tags(&conn).map_err(AppError::from)
}

#[tauri::command]
pub async fn set_book_tags(
    state: State<'_, AppState>,
    uid: String,
    tags: Vec<String>,
) -> CmdResult<()> {
    let conn = lock_db(&state)?;
    library::set_book_tags(&conn, &uid, &tags).map_err(AppError::from)
}

#[tauri::command]
pub async fn delete_book(
    state: State<'_, AppState>,
    uid: String,
    delete_file: bool,
) -> CmdResult<()> {
    let conn = lock_db(&state)?;
    library::delete_book(&conn, &uid, delete_file).map_err(AppError::from)
}

#[tauri::command]
pub async fn get_book(state: State<'_, AppState>, uid: String) -> CmdResult<BookDetail> {
    let conn = lock_db(&state)?;
    library::get_book(&conn, &uid)?.ok_or_else(|| AppError::msg("Book not found"))
}
