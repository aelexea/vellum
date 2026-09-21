//! Translate/dictionary commands (§4.8 `translate:`) — owned by B7.
//!
//! Thin wrappers over `crate::net`: the orchestration, fallback chains and graceful
//! degradation all live there (§11.4). `test_provider` deliberately bypasses the
//! fallback chain — it exercises exactly the named provider so the settings UI can
//! report per-instance health ("Works / Doesn't work", §5.9).

use tauri::State;

use crate::dto::{Lang, ProviderConfig, TranslateResult, TranslatorInfo};
use crate::error::CmdResult;
use crate::net::{self, dict, translate};
use crate::settings;
use crate::state::AppState;

/// `from`/`to` are ISO 639-1; `from = "auto"` detects the source language.
/// `provider_id = None` → `settings.translate.defaultProviderId`. An explicit
/// `provider_id` is honored directly (not settings-defaulted) — §4.8.
#[tauri::command]
pub async fn translate_text(
    state: State<'_, AppState>,
    text: String,
    from: String,
    to: String,
    provider_id: Option<String>,
) -> CmdResult<TranslateResult> {
    net::translate(&state, &text, &from, &to, provider_id.as_deref())
        .await
        .map_err(Into::into)
}

/// ISO 639-1 detection: provider probe (google `sl=auto`) with a local unicode-block
/// heuristic fallback — never needs the network to succeed (§11.4).
#[tauri::command]
pub async fn detect_language(state: State<'_, AppState>, text: String) -> CmdResult<String> {
    net::detect_lang(&state, &text).await.map_err(Into::into)
}

/// Registry × configured state (§4.8) for the settings "Translation" panel.
#[tauri::command]
pub async fn list_translators(state: State<'_, AppState>) -> CmdResult<Vec<TranslatorInfo>> {
    Ok(net::list_translators(&state))
}

/// Patch `settings.translate.providers[id]` and persist (§4.8). `settings::save` is
/// currently the B8 placeholder (Ok(())) — call it regardless; B8 lands the real IO.
#[tauri::command]
pub async fn save_provider_config(
    state: State<'_, AppState>,
    provider_id: String,
    cfg: ProviderConfig,
) -> CmdResult<()> {
    let snapshot = {
        let mut s = state.settings.write();
        net::apply_provider_config(&mut s, &provider_id, cfg);
        s.clone()
    };
    settings::save(&state.paths, &snapshot).map_err(Into::into)
}

/// "Test connection" (§5.9): translate "hello" → "ru" through *this* provider only
/// (fallback chain intentionally bypassed); dict providers get a "hello" lookup instead.
/// Any error → false (the UI shows "Doesn't work", never a toast from here).
#[tauri::command]
pub async fn test_provider(state: State<'_, AppState>, provider_id: String) -> CmdResult<bool> {
    // translate provider?
    if let Some(p) = translate::by_id(&provider_id) {
        let cfg = {
            let s = state.settings.read();
            translate::effective_config(&s.translate, p.id())
        };
        let ok = p
            .translate(&state.http, &cfg, "hello", "en", "ru")
            .await
            .is_ok();
        return Ok(ok);
    }
    // dict provider?
    if let Some(p) = dict::by_id(&provider_id) {
        let cfg = {
            let s = state.settings.read();
            dict::effective_config(&s, p.id())
        };
        let ok = matches!(p.lookup(&state.http, &cfg, "hello").await, Ok(Some(_)));
        return Ok(ok);
    }
    // unknown id → not working
    Ok(false)
}

/// Static language table for the target-lang pickers (§4.8).
#[tauri::command]
pub async fn list_languages(state: State<'_, AppState>) -> CmdResult<Vec<Lang>> {
    let _ = state;
    Ok(net::languages())
}
