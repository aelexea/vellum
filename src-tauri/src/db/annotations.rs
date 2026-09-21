//! highlights / notes / bookmarks tables (§3, §4.4) — owned by B4.
//!
//! All functions take an already-open [`Connection`] (commands hold the short-lived
//! `state.db` lock — §11.3) and return `anyhow::Result`, collapsed into `AppError` by
//! the command layer (§4.2).
//!
//! Mutation semantics:
//! - `update_*` on a missing id → `Err` (surfaces a toast instead of silently doing nothing);
//! - `delete_*` is idempotent → `Ok(())` even when the row is gone (panels re-fire deletes).
//!
//! `Highlight.has_note` is **derived**, never stored: `EXISTS` a note with the same
//! book + chapter + cfi range (§4.8). Adding a note never touches the highlight row.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::db::now_ms;
use crate::dto::{Bookmark, Highlight, Note};

/// `EXISTS` sub-select: a note covering exactly this highlight's range (§4.8 hasNote).
const HAS_NOTE: &str = "EXISTS(SELECT 1 FROM notes n \
     WHERE n.book_uid = h.book_uid AND n.chapter_idx = h.chapter_idx \
       AND n.cfi_start = h.cfi_start AND n.cfi_end = h.cfi_end)";

/// Column list shared by every highlight read (`h.text` = v1.3 selected text; the final
/// `has_note` column is appended by each SELECT).
const HL_COLS: &str = "h.id, h.book_uid, h.chapter_idx, h.cfi_start, h.cfi_end, h.color, \
     h.text, h.created_at";

/// Order: chapter, then creation (§4.8); `id` only breaks same-ms ties deterministically.
const HL_ORDER: &str = "ORDER BY h.chapter_idx, h.created_at, h.id";

fn row_to_highlight(row: &Row<'_>) -> rusqlite::Result<Highlight> {
    Ok(Highlight {
        id: row.get(0)?,
        book_uid: row.get(1)?,
        chapter_idx: row.get(2)?,
        cfi_start: row.get(3)?,
        cfi_end: row.get(4)?,
        color: row.get(5)?,
        text: row.get(6)?,
        created_at: row.get(7)?,
        has_note: row.get::<_, i64>(8)? != 0,
    })
}

fn row_to_note(row: &Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        book_uid: row.get(1)?,
        chapter_idx: row.get(2)?,
        cfi_start: row.get(3)?,
        cfi_end: row.get(4)?,
        selected_text: row.get(5)?,
        note_text: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn row_to_bookmark(row: &Row<'_>) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark {
        id: row.get(0)?,
        book_uid: row.get(1)?,
        chapter_idx: row.get(2)?,
        cfi: row.get(3)?,
        label: row.get(4)?,
        created_at: row.get(5)?,
    })
}

/// One highlight by id (with derived `has_note`), or `None` when absent.
fn highlight_by_id(c: &Connection, id: i64) -> anyhow::Result<Option<Highlight>> {
    let sql = format!("SELECT {HL_COLS}, {HAS_NOTE} AS has_note FROM highlights h WHERE h.id = ?1");
    let hl = c
        .query_row(&sql, params![id], row_to_highlight)
        .optional()?;
    Ok(hl)
}

