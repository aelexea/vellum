//! B4 integration tests (§8): annotations CRUD + stats/streak math against the real
//! public db API (`vellum_lib::db::{annotations,stats}`) and the heartbeat clamping in
//! `vellum_lib::commands::stats`.
//!
//! Decoupling rule: the schema below is the §4.4 DDL for the tables B4 uses, applied to a
//! fresh in-memory connection by this file — no dependency on `db::migrate` (B3, in flight)
//! and no dependency on a Tauri app handle.

use rusqlite::{params, Connection};

use vellum_lib::commands::stats::clamp_tick;
use vellum_lib::db::annotations as ann;
use vellum_lib::db::stats as st;

/// §4.4 DDL for the tables these tests touch (`books` is needed by `get_book_stats`).
const DDL: &str = "
CREATE TABLE IF NOT EXISTS books(
  uid TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '[]',
  cover_path TEXT, added_at INTEGER NOT NULL, last_opened_at INTEGER,
  progress REAL NOT NULL DEFAULT 0, position TEXT,
  total_chapters INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS highlights(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL, cfi_start TEXT NOT NULL, cfi_end TEXT NOT NULL,
  color TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL, cfi_start TEXT NOT NULL, cfi_end TEXT NOT NULL,
  selected_text TEXT NOT NULL DEFAULT '', note_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bookmarks(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL, cfi TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  day TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0, pages_turned INTEGER NOT NULL DEFAULT 0,
  UNIQUE(book_uid, day));
CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
CREATE INDEX IF NOT EXISTS idx_hl_book ON highlights(book_uid, chapter_idx);
CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_uid, chapter_idx);
";

fn conn() -> Connection {
    let c = Connection::open_in_memory().expect("open in-memory db");
    c.execute_batch("PRAGMA busy_timeout=5000;").unwrap();
    c.execute_batch(DDL).expect("apply §4.4 DDL");
    c
}

/// Seed a session row for an arbitrary day (today - `days_ago`).
fn seed_session(c: &Connection, uid: &str, days_ago: i64, seconds: i64, pages: i64) {
    c.execute(
        "INSERT INTO sessions(book_uid, day, seconds, pages_turned) VALUES(?1, ?2, ?3, ?4)",
        params![uid, st::day_index_back(days_ago), seconds, pages],
    )
    .expect("seed session");
}

fn seed_book(c: &Connection, uid: &str, last_opened: Option<i64>, progress: f64) {
    c.execute(
        "INSERT INTO books(uid, path, title, added_at, last_opened_at, progress) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            uid,
            format!("/books/{uid}.epub"),
            format!("Book {uid}"),
            1_700_000_000_000i64,
            last_opened,
            progress
        ],
    )
    .expect("seed book");
}

const ALICE: &str = "1111111111111111111111111111111111111111";
const FRANK: &str = "2222222222222222222222222222222222222222";

// ===========================================================================
// Annotations
// ===========================================================================

