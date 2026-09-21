//! lookups / vocab / review_log tables + SM-2 lite (§3, §4.4, §4.6) — owned by B6.
//!
//! All functions take an already-open [`Connection`] (commands hold the short-lived
//! `state.db` lock — §11.3) and return `anyhow::Result`, collapsed into `AppError` by
//! the command layer (§4.2).
//!
//! Testability design (B6): every time-dependent function takes an explicit
//! `now_ms: i64` (the command layer passes [`crate::db::now_ms`]), and the SM-2
//! scheduling core is the pure [`sm2_next`] — table-testable without a database.
//!
//! SRS rules (§4.6, SM-2 lite):
//! - again: due = now + 600 s (same-day requeue), interval resets to 10 min, ease −0.2
//! - hard: first review → 1 d, else interval × 1.2; ease −0.15
//! - good: first review → 1 d, else interval × ease
//! - easy: first review → 3 d, else interval × ease × 1.3; ease +0.15
//! - ease clamped to [1.3, 3.0]; review_count += 1; due_at = now + interval
//! - status: any review → 'learning'; interval ≥ 21 d → 'known';
//!   a user-set 'known' is never overridden by auto-transitions.

use rusqlite::{params, Connection, OptionalExtension, Row, ToSql};

use crate::dto::{
    LookupContext, VocabPatch, VocabStats, VocabStatus, VocabStatusCounts, VocabWord,
};

/// Milliseconds in a day.
pub const DAY_MS: i64 = 86_400_000;

/// 'again' requeue delay: 10 minutes (§4.6).
pub const AGAIN_DELAY_MS: i64 = 600_000;

/// 'again' interval expressed in days (what lands in `vocab.interval_days` /
/// `review_log.interval_after`).
pub const AGAIN_INTERVAL_DAYS: f64 = AGAIN_DELAY_MS as f64 / DAY_MS as f64;

/// Interval (days) at which a review auto-promotes a word to 'known' (§4.6).
pub const KNOWN_INTERVAL_DAYS: f64 = 21.0;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/// Normalize for matching (§4.4 `word_norm`): collapse internal whitespace runs to a
/// single space, strip surrounding non-alphanumeric characters (Unicode-aware: any
/// char that is not `is_alphanumeric`), then lowercase. `"«Привет,»"` → `"привет"`,
/// `"  Well-Known  "` → `"well-known"` (internal punctuation is kept).
pub fn normalize_word(w: &str) -> String {
    let collapsed = w.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c: char| !c.is_alphanumeric());
    trimmed.to_lowercase()
}

/// Display form stored in `vocab.word` / `lookups.word`: the raw input, trimmed only.
fn display_word(w: &str) -> String {
    w.trim().to_string()
}

// ---------------------------------------------------------------------------
// Status / review-result helpers
// ---------------------------------------------------------------------------

/// `VocabStatus` → the exact string the §4.4 CHECK constraint accepts.
pub fn status_str(s: VocabStatus) -> &'static str {
    match s {
        VocabStatus::New => "new",
        VocabStatus::Learning => "learning",
        VocabStatus::Known => "known",
    }
}

/// Parse a status string (case-insensitive); `None` when not one of new|learning|known.
pub fn parse_status(s: &str) -> Option<VocabStatus> {
    match s.trim().to_ascii_lowercase().as_str() {
        "new" => Some(VocabStatus::New),
        "learning" => Some(VocabStatus::Learning),
        "known" => Some(VocabStatus::Known),
        _ => None,
    }
}

/// Review grade (§4.6 `record_review(id, result)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewResult {
    Again,
    Hard,
    Good,
    Easy,
}

impl ReviewResult {
    /// Parse the wire value (case-insensitive); `None` for anything else.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "again" => Some(Self::Again),
            "hard" => Some(Self::Hard),
            "good" => Some(Self::Good),
            "easy" => Some(Self::Easy),
            _ => None,
        }
    }

    /// The string persisted in `review_log.result`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Again => "again",
            Self::Hard => "hard",
            Self::Good => "good",
            Self::Easy => "easy",
        }
    }
}

// ---------------------------------------------------------------------------
// SM-2 lite — pure scheduling core (§4.6)
// ---------------------------------------------------------------------------