/// Highlights of one book, optionally narrowed to a chapter (`None` = whole book).
pub fn list_highlights(
    c: &Connection,
    uid: &str,
    chapter_idx: Option<i64>,
) -> anyhow::Result<Vec<Highlight>> {
    let sql = format!(
        "SELECT {HL_COLS}, {HAS_NOTE} AS has_note FROM highlights h \
         WHERE h.book_uid = ?1 AND (?2 IS NULL OR h.chapter_idx = ?2) {HL_ORDER}"
    );
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(params![uid, chapter_idx], row_to_highlight)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Insert a highlight and return it with its new id (§4.8 `add_highlight`).
///
/// `text` (v1.3) is the highlighted text itself, stored so the annotations panel can quote
/// it without re-deriving from CFIs; it is immutable afterwards (`update_highlight` only
/// recolors). `has_note` is computed, so highlighting a range that already carries a
/// standalone note comes back with `hasNote: true` immediately.
#[allow(clippy::too_many_arguments)]
pub fn add_highlight(
    c: &Connection,
    book_uid: &str,
    chapter_idx: i64,
    cfi_start: &str,
    cfi_end: &str,
    color: &str,
    text: &str,
) -> anyhow::Result<Highlight> {
    let created_at = now_ms();
    c.execute(
        "INSERT INTO highlights(book_uid, chapter_idx, cfi_start, cfi_end, color, text, created_at) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            book_uid,
            chapter_idx,
            cfi_start,
            cfi_end,
            color,
            text,
            created_at
        ],
    )?;
    let id = c.last_insert_rowid();
    let hl = highlight_by_id(c, id)?
        .ok_or_else(|| anyhow::anyhow!("highlight {id} vanished after insert"))?;
    Ok(hl)
}

/// Recolor a highlight; `Err` when the id is unknown.
pub fn update_highlight(c: &Connection, id: i64, color: &str) -> anyhow::Result<()> {
    let n = c.execute(
        "UPDATE highlights SET color = ?1 WHERE id = ?2",
        params![color, id],
    )?;
    if n == 0 {
        anyhow::bail!("highlight {id} not found");
    }
    Ok(())
}

/// Delete a highlight (idempotent). The note on the same range, if any, is kept —
/// it is an independent row and stays listed in the annotations panel.
pub fn delete_highlight(c: &Connection, id: i64) -> anyhow::Result<()> {
    c.execute("DELETE FROM highlights WHERE id = ?1", params![id])?;
    Ok(())
}

/// Notes for one book, or **all** books when `uid` is `None` (annotations panel).
/// Newest first (§4.8).
pub fn list_notes(c: &Connection, uid: Option<&str>) -> anyhow::Result<Vec<Note>> {
    let mut stmt = c.prepare(
        "SELECT id, book_uid, chapter_idx, cfi_start, cfi_end, selected_text, note_text, \
                created_at, updated_at \
         FROM notes WHERE (?1 IS NULL OR book_uid = ?1) \
         ORDER BY created_at DESC, id DESC",
    )?;
    let rows = stmt.query_map(params![uid], row_to_note)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// One note by id, or `None`.
pub fn get_note(c: &Connection, id: i64) -> anyhow::Result<Option<Note>> {
    let note = c
        .query_row(
            "SELECT id, book_uid, chapter_idx, cfi_start, cfi_end, selected_text, note_text, \
                    created_at, updated_at \
             FROM notes WHERE id = ?1",
            params![id],
            row_to_note,
        )
        .optional()?;
    Ok(note)
}

/// Insert a note as its own row (§4.8). A highlight with an identical range is left
/// untouched — the two only *appear* linked through `Highlight.has_note`.
#[allow(clippy::too_many_arguments)]
pub fn add_note(
    c: &Connection,
    book_uid: &str,
    chapter_idx: i64,
    cfi_start: &str,
    cfi_end: &str,
    selected_text: &str,
    note_text: &str,
) -> anyhow::Result<Note> {
    let ts = now_ms();
    c.execute(
        "INSERT INTO notes(book_uid, chapter_idx, cfi_start, cfi_end, selected_text, note_text, \
                           created_at, updated_at) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![
            book_uid,
            chapter_idx,
            cfi_start,
            cfi_end,
            selected_text,
            note_text,
            ts
        ],
    )?;
    let id = c.last_insert_rowid();
    get_note(c, id)?.ok_or_else(|| anyhow::anyhow!("note {id} vanished after insert"))
}