/// Full lifecycle of all three annotation types in one DB, mirroring the panel flows:
/// create → list → update → delete, with the hasNote join flipping on note add/delete.
#[test]
fn b4_annotation_lifecycle_all_types() {
    let c = conn();

    // -- highlight ---------------------------------------------------------
    let hl = ann::add_highlight(
        &c,
        ALICE,
        2,
        "epubcfi(/4/2/6/1:0)",
        "epubcfi(/4/2/6/1:80)",
        "#ffe08a",
        "«Всё чудесатее и чудесатее»",
    )
    .expect("add_highlight");
    assert!(hl.id > 0);
    assert_eq!(hl.book_uid, ALICE);
    assert_eq!(hl.chapter_idx, 2);
    assert_eq!(hl.color, "#ffe08a");
    assert_eq!(hl.text, "«Всё чудесатее и чудесатее»", "v1.3 text stored");
    assert!(!hl.has_note);

    let listed = ann::list_highlights(&c, ALICE, None).unwrap();
    assert_eq!(listed, vec![hl.clone()]);
    assert_eq!(ann::list_highlights(&c, ALICE, Some(2)).unwrap().len(), 1);
    assert!(ann::list_highlights(&c, ALICE, Some(3)).unwrap().is_empty());
    assert!(ann::list_highlights(&c, FRANK, None).unwrap().is_empty());

    ann::update_highlight(&c, hl.id, "#9ecbf5").unwrap();
    assert_eq!(
        ann::list_highlights(&c, ALICE, None).unwrap()[0].color,
        "#9ecbf5"
    );

    // -- note on the same range → hasNote flips ---------------------------
    let note = ann::add_note(
        &c,
        ALICE,
        2,
        "epubcfi(/4/2/6/1:0)",
        "epubcfi(/4/2/6/1:80)",
        "«Всё чудесатее и чудесатее»",
        "важная мысль",
    )
    .unwrap();
    assert!(note.id > 0);
    assert_eq!(note.selected_text, "«Всё чудесатее и чудесатее»");
    assert_eq!(note.note_text, "важная мысль");
    assert_eq!(note.created_at, note.updated_at);

    let joined = ann::list_highlights(&c, ALICE, None).unwrap();
    assert!(joined[0].has_note, "hasNote derived from the matching note");
    assert_eq!(joined[0].id, hl.id);
    // the highlight row itself is untouched by add_note
    assert_eq!(joined[0].color, "#9ecbf5");
    assert_eq!(joined[0].created_at, hl.created_at);

    // -- note update -------------------------------------------------------
    std::thread::sleep(std::time::Duration::from_millis(2));
    ann::update_note(&c, note.id, "пересмотрено").unwrap();
    let notes = ann::list_notes(&c, Some(ALICE)).unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].note_text, "пересмотрено");
    assert!(notes[0].updated_at > note.updated_at);
    assert_eq!(notes[0].created_at, note.created_at);
    assert_eq!(notes[0].selected_text, note.selected_text);

    // -- bookmark ----------------------------------------------------------
    let bm = ann::add_bookmark(&c, ALICE, 2, "epubcfi(/4/2/6/1:0)", Some("начало главы")).unwrap();
    assert!(bm.id > 0);
    assert_eq!(bm.label.as_deref(), Some("начало главы"));
    let bm2 = ann::add_bookmark(&c, ALICE, 0, "epubcfi(/4/2/2/1:0)", None).unwrap();
    assert_eq!(bm2.label, None);
    let bms = ann::list_bookmarks(&c, Some(ALICE)).unwrap();
    assert_eq!(
        bms.iter().map(|b| b.id).collect::<Vec<_>>(),
        vec![bm2.id, bm.id],
        "ordered by chapter_idx"
    );

    // -- deletes ------------------------------------------------------------
    ann::delete_note(&c, note.id).unwrap();
    assert!(ann::list_notes(&c, Some(ALICE)).unwrap().is_empty());
    assert!(
        !ann::list_highlights(&c, ALICE, None).unwrap()[0].has_note,
        "hasNote flips back after note delete"
    );

    ann::delete_bookmark(&c, bm.id).unwrap();
    ann::delete_bookmark(&c, bm.id).expect("idempotent");
    assert_eq!(ann::list_bookmarks(&c, Some(ALICE)).unwrap().len(), 1);

    ann::delete_highlight(&c, hl.id).unwrap();
    assert!(ann::list_highlights(&c, ALICE, None).unwrap().is_empty());
    ann::delete_highlight(&c, hl.id).expect("idempotent");
    // unknown-id updates are errors, not silent no-ops
    assert!(ann::update_highlight(&c, hl.id, "#000").is_err());
    assert!(ann::update_note(&c, note.id, "x").is_err());
}