/// Pure SM-2-lite step (§4.6). Returns
/// `(interval_days, ease, due_at_ms, status)` where status is the *auto* status
/// ('learning' / 'known'); the caller protects a user-set 'known' (see
/// [`record_review`]).
///
/// - `interval`: current `vocab.interval_days` (`None` → never successfully scheduled)
/// - `ease`: current ease factor
/// - `review_count`: count *before* this review
/// - `now_ms`: injected clock
///
/// Multipliers use the ease value *before* this review's adjustment (easy's +0.15
/// applies to the next review, per §4.6's ordering).
pub fn sm2_next(
    interval: Option<f64>,
    ease: f64,
    review_count: i64,
    result: ReviewResult,
    now_ms: i64,
) -> (f64, f64, i64, &'static str) {
    // A `None` interval with review_count > 0 should not happen; 1 day is the sane base.
    let prev = interval.unwrap_or(1.0);
    let first = review_count == 0;

    let (new_interval, ease_delta) = match result {
        ReviewResult::Again => (AGAIN_INTERVAL_DAYS, -0.2),
        ReviewResult::Hard => (if first { 1.0 } else { prev * 1.2 }, -0.15),
        ReviewResult::Good => (if first { 1.0 } else { prev * ease }, 0.0),
        ReviewResult::Easy => (if first { 3.0 } else { prev * ease * 1.3 }, 0.15),
    };

    let new_ease = (ease + ease_delta).clamp(1.3, 3.0);
    // 'again' is an exact +10 min requeue (not float-derived), per §4.6.
    let due_at = if result == ReviewResult::Again {
        now_ms + AGAIN_DELAY_MS
    } else {
        now_ms + (new_interval * DAY_MS as f64) as i64
    };
    let status = if new_interval >= KNOWN_INTERVAL_DAYS {
        "known"
    } else {
        "learning"
    };

    (new_interval, new_ease, due_at, status)
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

/// Column list shared by every vocab read (with the books LEFT JOIN for `book_title`).
const VOCAB_COLS: &str = "v.id, v.word, v.translation, v.definition, v.transcription, v.pos, \
     v.examples, v.book_uid, b.title, v.chapter_idx, v.context, v.context_cfi, v.added_at, \
     v.status, v.review_count, v.interval_days, v.ease, v.due_at, v.last_reviewed_at";

const VOCAB_FROM: &str = "FROM vocab v LEFT JOIN books b ON b.uid = v.book_uid";

fn row_to_vocab(row: &Row<'_>) -> rusqlite::Result<VocabWord> {
    let examples_json: String = row.get(6)?;
    let status_s: String = row.get(13)?;
    Ok(VocabWord {
        id: row.get(0)?,
        word: row.get(1)?,
        translation: row.get(2)?,
        definition: row.get(3)?,
        transcription: row.get(4)?,
        pos: row.get(5)?,
        // Broken JSON (hand-edited db) degrades to an empty list, never an error.
        examples: serde_json::from_str(&examples_json).unwrap_or_default(),
        book_uid: row.get(7)?,
        book_title: row.get(8)?,
        chapter_idx: row.get(9)?,
        context: row.get(10)?,
        context_cfi: row.get(11)?,
        added_at: row.get(12)?,
        status: parse_status(&status_s).unwrap_or_default(),
        review_count: row.get(14)?,
        interval_days: row.get(15)?,
        ease: row.get(16)?,
        due_at: row.get(17)?,
        last_reviewed_at: row.get(18)?,
    })
}

/// One word by id (with `book_title` join), or `None` when absent.
pub fn fetch_by_id(c: &Connection, id: i64) -> anyhow::Result<Option<VocabWord>> {
    let sql = format!("SELECT {VOCAB_COLS} {VOCAB_FROM} WHERE v.id = ?1");
    Ok(c.query_row(&sql, params![id], row_to_vocab).optional()?)
}

fn must_fetch(c: &Connection, id: i64) -> anyhow::Result<VocabWord> {
    fetch_by_id(c, id)?.ok_or_else(|| anyhow::anyhow!("vocab word {id} not found"))
}

/// One word by its normalized form (§4.4 `word_norm` UNIQUE).
pub fn find_by_norm(c: &Connection, word_norm: &str) -> anyhow::Result<Option<VocabWord>> {
    let sql = format!("SELECT {VOCAB_COLS} {VOCAB_FROM} WHERE v.word_norm = ?1");
    Ok(c.query_row(&sql, params![word_norm], row_to_vocab)
        .optional()?)
}

// ---------------------------------------------------------------------------
// lookups (§4.6 lookup_word db half)
// ---------------------------------------------------------------------------

/// Outcome of the db half of `lookup_word` (§4.6): the merged `lookups` counter plus
/// the suggest decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LookupOutcome {
    /// Total times this word (normalized) has been looked up, including this time.
    pub count: i64,
    /// `!already_in_vocab && count >= suggest_threshold`.
    pub suggest_add: bool,
    /// A `vocab` row with the same `word_norm` exists.
    pub already_in_vocab: bool,
}

/// Upsert `lookups` (+1 count, refresh `last_seen_at`; `last_book/chapter/context/cfi`
/// come from `ctx` — when `ctx` is `None` the previously stored context is *kept*, a
/// contextless lookup must not wipe the last useful one). Then decide `suggest_add`
/// per §4.6: never for words already in vocab, else once `count >= suggest_threshold`.
pub fn record_lookup(
    c: &Connection,
    word: &str,
    ctx: Option<&LookupContext>,
    suggest_threshold: u32,
    now_ms: i64,
) -> anyhow::Result<LookupOutcome> {
    let word_norm = normalize_word(word);
    anyhow::ensure!(!word_norm.is_empty(), "empty lookup word");
    let display = display_word(word);

    let (last_book, last_chapter, last_context, last_cfi): (
        Option<&str>,
        Option<i64>,
        Option<&str>,
        Option<&str>,
    ) = match ctx {
        Some(x) => (
            Some(x.book_uid.as_str()),
            Some(x.chapter_idx),
            Some(x.sentence.as_str()),
            Some(x.cfi.as_str()),
        ),
        None => (None, None, None, None),
    };

    c.execute(
        "INSERT INTO lookups(word_norm, word, count, last_seen_at, \
           last_book, last_chapter, last_context, last_cfi) \
         VALUES(?1, ?2, 1, ?3, ?4, ?5, ?6, ?7) \
         ON CONFLICT(word_norm) DO UPDATE SET \
           word = excluded.word, \
           count = count + 1, \
           last_seen_at = excluded.last_seen_at, \
           last_book = COALESCE(excluded.last_book, lookups.last_book), \
           last_chapter = COALESCE(excluded.last_chapter, lookups.last_chapter), \
           last_context = COALESCE(excluded.last_context, lookups.last_context), \
           last_cfi = COALESCE(excluded.last_cfi, lookups.last_cfi)",
        params![
            word_norm,
            display,
            now_ms,
            last_book,
            last_chapter,
            last_context,
            last_cfi
        ],
    )?;

    let (count, in_vocab): (i64, i64) = c.query_row(
        "SELECT (SELECT count FROM lookups WHERE word_norm = ?1), \
                (SELECT COUNT(*) FROM vocab WHERE word_norm = ?1)",
        params![word_norm],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let already_in_vocab = in_vocab > 0;

    Ok(LookupOutcome {
        count,
        suggest_add: !already_in_vocab && count >= i64::from(suggest_threshold),
        already_in_vocab,
    })
}

// ---------------------------------------------------------------------------
// vocab CRUD
// ---------------------------------------------------------------------------

/// Input for [`add_word`] (the `add_vocab_word` command args, §4.8).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct VocabInput {
    pub word: String,
    pub translation: Option<String>,
    pub definition: Option<String>,
    pub transcription: Option<String>,
    pub pos: Option<String>,
    pub examples: Vec<String>,
    pub book_uid: Option<String>,
    pub chapter_idx: Option<i64>,
    pub context: Option<String>,
    pub context_cfi: Option<String>,
    /// `None` → 'new' (§4.4 default).
    pub status: Option<VocabStatus>,
    /// Preserve the original `addedAt` on import; `None` → `now_ms`.
    pub added_at: Option<i64>,
}