/// Replace a note's text and stamp `updated_at = now`; `Err` when the id is unknown.
/// `created_at` is preserved so panel ordering stays stable.
pub fn update_note(c: &Connection, id: i64, note_text: &str) -> anyhow::Result<()> {
    let n = c.execute(
        "UPDATE notes SET note_text = ?1, updated_at = ?2 WHERE id = ?3",
        params![note_text, now_ms(), id],
    )?;
    if n == 0 {
        anyhow::bail!("note {id} not found");
    }
    Ok(())
}

/// Delete a note (idempotent). A highlight on the same range survives; its `has_note`
/// simply flips back to false on the next read.
pub fn delete_note(c: &Connection, id: i64) -> anyhow::Result<()> {
    c.execute("DELETE FROM notes WHERE id = ?1", params![id])?;
    Ok(())
}

/// Bookmarks of one book, or **all** books when `uid` is `None`. By chapter, then age.
pub fn list_bookmarks(c: &Connection, uid: Option<&str>) -> anyhow::Result<Vec<Bookmark>> {
    let mut stmt = c.prepare(
        "SELECT id, book_uid, chapter_idx, cfi, label, created_at FROM bookmarks \
         WHERE (?1 IS NULL OR book_uid = ?1) \
         ORDER BY chapter_idx, created_at, id",
    )?;
    let rows = stmt.query_map(params![uid], row_to_bookmark)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Insert a bookmark and return it with its new id.
pub fn add_bookmark(
    c: &Connection,
    book_uid: &str,
    chapter_idx: i64,
    cfi: &str,
    label: Option<&str>,
) -> anyhow::Result<Bookmark> {
    let created_at = now_ms();
    c.execute(
        "INSERT INTO bookmarks(book_uid, chapter_idx, cfi, label, created_at) \
         VALUES(?1, ?2, ?3, ?4, ?5)",
        params![book_uid, chapter_idx, cfi, label, created_at],
    )?;
    let id = c.last_insert_rowid();
    let bm = c
        .query_row(
            "SELECT id, book_uid, chapter_idx, cfi, label, created_at FROM bookmarks WHERE id = ?1",
            params![id],
            row_to_bookmark,
        )
        .optional()?
        .ok_or_else(|| anyhow::anyhow!("bookmark {id} vanished after insert"))?;
    Ok(bm)
}

/// Delete a bookmark (idempotent).
pub fn delete_bookmark(c: &Connection, id: i64) -> anyhow::Result<()> {
    c.execute("DELETE FROM bookmarks WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests (§8 B4). Self-contained: in-memory DB + the §4.4 DDL copied verbatim for
// the tables used, so nothing here depends on `db::migrate` (B3, in flight).
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod testutil {
    use rusqlite::Connection;

    /// §4.4 DDL for the tables B4 touches (+ `books`, read by `get_book_stats`).
    /// Verbatim copies of the contract statements; `books` is the full §4.4 row.
    pub(crate) const SCHEMA: &str = "
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

    /// Fresh in-memory DB with [`SCHEMA`] applied.
    pub(crate) fn conn() -> Connection {
        let c = Connection::open_in_memory().expect("open in-memory db");
        c.execute_batch("PRAGMA busy_timeout=5000;").unwrap();
        c.execute_batch(SCHEMA).expect("apply §4.4 DDL");
        c
    }

    /// Minimal `books` row so `get_book_stats` has something to read.
    pub(crate) fn seed_book(c: &Connection, uid: &str, last_opened_at: Option<i64>, progress: f64) {
        c.execute(
            "INSERT INTO books(uid, path, title, added_at, last_opened_at, progress) \
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                uid,
                format!("/books/{uid}.epub"),
                format!("Book {uid}"),
                1_700_000_000_000i64,
                last_opened_at,
                progress
            ],
        )
        .expect("seed book");
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::conn;
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    // -- highlights --------------------------------------------------------

    #[test]
    fn b4_highlight_crud_roundtrip() {
        let c = conn();
        let hl = add_highlight(
            &c,
            A,
            3,
            "epubcfi(/4/2/6/1:0)",
            "epubcfi(/4/2/6/1:42)",
            "#ffe08a",
            "выделенный фрагмент",
        )
        .expect("add");
        assert!(hl.id > 0, "id from last_insert_rowid");
        assert_eq!(hl.book_uid, A);
        assert_eq!(hl.chapter_idx, 3);
        assert_eq!(hl.cfi_start, "epubcfi(/4/2/6/1:0)");
        assert_eq!(hl.cfi_end, "epubcfi(/4/2/6/1:42)");
        assert_eq!(hl.color, "#ffe08a");
        assert_eq!(hl.text, "выделенный фрагмент", "v1.3 selected text stored");
        assert!(hl.created_at > 1_700_000_000_000);
        assert!(!hl.has_note, "no note yet");

        // list sees the same row
        let all = list_highlights(&c, A, None).expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0], hl);

        // update colour — text is immutable and must survive
        update_highlight(&c, hl.id, "#a8e6a3").expect("update");
        let after = list_highlights(&c, A, None).unwrap();
        assert_eq!(after[0].color, "#a8e6a3");
        assert_eq!(
            after[0].text, "выделенный фрагмент",
            "text unchanged by recolor"
        );
        assert_eq!(after[0].created_at, hl.created_at, "created_at untouched");

        // delete
        delete_highlight(&c, hl.id).expect("delete");
        assert!(list_highlights(&c, A, None).unwrap().is_empty());
        // idempotent second delete, and unknown-id update errors
        delete_highlight(&c, hl.id).expect("delete twice is ok");
        assert!(update_highlight(&c, hl.id, "#000").is_err());
    }

    #[test]
    fn b4_highlights_filter_by_chapter_and_order() {
        let c = conn();
        let h0 = add_highlight(&c, A, 0, "s0", "e0", "#ffe08a", "t0").unwrap();
        let h2a = add_highlight(&c, A, 2, "s2a", "e2a", "#ffe08a", "t2a").unwrap();
        let h2b = add_highlight(&c, A, 2, "s2b", "e2b", "#9ecbf5", "t2b").unwrap();
        let other = add_highlight(&c, B, 2, "s", "e", "#ffe08a", "tb").unwrap();

        // whole book, ordered by chapter then creation
        let all = list_highlights(&c, A, None).unwrap();
        assert_eq!(
            all.iter().map(|h| h.id).collect::<Vec<_>>(),
            vec![h0.id, h2a.id, h2b.id]
        );
        // chapter filter
        let ch2 = list_highlights(&c, A, Some(2)).unwrap();
        assert_eq!(
            ch2.iter().map(|h| h.id).collect::<Vec<_>>(),
            vec![h2a.id, h2b.id]
        );
        assert!(list_highlights(&c, A, Some(9)).unwrap().is_empty());
        // never leaks another book's rows
        assert_eq!(list_highlights(&c, B, None).unwrap()[0].id, other.id);
    }

    // -- hasNote join ------------------------------------------------------

    #[test]
    fn b4_has_note_flips_with_matching_note_lifecycle() {
        let c = conn();
        let hl = add_highlight(&c, A, 1, "s1", "e1", "#f5a9c0", "quoted").unwrap();
        assert!(!hl.has_note);

        // a note on a *different* range must not flip it
        let elsewhere = add_note(&c, A, 1, "s1", "OTHER", "text", "note").unwrap();
        assert!(!list_highlights(&c, A, None).unwrap()[0].has_note);

        // exact same book+chapter+cfi_start+cfi_end → hasNote true
        let n = add_note(&c, A, 1, "s1", "e1", "quoted", "my note").unwrap();
        let listed = list_highlights(&c, A, None).unwrap();
        assert!(listed[0].has_note, "join should report the note");
        assert_eq!(listed[0].id, hl.id);

        // deleting the unrelated note keeps hasNote true
        delete_note(&c, elsewhere.id).unwrap();
        assert!(list_highlights(&c, A, None).unwrap()[0].has_note);

        // deleting the matching note flips it back
        delete_note(&c, n.id).unwrap();
        assert!(!list_highlights(&c, A, None).unwrap()[0].has_note);

        // same range but another chapter → still false
        add_note(&c, A, 2, "s1", "e1", "q", "n").unwrap();
        assert!(!list_highlights(&c, A, None).unwrap()[0].has_note);
        // another book, same range → still false
        add_note(&c, B, 1, "s1", "e1", "q", "n").unwrap();
        assert!(!list_highlights(&c, A, None).unwrap()[0].has_note);
    }

    #[test]
    fn b4_add_highlight_on_existing_note_range_reports_has_note() {
        let c = conn();
        add_note(&c, A, 0, "s", "e", "q", "n").unwrap();
        let hl = add_highlight(&c, A, 0, "s", "e", "#ffe08a", "q").unwrap();
        assert!(hl.has_note, "hasNote derived at insert time too");
    }

    #[test]
    fn b4_add_note_keeps_highlight_row_untouched() {
        let c = conn();
        let hl = add_highlight(&c, A, 4, "s", "e", "#cdb4f6", "selected").unwrap();
        let n = add_note(&c, A, 4, "s", "e", "selected", "body").unwrap();

        // separate rows in separate tables: the highlight keeps its own identity and is
        // unchanged apart from the derived hasNote (note ids come from the notes table,
        // so they are NOT comparable to highlight ids)
        assert_eq!(n.book_uid, hl.book_uid);
        assert_eq!(n.chapter_idx, hl.chapter_idx);
        let after = list_highlights(&c, A, None).unwrap();
        assert_eq!(after.len(), 1, "no second highlight row was created");
        assert_eq!(after[0].id, hl.id, "same highlight row");
        assert_eq!(after[0].color, "#cdb4f6");
        assert_eq!(after[0].cfi_start, "s");
        assert_eq!(after[0].created_at, hl.created_at);
        assert!(after[0].has_note);

        // deleting the highlight leaves the note listed (independent row)
        delete_highlight(&c, hl.id).unwrap();
        let notes = list_notes(&c, Some(A)).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, n.id);
        assert_eq!(notes[0].note_text, "body");
        assert!(list_highlights(&c, A, None).unwrap().is_empty());
    }

    // -- notes -------------------------------------------------------------

    #[test]
    fn b4_note_crud_roundtrip() {
        let c = conn();
        let n = add_note(&c, A, 7, "cs", "ce", "выделенный текст", "моя заметка").unwrap();
        assert!(n.id > 0);
        assert_eq!(n.selected_text, "выделенный текст");
        assert_eq!(n.note_text, "моя заметка");
        assert_eq!(n.created_at, n.updated_at, "fresh note: created == updated");

        std::thread::sleep(std::time::Duration::from_millis(2));
        update_note(&c, n.id, "обновлённая").expect("update");
        let after = get_note(&c, n.id).unwrap().expect("present");
        assert_eq!(after.note_text, "обновлённая");
        assert_eq!(
            after.selected_text, "выделенный текст",
            "selection preserved"
        );
        assert!(after.updated_at > n.updated_at, "updated_at stamped");
        assert_eq!(after.created_at, n.created_at, "created_at preserved");

        delete_note(&c, n.id).unwrap();
        assert!(get_note(&c, n.id).unwrap().is_none());
        delete_note(&c, n.id).expect("idempotent");
        assert!(update_note(&c, n.id, "x").is_err());
    }

    #[test]
    fn b4_list_notes_null_uid_spans_all_books_newest_first() {
        let c = conn();
        let a1 = add_note(&c, A, 0, "s", "e", "t1", "n1").unwrap();
        let b1 = add_note(&c, B, 1, "s", "e", "t2", "n2").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let a2 = add_note(&c, A, 2, "s", "e", "t3", "n3").unwrap();

        // null uid = annotations panel across the whole library
        let all = list_notes(&c, None).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(
            all.iter().map(|n| n.id).collect::<Vec<_>>(),
            vec![a2.id, b1.id, a1.id],
            "ORDER BY created_at DESC"
        );
        assert!(all.iter().any(|n| n.book_uid == A) && all.iter().any(|n| n.book_uid == B));
        assert_eq!(all[0].selected_text, "t3");
        assert_eq!(all[0].note_text, "n3");

        // scoped per book
        assert_eq!(list_notes(&c, Some(A)).unwrap().len(), 2);
        assert_eq!(list_notes(&c, Some(B)).unwrap().len(), 1);
        assert!(list_notes(&c, Some("nope")).unwrap().is_empty());
    }

    // -- bookmarks ---------------------------------------------------------

    #[test]
    fn b4_bookmark_crud_roundtrip() {
        let c = conn();
        let bm = add_bookmark(&c, A, 5, "epubcfi(/4/2/10/1:3)", Some("глава о монстре")).unwrap();
        assert!(bm.id > 0);
        assert_eq!(bm.chapter_idx, 5);
        assert_eq!(bm.cfi, "epubcfi(/4/2/10/1:3)");
        assert_eq!(bm.label.as_deref(), Some("глава о монстре"));

        // null label round-trips as None, not ""
        let bare = add_bookmark(&c, A, 5, "epubcfi(/4/2/10/1:9)", None).unwrap();
        assert_eq!(bare.label, None);

        let list = list_bookmarks(&c, Some(A)).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0], bm);
        assert_eq!(list[1], bare);

        delete_bookmark(&c, bm.id).unwrap();
        let list = list_bookmarks(&c, Some(A)).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, bare.id);
        delete_bookmark(&c, bm.id).expect("idempotent");
    }

    #[test]
    fn b4_list_bookmarks_null_uid_spans_books_ordered_by_chapter() {
        let c = conn();
        let b5 = add_bookmark(&c, B, 5, "cb5", None).unwrap();
        let a9 = add_bookmark(&c, A, 9, "ca9", None).unwrap();
        let a1 = add_bookmark(&c, A, 1, "ca1", Some("first")).unwrap();

        let all = list_bookmarks(&c, None).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(
            all.iter().map(|x| x.id).collect::<Vec<_>>(),
            vec![a1.id, b5.id, a9.id],
            "chapter order across books"
        );
        assert_eq!(list_bookmarks(&c, Some(A)).unwrap().len(), 2);
        assert_eq!(list_bookmarks(&c, Some(B)).unwrap().len(), 1);
    }

    // -- serde shape (frontend contract, §4.1) -----------------------------

    #[test]
    fn b4_annotation_dtos_serialize_camel_case() {
        let c = conn();
        let hl = add_highlight(&c, A, 0, "s", "e", "#ffe08a", "цитата").unwrap();
        let n = add_note(&c, A, 0, "s", "e", "sel", "note").unwrap();
        let bm = add_bookmark(&c, A, 0, "cfi", None).unwrap();
        // re-read so hasNote is the joined value
        let hl = list_highlights(&c, A, None).unwrap().remove(0);

        let json = serde_json::to_value(&hl).unwrap();
        assert_eq!(json["id"], hl.id);
        assert_eq!(json["bookUid"], A);
        assert_eq!(json["chapterIdx"], 0);
        assert_eq!(json["cfiStart"], "s");
        assert_eq!(json["cfiEnd"], "e");
        assert_eq!(json["text"], "цитата", "v1.3 selected text on the wire");
        assert_eq!(json["createdAt"], hl.created_at);
        assert_eq!(json["hasNote"], true);
        assert!(json.get("book_uid").is_none(), "must be camelCase");

        let json = serde_json::to_value(&n).unwrap();
        assert_eq!(json["selectedText"], "sel");
        assert_eq!(json["noteText"], "note");
        assert_eq!(json["updatedAt"], n.updated_at);

        let json = serde_json::to_value(&bm).unwrap();
        assert_eq!(json["label"], serde_json::Value::Null);
        assert_eq!(json["cfi"], "cfi");
    }
}
