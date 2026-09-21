//! Command modules (§3) + the smoke-test config command (integration).
//!
//! `lib.rs` (frozen) lists every command in `invoke_handler`; each WP replaces the stub
//! bodies in its file. Command names are frozen (§4.8).

pub mod annotations;
pub mod library;
pub mod reader;
pub mod search;
pub mod settings;
pub mod stats;
pub mod translate;
pub mod vocab;

use crate::dto::SmokeConfig;

/// Smoke-test hook (integration): when `VELLUM_SMOKE` is set, the frontend reads the
/// optional `VELLUM_SMOKE_BOOK` / `_VIEW` / `_OVERLAY` / `_THEME` env vars at boot to
/// drive `tools/smoke.sh`. Sync + stateless on purpose.
#[tauri::command]
pub fn get_smoke_config() -> Option<SmokeConfig> {
    if std::env::var("VELLUM_SMOKE").is_err() {
        return None;
    }
    Some(SmokeConfig {
        book: std::env::var("VELLUM_SMOKE_BOOK").ok(),
        view: std::env::var("VELLUM_SMOKE_VIEW").ok(),
        overlay: std::env::var("VELLUM_SMOKE_OVERLAY").ok(),
        theme: std::env::var("VELLUM_SMOKE_THEME").ok(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test only: env vars are process-global and cargo runs tests on parallel threads,
    /// so both assertions live here to avoid racing any other test.
    #[test]
    fn smoke_config_follows_env() {
        std::env::remove_var("VELLUM_SMOKE");
        assert!(get_smoke_config().is_none());

        std::env::set_var("VELLUM_SMOKE", "1");
        std::env::set_var("VELLUM_SMOKE_VIEW", "reader");
        let c = get_smoke_config().expect("Some when VELLUM_SMOKE set");
        assert_eq!(c.view.as_deref(), Some("reader"));
        assert!(c.book.is_none());

        std::env::remove_var("VELLUM_SMOKE_VIEW");
        std::env::remove_var("VELLUM_SMOKE");
        assert!(get_smoke_config().is_none());
    }
}
