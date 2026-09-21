//! FTS5 full-book search (§4.5) — owned by B5.
//!
//! * [`index`] builds `book_search` in the background and emits progress events.
//! * [`query`] sanitizes user input and runs `MATCH` + `snippet()` over it.
//!
//! Trigger points: B3's `open_book` calls [`index::maybe_reindex`] (auto-index a book that
//! has never been indexed); the `reindex_book` command forces a rebuild; `search_in_book`
//! returns `[]` until the index is ready and kickstarts indexing on first use.

pub mod index;
pub mod query;

use rusqlite::Connection;

use crate::dto::{IndexState, IndexStatus};

/// Test-support DDL: the §4.4 subset B5 reads and writes (`books`, `chapters`,
/// `book_search`).
///
/// Tests build their own temp DBs from this instead of calling `db::migrate`, so B5 is
/// verifiable while B3's migration is still in flight (the contract's §4.4 DDL is exact, so
/// this stays in sync by construction). Not `#[cfg(test)]` because integration tests in
/// `src-tauri/tests/` are a separate crate and can only see `pub` items.
pub const TEST_DDL: &str = "\
CREATE TABLE IF NOT EXISTS books(
  uid TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '[]',
  cover_path TEXT, added_at INTEGER NOT NULL, last_opened_at INTEGER,
  progress REAL NOT NULL DEFAULT 0, position TEXT,
  total_chapters INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chapters(book_uid TEXT NOT NULL, idx INTEGER NOT NULL,
  href TEXT NOT NULL, title TEXT, char_count INTEGER, PRIMARY KEY(book_uid, idx));
CREATE VIRTUAL TABLE IF NOT EXISTS book_search USING fts5(
  book_uid UNINDEXED, chapter_idx UNINDEXED, chapter_title, body,
  tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS highlights(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL, cfi_start TEXT NOT NULL, cfi_end TEXT NOT NULL,
  color TEXT NOT NULL, created_at INTEGER NOT NULL);
";

/// Map the `books.indexed` column (§4.4: 0 none, 1 indexing, 2 ready, -1 error) onto the
/// DTO, filling in chapter progress.
///
/// `chapters_done` prefers the indexer's live counter (exact, updates as chapters land) and
/// otherwise counts `chapters.char_count`, which only a *successful* index writes: inserts
/// and char_count updates share one transaction, so a ready book reports `done == total`
/// and an errored one reports `done == 0` — nothing was committed, and that is the honest
/// number for a UI offering "Build index".
pub fn index_status(conn: &Connection, uid: &str, indexed: i64) -> IndexStatus {
    let state = index_state_from_db(indexed);
    let chapters_total = count_or(
        conn,
        uid,
        "SELECT COUNT(*) FROM chapters WHERE book_uid = ?1",
        0,
    );
    let chapters_done = index::progress(uid)
        .map(|(done, _)| done)
        .unwrap_or_else(|| count_char_counted(conn, uid));

    IndexStatus {
        state,
        chapters_done,
        // Never report a total smaller than done (a live task can know more than the
        // committed `chapters` rows do).
        chapters_total: chapters_total.max(chapters_done),
    }
}

/// `indexed` column → DTO state (§4.4).
pub fn index_state_from_db(indexed: i64) -> IndexState {
    match indexed {
        1 => IndexState::Indexing,
        2 => IndexState::Ready,
        -1 => IndexState::Error,
        // 0, and anything unexpected, is "not indexed".
        _ => IndexState::None,
    }
}

/// Read `books.indexed`; `None` when the book does not exist.
pub fn read_indexed(conn: &Connection, uid: &str) -> Option<i64> {
    conn.query_row("SELECT indexed FROM books WHERE uid = ?1", [uid], |r| {
        r.get(0)
    })
    .ok()
}

/// Count chapters whose `char_count` was filled in by indexing.
fn count_char_counted(conn: &Connection, uid: &str) -> i64 {
    count_or(
        conn,
        uid,
        "SELECT COUNT(*) FROM chapters WHERE book_uid = ?1 AND char_count IS NOT NULL",
        0,
    )
}

fn count_or(conn: &Connection, uid: &str, sql: &str, fallback: i64) -> i64 {
    conn.query_row(sql, [uid], |r| r.get::<_, i64>(0))
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn indexed_column_maps_to_states() {
        assert_eq!(index_state_from_db(0), IndexState::None);
        assert_eq!(index_state_from_db(1), IndexState::Indexing);
        assert_eq!(index_state_from_db(2), IndexState::Ready);
        assert_eq!(index_state_from_db(-1), IndexState::Error);
        // Unknown values degrade to "none" rather than claiming an index exists.
        assert_eq!(index_state_from_db(7), IndexState::None);
        assert_eq!(index_state_from_db(-5), IndexState::None);
    }

    #[test]
    fn status_reports_counts_from_a_live_db() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(TEST_DDL).unwrap();
        conn.execute(
            "INSERT INTO books(uid, path, title, added_at, indexed) VALUES ('u1','/b/x.epub','X',0,0)",
            [],
        )
        .unwrap();
        for i in 0..3 {
            conn.execute(
                "INSERT INTO chapters(book_uid, idx, href, title, char_count) VALUES ('u1',?1,?2,?3,NULL)",
                rusqlite::params![i, format!("c{i}.xhtml"), format!("Ch {i}")],
            )
            .unwrap();
        }

        let s = index_status(&conn, "u1", 0);
        assert_eq!(s.state, IndexState::None);
        assert_eq!(s.chapters_total, 3);
        assert_eq!(s.chapters_done, 0);

        // After a successful index, char_count is filled → done == total.
        conn.execute(
            "UPDATE chapters SET char_count = 42 WHERE book_uid = 'u1'",
            [],
        )
        .unwrap();
        let s = index_status(&conn, "u1", 2);
        assert_eq!(s.state, IndexState::Ready);
        assert_eq!(s.chapters_done, 3);
        assert_eq!(s.chapters_total, 3);

        // An errored index committed nothing (single transaction), so char_count is NULL
        // everywhere and the honest count is 0 — which is what a retry UI should show.
        conn.execute("UPDATE chapters SET char_count = NULL", [])
            .unwrap();
        let s = index_status(&conn, "u1", -1);
        assert_eq!(s.state, IndexState::Error);
        assert_eq!(s.chapters_done, 0);
        assert_eq!(s.chapters_total, 3);
    }

    #[test]
    fn missing_book_reads_as_none() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(TEST_DDL).unwrap();
        assert_eq!(read_indexed(&conn, "nope"), None);
    }
}