/// Notes and bookmarks with a null uid span the whole library (annotations panel).
#[test]
fn b4_annotations_null_uid_lists_all_books() {
    let c = conn();
    let a1 = ann::add_note(&c, ALICE, 0, "s", "e", "цитата 1", "заметка 1").unwrap();
    let f1 = ann::add_note(&c, FRANK, 4, "s", "e", "цитата 2", "заметка 2").unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let a2 = ann::add_note(&c, ALICE, 9, "s", "e", "цитата 3", "заметка 3").unwrap();

    let all = ann::list_notes(&c, None).unwrap();
    assert_eq!(all.len(), 3);
    assert_eq!(
        all.iter().map(|n| n.id).collect::<Vec<_>>(),
        vec![a2.id, f1.id, a1.id],
        "ORDER BY created_at DESC across books"
    );
    assert_eq!(all.iter().filter(|n| n.book_uid == ALICE).count(), 2);
    assert_eq!(all.iter().filter(|n| n.book_uid == FRANK).count(), 1);
    assert_eq!(ann::list_notes(&c, Some(ALICE)).unwrap().len(), 2);

    ann::add_bookmark(&c, FRANK, 1, "cfi-f", None).unwrap();
    ann::add_bookmark(&c, ALICE, 7, "cfi-a", None).unwrap();
    let bms = ann::list_bookmarks(&c, None).unwrap();
    assert_eq!(bms.len(), 2);
    assert_eq!(bms[0].book_uid, FRANK, "chapter 1 before chapter 7");
    assert_eq!(bms[1].book_uid, ALICE);
}

/// Unicode/emoji-free but non-ASCII content must survive the roundtrip verbatim.
#[test]
fn b4_annotations_preserve_unicode_text() {
    let c = conn();
    let text = "Съешь же ещё этих мягких французских булок, да выпей чаю — «цитата»";
    let n = ann::add_note(
        &c,
        ALICE,
        1,
        "epubcfi(/4/2/2/1:5)",
        "epubcfi(/4/2/2/1:60)",
        text,
        text,
    )
    .unwrap();
    let back = ann::list_notes(&c, Some(ALICE)).unwrap();
    assert_eq!(back[0].selected_text, text);
    assert_eq!(back[0].note_text, text);
    assert_eq!(back[0].id, n.id);

    let bm = ann::add_bookmark(&c, ALICE, 1, "epubcfi(/4/2/2/1:5)", Some(text)).unwrap();
    assert_eq!(
        ann::list_bookmarks(&c, Some(ALICE)).unwrap()[0]
            .label
            .as_deref(),
        Some(text)
    );
    assert_eq!(bm.cfi, "epubcfi(/4/2/2/1:5)");
}

// ===========================================================================
// Heartbeat clamping (commands layer, no Tauri handle needed)
// ===========================================================================

#[test]
fn b4_tick_clamping_bounds() {
    // normal 30 s heartbeat passes through untouched
    assert_eq!(clamp_tick(30.0, 2), (30, 2));
    assert_eq!(clamp_tick(0.0, 0), (0, 0));
    assert_eq!(clamp_tick(300.0, 10_000), (300, 10_000));
    // absurd finite values clamp instead of corrupting the stats
    assert_eq!(clamp_tick(99_999.0, 0), (300, 0));
    assert_eq!(clamp_tick(30.0, 999_999), (30, 10_000));
    // non-finite is nonsense from a broken timer → dropped to 0, NOT capped to 300
    // (crediting 5 min of reading to a glitch would be worse than crediting nothing)
    assert_eq!(clamp_tick(f64::INFINITY, 0), (0, 0));
    assert_eq!(clamp_tick(f64::NEG_INFINITY, 0), (0, 0));
    // nonsense drops to zero
    assert_eq!(clamp_tick(-12.0, 4), (0, 4));
    assert_eq!(clamp_tick(12.0, -4), (12, 0));
    assert_eq!(clamp_tick(f64::NAN, 4), (0, 4));
}

