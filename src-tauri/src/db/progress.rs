//! Reading positions, last_opened, toc/chapter cache (§3) — owned by B3.
//!
//! Positions are stored as the exact [`ReadingPosition`] JSON in `books.position`, with
//! `books.progress` mirroring `globalPct` so listings can sort without parsing JSON.
//! Toc/chapters are cached at import so opening a book never re-parses the epub (§1).

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::now_ms;
use crate::dto::{ChapterMeta, ReadingPosition, TocEntry};

/// Persist a reading position: upsert `books.position` (exact JSON), mirror
/// `progress = globalPct`, and stamp `last_opened_at = now`.
///
/// `saved_at` is taken from the caller's position when set, else stamped now.
pub fn save_position(c: &Connection, uid: &str, pos: &ReadingPosition) -> anyhow::Result<()> {
    let json = serde_json::to_string(pos)?;
    let progress = pos.global_pct.clamp(0.0, 1.0);
    let opened = if pos.saved_at > 0 {
        pos.saved_at
    } else {
        now_ms()
    };
    c.execute(
        "UPDATE books SET position = ?1, progress = ?2, last_opened_at = ?3 WHERE uid = ?4",
        params![json, progress, opened, uid],
    )?;
    Ok(())
}

/// Load the stored position, or None when the book has never been read (or the uid is
/// unknown). Corrupt JSON degrades to None rather than erroring — a book must still open.
pub fn load_position(c: &Connection, uid: &str) -> anyhow::Result<Option<ReadingPosition>> {
    // Two Option layers: outer = row absent (unknown uid), inner = position column NULL
    // (never read). `.optional()` only converts QueryReturnedNoRows, so the column read
    // itself must be Option-typed or NULL rows would surface as type errors.
    let cell: Option<Option<String>> = c
        .query_row("SELECT position FROM books WHERE uid = ?1", [uid], |r| {
            r.get::<_, Option<String>>(0)
        })
        .optional()?;
    Ok(cell
        .flatten()
        .and_then(|j| serde_json::from_str::<ReadingPosition>(&j).ok()))
}

/// Touch `last_opened_at = now_ms()` without changing the position (used when a book is
/// opened but the reader hasn't produced a position yet).
pub fn touch_last_opened(c: &Connection, uid: &str) -> anyhow::Result<()> {
    c.execute(
        "UPDATE books SET last_opened_at = ?1 WHERE uid = ?2",
        params![now_ms(), uid],
    )?;
    Ok(())
}

/// Replace-all cache of a book's toc (§4.1). `idx` is the flat vec position (0-based),
/// matching [`TocEntry::parent_idx`] semantics.
pub fn cache_toc(c: &Connection, uid: &str, toc: &[TocEntry]) -> anyhow::Result<()> {
    let tx = c.unchecked_transaction()?;
    cache_toc_in(&tx, uid, toc)?;
    tx.commit()?;
    Ok(())
}

