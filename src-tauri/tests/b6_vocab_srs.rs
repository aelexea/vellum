//! B6 integration tests (§8): lookups counter + suggest threshold, add_word merge,
//! list filters, queue ordering, record_review persistence + review_log, stats math,
//! export/import roundtrips, and the full `lookup_word` command path (db + net + merge)
//! against an offline provider setup.
//!
//! Decoupling rule: the schema below is the §4.4 DDL for the tables B6 touches, applied
//! to a fresh in-memory connection by this file — no dependency on `db::migrate` (B3)
//! and no dependency on a Tauri app handle. `net::lookup` (B7) is implemented, so the
//! full-path test is NOT gated.

use rusqlite::{params, Connection};

use vellum_lib::commands::vocab::lookup_word_impl;
use vellum_lib::db::vocab as v;
use vellum_lib::db::vocab::{ReviewResult, VocabInput};
use vellum_lib::dto::{LookupContext, VocabPatch, VocabStatus};

/// §4.4 DDL for the tables these tests touch (`books` feeds the `book_title` join).
const DDL: &str = "
CREATE TABLE IF NOT EXISTS books(
  uid TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '[]',
  cover_path TEXT, added_at INTEGER NOT NULL, last_opened_at INTEGER,
  progress REAL NOT NULL DEFAULT 0, position TEXT,
  total_chapters INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS lookups(word_norm TEXT PRIMARY KEY, word TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1, last_seen_at INTEGER NOT NULL,
  last_book TEXT, last_chapter INTEGER, last_context TEXT, last_cfi TEXT);
CREATE TABLE IF NOT EXISTS vocab(id INTEGER PRIMARY KEY, word TEXT NOT NULL,
  word_norm TEXT NOT NULL UNIQUE, translation TEXT, definition TEXT, transcription TEXT,
  pos TEXT, examples TEXT NOT NULL DEFAULT '[]',
  book_uid TEXT, chapter_idx INTEGER, context TEXT, context_cfi TEXT,
  added_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new'
    CHECK(status IN ('new','learning','known')),
  review_count INTEGER NOT NULL DEFAULT 0, ease REAL NOT NULL DEFAULT 2.5,
  interval_days REAL, due_at INTEGER, last_reviewed_at INTEGER);
CREATE TABLE IF NOT EXISTS review_log(id INTEGER PRIMARY KEY, vocab_id INTEGER NOT NULL,
  at INTEGER NOT NULL, result TEXT NOT NULL, interval_after REAL);
CREATE INDEX IF NOT EXISTS idx_vocab_due ON vocab(due_at);
";

fn conn() -> Connection {
    let c = Connection::open_in_memory().expect("open in-memory db");
    c.execute_batch("PRAGMA busy_timeout=5000;").unwrap();
    c.execute_batch(DDL).expect("apply §4.4 DDL");
    c
}

/// Fixed clock: 2026-09-21T00:00:00Z.
const NOW: i64 = 1_789_948_800_000;
const DAY: i64 = 86_400_000;

fn input(word: &str) -> VocabInput {
    VocabInput {
        word: word.to_owned(),
        ..Default::default()
    }
}

fn add(c: &Connection, word: &str, now: i64) -> vellum_lib::dto::VocabWord {
    v::add_word(c, &input(word), now).expect("add_word")
}

fn ctx(book: &str, chapter: i64, sentence: &str) -> LookupContext {
    LookupContext {
        book_uid: book.to_owned(),
        chapter_idx: chapter,
        sentence: sentence.to_owned(),
        cfi: format!("epubcfi(/4/{chapter})"),
    }
}

// ===========================================================================
// record_lookup + suggest threshold (§4.6)
// ===========================================================================

#[test]
fn b6_lookup_counter_and_suggest_threshold() {
    let c = conn();
    let ctx1 = ctx("uid1", 2, "The monster appeared.");

    // lookups 1 and 2: no suggestion (threshold 3)
    let o1 = v::record_lookup(&c, "\"Monster,\"", Some(&ctx1), 3, NOW).unwrap();
    assert_eq!(o1.count, 1);
    assert!(!o1.suggest_add);
    assert!(!o1.already_in_vocab);

    let o2 = v::record_lookup(&c, "monster!", None, 3, NOW + 1000).unwrap();
    assert_eq!(o2.count, 2);
    assert!(!o2.suggest_add);

    // 3rd lookup reaches the threshold → suggest
    let o3 = v::record_lookup(&c, "MONSTER", None, 3, NOW + 2000).unwrap();
    assert_eq!(o3.count, 3);
    assert!(o3.suggest_add);

    // one row only (word_norm is the PK), context from the first lookup survived the
    // contextless ones, last_seen_at tracks the newest
    let count: i64 = c
        .query_row("SELECT COUNT(*) FROM lookups", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1, "one lookups row for all case/punct variants");
    let (last_book, last_ctx, last_seen, display): (String, String, i64, String) = c
        .query_row(
            "SELECT last_book, last_context, last_seen_at, word \
             FROM lookups WHERE word_norm = 'monster'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(last_book, "uid1");
    assert_eq!(last_ctx, "The monster appeared.");
    assert_eq!(last_seen, NOW + 2000);
    assert_eq!(display, "MONSTER", "display word refreshed to the newest");
}

#[test]
fn b6_lookup_already_in_vocab_never_suggests() {
    let c = conn();
    add(&c, "monster", NOW);
    for i in 0..5 {
        let o = v::record_lookup(&c, "monster", None, 1, NOW + i).unwrap();
        assert!(o.already_in_vocab, "lookup #{i}");
        assert!(!o.suggest_add, "in-vocab word must never be suggested");
        assert_eq!(o.count, i + 1);
    }
}

#[test]
fn b6_lookup_empty_word_is_error() {
    let c = conn();
    assert!(v::record_lookup(&c, "  «»…  ", None, 3, NOW).is_err());
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM lookups", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "nothing recorded for an empty word");
}

#[test]
fn b6_lookup_threshold_one_suggests_immediately() {
    let c = conn();
    let o = v::record_lookup(&c, "слово", None, 1, NOW).unwrap();
    assert_eq!(o.count, 1);
    assert!(o.suggest_add);
}

// ===========================================================================
// add_word (§4.6: defaults + idempotent merge)
// ===========================================================================

#[test]
fn b6_add_word_new_row_defaults() {
    let c = conn();
    let w = v::add_word(
        &c,
        &VocabInput {
            word: "  Monster  ".into(),
            translation: Some("чудовище".into()),
            examples: vec!["a scary one".into()],
            book_uid: Some("uid1".into()),
            chapter_idx: Some(4),
            context: Some("It lived.".into()),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(w.word, "Monster", "display form trimmed, case kept");
    assert_eq!(w.translation.as_deref(), Some("чудовище"));
    assert_eq!(w.examples, vec!["a scary one".to_string()]);
    assert_eq!(w.added_at, NOW);
    assert_eq!(w.status, VocabStatus::New);
    assert_eq!(w.review_count, 0);
    assert_eq!(w.interval_days, None);
    assert_eq!(w.ease, 2.5, "dto-v1.2 ease defaults to 2.5");
    assert_eq!(w.due_at, Some(NOW), "immediately reviewable");
    assert_eq!(w.last_reviewed_at, None);
    assert_eq!(w.book_title, None, "no books row → join yields null");
    // word_norm stored lowercased+stripped
    let norm: String = c
        .query_row("SELECT word_norm FROM vocab WHERE id=?1", [w.id], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(norm, "monster");
}

#[test]
fn b6_add_word_book_title_join() {
    let c = conn();
    c.execute(
        "INSERT INTO books(uid, path, title, added_at) VALUES('uid1','/b.epub','Frankenstein',1)",
        [],
    )
    .unwrap();
    let w = v::add_word(
        &c,
        &VocabInput {
            word: "monster".into(),
            book_uid: Some("uid1".into()),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(w.book_title.as_deref(), Some("Frankenstein"));
    // and it shows up through list_words too
    let listed = v::list_words(&c, None, Some("uid1"), None, false, NOW).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].book_title.as_deref(), Some("Frankenstein"));
}

#[test]
fn b6_add_word_idempotent_merge() {
    let c = conn();
    let first = v::add_word(
        &c,
        &VocabInput {
            word: "Monster".into(),
            translation: Some("чудовище".into()),
            book_uid: Some("uid1".into()),
            context: Some("old context".into()),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();

    // same word_norm (case + punctuation variants), partially overlapping fields
    let merged = v::add_word(
        &c,
        &VocabInput {
            word: "«monster!»".into(),
            translation: Some("new translation".into()), // must NOT overwrite (fill-if-empty)
            definition: Some("a scary creature".into()), // fills the empty slot
            context: Some("newest context".into()),      // overwritten with newest
            book_uid: Some("uid2".into()),               // overwritten with newest
            ..Default::default()
        },
        NOW + 5000,
    )
    .unwrap();

    assert_eq!(merged.id, first.id, "no duplicate row");
    let count: i64 = c
        .query_row("SELECT COUNT(*) FROM vocab", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(
        merged.translation.as_deref(),
        Some("чудовище"),
        "fill-if-empty"
    );
    assert_eq!(merged.definition.as_deref(), Some("a scary creature"));
    assert_eq!(
        merged.context.as_deref(),
        Some("newest context"),
        "newest wins"
    );
    assert_eq!(merged.book_uid.as_deref(), Some("uid2"));
    // SRS state untouched by the merge
    assert_eq!(merged.added_at, NOW);
    assert_eq!(merged.status, VocabStatus::New);
    assert_eq!(merged.due_at, Some(NOW));
}

#[test]
fn b6_add_word_merge_fills_empty_translation() {
    let c = conn();
    let first = add(&c, "слово", NOW);
    assert_eq!(first.translation, None);
    let merged = v::add_word(
        &c,
        &VocabInput {
            word: "Слово".into(),
            translation: Some("word".into()),
            examples: vec!["ex".into()],
            ..Default::default()
        },
        NOW + 1,
    )
    .unwrap();
    assert_eq!(merged.id, first.id);
    assert_eq!(
        merged.translation.as_deref(),
        Some("word"),
        "empty slot filled"
    );
    assert_eq!(merged.examples, vec!["ex".to_string()]);
}

#[test]
fn b6_add_word_empty_word_is_error() {
    let c = conn();
    assert!(v::add_word(&c, &input("  …—  "), NOW).is_err());
}

#[test]
fn b6_add_word_honors_explicit_status() {
    let c = conn();
    let w = v::add_word(
        &c,
        &VocabInput {
            word: "known one".into(),
            status: Some(VocabStatus::Known),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(w.status, VocabStatus::Known);
    assert_eq!(w.due_at, Some(NOW));
}

// ===========================================================================
// update_word / delete_word
// ===========================================================================

#[test]
fn b6_update_word_partial_patch() {
    let c = conn();
    let w = add(&c, "monster", NOW);
    let patched = v::update_word(
        &c,
        w.id,
        &VocabPatch {
            translation: Some("чудовище".into()),
            status: Some(VocabStatus::Learning),
            ..Default::default()
        },
        NOW + 1,
    )
    .unwrap();
    assert_eq!(patched.translation.as_deref(), Some("чудовище"));
    assert_eq!(patched.status, VocabStatus::Learning);
    // untouched fields survive
    assert_eq!(patched.word, "monster");
    assert_eq!(patched.added_at, NOW);
    assert_eq!(patched.due_at, Some(NOW));
    assert_eq!(patched.ease, 2.5);
}

#[test]
fn b6_update_word_examples_and_due_at() {
    let c = conn();
    let w = add(&c, "monster", NOW);
    let patched = v::update_word(
        &c,
        w.id,
        &VocabPatch {
            examples: Some(vec!["one".into(), "two".into()]),
            due_at: Some(NOW + 9 * DAY),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    assert_eq!(patched.examples, vec!["one".to_string(), "two".to_string()]);
    assert_eq!(patched.due_at, Some(NOW + 9 * DAY));
}

#[test]
fn b6_update_word_missing_id_errors() {
    let c = conn();
    let r = v::update_word(
        &c,
        4242,
        &VocabPatch {
            translation: Some("x".into()),
            ..Default::default()
        },
        NOW,
    );
    assert!(r.is_err());
    // even an empty patch reports the missing row
    assert!(v::update_word(&c, 4242, &VocabPatch::default(), NOW).is_err());
}

#[test]
fn b6_delete_word_removes_review_log_and_is_idempotent() {
    let c = conn();
    let w = add(&c, "monster", NOW);
    v::record_review(&c, w.id, ReviewResult::Good, NOW + 1).unwrap();
    v::record_review(&c, w.id, ReviewResult::Again, NOW + 2).unwrap();
    let logs: i64 = c
        .query_row("SELECT COUNT(*) FROM review_log", [], |r| r.get(0))
        .unwrap();
    assert_eq!(logs, 2);

    v::delete_word(&c, w.id).unwrap();
    let (words, logs): (i64, i64) = c
        .query_row(
            "SELECT (SELECT COUNT(*) FROM vocab), (SELECT COUNT(*) FROM review_log)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((words, logs), (0, 0));
    // second delete is a no-op Ok
    v::delete_word(&c, w.id).unwrap();
}

// ===========================================================================
// list_words filter matrix
// ===========================================================================

fn seed_list_matrix(c: &Connection) {
    // added_at controls ORDER BY; the add_word `now_ms` param controls due_at.
    v::add_word(
        c,
        &VocabInput {
            word: "monster".into(),
            translation: Some("чудовище".into()),
            status: Some(VocabStatus::Learning),
            book_uid: Some("uid1".into()),
            added_at: Some(100),
            ..Default::default()
        },
        NOW - 2 * DAY, // due 2 days ago
    )
    .unwrap();
    v::add_word(
        c,
        &VocabInput {
            word: "слово".into(),
            translation: Some("word".into()),
            book_uid: Some("uid2".into()),
            added_at: Some(300),
            ..Default::default()
        },
        NOW, // due now
    )
    .unwrap();
    v::add_word(
        c,
        &VocabInput {
            word: "creature".into(),
            status: Some(VocabStatus::Known),
            book_uid: Some("uid1".into()),
            added_at: Some(200),
            ..Default::default()
        },
        NOW - DAY,
    )
    .unwrap();
    v::add_word(
        c,
        &VocabInput {
            word: "future".into(),
            added_at: Some(400),
            ..Default::default()
        },
        NOW + DAY, // due tomorrow
    )
    .unwrap();
}

#[test]
fn b6_list_filter_matrix() {
    let c = conn();
    seed_list_matrix(&c);

    // no filters → all 4, added_at DESC
    let all = v::list_words(&c, None, None, None, false, NOW).unwrap();
    let words: Vec<&str> = all.iter().map(|w| w.word.as_str()).collect();
    assert_eq!(words, vec!["future", "слово", "creature", "monster"]);

    // status filter
    let learning = v::list_words(&c, Some("learning"), None, None, false, NOW).unwrap();
    assert_eq!(learning.len(), 1);
    assert_eq!(learning[0].word, "monster");
    let known = v::list_words(&c, Some("known"), None, None, false, NOW).unwrap();
    assert_eq!(known.len(), 1);
    assert_eq!(known[0].word, "creature");

    // book filter (added_at DESC within the book)
    let book1 = v::list_words(&c, None, Some("uid1"), None, false, NOW).unwrap();
    let words: Vec<&str> = book1.iter().map(|w| w.word.as_str()).collect();
    assert_eq!(words, vec!["creature", "monster"]);

    // query LIKE on word (case-insensitive via word_norm) and on translation
    let q = v::list_words(&c, None, None, Some("MONST"), false, NOW).unwrap();
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].word, "monster");
    let q = v::list_words(&c, None, None, Some("чудов"), false, NOW).unwrap();
    assert_eq!(q.len(), 1, "translation LIKE");
    let q = v::list_words(&c, None, None, Some("word"), false, NOW).unwrap();
    assert_eq!(q.len(), 1);
    assert_eq!(q[0].word, "слово");
    let q = v::list_words(&c, None, None, Some("нет такого"), false, NOW).unwrap();
    assert!(q.is_empty());

    // dueOnly: due_at <= now → excludes "future"
    let due = v::list_words(&c, None, None, None, true, NOW).unwrap();
    let words: Vec<&str> = due.iter().map(|w| w.word.as_str()).collect();
    assert_eq!(words, vec!["слово", "creature", "monster"]);

    // empty/blank filters behave as absent
    let all2 = v::list_words(&c, Some(""), Some("  "), Some(""), false, NOW).unwrap();
    assert_eq!(all2.len(), 4);

    // combined: status + book + query
    let combo =
        v::list_words(&c, Some("learning"), Some("uid1"), Some("mons"), false, NOW).unwrap();
    assert_eq!(combo.len(), 1);
}

#[test]
fn b6_list_query_escapes_like_wildcards() {
    let c = conn();
    add(&c, "100%", NOW);
    add(&c, "1000", NOW + 1);
    // the literal '%' must not act as a wildcard
    let q = v::list_words(&c, None, None, Some("100%"), false, NOW).unwrap();
    let words: Vec<&str> = q.iter().map(|w| w.word.as_str()).collect();
    assert_eq!(words, vec!["100%"]);
    // '_' likewise
    add(&c, "a_b", NOW + 2);
    add(&c, "axb", NOW + 3);
    let q = v::list_words(&c, None, None, Some("a_b"), false, NOW).unwrap();
    let words: Vec<&str> = q.iter().map(|w| w.word.as_str()).collect();
    assert_eq!(words, vec!["a_b"]);
}

// ===========================================================================
// get_queue ordering (§4.6)
// ===========================================================================

#[test]
fn b6_queue_ordering_new_first_then_oldest_due_known_excluded() {
    let c = conn();

    // unscheduled new word (due_at NULL) — first branch of the queue predicate
    c.execute(
        "INSERT INTO vocab(word, word_norm, added_at, status, due_at) \
         VALUES('fresh','fresh',50,'new',NULL)",
        [],
    )
    .unwrap();
    // known word without a schedule — excluded by both branches
    c.execute(
        "INSERT INTO vocab(word, word_norm, added_at, status, due_at) \
         VALUES('mastered','mastered',60,'known',NULL)",
        [],
    )
    .unwrap();
    // known word that is overdue — still excluded
    v::add_word(
        &c,
        &VocabInput {
            word: "known overdue".into(),
            status: Some(VocabStatus::Known),
            added_at: Some(70),
            ..Default::default()
        },
        NOW - 3 * DAY,
    )
    .unwrap();

    // due words: oldest first
    let old = v::add_word(
        &c,
        &VocabInput {
            word: "old".into(),
            status: Some(VocabStatus::Learning),
            added_at: Some(10),
            ..Default::default()
        },
        NOW - 2 * DAY,
    )
    .unwrap();
    let recent = v::add_word(
        &c,
        &VocabInput {
            word: "recent".into(),
            status: Some(VocabStatus::Learning),
            added_at: Some(20),
            ..Default::default()
        },
        NOW - DAY,
    )
    .unwrap();
    // not due yet → excluded
    v::add_word(
        &c,
        &VocabInput {
            word: "not yet".into(),
            added_at: Some(30),
            ..Default::default()
        },
        NOW + DAY,
    )
    .unwrap();

    let q = v::get_queue(&c, 10, NOW).unwrap();
    let words: Vec<&str> = q.iter().map(|w| w.word.as_str()).collect();
    assert_eq!(words, vec!["fresh", "old", "recent"]);

    // LIMIT respected, ordering stable
    let q2 = v::get_queue(&c, 2, NOW).unwrap();
    let words: Vec<&str> = q2.iter().map(|w| w.word.as_str()).collect();
    assert_eq!(words, vec!["fresh", "old"]);
    assert!(old.due_at.unwrap() < recent.due_at.unwrap());
}

// ===========================================================================
// record_review persistence + review_log (§4.6 SM-2)
// ===========================================================================

#[test]
fn b6_record_review_persists_and_logs() {
    let c = conn();
    let w = add(&c, "monster", NOW);

    // first good: interval 1.0, due +1d, status learning, ease unchanged
    let r1 = v::record_review(&c, w.id, ReviewResult::Good, NOW + 1000).unwrap();
    assert_eq!(r1.review_count, 1);
    assert_eq!(r1.interval_days, Some(1.0));
    assert_eq!(r1.due_at, Some(NOW + 1000 + DAY));
    assert_eq!(r1.status, VocabStatus::Learning);
    assert_eq!(r1.ease, 2.5, "dto-v1.2: updated ease carried in the DTO");
    assert_eq!(r1.last_reviewed_at, Some(NOW + 1000));

    // second good: interval × ease = 2.5
    let r2 = v::record_review(&c, w.id, ReviewResult::Good, NOW + 2000).unwrap();
    assert_eq!(r2.review_count, 2);
    assert!((r2.interval_days.unwrap() - 2.5).abs() < 1e-9);
    assert_eq!(r2.due_at, Some(NOW + 2000 + (2.5 * DAY as f64) as i64));

    // again: +600 s requeue, ease −0.2
    let r3 = v::record_review(&c, w.id, ReviewResult::Again, NOW + 3000).unwrap();
    assert_eq!(r3.review_count, 3);
    assert_eq!(r3.due_at, Some(NOW + 3000 + 600_000));
    assert!((r3.ease - 2.3).abs() < 1e-9);
    assert_eq!(r3.status, VocabStatus::Learning);

    // review_log: one row per review, in order
    let logs: Vec<(i64, i64, String, f64)> = {
        let mut stmt = c
            .prepare("SELECT vocab_id, at, result, interval_after FROM review_log ORDER BY id")
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap();
        rows.map(|x| x.unwrap()).collect()
    };
    assert_eq!(logs.len(), 3);
    assert_eq!(logs[0], (w.id, NOW + 1000, "good".into(), 1.0));
    assert_eq!(logs[1].0, w.id);
    assert_eq!(logs[1].2, "good");
    assert!((logs[1].3 - 2.5).abs() < 1e-9);
    assert_eq!(logs[2].2, "again");
    assert!(
        (logs[2].3 - v::AGAIN_INTERVAL_DAYS).abs() < 1e-12,
        "again interval ≈ 10 min in days"
    );
}

#[test]
fn b6_record_review_auto_promotes_to_known_at_21_days() {
    let c = conn();
    // interval 10 d × ease 2.5 = 25 d ≥ 21 → 'known'
    c.execute(
        "INSERT INTO vocab(word, word_norm, added_at, status, review_count, ease, interval_days, due_at) \
         VALUES('big','big',1,'learning',4,2.5,10.0,?)",
        params![NOW - DAY],
    )
    .unwrap();
    let r = v::record_review(&c, 1, ReviewResult::Good, NOW).unwrap();
    assert!((r.interval_days.unwrap() - 25.0).abs() < 1e-9);
    assert_eq!(r.status, VocabStatus::Known);
}

#[test]
fn b6_record_review_never_downgrades_user_known() {
    let c = conn();
    let w = v::add_word(
        &c,
        &VocabInput {
            word: "mastered".into(),
            status: Some(VocabStatus::Known),
            ..Default::default()
        },
        NOW,
    )
    .unwrap();
    // even an 'again' keeps the user-set 'known' (SRS fields still update + log)
    let r = v::record_review(&c, w.id, ReviewResult::Again, NOW + 1).unwrap();
    assert_eq!(r.status, VocabStatus::Known);
    assert_eq!(r.review_count, 1);
    assert_eq!(r.due_at, Some(NOW + 1 + 600_000));
    let logs: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM review_log WHERE vocab_id=?1",
            [w.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(logs, 1);
}

#[test]
fn b6_record_review_missing_id_errors() {
    let c = conn();
    assert!(v::record_review(&c, 999, ReviewResult::Good, NOW).is_err());
}

#[test]
fn b6_review_sequence_hard_then_recovery() {
    let c = conn();
    let w = add(&c, "tough", NOW);
    // good(1d) → hard(×1.2, ease −0.15) → easy(×ease×1.3, ease +0.15)
    let a = v::record_review(&c, w.id, ReviewResult::Good, NOW).unwrap();
    let b = v::record_review(&c, w.id, ReviewResult::Hard, NOW + DAY).unwrap();
    assert!((b.interval_days.unwrap() - 1.2).abs() < 1e-9);
    assert!((b.ease - 2.35).abs() < 1e-9);
    let d = v::record_review(&c, w.id, ReviewResult::Easy, NOW + 2 * DAY).unwrap();
    // 1.2 × 2.35 × 1.3 = 3.666
    assert!((d.interval_days.unwrap() - 1.2 * 2.35 * 1.3).abs() < 1e-9);
    assert!((d.ease - 2.5).abs() < 1e-9);
    assert_eq!(d.status, VocabStatus::Learning);
    assert_eq!(a.id, w.id);
}

// ===========================================================================
// stats (§4.8 vocab_stats)
// ===========================================================================

#[test]
fn b6_stats_math_seeded() {
    let c = conn();
    let now = vellum_lib::db::now_ms(); // real clock: reviewsToday uses the local day
    let day_start = v::local_day_start_ms(now);

    // w1: unscheduled new → counts toward dueToday
    v::add_word(
        &c,
        &VocabInput {
            word: "fresh".into(),
            added_at: Some(now - DAY),
            ..Default::default()
        },
        now - DAY,
    )
    .unwrap();
    // make w1 unscheduled (due_at NULL) like a raw insert would
    c.execute("UPDATE vocab SET due_at=NULL WHERE word_norm='fresh'", [])
        .unwrap();
    // w2: due in 3 h → dueToday
    v::add_word(
        &c,
        &VocabInput {
            word: "soon".into(),
            status: Some(VocabStatus::Learning),
            added_at: Some(now - DAY),
            ..Default::default()
        },
        now + 3 * 3_600_000,
    )
    .unwrap();
    // w3: known + overdue → NOT dueToday (known excluded)
    v::add_word(
        &c,
        &VocabInput {
            word: "done".into(),
            status: Some(VocabStatus::Known),
            added_at: Some(now - DAY),
            ..Default::default()
        },
        now - DAY,
    )
    .unwrap();
    // w4: due in 25 h → NOT dueToday; added 10 d ago → NOT addedThisWeek
    v::add_word(
        &c,
        &VocabInput {
            word: "later".into(),
            added_at: Some(now - 10 * DAY),
            ..Default::default()
        },
        now + 25 * 3_600_000,
    )
    .unwrap();

    // review_log: two today (at now, and just after the local day start), one yesterday
    for at in [now, day_start + 1000, now - 25 * 3_600_000] {
        c.execute(
            "INSERT INTO review_log(vocab_id, at, result, interval_after) \
             VALUES(1,?1,'good',1.0)",
            params![at],
        )
        .unwrap();
    }

    let s = v::stats(&c, now).unwrap();
    assert_eq!(s.total, 4);
    assert_eq!(s.by_status.new, 2);
    assert_eq!(s.by_status.learning, 1);
    assert_eq!(s.by_status.known, 1);
    assert_eq!(
        s.due_today, 2,
        "fresh (unscheduled new) + soon (due in 3 h)"
    );
    assert_eq!(
        s.reviews_today, 2,
        "now + day_start+1s count; −25 h does not"
    );
    assert_eq!(s.added_this_week, 3, "w4 was added 10 days ago");
}

// ===========================================================================
// export / import roundtrips (§4.6)
// ===========================================================================

fn seed_tricky(c: &Connection) -> Vec<vellum_lib::dto::VocabWord> {
    vec![
        v::add_word(
            c,
            &VocabInput {
                word: "monster".into(),
                translation: Some("чудо;вище".into()), // ';' inside
                definition: Some("say \"hi\"".into()), // quotes inside
                context: Some("line1\nline2".into()),  // newline inside
                book_uid: Some("uid1".into()),
                ..Default::default()
            },
            NOW,
        )
        .unwrap(),
        v::add_word(
            c,
            &VocabInput {
                word: "слово".into(),
                translation: Some("word".into()),
                ..Default::default()
            },
            NOW + 1,
        )
        .unwrap(),
    ]
}

#[test]
fn b6_export_import_json_roundtrip_exact() {
    let c = conn();
    let seeded = seed_tricky(&c);
    let json = v::export_json(&v::all_words(&c).unwrap()).unwrap();

    let c2 = conn();
    let n = v::import_json(&c2, &json, NOW + 999).unwrap();
    assert_eq!(n, 2);
    let imported = v::all_words(&c2).unwrap();
    assert_eq!(imported.len(), 2);
    // field-exact on the data columns (ids may differ; addedAt preserved from JSON)
    for (a, b) in seeded.iter().zip(imported.iter().rev()) {
        assert_eq!(a.word, b.word);
        assert_eq!(a.translation, b.translation);
        assert_eq!(a.definition, b.definition);
        assert_eq!(a.context, b.context);
        assert_eq!(a.book_uid, b.book_uid);
        assert_eq!(a.added_at, b.added_at, "addedAt preserved on import");
        assert_eq!(a.ease, b.ease);
    }
    // importing twice is idempotent (merge, no duplicates)
    let n2 = v::import_json(&c2, &json, NOW + 1000).unwrap();
    assert_eq!(n2, 2);
    let total: i64 = c2
        .query_row("SELECT COUNT(*) FROM vocab", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 2);
}

#[test]
fn b6_import_json_skips_broken_entries() {
    let c = conn();
    let json = r#"[
        {"word":"good","translation":"ok"},
        42,
        "junk",
        {"translation":"no word field"},
        {"word":"  ","translation":"blank word"},
        {"word":"also good","examples":["x"],"status":"known","addedAt":123}
    ]"#;
    let n = v::import_json(&c, json, NOW).unwrap();
    assert_eq!(n, 2, "only the two valid entries");
    let words = v::list_words(&c, None, None, None, false, NOW).unwrap();
    assert_eq!(words.len(), 2);
    let known = words.iter().find(|w| w.word == "also good").unwrap();
    assert_eq!(known.status, VocabStatus::Known);
    assert_eq!(known.added_at, 123);
    assert_eq!(known.examples, vec!["x".to_string()]);
    // non-array top level → Err
    assert!(v::import_json(&c, "{\"word\":\"x\"}", NOW).is_err());
    assert!(v::import_json(&c, "not json at all", NOW).is_err());
}

#[test]
fn b6_export_import_csv_roundtrip_tricky_fields() {
    let c = conn();
    seed_tricky(&c);
    let csv = v::export_csv(&v::all_words(&c).unwrap());
    assert!(csv.starts_with('\u{feff}'));

    let c2 = conn();
    let n = v::import_csv(&c2, &csv, NOW + 5).unwrap();
    assert_eq!(n, 2);
    // CSV carries no `addedAt`, so import order is not the export order — look up by
    // word rather than relying on positional order.
    let imported = v::all_words(&c2).unwrap();
    assert_eq!(imported.len(), 2);
    let by_word = |w: &str| imported.iter().find(|x| x.word == w).expect(w);

    let s = by_word("слово");
    assert_eq!(s.translation.as_deref(), Some("word"));

    let m = by_word("monster");
    assert_eq!(
        m.translation.as_deref(),
        Some("чудо;вище"),
        "semicolon survived"
    );
    assert_eq!(
        m.definition.as_deref(),
        Some("say \"hi\""),
        "quotes survived"
    );
    assert_eq!(
        m.context.as_deref(),
        Some("line1\nline2"),
        "newline survived"
    );
}

#[test]
fn b6_import_csv_skips_broken_lines_and_counts() {
    let c = conn();
    // header + 3 valid rows (alpha, beta, and a final row with no trailing newline);
    // two empty-word rows must be skipped.
    let csv = "\u{feff}word;translation;definition;status;due_at;book;context\n\
               alpha;альфа;;new;;;ok\n\
               ;no-word-here;;;;;;\n\
               ;;;;;;\n\
               beta;бета;;learning;;;ctx\n\
               gamma;гамма";
    let n = v::import_csv(&c, csv, NOW).unwrap();
    assert_eq!(
        n, 3,
        "alpha + beta + gamma (no trailing newline); empty-word rows skipped"
    );
    let words = v::list_words(&c, None, None, None, false, NOW).unwrap();
    assert_eq!(words.len(), 3);
    let beta = words.iter().find(|w| w.word == "beta").unwrap();
    assert_eq!(beta.status, VocabStatus::Learning, "status column applied");
    assert_eq!(beta.translation.as_deref(), Some("бета"));
    // the last row (no trailing newline) still parsed
    let gamma = words.iter().find(|w| w.word == "gamma").unwrap();
    assert_eq!(gamma.translation.as_deref(), Some("гамма"));
}

#[test]
fn b6_import_csv_headerless_file_works() {
    let c = conn();
    let n = v::import_csv(&c, "gamma;гамма\n", NOW).unwrap();
    assert_eq!(n, 1);
    let words = v::all_words(&c).unwrap();
    assert_eq!(words[0].word, "gamma");
    assert_eq!(words[0].translation.as_deref(), Some("гамма"));
}

#[test]
fn b6_export_anki_smoke_db_rows() {
    let c = conn();
    seed_tricky(&c);
    let anki = v::export_anki(&v::all_words(&c).unwrap());
    let lines: Vec<&str> = anki.lines().collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0], "слово\tword"); // no definition/context → no <br>
                                         // tricky fields flattened: newline → space, tab-safety guaranteed
    assert!(lines[1].starts_with("monster\tчудо;вище — say \"hi\"<br>line1 line2"));
    for l in &lines {
        assert_eq!(l.matches('\t').count(), 1);
    }
}

// ===========================================================================
// Full lookup_word command path (db + net B7 + merge) — net is implemented,
// so this is NOT gated. Offline providers (dead port) → translation/dictionary
// null, still Ok; the db outcome fields always come from our layer.
// ===========================================================================

/// Offline `AppState` (B7's test pattern): every provider points at a dead port so
/// the full resolve → HTTP → refuse → degrade path runs without internet.
fn offline_state(conn: Connection) -> vellum_lib::AppState {
    use dashmap::DashMap;
    use parking_lot::RwLock;
    use std::sync::{Mutex, OnceLock};
    use vellum_lib::db::AppPaths;
    use vellum_lib::dto::ProviderConfig;
    use vellum_lib::settings::Settings;

    const DEAD: &str = "http://127.0.0.1:1";
    let mut settings = Settings::default();
    settings.translate.default_provider_id = "libre".to_owned();
    settings.translate.default_target_lang = "ru".to_owned();
    settings.translate.providers.insert(
        "libre".to_owned(),
        ProviderConfig {
            enabled: true,
            base_url: Some(DEAD.to_owned()),
            api_key: None,
        },
    );
    for id in ["google", "lingva"] {
        settings.translate.providers.insert(
            id.to_owned(),
            ProviderConfig {
                enabled: false,
                base_url: Some(DEAD.to_owned()),
                api_key: None,
            },
        );
    }
    settings.translate.providers.insert(
        "dictionaryapi".to_owned(),
        ProviderConfig {
            enabled: true,
            base_url: Some(format!("{DEAD}/api/v2/entries/en")),
            api_key: None,
        },
    );
    settings.vocab.suggest_after_lookups = 3;

    vellum_lib::AppState {
        db: Mutex::new(conn),
        zips: DashMap::new(),
        http: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(1))
            .build()
            .unwrap(),
        settings: RwLock::new(settings),
        paths: AppPaths {
            data_dir: std::env::temp_dir(),
            config_dir: std::env::temp_dir(),
            cache_dir: std::env::temp_dir(),
            covers_dir: std::env::temp_dir(),
            backups_dir: std::env::temp_dir(),
            db_path: std::env::temp_dir().join("vellum-b6-test.db"),
        },
        fonts: OnceLock::new(),
    }
}

#[test]
fn b6_lookup_word_full_path_offline() {
    let state = offline_state(conn());
    let ctx1 = ctx("uid1", 2, "The monster appeared.");

    // lookup #1: count 1, no suggest, network degraded to nulls, still Ok
    let r1 = tauri::async_runtime::block_on(lookup_word_impl(
        &state,
        "\"Monster,\"".to_owned(),
        Some(ctx1.clone()),
    ))
    .expect("lookup must be Ok even with all providers down");
    assert_eq!(r1.lookup_count, 1);
    assert!(!r1.suggest_add);
    assert!(!r1.already_in_vocab);
    assert!(r1.translation.is_none());
    assert!(r1.dictionary.is_none());
    assert!(
        !r1.word.is_empty(),
        "display word filled by net or fallback"
    );

    // lookups #2, #3: counter climbs, suggestion flips at threshold 3
    let r2 = tauri::async_runtime::block_on(lookup_word_impl(&state, "monster".to_owned(), None))
        .unwrap();
    assert_eq!(r2.lookup_count, 2);
    assert!(!r2.suggest_add);
    let r3 = tauri::async_runtime::block_on(lookup_word_impl(&state, "monster".to_owned(), None))
        .unwrap();
    assert_eq!(r3.lookup_count, 3);
    assert!(r3.suggest_add, "threshold reached → suggest");

    // context from the first lookup survived the contextless ones
    {
        let c = state.db.lock().unwrap();
        let (book, sentence): (String, String) = c
            .query_row(
                "SELECT last_book, last_context FROM lookups WHERE word_norm='monster'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(book, "uid1");
        assert_eq!(sentence, "The monster appeared.");
    }

    // add to vocab → alreadyInVocab, suggestion stops
    {
        let c = state.db.lock().unwrap();
        v::add_word(&c, &input("monster"), NOW).unwrap();
    }
    let r4 = tauri::async_runtime::block_on(lookup_word_impl(&state, "monster".to_owned(), None))
        .unwrap();
    assert_eq!(r4.lookup_count, 4);
    assert!(r4.already_in_vocab);
    assert!(!r4.suggest_add);
}

#[test]
fn b6_lookup_word_empty_word_errors_before_net() {
    let state = offline_state(conn());
    let r = tauri::async_runtime::block_on(lookup_word_impl(&state, "…—".to_owned(), None));
    assert!(r.is_err(), "empty normalized word → Err from the db half");
}