/// What the command layer would store for an absurd heartbeat: exactly the clamped value.
#[test]
fn b4_absurd_tick_is_stored_clamped() {
    let c = conn();
    let (secs, pages) = clamp_tick(99_999.0, 999_999);
    st::record_tick(&c, ALICE, secs, pages).unwrap();
    let stats = st::get_stats(&c, "day").unwrap();
    assert_eq!(stats.range_seconds, 300);
    assert_eq!(stats.pages_turned, 10_000);
    assert_eq!(stats.books_touched, 1);
    assert_eq!(stats.by_day.len(), 1);
}

// ===========================================================================
// Stats aggregation
// ===========================================================================

#[test]
fn b4_three_ticks_same_day_merge_into_one_row() {
    let c = conn();
    st::record_tick(&c, ALICE, 30, 2).unwrap();
    st::record_tick(&c, ALICE, 30, 1).unwrap();
    st::record_tick(&c, ALICE, 30, 0).unwrap();

    let rows: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE book_uid = ?1",
            params![ALICE],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1, "UNIQUE(book_uid, day) upsert");

    let s = st::get_stats(&c, "day").unwrap();
    assert_eq!(s.range_seconds, 90);
    assert_eq!(s.pages_turned, 3);
    assert_eq!(s.by_day.len(), 1);
    assert_eq!(s.by_day[0].seconds, 90);
    assert_eq!(s.streak_days, 1);
}

#[test]
fn b4_ticks_on_different_days_stay_separate() {
    let c = conn();
    st::record_tick(&c, ALICE, 30, 1).unwrap(); // today
    seed_session(&c, ALICE, 1, 120, 4); // yesterday
    seed_session(&c, ALICE, 2, 90, 3);

    let days: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE book_uid = ?1",
            params![ALICE],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(days, 3);

    let s = st::get_stats(&c, "week").unwrap();
    assert_eq!(s.by_day.len(), 7);
    assert_eq!(s.range_seconds, 240, "30 + 120 + 90");
    assert_eq!(s.pages_turned, 8);
    // today only got a single 30 s heartbeat, below the 60 s reading-day threshold, so the
    // streak anchors on yesterday (120 s) and counts back through the 90 s day → 2, not 3.
    assert_eq!(s.streak_days, 2);
}

/// Same shape, but today is a real reading day → the streak includes it.
#[test]
fn b4_streak_includes_today_once_threshold_reached() {
    let c = conn();
    st::record_tick(&c, ALICE, 30, 1).unwrap();
    st::record_tick(&c, ALICE, 30, 1).unwrap(); // 60 s total today → reading day
    seed_session(&c, ALICE, 1, 120, 4);
    seed_session(&c, ALICE, 2, 90, 3);

    let s = st::get_stats(&c, "week").unwrap();
    assert_eq!(s.range_seconds, 270, "60 today + 120 + 90");
    assert_eq!(s.pages_turned, 9, "2 today + 4 + 3");
    assert_eq!(s.streak_days, 3, "today + 2 previous days");
    assert_eq!(s.by_day.last().unwrap().seconds, 60);
}

#[test]
fn b4_week_and_month_windows_zero_fill() {
    let c = conn();
    seed_session(&c, ALICE, 0, 61, 2);
    seed_session(&c, ALICE, 6, 61, 2);

    let week = st::get_stats(&c, "week").unwrap();
    assert_eq!(week.by_day.len(), 7);
    assert_eq!(week.by_day.first().unwrap().date, st::day_index_back(6));
    assert_eq!(week.by_day.last().unwrap().date, st::day_index_back(0));
    assert_eq!(week.by_day.iter().filter(|d| d.seconds == 0).count(), 5);
    assert_eq!(week.range_seconds, 122);

    let month = st::get_stats(&c, "month").unwrap();
    assert_eq!(month.by_day.len(), 30);
    assert_eq!(month.by_day.first().unwrap().date, st::day_index_back(29));
    assert_eq!(month.range_seconds, 122);
    assert_eq!(month.by_day.iter().filter(|d| d.seconds == 0).count(), 28);

    let day = st::get_stats(&c, "day").unwrap();
    assert_eq!(day.by_day.len(), 1);
    assert_eq!(day.range_seconds, 61);

    let all = st::get_stats(&c, "all").unwrap();
    assert_eq!(all.by_day.len(), 2, "only days with data");
    assert_eq!(all.range_seconds, 122);
}

