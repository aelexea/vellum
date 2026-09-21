//! Vocab + SRS commands (§4.8 `vocab:`) — owned by B6.
//!
//! Thin wrappers over [`crate::db::vocab`]: take the `state.db` lock for the duration
//! of one short query, map `anyhow::Error` → `AppError` (§4.2), return the DTOs
//! unchanged. No `.await` inside a locked scope (§11.3) — `lookup_word` drops the lock
//! before calling the network layer.
//!
//! Note on `add_vocab_word`: §4.8 marks the args "all nullable opt args" — `word` itself
//! stays required (a vocab entry without a word is meaningless); everything else is
//! `Option` and defaults to null/empty when the caller omits it.

use tauri::State;

use crate::db::now_ms;
use crate::db::vocab as db_vocab;
use crate::db::vocab::{ReviewResult, VocabInput};
use crate::dto::{LookupContext, LookupResult, VocabPatch, VocabStats, VocabWord};
use crate::error::{AppError, CmdResult};
use crate::net;
use crate::state::AppState;

/// Short-lived db lock (§11.3). A poisoned mutex means another command panicked while
/// holding it — surface that as an error instead of panicking the async runtime.
fn lock_db(state: &AppState) -> CmdResult<std::sync::MutexGuard<'_, rusqlite::Connection>> {
    state
        .db
        .lock()
        .map_err(|_| AppError::msg("database is busy (lock poisoned)"))
}

/// Display form of a looked-up word for `LookupResult.word` when the network half
/// fails: trim + strip wrapping punctuation, case preserved (mirrors what
/// `net::normalize_word` puts in the success path).
fn display_lookup_word(word: &str) -> String {
    word.trim()
        .trim_matches(|c: char| !c.is_alphanumeric())
        .to_string()
}

// ---------------------------------------------------------------------------
// lookup_word (§4.6): db half (lookups upsert + suggest) → net half → merge
// ---------------------------------------------------------------------------

/// `&AppState` seam so the full command path (db + net + merge) is integration-testable
/// without a Tauri handle (`tauri::State` cannot be constructed in tests).
pub async fn lookup_word_impl(
    state: &AppState,
    word: String,
    context: Option<LookupContext>,
) -> CmdResult<LookupResult> {
    // 1. db half: upsert `lookups`, decide `suggest_add` (§4.6). Lock dropped before any
    //    await — the network call below must never hold the db mutex (§11.3).
    let outcome = {
        let threshold = state.settings.read().vocab.suggest_after_lookups;
        let c = lock_db(state)?;
        db_vocab::record_lookup(&c, &word, context.as_ref(), threshold, now_ms())?
    };

    // 2. net half (B7 §11.4): dict (when eligible) + translate(auto → targetLang).
    let net_result = net::lookup(state, &word, context.as_ref()).await;

    // 3. merge: db outcome always wins for the three counter fields. Network failure
    //    degrades to null translation/dictionary, never an error (B6 task spec; the UI
    //    renders "Translation unavailable" from the two nulls).
    let mut result = match net_result {
        Ok(mut r) => {
            // net::normalize_word strips punctuation but keeps case; keep whichever
            // non-empty display form net produced, fall back to our own.
            if r.word.trim().is_empty() {
                r.word = display_lookup_word(&word);
            }
            r
        }
        Err(_) => LookupResult {
            word: display_lookup_word(&word),
            translation: None,
            dictionary: None,
            lookup_count: 0,
            suggest_add: false,
            already_in_vocab: false,
        },
    };
    result.lookup_count = outcome.count;
    result.suggest_add = outcome.suggest_add;
    result.already_in_vocab = outcome.already_in_vocab;
    Ok(result)
}

#[tauri::command]
pub async fn lookup_word(
    state: State<'_, AppState>,
    word: String,
    context: Option<LookupContext>,
) -> CmdResult<LookupResult> {
    lookup_word_impl(&state, word, context).await
}

// ---------------------------------------------------------------------------
// CRUD (§4.8)
// ---------------------------------------------------------------------------

/// Newest first; `query` matches word/translation (LIKE), `dueOnly` keeps rows due by
/// now. See [`db_vocab::list_words`].
#[tauri::command]
pub async fn list_vocab(
    state: State<'_, AppState>,
    status: Option<String>,
    book_uid: Option<String>,
    query: Option<String>,
    due_only: bool,
) -> CmdResult<Vec<VocabWord>> {
    let c = lock_db(&state)?;
    Ok(db_vocab::list_words(
        &c,
        status.as_deref(),
        book_uid.as_deref(),
        query.as_deref(),
        due_only,
        now_ms(),
    )?)
}

