//! Vellum — Tauri 2 backend (§4.9). Frozen mod tree + invoke_handler list.
//!
//! Stubs keep the crate compiling and bootable until each WP lands; the allow list is
//! crate-wide per §11 so partial builds stay green.

#![allow(
    dead_code,
    unused_variables,
    clippy::needless_return,
    clippy::too_many_arguments
)]

pub mod backup;
pub mod commands;
pub mod db;
pub mod dto;
pub mod epub;
pub mod error;
pub mod fonts;
pub mod net;
pub mod protocol;
pub mod search;
pub mod settings;
pub mod state;

pub use error::{AppError, CmdResult};
pub use state::AppState;

use tauri::Manager;

/// §4.9: init state (db + migrate + settings + http), spawn auto-backup, register the
/// `vellum://` protocol, manage state, wire plugins and every §4.8 command.
pub fn run() {
    tauri::Builder::default()
        // single-instance: a second launch just focuses the existing main window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Tauri 2 registers URI schemes on the Builder ONLY (AppHandle has no such API), and
        // the scheme must exist before the config window is created — hence chained here, not
        // in setup().
        .register_asynchronous_uri_scheme_protocol("vellum", protocol::uri_scheme_protocol())
        .setup(|app| {
            let handle = app.handle().clone();

            // DB + settings + http client + XDG paths (creates all dirs).
            let state = AppState::init(&handle)?;

            // Auto-backup on startup (§4.7) — spawned off-thread so a slow VACUUM never
            // delays the window.
            let backup_paths = state.paths.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(e) = backup::auto_backup(&backup_paths) {
                    eprintln!("[vellum] auto-backup skipped: {e}");
                }
            });

            // Rescan-lite (§4.9): db::library::mark_missing has landed; intentionally
            // driven by the explicit rescan_library command on a blocking thread rather
            // than spawned at setup, so missing flags refresh on rescan/book-open.
            // Documented in README.

            // (vellum:// URI scheme is registered on the Builder above — Tauri 2 has no
            // AppHandle registration API; see protocol::uri_scheme_protocol.)

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // smoke test hook (integration)
            commands::get_smoke_config,
            // library [B3]
            commands::library::import_books,
            commands::library::scan_directory,
            commands::library::rescan_library,
            commands::library::list_books,
            commands::library::list_tags,
            commands::library::set_book_tags,
            commands::library::delete_book,
            commands::library::get_book,
            // reader [B3/B4]
            commands::reader::open_book,
            commands::reader::save_position,
            commands::stats::record_reading_tick,
            // annotations [B4]
            commands::annotations::list_highlights,
            commands::annotations::add_highlight,
            commands::annotations::update_highlight,
            commands::annotations::delete_highlight,
            commands::annotations::list_notes,
            commands::annotations::add_note,
            commands::annotations::update_note,
            commands::annotations::delete_note,
            commands::annotations::list_bookmarks,
            commands::annotations::add_bookmark,
            commands::annotations::delete_bookmark,
            // search [B5]
            commands::search::get_index_status,
            commands::search::reindex_book,
            commands::search::search_in_book,
            // vocab [B6]
            commands::vocab::lookup_word,
            commands::vocab::list_vocab,
            commands::vocab::add_vocab_word,
            commands::vocab::update_vocab_word,
            commands::vocab::delete_vocab_word,
            commands::vocab::get_review_queue,
            commands::vocab::record_review,
            commands::vocab::vocab_stats,
            commands::vocab::export_vocab,
            commands::vocab::import_vocab,
            // translate [B7]
            commands::translate::translate_text,
            commands::translate::detect_language,
            commands::translate::list_translators,
            commands::translate::save_provider_config,
            commands::translate::test_provider,
            commands::translate::list_languages,
            // settings + data [B8]
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::settings::list_fonts,
            commands::settings::export_settings,
            commands::settings::import_settings,
            commands::settings::backup_db,
            commands::settings::export_annotations,
            commands::settings::import_annotations,
            // stats [B4]
            commands::stats::get_stats,
            commands::stats::get_book_stats,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Vellum");
}