#[test]
fn b4_streak_five_days_then_gap() {
    let c = conn();
    for ago in 0..5 {
        seed_session(&c, ALICE, ago, 300, 10);
    }
    seed_session(&c, ALICE, 5, 10, 1); // below the 60 s threshold → gap
    seed_session(&c, ALICE, 6, 300, 10);
    seed_session(&c, ALICE, 7, 300, 10);

    let s = st::get_stats(&c, "month").unwrap();
    assert_eq!(s.streak_days, 5);
    assert_eq!(s.range_seconds, 5 * 300 + 10 + 300 + 300);
}

#[test]
fn b4_streak_survives_an_empty_today() {
    let c = conn();
    // 4 consecutive reading days ending yesterday; today only pages, no seconds
    for ago in 1..=4 {
        seed_session(&c, ALICE, ago, 300, 10);
    }
    seed_session(&c, ALICE, 0, 0, 12);

    let s = st::get_stats(&c, "week").unwrap();
    assert_eq!(s.streak_days, 4, "counts back from yesterday");
    assert_eq!(s.pages_turned, 52);
    assert_eq!(s.books_touched, 1, "today's zero-second row does not count");
}

#[test]
fn b4_streak_resets_without_recent_reading() {
    let c = conn();
    seed_session(&c, ALICE, 3, 300, 10);
    seed_session(&c, ALICE, 4, 300, 10);
    assert_eq!(st::get_stats(&c, "week").unwrap().streak_days, 0);
    assert_eq!(st::get_stats(&c, "all").unwrap().streak_days, 0);
    assert_eq!(
        st::get_stats(&conn(), "week").unwrap().streak_days,
        0,
        "empty db"
    );
}

#[test]
fn b4_streak_counts_seconds_across_books() {
    let c = conn();
    seed_session(&c, ALICE, 0, 40, 1);
    seed_session(&c, FRANK, 0, 40, 1); // 80 s total → reading day
    seed_session(&c, ALICE, 1, 61, 2);

    let s = st::get_stats(&c, "week").unwrap();
    assert_eq!(s.streak_days, 2);
    assert_eq!(s.books_touched, 2);
    assert_eq!(s.by_day.last().unwrap().seconds, 80);
}

#[test]
fn b4_books_touched_counts_distinct_books_with_seconds() {
    let c = conn();
    seed_session(&c, ALICE, 0, 100, 5);
    seed_session(&c, ALICE, 3, 100, 5); // same book, second day → still 1
    seed_session(&c, FRANK, 1, 100, 5);
    seed_session(&c, "3333333333333333333333333333333333333333", 2, 0, 99); // pages only

    let s = st::get_stats(&c, "all").unwrap();
    assert_eq!(s.books_touched, 2);
    assert_eq!(s.pages_turned, 114);
}

// ===========================================================================
// Book stats
// ===========================================================================

