//! Settings + data commands (§4.8 `settings:`) — owned by B8.
//!
//! JS-facing names, arguments and return types are exactly as frozen in §4.8. The heavy
//! commands take an `AppHandle` instead of `State<'_, AppState>` so their blocking work
//! (`fc-list`, `VACUUM INTO`, bulk SQL) can run in `spawn_blocking` rather than parking a
//! tokio worker; `AppHandle` is resolved by Tauri, not passed from JS, so the invoke
//! signature is unchanged.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager, State};

use crate::backup;
use crate::dto::{FontFamily, Settings};
use crate::error::{AppError, CmdResult};
use crate::settings as settings_mod;
use crate::state::AppState;

/// Set on the first `get_settings` call so the startup auto-backup (§4.7) runs exactly once
/// per process. lib.rs is frozen and currently spawns its own local stub (see B8 report), so
/// the real one is triggered here from a file B8 owns.
static AUTO_BACKUP_TRIGGERED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> CmdResult<Settings> {
    let paths = app.state::<AppState>().paths.clone();
    if !AUTO_BACKUP_TRIGGERED.swap(true, Ordering::Relaxed) {
        backup::spawn_auto_backup_paths(paths);
    }
    // Cheap: parking_lot read lock + clone, no IO. The guard is bound first so it is dropped
    // before the borrowed state.
    let state = app.state::<AppState>();
    let snapshot = state.settings.read().clone();
    Ok(snapshot)
}

/// Deep-merge `patch` into the live settings, persist atomically, return the full result.
#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    patch: serde_json::Value,
) -> CmdResult<Settings> {
    // Hold the write lock for the whole read→merge→persist→store sequence so concurrent
    // saves cannot lose each other's keys, and so memory and disk never diverge.
    let mut guard = state.settings.write();
    let merged = settings_mod::merge_patch(&guard, patch)?;
    // Persist first: on IO error the in-memory settings stay in step with the file.
    settings_mod::save(&state.paths, &merged)?;
    *guard = merged.clone();
    Ok(merged)
}

#[tauri::command]
pub async fn list_fonts(app: AppHandle) -> CmdResult<Vec<FontFamily>> {
    // `fc-list` is a subprocess (up to the 5 s guard) — keep it off the async worker.
    spawn_blocking(app, |state| Ok(settings_mod::list_fonts(state))).await
}

#[tauri::command]
pub async fn export_settings(state: State<'_, AppState>, path: String) -> CmdResult<()> {
    backup::export_settings(&state.paths, &path).map_err(AppError::from)
}

#[tauri::command]
pub async fn import_settings(state: State<'_, AppState>, path: String) -> CmdResult<Settings> {
    let imported = backup::import_settings(&state.paths, &path).map_err(AppError::from)?;
    // Adopt the imported settings in memory too, so the running app matches the file.
    *state.settings.write() = imported.clone();
    Ok(imported)
}

/// `VACUUM INTO ?path` snapshot (§4.7).
#[tauri::command]
pub async fn backup_db(app: AppHandle, path: String) -> CmdResult<()> {
    spawn_blocking(app, move |state| backup::backup_db(state, &path)).await
}

/// Export annotations json|md (§4.7); returns row count. `uid = None` → all books.
#[tauri::command]
pub async fn export_annotations(
    app: AppHandle,
    uid: Option<String>,
    path: String,
    format: String,
) -> CmdResult<usize> {
    spawn_blocking(app, move |state| {
        backup::export_annotations(state, uid.as_deref(), &path, &format)
    })
    .await
}

/// Import annotations json (§4.7); returns row count.
#[tauri::command]
pub async fn import_annotations(app: AppHandle, path: String) -> CmdResult<usize> {
    spawn_blocking(app, move |state| backup::import_annotations(state, &path)).await
}

/// Run a fallible blocking closure on the blocking pool with access to the managed state.
async fn spawn_blocking<F, T>(app: AppHandle, f: F) -> CmdResult<T>
where
    F: FnOnce(&AppState) -> anyhow::Result<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        f(&state)
    })
    .await
    .map_err(|e| AppError::msg(format!("background task failed: {e}")))?
    .map_err(AppError::from)
}