/// Fill-if-empty merge (translation-like fields): a present non-empty current value
/// wins; otherwise a non-empty new value replaces it.
fn fill_if_empty(cur: Option<String>, new: Option<String>) -> Option<String> {
    let cur_empty = cur.as_ref().is_none_or(|s| s.trim().is_empty());
    if cur_empty {
        new.filter(|s| !s.trim().is_empty()).or(cur)
    } else {
        cur
    }
}

/// Newest-non-null merge (context-like fields): a non-empty new value overwrites.
fn newest(cur: Option<String>, new: Option<String>) -> Option<String> {
    new.filter(|s| !s.trim().is_empty()).or(cur)
}

/// Add a word (§4.6). New row: `added_at = now_ms` (or the preserved import value),
/// `status` per arg or 'new', `due_at = now_ms` (immediately reviewable),
/// `interval_days` NULL, `ease` 2.5.
///
/// `word_norm` UNIQUE conflict → **idempotent merge**: the existing row is returned,
/// updated with the newly provided non-null fields — translation-like fields
/// (translation/definition/transcription/pos) only *fill empties*, context-like fields
/// (context/book/chapter/cfi/examples/display word) are overwritten with the newest
/// non-empty value. SRS state (status/ease/interval/due/review_count/added_at) is never
/// touched by a merge — use [`update_word`] for that.
pub fn add_word(c: &Connection, input: &VocabInput, now_ms: i64) -> anyhow::Result<VocabWord> {
    let word_norm = normalize_word(&input.word);
    anyhow::ensure!(!word_norm.is_empty(), "word is empty");
    let display = display_word(&input.word);

    if let Some(existing) = find_by_norm(c, &word_norm)? {
        let examples = if input.examples.is_empty() {
            existing.examples.clone()
        } else {
            input.examples.clone()
        };
        let chapter_idx = input.chapter_idx.or(existing.chapter_idx);
        c.execute(
            "UPDATE vocab SET word=?1, translation=?2, definition=?3, transcription=?4, \
               pos=?5, examples=?6, book_uid=?7, chapter_idx=?8, context=?9, context_cfi=?10 \
             WHERE id=?11",
            params![
                display,
                fill_if_empty(existing.translation.clone(), input.translation.clone()),
                fill_if_empty(existing.definition.clone(), input.definition.clone()),
                fill_if_empty(existing.transcription.clone(), input.transcription.clone()),
                fill_if_empty(existing.pos.clone(), input.pos.clone()),
                serde_json::to_string(&examples)?,
                newest(existing.book_uid.clone(), input.book_uid.clone()),
                chapter_idx,
                newest(existing.context.clone(), input.context.clone()),
                newest(existing.context_cfi.clone(), input.context_cfi.clone()),
                existing.id,
            ],
        )?;
        return must_fetch(c, existing.id);
    }

    let status = status_str(input.status.unwrap_or_default());
    let added_at = input.added_at.unwrap_or(now_ms);
    let examples = serde_json::to_string(&input.examples)?;
    c.execute(
        "INSERT INTO vocab(word, word_norm, translation, definition, transcription, pos, \
           examples, book_uid, chapter_idx, context, context_cfi, added_at, status, \
           review_count, ease, interval_days, due_at, last_reviewed_at) \
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13, 0, 2.5, NULL, ?14, NULL)",
        params![
            display,
            word_norm,
            input.translation,
            input.definition,
            input.transcription,
            input.pos,
            examples,
            input.book_uid,
            input.chapter_idx,
            input.context,
            input.context_cfi,
            added_at,
            status,
            now_ms, // due_at: immediately reviewable (§4.6 task spec)
        ],
    )?;
    must_fetch(c, c.last_insert_rowid())
}

/// Apply a [`VocabPatch`] (§4.8: only present fields are updated) and return the row.
/// A patched `status = 'known'` is user-set and sticks — [`record_review`] never
/// overrides it. Missing id → `Err`. `now_ms` is unused (the table has no updated_at);
/// it is kept for signature uniformity with the other time-injected fns.
pub fn update_word(
    c: &Connection,
    id: i64,
    patch: &VocabPatch,
    _now_ms: i64,
) -> anyhow::Result<VocabWord> {
    let mut sets: Vec<&str> = Vec::new();
    let mut values: Vec<Box<dyn ToSql>> = Vec::new();

    macro_rules! set {
        ($col:literal, $val:expr) => {
            if let Some(v) = $val {
                sets.push(concat!($col, " = ?"));
                values.push(Box::new(v));
            }
        };
    }
    set!("translation", patch.translation.clone());
    set!("definition", patch.definition.clone());
    set!("transcription", patch.transcription.clone());
    set!("pos", patch.pos.clone());
    set!("context", patch.context.clone());
    set!("due_at", patch.due_at);
    if let Some(status) = patch.status {
        sets.push("status = ?");
        values.push(Box::new(status_str(status).to_owned()));
    }
    if let Some(examples) = &patch.examples {
        sets.push("examples = ?");
        values.push(Box::new(serde_json::to_string(examples)?));
    }

    if !sets.is_empty() {
        let sql = format!("UPDATE vocab SET {} WHERE id = ?", sets.join(", "));
        values.push(Box::new(id));
        let refs: Vec<&dyn ToSql> = values.iter().map(|b| b.as_ref()).collect();
        let changed = c.execute(&sql, refs.as_slice())?;
        if changed == 0 {
            anyhow::bail!("vocab word {id} not found");
        }
    } else if fetch_by_id(c, id)?.is_none() {
        anyhow::bail!("vocab word {id} not found");
    }
    must_fetch(c, id)
}