#[test]
fn b4_book_stats_scoped_to_one_book() {
    let c = conn();
    seed_book(&c, ALICE, Some(1_790_000_000_000), 0.35);
    seed_book(&c, FRANK, None, 0.9);
    seed_session(&c, ALICE, 20, 100, 6);
    seed_session(&c, ALICE, 5, 200, 9);
    seed_session(&c, FRANK, 5, 5000, 400);

    let a = st::get_book_stats(&c, ALICE).unwrap();
    assert_eq!(a.total_seconds, 300);
    assert_eq!(a.pages_turned, 15);
    assert_eq!(a.first_opened_at, st::day_start_ms(&st::day_index_back(20)));
    assert_eq!(a.last_opened_at, Some(1_790_000_000_000));
    assert!((a.progress - 0.35).abs() < f64::EPSILON);

    // FRANK has no books.last_opened_at → falls back to the newest session day
    let f = st::get_book_stats(&c, FRANK).unwrap();
    assert_eq!(f.total_seconds, 5000);
    assert_eq!(f.pages_turned, 400);
    assert_eq!(f.last_opened_at, st::day_start_ms(&st::day_index_back(5)));
    assert_eq!(f.first_opened_at, f.last_opened_at);
}

#[test]
fn b4_book_stats_unknown_uid_returns_zeros() {
    let c = conn();
    let s = st::get_book_stats(&c, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef").unwrap();
    assert_eq!(s.total_seconds, 0);
    assert_eq!(s.pages_turned, 0);
    assert_eq!(s.first_opened_at, None);
    assert_eq!(s.last_opened_at, None);
    assert_eq!(s.progress, 0.0);
}

// ===========================================================================
// Wire format (§4.1 camelCase) — what the frontend actually receives
// ===========================================================================

#[test]
fn b4_dto_wire_format_is_camel_case() {
    let c = conn();
    let hl = ann::add_highlight(&c, ALICE, 1, "s", "e", "#a8e6a3", "цитата").unwrap();
    ann::add_note(&c, ALICE, 1, "s", "e", "sel", "note").unwrap();
    ann::add_bookmark(&c, ALICE, 1, "s", Some("label")).unwrap();
    seed_session(&c, ALICE, 0, 90, 3);
    seed_book(&c, ALICE, None, 0.5);

    let listed = ann::list_highlights(&c, ALICE, None).unwrap().remove(0);
    assert_eq!(listed.id, hl.id);
    let json = serde_json::to_value(&listed).unwrap();
    for key in [
        "id",
        "bookUid",
        "chapterIdx",
        "cfiStart",
        "cfiEnd",
        "color",
        "text",
        "createdAt",
        "hasNote",
    ] {
        assert!(json.get(key).is_some(), "missing {key} in {json}");
    }
    assert_eq!(json["hasNote"], true);
    assert_eq!(json["text"], "цитата");
    assert!(json.get("book_uid").is_none());

    let json = serde_json::to_value(&ann::list_notes(&c, None).unwrap()[0]).unwrap();
    for key in [
        "id",
        "bookUid",
        "chapterIdx",
        "cfiStart",
        "cfiEnd",
        "selectedText",
        "noteText",
        "createdAt",
        "updatedAt",
    ] {
        assert!(json.get(key).is_some(), "missing {key} in {json}");
    }

    let json = serde_json::to_value(&ann::list_bookmarks(&c, None).unwrap()[0]).unwrap();
    for key in ["id", "bookUid", "chapterIdx", "cfi", "label", "createdAt"] {
        assert!(json.get(key).is_some(), "missing {key} in {json}");
    }

    let json = serde_json::to_value(st::get_stats(&c, "week").unwrap()).unwrap();
    for key in [
        "rangeSeconds",
        "byDay",
        "pagesTurned",
        "booksTouched",
        "streakDays",
    ] {
        assert!(json.get(key).is_some(), "missing {key} in {json}");
    }
    assert_eq!(json["byDay"].as_array().unwrap().len(), 7);
    let day0 = &json["byDay"][6];
    assert!(day0.get("date").is_some() && day0.get("seconds").is_some());

    let json = serde_json::to_value(st::get_book_stats(&c, ALICE).unwrap()).unwrap();
    for key in [
        "totalSeconds",
        "pagesTurned",
        "firstOpenedAt",
        "lastOpenedAt",
        "progress",
    ] {
        assert!(json.get(key).is_some(), "missing {key} in {json}");
    }
}