/// `word_norm` conflict → the existing row merged with the newly provided non-null
/// fields (idempotent; see [`db_vocab::add_word`]). Invalid `status` strings are an
/// error rather than a silent default.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn add_vocab_word(
    state: State<'_, AppState>,
    word: String,
    translation: Option<String>,
    definition: Option<String>,
    transcription: Option<String>,
    pos: Option<String>,
    examples: Option<Vec<String>>,
    book_uid: Option<String>,
    chapter_idx: Option<i64>,
    context: Option<String>,
    context_cfi: Option<String>,
    status: Option<String>,
) -> CmdResult<VocabWord> {
    let status = match status {
        Some(s) => Some(
            db_vocab::parse_status(&s)
                .ok_or_else(|| AppError::msg(format!("invalid vocab status: {s}")))?,
        ),
        None => None,
    };
    let input = VocabInput {
        word,
        translation,
        definition,
        transcription,
        pos,
        examples: examples.unwrap_or_default(),
        book_uid,
        chapter_idx,
        context,
        context_cfi,
        status,
        added_at: None,
    };
    let c = lock_db(&state)?;
    Ok(db_vocab::add_word(&c, &input, now_ms())?)
}

/// Only the fields present in `patch` are updated (§4.8 `VocabPatch`); a patched
/// `status: 'known'` sticks (auto-transitions never override it).
#[tauri::command]
pub async fn update_vocab_word(
    state: State<'_, AppState>,
    id: i64,
    patch: VocabPatch,
) -> CmdResult<VocabWord> {
    let c = lock_db(&state)?;
    Ok(db_vocab::update_word(&c, id, &patch, now_ms())?)
}

#[tauri::command]
pub async fn delete_vocab_word(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let c = lock_db(&state)?;
    Ok(db_vocab::delete_word(&c, id)?)
}

// ---------------------------------------------------------------------------
// SRS review (§4.6)
// ---------------------------------------------------------------------------

/// `limit` defaults to `settings.vocab.dailyReviewLimit * 2` when null (§4.6).
#[tauri::command]
pub async fn get_review_queue(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> CmdResult<Vec<VocabWord>> {
    let limit = match limit {
        Some(l) if l > 0 => l,
        _ => {
            let daily = state.settings.read().vocab.daily_review_limit;
            i64::from(daily) * 2
        }
    };
    let c = lock_db(&state)?;
    Ok(db_vocab::get_queue(&c, limit, now_ms())?)
}

/// `result` ∈ again|hard|good|easy (§4.6 SM-2 lite); returns the word with its updated
/// SRS state (incl. the dto-v1.2 `ease`) and appends a `review_log` row.
#[tauri::command]
pub async fn record_review(
    state: State<'_, AppState>,
    id: i64,
    result: String,
) -> CmdResult<VocabWord> {
    let result = ReviewResult::parse(&result)
        .ok_or_else(|| AppError::msg(format!("invalid review result: {result}")))?;
    let c = lock_db(&state)?;
    Ok(db_vocab::record_review(&c, id, result, now_ms())?)
}

#[tauri::command]
pub async fn vocab_stats(state: State<'_, AppState>) -> CmdResult<VocabStats> {
    let c = lock_db(&state)?;
    Ok(db_vocab::stats(&c, now_ms())?)
}

// ---------------------------------------------------------------------------
// Export / import (§4.6)
// ---------------------------------------------------------------------------

/// Export json|csv|anki (§4.6) to `path`; returns the number of words written.
#[tauri::command]
pub async fn export_vocab(
    state: State<'_, AppState>,
    path: String,
    format: String,
) -> CmdResult<usize> {
    let words = {
        let c = lock_db(&state)?;
        db_vocab::all_words(&c)?
    };
    let body = match format.trim().to_ascii_lowercase().as_str() {
        "json" => db_vocab::export_json(&words)?,
        "csv" => db_vocab::export_csv(&words),
        "anki" => db_vocab::export_anki(&words),
        other => {
            return Err(AppError::msg(format!(
                "unknown export format: {other} (json|csv|anki)"
            )))
        }
    };
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    std::fs::write(&path, body)?;
    Ok(words.len())
}

/// Import json|csv best-effort (§4.6); returns the number of words upserted. §4.8 has
/// no format argument, so the content decides: JSON when the file starts with `[`/`{`,
/// CSV otherwise (see [`db_vocab::is_json_import`]).
#[tauri::command]
pub async fn import_vocab(state: State<'_, AppState>, path: String) -> CmdResult<usize> {
    let text = std::fs::read_to_string(&path)?;
    let c = lock_db(&state)?;
    let now = now_ms();
    if db_vocab::is_json_import(&text) {
        Ok(db_vocab::import_json(&c, &text, now)?)
    } else {
        Ok(db_vocab::import_csv(&c, &text, now)?)
    }
}