/// [`cache_toc`] body without the transaction wrapper — for callers (import) that
/// already hold an outer transaction. SQLite has no nested BEGIN, so the public wrapper
/// and this split keep both paths single-transaction.
pub fn cache_toc_in(c: &Connection, uid: &str, toc: &[TocEntry]) -> anyhow::Result<()> {
    c.execute("DELETE FROM toc WHERE book_uid = ?1", [uid])?;
    let mut stmt = c.prepare_cached(
        "INSERT INTO toc(book_uid, idx, title, chapter_idx, cfi, level, parent_idx) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?;
    for (i, e) in toc.iter().enumerate() {
        stmt.execute(params![
            uid,
            i as i64,
            e.title,
            e.chapter_idx,
            e.cfi,
            e.level,
            e.parent_idx
        ])?;
    }
    Ok(())
}

/// Read the cached toc in idx order.
pub fn load_toc(c: &Connection, uid: &str) -> anyhow::Result<Vec<TocEntry>> {
    let mut stmt = c.prepare(
        "SELECT title, chapter_idx, cfi, level, parent_idx FROM toc \
         WHERE book_uid = ?1 ORDER BY idx",
    )?;
    let rows = stmt.query_map([uid], crate::db::library::row_to_toc)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Replace-all cache of a book's chapters. `idx` is the spine position (see
/// `db::library` module docs — full-spine index, matching B2's serve + B5's plan).
pub fn cache_chapters(c: &Connection, uid: &str, chapters: &[ChapterMeta]) -> anyhow::Result<()> {
    let tx = c.unchecked_transaction()?;
    cache_chapters_in(&tx, uid, chapters)?;
    tx.commit()?;
    Ok(())
}

/// [`cache_chapters`] body without the transaction wrapper — see [`cache_toc_in`].
pub fn cache_chapters_in(
    c: &Connection,
    uid: &str,
    chapters: &[ChapterMeta],
) -> anyhow::Result<()> {
    c.execute("DELETE FROM chapters WHERE book_uid = ?1", [uid])?;
    let mut stmt = c.prepare_cached(
        "INSERT INTO chapters(book_uid, idx, href, title, char_count) \
         VALUES(?1, ?2, ?3, ?4, ?5)",
    )?;
    for ch in chapters {
        stmt.execute(params![uid, ch.idx, ch.href, ch.title, ch.char_count])?;
    }
    Ok(())
}

/// Read the cached chapters in idx order.
pub fn load_chapters(c: &Connection, uid: &str) -> anyhow::Result<Vec<ChapterMeta>> {
    let mut stmt = c.prepare(
        "SELECT idx, href, title, char_count FROM chapters WHERE book_uid = ?1 ORDER BY idx",
    )?;
    let rows = stmt.query_map([uid], crate::db::library::row_to_chapter)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Set `books.indexed` (§4.4: 0 none, 1 indexing, 2 ready, -1 error). B5's index task
/// uses this as the durable state anchor; `get_index_status` reads it back.
pub fn set_index_state(c: &Connection, uid: &str, state: i8) -> anyhow::Result<()> {
    c.execute(
        "UPDATE books SET indexed = ?1 WHERE uid = ?2",
        params![state as i64, uid],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::library::{self, testutil::*, BookRecord};
    use crate::dto::{ReadMode, TocEntry};

    fn seed(c: &Connection, uid: &str) {
        upsert(c, uid);
    }
    fn upsert(c: &Connection, uid: &str) {
        library::upsert_book(
            c,
            &BookRecord {
                uid: uid.to_owned(),
                path: format!("/books/{uid}.epub"),
                title: format!("Book {uid}"),
                authors: vec!["A".into()],
                cover_path: None,
                added_at: now_ms(),
                total_chapters: 5,
                size_bytes: 10,
            },
        )
        .unwrap();
    }

    fn pos(chapter_idx: i64, global_pct: f64) -> ReadingPosition {
        ReadingPosition {
            cfi: Some("epubcfi(/4/2/6/1:12)".into()),
            chapter_idx,
            pct_within_chapter: 0.5,
            page_index: Some(3),
            page_count: Some(40),
            mode: ReadMode::Paginated,
            global_pct,
            saved_at: now_ms(),
        }
    }

    /// Position JSON survives a save→load roundtrip byte-for-byte (field-exact).
    #[test]
    fn position_roundtrip_exact() {
        let (paths, dir) = temp_paths("pos");
        let c = open_test_db(&paths);
        seed(&c, "u1");

        let p = pos(2, 0.42);
        save_position(&c, "u1", &p).unwrap();
        let back = load_position(&c, "u1").unwrap().expect("position present");
        assert_eq!(back, p, "position must roundtrip exactly");

        // progress mirrors globalPct; last_opened_at stamped from saved_at.
        let meta = library::book_meta(&c, "u1").unwrap().unwrap();
        assert!((meta.progress - 0.42).abs() < 1e-9);
        assert_eq!(meta.position_chapter_idx, Some(2));
        assert_eq!(meta.last_opened_at, Some(p.saved_at));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// progress is clamped to [0,1] and load returns None for a never-read book.
    #[test]
    fn position_clamp_and_absent() {
        let (paths, dir) = temp_paths("posclamp");
        let c = open_test_db(&paths);
        seed(&c, "u1");
        assert!(load_position(&c, "u1").unwrap().is_none(), "fresh → None");
        assert!(
            load_position(&c, "nope").unwrap().is_none(),
            "unknown uid → None"
        );

        let mut p = pos(0, 1.7);
        save_position(&c, "u1", &p).unwrap();
        assert_eq!(library::book_meta(&c, "u1").unwrap().unwrap().progress, 1.0);
        p.global_pct = -0.5;
        save_position(&c, "u1", &p).unwrap();
        assert_eq!(library::book_meta(&c, "u1").unwrap().unwrap().progress, 0.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// saved_at == 0 → stamped now rather than persisted as 0.
    #[test]
    fn touch_last_opened_stamps_now() {
        let (paths, dir) = temp_paths("touch");
        let c = open_test_db(&paths);
        seed(&c, "u1");
        assert!(library::book_meta(&c, "u1")
            .unwrap()
            .unwrap()
            .last_opened_at
            .is_none());
        touch_last_opened(&c, "u1").unwrap();
        let opened = library::book_meta(&c, "u1")
            .unwrap()
            .unwrap()
            .last_opened_at
            .unwrap();
        assert!(opened > 1_700_000_000_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// toc + chapters cache roundtrip, replace-all semantics, ordered by idx.
    #[test]
    fn cache_toc_and_chapters_roundtrip() {
        let (paths, dir) = temp_paths("cache");
        let c = open_test_db(&paths);
        seed(&c, "u1");

        let toc = vec![
            TocEntry {
                title: "Cover".into(),
                chapter_idx: 0,
                cfi: None,
                level: 1,
                parent_idx: None,
            },
            TocEntry {
                title: "Ch 1".into(),
                chapter_idx: 1,
                cfi: Some("epubcfi(/4/2)".into()),
                level: 2,
                parent_idx: Some(0),
            },
            TocEntry {
                title: "Unresolved".into(),
                chapter_idx: -1,
                cfi: None,
                level: 1,
                parent_idx: None,
            },
        ];
        cache_toc(&c, "u1", &toc).unwrap();
        assert_eq!(load_toc(&c, "u1").unwrap(), toc);

        // replace-all: a shorter toc fully supersedes the old one.
        let toc2 = vec![TocEntry {
            title: "Only".into(),
            chapter_idx: 0,
            cfi: None,
            level: 1,
            parent_idx: None,
        }];
        cache_toc(&c, "u1", &toc2).unwrap();
        assert_eq!(load_toc(&c, "u1").unwrap(), toc2);

        let chapters = vec![
            ChapterMeta {
                idx: 0,
                href: "a.xhtml".into(),
                title: Some("A".into()),
                char_count: Some(100),
            },
            ChapterMeta {
                idx: 1,
                href: "b.xhtml".into(),
                title: None,
                char_count: None,
            },
        ];
        cache_chapters(&c, "u1", &chapters).unwrap();
        assert_eq!(load_chapters(&c, "u1").unwrap(), chapters);

        // Out-of-order insert still loads ordered by idx.
        let unordered = vec![
            ChapterMeta {
                idx: 5,
                href: "e.xhtml".into(),
                title: None,
                char_count: None,
            },
            ChapterMeta {
                idx: 2,
                href: "b.xhtml".into(),
                title: None,
                char_count: None,
            },
        ];
        cache_chapters(&c, "u1", &unordered).unwrap();
        let loaded = load_chapters(&c, "u1").unwrap();
        assert_eq!(loaded[0].idx, 2);
        assert_eq!(loaded[1].idx, 5);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// set_index_state writes the §4.4 indexed codes; B5 reads them back.
    #[test]
    fn set_index_state_roundtrip() {
        let (paths, dir) = temp_paths("idxstate");
        let c = open_test_db(&paths);
        seed(&c, "u1");
        for s in [0i8, 1, 2, -1] {
            set_index_state(&c, "u1", s).unwrap();
            let got: i64 = c
                .query_row("SELECT indexed FROM books WHERE uid='u1'", [], |r| r.get(0))
                .unwrap();
            assert_eq!(got, s as i64);
        }
        // search::index_state_from_db maps the codes onto the DTO states.
        assert_eq!(
            crate::search::index_state_from_db(2),
            crate::dto::IndexState::Ready
        );
        assert_eq!(
            crate::search::index_state_from_db(-1),
            crate::dto::IndexState::Error
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