/// Delete a word and its `review_log` rows (§4.4 has no FK cascade). Idempotent:
/// deleting a missing id is `Ok`.
pub fn delete_word(c: &Connection, id: i64) -> anyhow::Result<()> {
    let tx = c.unchecked_transaction()?;
    tx.execute("DELETE FROM review_log WHERE vocab_id = ?1", params![id])?;
    tx.execute("DELETE FROM vocab WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// Escape LIKE wildcards so a user query matches literally (`ESCAPE '\'`).
fn escape_like(q: &str) -> String {
    let mut out = String::with_capacity(q.len());
    for ch in q.chars() {
        match ch {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// List/filter words (§4.8 `list_vocab`), newest first.
///
/// - `query` matches `word` / `word_norm` / `translation` via LIKE (wildcards escaped).
///   The pattern is lowercased and matched against `word_norm` too, which makes the
///   search case-insensitive for **all** scripts (SQLite's LIKE is ASCII-only
///   case-insensitive; `word_norm` is stored lowercased).
/// - `due_only` keeps rows with `due_at <= now_ms`.
pub fn list_words(
    c: &Connection,
    status: Option<&str>,
    book_uid: Option<&str>,
    query: Option<&str>,
    due_only: bool,
    now_ms: i64,
) -> anyhow::Result<Vec<VocabWord>> {
    let status = status.filter(|s| !s.trim().is_empty());
    let book_uid = book_uid.filter(|s| !s.trim().is_empty());
    let like = query
        .filter(|q| !q.trim().is_empty())
        .map(|q| format!("%{}%", escape_like(&q.to_lowercase())));

    let sql = format!(
        "SELECT {VOCAB_COLS} {VOCAB_FROM} \
         WHERE (?1 IS NULL OR v.status = ?1) \
           AND (?2 IS NULL OR v.book_uid = ?2) \
           AND (?3 IS NULL OR v.word LIKE ?3 ESCAPE '\\' \
                OR v.word_norm LIKE ?3 ESCAPE '\\' \
                OR v.translation LIKE ?3 ESCAPE '\\') \
           AND (?4 = 0 OR (v.due_at IS NOT NULL AND v.due_at <= ?5)) \
         ORDER BY v.added_at DESC, v.id DESC"
    );
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(
        params![status, book_uid, like, due_only, now_ms],
        row_to_vocab,
    )?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Every word, newest first — the export source (§4.6).
pub fn all_words(c: &Connection) -> anyhow::Result<Vec<VocabWord>> {
    list_words(c, None, None, None, false, 0)
}

// ---------------------------------------------------------------------------
// SRS queue + review (§4.6)
// ---------------------------------------------------------------------------

/// Review queue (§4.6): new words without a schedule first, then everything due
/// (oldest first); user-'known' words are never queued.
/// `WHERE (status='new' AND due_at IS NULL) OR (due_at <= now AND status != 'known')`
/// `ORDER BY (due_at IS NULL) DESC, due_at ASC LIMIT ?`.
pub fn get_queue(c: &Connection, limit: i64, now_ms: i64) -> anyhow::Result<Vec<VocabWord>> {
    let sql = format!(
        "SELECT {VOCAB_COLS} {VOCAB_FROM} \
         WHERE (v.status = 'new' AND v.due_at IS NULL) \
            OR (v.due_at IS NOT NULL AND v.due_at <= ?1 AND v.status != 'known') \
         ORDER BY (v.due_at IS NULL) DESC, v.due_at ASC, v.id ASC \
         LIMIT ?2"
    );
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(params![now_ms, limit], row_to_vocab)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Grade one review (§4.6 SM-2 lite) via the pure [`sm2_next`], persist the new SRS
/// state, append the `review_log` row, and return the updated word (with the updated
/// `ease` — dto v1.2). A user-set `status = 'known'` sticks: auto-transitions never
/// override it (the SRS fields are still updated and logged). Missing id → `Err`.
pub fn record_review(
    c: &Connection,
    id: i64,
    result: ReviewResult,
    now_ms: i64,
) -> anyhow::Result<VocabWord> {
    let row: Option<(f64, Option<f64>, i64, String)> = c
        .query_row(
            "SELECT ease, interval_days, review_count, status FROM vocab WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let (ease, interval, review_count, status_s) =
        row.ok_or_else(|| anyhow::anyhow!("vocab word {id} not found"))?;

    let (new_interval, new_ease, due_at, auto_status) =
        sm2_next(interval, ease, review_count, result, now_ms);
    // §4.6: never downgrade a user-set 'known'.
    let new_status = if status_s == "known" {
        "known"
    } else {
        auto_status
    };

    let tx = c.unchecked_transaction()?;
    tx.execute(
        "UPDATE vocab SET ease=?1, interval_days=?2, due_at=?3, review_count=?4, \
           status=?5, last_reviewed_at=?6 \
         WHERE id=?7",
        params![
            new_ease,
            new_interval,
            due_at,
            review_count + 1,
            new_status,
            now_ms,
            id
        ],
    )?;
    tx.execute(
        "INSERT INTO review_log(vocab_id, at, result, interval_after) VALUES(?1,?2,?3,?4)",
        params![id, now_ms, result.as_str(), new_interval],
    )?;
    tx.commit()?;

    must_fetch(c, id)
}

// ---------------------------------------------------------------------------
// Stats (§4.8 vocab_stats)
// ---------------------------------------------------------------------------

/// Start of the *local* day containing `now_ms`, as unix ms. Uses the cached local
/// UTC offset from [`crate::db::local_offset_minutes`] (same source as `db::today_str`,
/// no chrono) — documented choice for `reviewsToday`.
pub fn local_day_start_ms(now_ms: i64) -> i64 {
    let offset = i64::from(crate::db::local_offset_minutes()) * 60_000;
    (now_ms + offset).div_euclid(DAY_MS) * DAY_MS - offset
}

/// Vocab dashboard numbers (§4.8 `vocab_stats`).
///
/// Documented choices:
/// - `dueToday`: rolling 24 h window (`due_at <= now + 1 d`, excluding 'known') **plus**
///   unscheduled new words — i.e. exactly what [`get_queue`] would return today, so the
///   UI badge matches the review session count.
/// - `reviewsToday`: `review_log.at >= ` start of the *local* day (see
///   [`local_day_start_ms`]).
/// - `addedThisWeek`: `added_at >= now − 7 d` (rolling).
pub fn stats(c: &Connection, now_ms: i64) -> anyhow::Result<VocabStats> {
    let total: i64 = c.query_row("SELECT COUNT(*) FROM vocab", [], |r| r.get(0))?;

    let mut by_status = VocabStatusCounts {
        new: 0,
        learning: 0,
        known: 0,
    };
    {
        let mut stmt = c.prepare("SELECT status, COUNT(*) FROM vocab GROUP BY status")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (s, n) = row?;
            match parse_status(&s) {
                Some(VocabStatus::New) => by_status.new = n,
                Some(VocabStatus::Learning) => by_status.learning = n,
                Some(VocabStatus::Known) => by_status.known = n,
                None => {}
            }
        }
    }

    let due_today: i64 = c.query_row(
        "SELECT COUNT(*) FROM vocab \
         WHERE (due_at IS NOT NULL AND due_at <= ?1 AND status != 'known') \
            OR (status = 'new' AND due_at IS NULL)",
        params![now_ms + DAY_MS],
        |r| r.get(0),
    )?;

    let reviews_today: i64 = c.query_row(
        "SELECT COUNT(*) FROM review_log WHERE at >= ?1",
        params![local_day_start_ms(now_ms)],
        |r| r.get(0),
    )?;

    let added_this_week: i64 = c.query_row(
        "SELECT COUNT(*) FROM vocab WHERE added_at >= ?1",
        params![now_ms - 7 * DAY_MS],
        |r| r.get(0),
    )?;

    Ok(VocabStats {
        total,
        by_status,
        due_today,
        reviews_today,
        added_this_week,
    })
}

// ---------------------------------------------------------------------------
// Export / import (§4.6) — pure string builders + best-effort parsers
// ---------------------------------------------------------------------------

/// JSON export: the full `VocabWord[]`, pretty-printed, camelCase (dto convention;
/// includes the dto-v1.2 `ease` field automatically).
pub fn export_json(words: &[VocabWord]) -> anyhow::Result<String> {
    Ok(serde_json::to_string_pretty(words)?)
}

/// Howard Hinnant's public-domain `civil_from_days` (same helper as `db/mod.rs`, which
/// keeps its copy private): days since 1970-01-01 → (year, month, day).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], Mar=0
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// `due_at` (unix ms) → local `yyyy-mm-dd` for the CSV column (documented choice:
/// local date via the same cached offset as `db::today_str`).
pub fn due_date(ms: i64) -> String {
    let offset = i64::from(crate::db::local_offset_minutes()) * 60_000;
    let (y, m, d) = civil_from_days((ms + offset).div_euclid(DAY_MS));
    format!("{y:04}-{m:02}-{d:02}")
}

/// Quote-aware CSV field escaping: fields containing `;`, `"` or a newline are wrapped
/// in quotes with internal quotes doubled (RFC-4180 style, `;` separator).
fn csv_field(s: &str) -> String {
    if s.contains([';', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_owned()
    }
}

/// CSV export (§4.6): UTF-8 **BOM** + header `word;translation;definition;status;
/// due_at;book;context`, `;`-separated, `due_at` as a local `yyyy-mm-dd` date (empty
/// when unscheduled), `book` = book title (falls back to the uid). `\n` line endings.
pub fn export_csv(words: &[VocabWord]) -> String {
    let mut out = String::from("\u{feff}word;translation;definition;status;due_at;book;context\n");
    for w in words {
        let book = w
            .book_title
            .as_deref()
            .filter(|t| !t.is_empty())
            .or(w.book_uid.as_deref())
            .unwrap_or("");
        let due = w.due_at.map(due_date).unwrap_or_default();
        let fields = [
            csv_field(&w.word),
            csv_field(w.translation.as_deref().unwrap_or("")),
            csv_field(w.definition.as_deref().unwrap_or("")),
            csv_field(status_str(w.status)),
            csv_field(&due),
            csv_field(book),
            csv_field(w.context.as_deref().unwrap_or("")),
        ];
        out.push_str(&fields.join(";"));
        out.push('\n');
    }
    out
}

/// Anki tab-separated export (§4.6): `word<TAB>translation — definition<br>context`.
/// Missing parts are dropped (no empty "—" or dangling `<br>`); tabs/newlines inside
/// any field become spaces so the two-column format survives.
pub fn export_anki(words: &[VocabWord]) -> String {
    fn sanitize(s: &str) -> String {
        s.chars()
            .map(|c| match c {
                '\t' | '\n' | '\r' => ' ',
                _ => c,
            })
            .collect()
    }
    let mut out = String::new();
    for w in words {
        let head = [w.translation.as_deref(), w.definition.as_deref()]
            .into_iter()
            .flatten()
            .filter(|s| !s.trim().is_empty())
            .map(sanitize)
            .collect::<Vec<_>>()
            .join(" — ");
        let mut back = head;
        if let Some(ctx) = w.context.as_deref().filter(|s| !s.trim().is_empty()) {
            if !back.is_empty() {
                back.push_str("<br>");
            }
            back.push_str(&sanitize(ctx));
        }
        out.push_str(&sanitize(&w.word));
        out.push('\t');
        out.push_str(&back);
        out.push('\n');
    }
    out
}

/// Strip a leading run of whitespace and UTF-8 BOM, in any order. Handles a BOM that
/// is preceded by stray whitespace (hand-edited exports), which a plain `strip_prefix`
/// at byte 0 would miss. Returns the remaining slice.
fn lstrip_bom(text: &str) -> &str {
    let mut t = text;
    loop {
        let trimmed = t.trim_start();
        match trimmed.strip_prefix('\u{feff}') {
            Some(rest) => t = rest,
            None => return trimmed,
        }
    }
}

/// Split CSV text into records with a quote state machine: `;` separates fields,
/// `\n` ends a record, quoted fields may contain both (`""` = a literal quote).
/// A leading UTF-8 BOM is stripped; `\r` is dropped; fully-empty records are skipped.
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let text = lstrip_bom(text);
    let mut records: Vec<Vec<String>> = Vec::new();
    let mut record: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = text.chars().peekable();

    while let Some(ch) = chars.next() {
        if in_quotes {
            match ch {
                '"' => {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        field.push('"');
                    } else {
                        in_quotes = false;
                    }
                }
                _ => field.push(ch),
            }
        } else {
            match ch {
                '"' => in_quotes = true,
                ';' => record.push(std::mem::take(&mut field)),
                '\n' => {
                    record.push(std::mem::take(&mut field));
                    records.push(std::mem::take(&mut record));
                }
                '\r' => {} // CRLF: the '\n' ends the record
                _ => field.push(ch),
            }
        }
    }
    if !field.is_empty() || !record.is_empty() {
        record.push(field);
        records.push(record);
    }
    records.retain(|r| !(r.len() == 1 && r[0].trim().is_empty()));
    records
}

/// JSON import (§4.6, best-effort): a `VocabWord[]` array (what [`export_json`]
/// writes); broken entries (non-objects, missing/empty `word`) are skipped, every other
/// entry is upserted with [`add_word`] semantics (`addedAt` is preserved when present;
/// SRS state of *new* rows follows add_word defaults). Returns the upserted count.
pub fn import_json(c: &Connection, text: &str, now_ms: i64) -> anyhow::Result<usize> {
    let value: serde_json::Value = serde_json::from_str(lstrip_bom(text))?;
    let entries = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("expected a JSON array of vocab words"))?;

    let mut count = 0usize;
    for entry in entries {
        let Some(obj) = entry.as_object() else {
            continue;
        };
        let Some(word) = obj
            .get("word")
            .and_then(|v| v.as_str())
            .filter(|w| !w.trim().is_empty())
        else {
            continue; // broken entry → skip
        };
        let str_field = |key: &str| {
            obj.get(key)
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
        };
        let input = VocabInput {
            word: word.to_owned(),
            translation: str_field("translation"),
            definition: str_field("definition"),
            transcription: str_field("transcription"),
            pos: str_field("pos"),
            examples: obj
                .get("examples")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            book_uid: str_field("bookUid"),
            chapter_idx: obj.get("chapterIdx").and_then(|v| v.as_i64()),
            context: str_field("context"),
            context_cfi: str_field("contextCfi"),
            status: obj
                .get("status")
                .and_then(|v| v.as_str())
                .and_then(parse_status),
            added_at: obj.get("addedAt").and_then(|v| v.as_i64()),
        };
        if add_word(c, &input, now_ms).is_ok() {
            count += 1;
        }
    }
    Ok(count)
}

/// CSV import (§4.6, best-effort): [`parse_csv`] records in the [`export_csv`] column
/// order (`word;translation;definition;status;due_at;book;context`); a `word` header
/// row is detected and skipped, broken lines (empty word) are skipped. The `due_at`
/// and `book` columns are informational only on import — add_word semantics re-due the
/// word to `now_ms` and a title cannot be resolved back to a uid reliably. Returns the
/// upserted count.
pub fn import_csv(c: &Connection, text: &str, now_ms: i64) -> anyhow::Result<usize> {
    let records = parse_csv(text);
    let mut count = 0usize;
    for (i, rec) in records.iter().enumerate() {
        if i == 0 && rec.first().map(|s| s.trim()) == Some("word") {
            continue; // header
        }
        let field = |idx: usize| rec.get(idx).filter(|s| !s.trim().is_empty()).cloned();
        let Some(word) = field(0) else { continue }; // broken line → skip
        let input = VocabInput {
            word,
            translation: field(1),
            definition: field(2),
            status: field(3).and_then(|s| parse_status(&s)),
            context: field(6),
            ..Default::default()
        };
        if add_word(c, &input, now_ms).is_ok() {
            count += 1;
        }
    }
    Ok(count)
}

/// Import dispatch helper: JSON when the (BOM-stripped, trimmed) text starts with
/// `[` or `{`, CSV otherwise. Used by the `import_vocab` command (§4.8 has no format
/// argument, so the content decides).
pub fn is_json_import(text: &str) -> bool {
    let t = lstrip_bom(text);
    t.starts_with('[') || t.starts_with('{')
}

// ---------------------------------------------------------------------------
// Unit tests — pure layer (no DB). DB-backed tests: tests/b6_vocab_srs.rs.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed clock for deterministic assertions.
    const NOW: i64 = 1_789_948_800_000; // 2026-09-21T00:00:00Z

    #[test]
    fn b6_normalize_word_table() {
        // (input, expected) — punctuation / case / whitespace / cyrillic
        let cases = [
            ("Hello", "hello"),
            ("  spaced  ", "spaced"),
            ("«Привет,»", "привет"),
            ("\"monster,\"", "monster"),
            ("...word!!!", "word"),
            ("(x)", "x"),
            ("Don't", "don't"), // internal punctuation kept
            ("well-known", "well-known"),
            ("多 字", "多 字"), // CJK: alphanumeric chars kept, space collapsed
            ("A\tB\n C ", "a b c"), // internal whitespace collapsed to single spaces
            ("'quoted'", "quoted"),
            ("123", "123"),
        ];
        for (input, want) in cases {
            assert_eq!(normalize_word(input), want, "input {input:?}");
        }
    }

    #[test]
    fn b6_normalize_word_edges() {
        assert_eq!(normalize_word(""), "");
        assert_eq!(normalize_word("   "), "");
        assert_eq!(normalize_word("…!?—-,"), ""); // all punctuation
        assert_eq!(normalize_word("Ünïcödé"), "ünïcödé");
    }

    #[test]
    fn b6_sm2_first_good() {
        // new word (no interval, rc=0) + good → 1 day, ease untouched, learning
        let (interval, ease, due, status) = sm2_next(None, 2.5, 0, ReviewResult::Good, NOW);
        assert_eq!(interval, 1.0);
        assert_eq!(ease, 2.5);
        assert_eq!(due, NOW + DAY_MS);
        assert_eq!(status, "learning");
    }

    #[test]
    fn b6_sm2_good_multiplies_by_ease() {
        // second good: interval × ease = 1.0 × 2.5
        let (interval, ease, due, status) = sm2_next(Some(1.0), 2.5, 1, ReviewResult::Good, NOW);
        assert!((interval - 2.5).abs() < 1e-9);
        assert_eq!(ease, 2.5);
        assert_eq!(due, NOW + (2.5 * DAY_MS as f64) as i64);
        assert_eq!(status, "learning");
    }

    #[test]
    fn b6_sm2_first_easy_is_three_days() {
        let (interval, ease, due, status) = sm2_next(None, 2.5, 0, ReviewResult::Easy, NOW);
        assert_eq!(interval, 3.0);
        assert!((ease - 2.65).abs() < 1e-9, "ease +0.15");
        assert_eq!(due, NOW + 3 * DAY_MS);
        assert_eq!(status, "learning");
    }

    #[test]
    fn b6_sm2_again_requeues_in_ten_minutes() {
        let (interval, ease, due, status) = sm2_next(Some(5.0), 2.5, 3, ReviewResult::Again, NOW);
        assert!((interval - AGAIN_INTERVAL_DAYS).abs() < 1e-12);
        assert!((ease - 2.3).abs() < 1e-9, "ease −0.2");
        assert_eq!(due, NOW + 600_000, "exactly +10 min");
        assert_eq!(status, "learning");
    }

    #[test]
    fn b6_sm2_hard_first_and_multiplied() {
        // first hard → 1 day, ease −0.15
        let (interval, ease, _, _) = sm2_next(None, 2.5, 0, ReviewResult::Hard, NOW);
        assert_eq!(interval, 1.0);
        assert!((ease - 2.35).abs() < 1e-9);
        // subsequent hard → interval × 1.2
        let (interval, _, due, _) = sm2_next(Some(2.0), 2.35, 2, ReviewResult::Hard, NOW);
        assert!((interval - 2.4).abs() < 1e-9);
        assert_eq!(due, NOW + (2.4 * DAY_MS as f64) as i64);
    }

    #[test]
    fn b6_sm2_easy_uses_pre_increment_ease() {
        // interval × ease × 1.3 with the OLD ease, then ease += 0.15
        let (interval, ease, _, _) = sm2_next(Some(4.0), 2.0, 2, ReviewResult::Easy, NOW);
        assert!((interval - 4.0 * 2.0 * 1.3).abs() < 1e-9);
        assert!((ease - 2.15).abs() < 1e-9);
    }

    #[test]
    fn b6_sm2_ease_clamped_both_ends() {
        // floor 1.3 after many hard/again grades
        let (_, ease, _, _) = sm2_next(Some(1.0), 1.35, 5, ReviewResult::Hard, NOW);
        assert!((ease - 1.3).abs() < 1e-9, "clamps at 1.3, got {ease}");
        let (_, ease, _, _) = sm2_next(Some(1.0), 1.3, 5, ReviewResult::Again, NOW);
        assert!((ease - 1.3).abs() < 1e-9, "floor holds");
        // ceiling 3.0 after many easy grades
        let (_, ease, _, _) = sm2_next(Some(1.0), 2.95, 5, ReviewResult::Easy, NOW);
        assert!((ease - 3.0).abs() < 1e-9, "clamps at 3.0, got {ease}");
        let (_, ease, _, _) = sm2_next(Some(1.0), 3.0, 6, ReviewResult::Easy, NOW);
        assert!((ease - 3.0).abs() < 1e-9, "ceiling holds");
    }

    #[test]
    fn b6_sm2_known_threshold_at_21_days() {
        // interval ≥ 21 d → 'known'
        let (interval, _, _, status) = sm2_next(Some(10.0), 2.5, 4, ReviewResult::Good, NOW);
        assert!((interval - 25.0).abs() < 1e-9);
        assert_eq!(status, "known");
        // just below stays 'learning'
        let (_, _, _, status) = sm2_next(Some(8.0), 2.5, 4, ReviewResult::Good, NOW);
        assert_eq!(status, "learning"); // 20.0 < 21
                                        // exactly 21 → known
        let (_, _, _, status) = sm2_next(Some(8.4), 2.5, 4, ReviewResult::Good, NOW);
        assert_eq!(status, "known"); // 21.0
    }

    #[test]
    fn b6_review_result_parse_and_wire() {
        for (s, r) in [
            ("again", ReviewResult::Again),
            ("HARD", ReviewResult::Hard),
            (" good ", ReviewResult::Good),
            ("Easy", ReviewResult::Easy),
        ] {
            assert_eq!(ReviewResult::parse(s), Some(r));
            assert_eq!(ReviewResult::parse(s).unwrap().as_str(), r.as_str());
        }
        assert_eq!(ReviewResult::parse("great"), None);
        assert_eq!(ReviewResult::parse(""), None);
    }

    #[test]
    fn b6_status_parse_roundtrip() {
        for s in [VocabStatus::New, VocabStatus::Learning, VocabStatus::Known] {
            assert_eq!(parse_status(status_str(s)), Some(s));
        }
        assert_eq!(parse_status("KNOWN"), Some(VocabStatus::Known));
        assert_eq!(parse_status("bogus"), None);
    }

    fn sample_words() -> Vec<VocabWord> {
        vec![
            VocabWord {
                id: 1,
                word: "monster".into(),
                translation: Some("чудовище".into()),
                definition: Some("a scary creature".into()),
                transcription: Some("/ˈmɒn.stər/".into()),
                pos: Some("noun".into()),
                examples: vec!["Frankenstein's monster".into()],
                book_uid: Some("uid1".into()),
                book_title: Some("Frankenstein".into()),
                chapter_idx: Some(4),
                context: Some("The monster; it lived".into()),
                context_cfi: Some("epubcfi(/4/2)".into()),
                added_at: NOW,
                status: VocabStatus::Learning,
                review_count: 2,
                interval_days: Some(2.5),
                ease: 2.35,
                due_at: Some(NOW + 2 * DAY_MS),
                last_reviewed_at: Some(NOW - DAY_MS),
            },
            VocabWord {
                id: 2,
                word: "слово".into(),
                translation: None,
                definition: None,
                transcription: None,
                pos: None,
                examples: vec![],
                book_uid: None,
                book_title: None,
                chapter_idx: None,
                context: None,
                context_cfi: None,
                added_at: NOW - DAY_MS,
                status: VocabStatus::New,
                review_count: 0,
                interval_days: None,
                ease: 2.5,
                due_at: None,
                last_reviewed_at: None,
            },
        ]
    }

    #[test]
    fn b6_export_json_is_pretty_camel_and_has_ease() {
        let json = export_json(&sample_words()).unwrap();
        assert!(json.contains('\n'), "pretty-printed");
        // camelCase keys + the dto-v1.2 ease field
        for key in [
            "\"id\"",
            "\"word\"",
            "\"bookUid\"",
            "\"bookTitle\"",
            "\"contextCfi\"",
            "\"addedAt\"",
            "\"reviewCount\"",
            "\"intervalDays\"",
            "\"ease\"",
            "\"dueAt\"",
            "\"lastReviewedAt\"",
        ] {
            assert!(json.contains(key), "missing {key}");
        }
        assert!(json.contains("\"ease\": 2.35"));
        // exact roundtrip through serde
        let back: Vec<VocabWord> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, sample_words());
    }

    #[test]
    fn b6_export_csv_format_and_escaping() {
        let csv = export_csv(&sample_words());
        assert!(csv.starts_with('\u{feff}'), "UTF-8 BOM");
        let body = csv.strip_prefix('\u{feff}').unwrap();
        let mut lines = body.lines();
        assert_eq!(
            lines.next().unwrap(),
            "word;translation;definition;status;due_at;book;context"
        );
        // row 1: ';' inside context → quoted; book = title
        let row1 = lines.next().unwrap();
        assert!(row1.starts_with("monster;чудовище;a scary creature;learning;"));
        assert!(
            row1.ends_with(";Frankenstein;\"The monster; it lived\""),
            "{row1}"
        );
        // due_at rendered as a yyyy-mm-dd date
        let due_field = row1.split(';').nth(4).unwrap();
        assert_eq!(due_field.len(), 10);
        assert_eq!(due_field.chars().nth(4), Some('-'));
        // row 2: nulls → empty fields, no due date
        let row2 = lines.next().unwrap();
        assert_eq!(row2, "слово;;;new;;;");
        assert!(lines.next().is_none());
    }

    #[test]
    fn b6_csv_field_quoting_rules() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("with;semi"), "\"with;semi\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("line\nbreak"), "\"line\nbreak\"");
        assert_eq!(csv_field(""), "");
    }

    #[test]
    fn b6_parse_csv_state_machine() {
        let text = "\u{feff}word;translation\n\
                    \"semi;colon\";\"quote\"\"inside\"\n\
                    \"multi\nline\";ok\n\
                    plain;row\n";
        let recs = parse_csv(text);
        assert_eq!(recs.len(), 4);
        assert_eq!(recs[0], vec!["word", "translation"]);
        assert_eq!(recs[1], vec!["semi;colon", "quote\"inside"]);
        assert_eq!(recs[2], vec!["multi\nline", "ok"]); // newline inside quotes
        assert_eq!(recs[3], vec!["plain", "row"]);
    }

    #[test]
    fn b6_parse_csv_crlf_and_ragged_rows() {
        let recs = parse_csv("a;b\r\nc\r\n\r\n");
        assert_eq!(recs, vec![vec!["a", "b"], vec!["c"]]); // \r dropped, empty line skipped
    }

    #[test]
    fn b6_export_anki_format() {
        let anki = export_anki(&sample_words());
        let mut lines = anki.lines();
        let l1 = lines.next().unwrap();
        assert_eq!(
            l1,
            "monster\tчудовище — a scary creature<br>The monster; it lived"
        );
        // word 2: no translation/definition/context → empty back
        assert_eq!(lines.next().unwrap(), "слово\t");
        assert!(lines.next().is_none());
        // exactly one tab per line, no stray newlines inside fields
        for l in anki.lines() {
            assert_eq!(l.matches('\t').count(), 1, "{l}");
        }
    }

    #[test]
    fn b6_export_anki_sanitizes_tabs_and_newlines() {
        let mut words = sample_words();
        words[0].word = "mo\tster".into();
        words[0].context = Some("line1\nline2".into());
        let anki = export_anki(&words[..1]);
        assert_eq!(anki.lines().count(), 1);
        assert!(anki.starts_with("mo ster\t"), "{anki:?}");
        assert!(anki.contains("<br>line1 line2"), "{anki:?}");
    }

    #[test]
    fn b6_export_anki_partial_fields() {
        let mut w = sample_words();
        w[0].definition = None; // translation only → no dangling " — "
        w[0].context = None;
        assert_eq!(export_anki(&w[..1]), "monster\tчудовище\n");
        w[0].translation = None;
        w[0].definition = Some("def".into());
        w[0].context = Some("ctx".into());
        assert_eq!(export_anki(&w[..1]), "monster\tdef<br>ctx\n");
    }

    #[test]
    fn b6_civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // NOW (2026-09-21T00:00:00Z) / DAY_MS
        assert_eq!(civil_from_days(NOW.div_euclid(DAY_MS)), (2026, 9, 21));
    }

    #[test]
    fn b6_due_date_format() {
        // Whatever the local offset, the shape is yyyy-mm-dd and near the input date.
        let d = due_date(NOW);
        assert_eq!(d.len(), 10);
        assert!(d.starts_with("2026-09-2"), "{d}"); // 2026-09-20/21/22 depending on tz
    }

    #[test]
    fn b6_is_json_import_sniffing() {
        assert!(is_json_import("[{\"word\":\"x\"}]"));
        assert!(is_json_import("  \u{feff} []"));
        assert!(is_json_import("{}"));
        assert!(!is_json_import("word;translation\nx;y"));
        assert!(!is_json_import(""));
    }

    #[test]
    fn b6_local_day_start_is_midnight_local() {
        let start = local_day_start_ms(NOW);
        assert!(start <= NOW && NOW - start < DAY_MS, "{start} vs {NOW}");
        // the next local midnight is exactly one day later
        assert_eq!(local_day_start_ms(start + DAY_MS), start + DAY_MS);
    }

    #[test]
    fn b6_escape_like_wildcards() {
        assert_eq!(escape_like("100%_a\\b"), "100\\%\\_a\\\\b");
        assert_eq!(escape_like("plain"), "plain");
    }
}
