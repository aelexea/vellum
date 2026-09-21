//! books/tags/scan-dirs/import/covers tables (§3, §4.4) — owned by B3.
//!
//! All functions take an already-open [`Connection`] (command layer holds the short-lived
//! `state.db` lock — §11.3) and return `anyhow::Result`, collapsed into `AppError` by the
//! commands (§4.2).
//!
//! ## Interop conventions (verified against B2/B5 landed code)
//! * `chapters.idx` is the **full-spine position** (every spine item, linear or not):
//!   `epub::serve::serve_chapter` indexes `archive.spine[idx]`, B5's fallback plan
//!   enumerates the full spine, and B1 resolves `TocEntry.chapter_idx` to the spine
//!   position — all three must agree with the rows written at import.
//! * `books.total_chapters` is the **linear** spine count (§4.8 import algorithm); for
//!   all-linear books (every Gutenberg fixture) the two coincide.
//! * Cover files are written as `covers_dir/{uid}.{ext}` because B2's `protocol.rs`
//!   discovers covers by exactly that pattern.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::db::{now_ms, progress};
use crate::dto::{
    BookDetail, BookMeta, ChapterMeta, ImportIssue, ImportReport, LibraryFilter, Tag,
};
use crate::epub::BookArchive;
use crate::state::AppState;

/// Columns selected by every book read, in [`row_to_book`]'s order. The trailing
/// correlated subquery flattens tag names into one `char(31)`-separated string so a
/// listing stays a single statement (500-row budget: §1 < 5 ms).
const BOOK_COLS: &str = "b.uid, b.path, b.title, b.authors, b.cover_path, b.added_at, \
     b.last_opened_at, b.progress, b.position, b.total_chapters, b.size_bytes, b.missing, \
     (SELECT group_concat(t.name, char(31)) FROM book_tags bt \
        JOIN tags t ON t.id = bt.tag_id WHERE bt.book_uid = b.uid)";

/// Separator produced by `group_concat(…, char(31))` — unit separator, never in tag names.
const TAG_SEP: char = '\u{1f}';

/// Raw column values for an insert/update of one `books` row (import path). A dedicated
/// record instead of [`BookMeta`] because the DTO carries `cover_url` (a `vellum://`
/// string) while the table stores `cover_path` (absolute fs path) — see DEVIATIONS.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BookRecord {
    pub uid: String,
    pub path: String,
    pub title: String,
    pub authors: Vec<String>,
    /// Absolute path of the cached cover file, or None.
    pub cover_path: Option<String>,
    pub added_at: i64,
    pub total_chapters: i64,
    pub size_bytes: i64,
}

/// Map a `books` row (with [`BOOK_COLS`] shape) to the DTO (§11.3 row mapper).
pub fn row_to_book(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookMeta> {
    let uid: String = row.get(0)?;
    let authors_json: String = row.get(3)?;
    let cover_path: Option<String> = row.get(4)?;
    let position_json: Option<String> = row.get(8)?;
    let tags_concat: Option<String> = row.get(12)?;

    // Corrupt JSON must not sink a listing: degrade to empty (authors) / None (position).
    let authors: Vec<String> = serde_json::from_str(&authors_json).unwrap_or_default();
    let position_chapter_idx = position_json
        .as_deref()
        .and_then(|j| serde_json::from_str::<crate::dto::ReadingPosition>(j).ok())
        .map(|p| p.chapter_idx);

    // cover_path presence (not its value) is what matters: the frontend always fetches
    // through the protocol route, so we hand it the canonical uid-based URL.
    let cover_url = cover_path.map(|_| format!("vellum://covers/{uid}"));

    Ok(BookMeta {
        uid,
        title: row.get(2)?,
        authors,
        path: row.get(1)?,
        cover_url,
        progress: row.get(7)?,
        position_chapter_idx,
        total_chapters: row.get(9)?,
        added_at: row.get(5)?,
        last_opened_at: row.get(6)?,
        tags: tags_concat
            .map(|s| {
                s.split(TAG_SEP)
                    .filter(|t| !t.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        size_bytes: row.get(10)?,
        missing: row.get::<_, i64>(11)? != 0,
    })
}

/// Map a `toc` row (SELECT title, chapter_idx, cfi, level, parent_idx) to the DTO.
pub fn row_to_toc(row: &rusqlite::Row<'_>) -> rusqlite::Result<crate::dto::TocEntry> {
    Ok(crate::dto::TocEntry {
        title: row.get(0)?,
        chapter_idx: row.get(1)?,
        cfi: row.get(2)?,
        level: row.get(3)?,
        parent_idx: row.get(4)?,
    })
}

/// Map a `chapters` row (SELECT idx, href, title, char_count) to the DTO.
pub fn row_to_chapter(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChapterMeta> {
    Ok(ChapterMeta {
        idx: row.get(0)?,
        href: row.get(1)?,
        title: row.get(2)?,
        char_count: row.get(3)?,
    })
}

/// Escape `%`, `_` and `\` so a user query matches literally inside `LIKE … ESCAPE '\'`.
fn escape_like(q: &str) -> String {
    let mut out = String::with_capacity(q.len() + 4);
    for ch in q.chars() {
        if matches!(ch, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// List books per [`LibraryFilter`] (§4.1): query → title/authors LIKE, tag → join,
/// missing hide/only/all, sort per enum with a deterministic `uid` tiebreaker.
///
/// Single prepared statement, two always-bound params (`NULL` disables a predicate), so
/// SQLite caches one query plan for every filter combination.
pub fn list_books(c: &Connection, filter: &LibraryFilter) -> anyhow::Result<Vec<BookMeta>> {
    let like = filter
        .query
        .as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(|q| format!("%{}%", escape_like(q)));
    let tag = filter
        .tag
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_owned);

    let missing_clause = match filter.missing {
        crate::dto::MissingFilter::Hide => " AND b.missing = 0",
        crate::dto::MissingFilter::Only => " AND b.missing = 1",
        crate::dto::MissingFilter::All => "",
    };

    let dir = if filter.sort_desc { "DESC" } else { "ASC" };
    // Never-opened books always sort last regardless of direction (NULLS LAST both ways).
    let order = match filter.sort {
        crate::dto::LibrarySort::LastOpened => format!("b.last_opened_at {dir} NULLS LAST"),
        crate::dto::LibrarySort::Title => format!("b.title COLLATE NOCASE {dir}"),
        crate::dto::LibrarySort::Author => {
            format!("COALESCE(json_extract(b.authors, '$[0]'), '') COLLATE NOCASE {dir}")
        }
        // 'percent' is the whole-book progress too (§4.1 LibraryFilter['sort']).
        crate::dto::LibrarySort::Progress | crate::dto::LibrarySort::Percent => {
            format!("b.progress {dir}")
        }
        crate::dto::LibrarySort::Added => format!("b.added_at {dir}"),
    };

    let sql = format!(
        "SELECT {BOOK_COLS} FROM books b \
         WHERE (?1 IS NULL OR b.title LIKE ?2 ESCAPE '\\' OR b.authors LIKE ?2 ESCAPE '\\') \
           AND (?3 IS NULL OR EXISTS(SELECT 1 FROM book_tags bt2 \
                    JOIN tags t2 ON t2.id = bt2.tag_id \
                    WHERE bt2.book_uid = b.uid AND t2.name = ?3)) \
           {missing_clause} \
         ORDER BY {order}, b.uid ASC"
    );

    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(params![like, like, tag], row_to_book)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// One book's meta (tags included), or None when the uid is unknown.
pub fn book_meta(c: &Connection, uid: &str) -> anyhow::Result<Option<BookMeta>> {
    let sql = format!("SELECT {BOOK_COLS} FROM books b WHERE b.uid = ?1");
    let mut stmt = c.prepare(&sql)?;
    Ok(stmt.query_row(params![uid], row_to_book).optional()?)
}

/// [`BookDetail`] = meta + cached toc + cached chapters (§4.1).
pub fn get_book(c: &Connection, uid: &str) -> anyhow::Result<Option<BookDetail>> {
    let Some(meta) = book_meta(c, uid)? else {
        return Ok(None);
    };
    Ok(Some(BookDetail {
        toc: progress::load_toc(c, uid)?,
        chapters: progress::load_chapters(c, uid)?,
        meta,
    }))
}

/// Insert a book row; on uid conflict refresh the file-facing columns but **preserve**
/// reading state (progress, position, last_opened_at, added_at, indexed).
pub fn upsert_book(c: &Connection, b: &BookRecord) -> anyhow::Result<()> {
    let authors_json = serde_json::to_string(&b.authors)?;
    c.execute(
        "INSERT INTO books(uid, path, title, authors, cover_path, added_at, \
             total_chapters, size_bytes) \
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
         ON CONFLICT(uid) DO UPDATE SET \
             path = excluded.path, title = excluded.title, authors = excluded.authors, \
             cover_path = excluded.cover_path, total_chapters = excluded.total_chapters, \
             size_bytes = excluded.size_bytes, missing = 0",
        params![
            b.uid,
            b.path,
            b.title,
            authors_json,
            b.cover_path,
            b.added_at,
            b.total_chapters,
            b.size_bytes
        ],
    )?;
    Ok(())
}

/// All tags with their book counts (§4.1 `Tag`), alphabetical, used tags only.
pub fn list_tags(c: &Connection) -> anyhow::Result<Vec<Tag>> {
    let mut stmt = c.prepare(
        "SELECT t.id, t.name, COUNT(bt.book_uid) FROM tags t \
         JOIN book_tags bt ON bt.tag_id = t.id \
         GROUP BY t.id, t.name ORDER BY t.name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Tag {
            id: r.get(0)?,
            name: r.get(1)?,
            count: r.get(2)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// Replace-all book tags (§4.8): dedupe/trim input, create missing tag rows, then prune
/// tags no book references anymore (keeps `list_tags` free of orphans).
pub fn set_book_tags(c: &Connection, uid: &str, tags: &[String]) -> anyhow::Result<()> {
    let tx = c.unchecked_transaction()?;
    tx.execute("DELETE FROM book_tags WHERE book_uid = ?1", [uid])?;
    let mut seen = HashSet::new();
    for raw in tags {
        let name = raw.trim();
        if name.is_empty() || !seen.insert(name) {
            continue;
        }
        tx.execute("INSERT OR IGNORE INTO tags(name) VALUES(?1)", [name])?;
        let id: i64 = tx.query_row("SELECT id FROM tags WHERE name = ?1", [name], |r| r.get(0))?;
        tx.execute(
            "INSERT OR IGNORE INTO book_tags(book_uid, tag_id) VALUES(?1, ?2)",
            params![uid, id],
        )?;
    }
    tx.execute(
        "DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM book_tags)",
        [],
    )?;
    tx.commit()?;
    Ok(())
}

/// Delete a book and every related row (§4.8). `vocab.book_uid` intentionally keeps its
/// dangling string (words outlive books). With `delete_file`, the epub and its cached
/// cover are removed from disk **after** the DB commit; fs errors are non-fatal.
pub fn delete_book(c: &Connection, uid: &str, delete_file: bool) -> anyhow::Result<()> {
    let files: Option<(String, Option<String>)> = c
        .query_row(
            "SELECT path, cover_path FROM books WHERE uid = ?1",
            [uid],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;

    let tx = c.unchecked_transaction()?;
    for sql in [
        "DELETE FROM books WHERE uid = ?1",
        "DELETE FROM toc WHERE book_uid = ?1",
        "DELETE FROM chapters WHERE book_uid = ?1",
        "DELETE FROM book_tags WHERE book_uid = ?1",
        "DELETE FROM book_search WHERE book_uid = ?1",
        "DELETE FROM highlights WHERE book_uid = ?1",
        "DELETE FROM notes WHERE book_uid = ?1",
        "DELETE FROM bookmarks WHERE book_uid = ?1",
        "DELETE FROM sessions WHERE book_uid = ?1",
    ] {
        tx.execute(sql, [uid])?;
    }
    tx.commit()?;

    if delete_file {
        if let Some((path, cover)) = files {
            let _ = std::fs::remove_file(&path);
            if let Some(cover) = cover {
                let _ = std::fs::remove_file(&cover);
            }
        }
    }
    Ok(())
}

/// Rescan-lite (§4.9): stat every book's path; flip `missing` both ways. Returns the
/// number of rows whose flag changed.
pub fn mark_missing(c: &Connection) -> anyhow::Result<usize> {
    let rows: Vec<(String, String, i64)> = {
        let mut stmt = c.prepare("SELECT uid, path, missing FROM books")?;
        let it = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        let mut v = Vec::new();
        for r in it {
            v.push(r?);
        }
        v
    };

    let mut updates: Vec<(String, i64)> = Vec::new();
    for (uid, path, cur) in rows {
        let present = std::fs::metadata(&path)
            .map(|m| m.is_file())
            .unwrap_or(false);
        let new = i64::from(!present);
        if new != cur {
            updates.push((uid, new));
        }
    }

    let tx = c.unchecked_transaction()?;
    for (uid, new) in &updates {
        tx.execute(
            "UPDATE books SET missing = ?1 WHERE uid = ?2",
            params![new, uid],
        )?;
    }
    tx.commit()?;
    Ok(updates.len())
}

/// Resolve a book path by uid for the `vellum://` protocol (B2 uses via AppState).
pub fn path_by_uid(state: &AppState, uid: &str) -> anyhow::Result<Option<String>> {
    let conn = state
        .db
        .lock()
        .map_err(|_| anyhow::anyhow!("db lock poisoned"))?;
    Ok(conn
        .query_row("SELECT path FROM books WHERE uid = ?1", [uid], |r| r.get(0))
        .optional()?)
}

// ---------------------------------------------------------------------------
// Import (§4.8 algorithm) — headless core, driven by commands/library.rs
// ---------------------------------------------------------------------------

/// Result of importing one file: exactly one of the three is set.
#[derive(Debug, Clone, Default)]
pub struct ImportOutcome {
    pub imported: Option<BookMeta>,
    pub skipped: Option<ImportIssue>,
    pub failed: Option<ImportIssue>,
}

impl ImportOutcome {
    fn imported(b: BookMeta) -> Self {
        Self {
            imported: Some(b),
            ..Default::default()
        }
    }
    fn skipped(path: &str, reason: &str) -> Self {
        Self {
            skipped: Some(ImportIssue {
                path: path.to_owned(),
                reason: reason.to_owned(),
            }),
            ..Default::default()
        }
    }
    fn failed(path: &str, reason: impl std::fmt::Display) -> Self {
        Self {
            failed: Some(ImportIssue {
                path: path.to_owned(),
                reason: reason.to_string(),
            }),
            ..Default::default()
        }
    }
    fn merge_into(self, report: &mut ImportReport) {
        if let Some(b) = self.imported {
            report.imported.push(b);
        }
        if let Some(s) = self.skipped {
            report.skipped.push(s);
        }
        if let Some(f) = self.failed {
            report.failed.push(f);
        }
    }
}

/// Panic guard around B1's epub API: the scaffold stubs are `unimplemented!()` until B1
/// lands, and even after that a malformed book must degrade to `failed`, never take the
/// process down (same containment pattern B2's serve.rs uses).
fn epub_guard<T>(f: impl FnOnce() -> T) -> Option<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).ok()
}

/// Import one `.epub` file (§4.8 algorithm): metadata → uid → dedupe → cover → book row
/// → toc/chapters cache. Single transaction for all writes; a failure leaves no partial
/// rows.
pub fn import_epub(c: &Connection, covers_dir: &Path, path: &str) -> anyhow::Result<ImportOutcome> {
    let p = Path::new(path);
    let size_bytes = match std::fs::metadata(p) {
        Ok(m) if m.is_file() => m.len() as i64,
        Ok(_) => return Ok(ImportOutcome::failed(path, "not a file")),
        Err(e) => {
            return Ok(ImportOutcome::failed(
                path,
                format!("file unavailable: {e}"),
            ))
        }
    };

    let archive = match epub_guard(|| crate::epub::open_book(path)) {
        Some(Ok(a)) => a,
        Some(Err(e)) => return Ok(ImportOutcome::failed(path, format!("{e:#}"))),
        None => return Ok(ImportOutcome::failed(path, "EPUB parser unavailable")),
    };

    let uid = match epub_guard(|| crate::epub::compute_uid(&archive.metadata, p)) {
        Some(Ok(u)) if !u.is_empty() => u,
        Some(Err(e)) => return Ok(ImportOutcome::failed(path, format!("{e:#}"))),
        _ => return Ok(ImportOutcome::failed(path, "failed to compute book uid")),
    };

    // Already in the library → refresh where the file lives now, report as skipped.
    let exists: bool = c
        .query_row("SELECT 1 FROM books WHERE uid = ?1", [&uid], |_| Ok(true))
        .optional()?
        .unwrap_or(false);
    if exists {
        c.execute(
            "UPDATE books SET path = ?1, size_bytes = ?2 WHERE uid = ?3",
            params![path, size_bytes, uid],
        )?;
        return Ok(ImportOutcome::skipped(path, "already in library"));
    }

    let cover_path = extract_cover(covers_dir, &uid, path, &archive);

    let title = {
        let t = archive.metadata.title.trim();
        if t.is_empty() {
            p.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| uid.clone())
        } else {
            t.to_owned()
        }
    };

    let chapters = build_chapters(&archive);
    let total_chapters = archive.spine.iter().filter(|s| s.linear).count() as i64;

    let record = BookRecord {
        uid: uid.clone(),
        path: path.to_owned(),
        title,
        authors: archive.metadata.authors.clone(),
        cover_path,
        added_at: now_ms(),
        total_chapters,
        size_bytes,
    };

    // One transaction: book row + toc + chapters land together or not at all. The `_in`
    // cache variants run inside *this* transaction — the public wrappers would try to open
    // a nested one, which SQLite rejects ("cannot start a transaction within a transaction").
    let tx = c.unchecked_transaction()?;
    upsert_book(&tx, &record)?;
    progress::cache_toc_in(&tx, &uid, &archive.toc)?;
    progress::cache_chapters_in(&tx, &uid, &chapters)?;
    tx.commit()?;

    let meta = book_meta(c, &uid)?.unwrap_or_default();
    Ok(ImportOutcome::imported(meta))
}

/// Import many files, emitting `import-progress` via `emit(done, total, current)` after
/// each file (§4.8 event). Never fails per-file: issues land in the report.
pub fn import_many(
    c: &Connection,
    covers_dir: &Path,
    files: &[String],
    emit: &dyn Fn(usize, usize, &str),
) -> anyhow::Result<ImportReport> {
    let total = files.len();
    let mut report = ImportReport::default();
    for (i, path) in files.iter().enumerate() {
        emit(i, total, path);
        match import_epub(c, covers_dir, path) {
            Ok(outcome) => outcome.merge_into(&mut report),
            Err(e) => ImportOutcome::failed(path, format!("{e:#}")).merge_into(&mut report),
        }
    }
    emit(total, total, "");
    Ok(report)
}

/// `chapters` rows: every spine item at its full-spine index (see module docs), title
/// taken from the toc entry pointing at the same chapter (§4.8 import algorithm).
fn build_chapters(archive: &BookArchive) -> Vec<ChapterMeta> {
    archive
        .spine
        .iter()
        .enumerate()
        .map(|(i, item)| ChapterMeta {
            idx: i as i64,
            href: item.href.clone(),
            title: archive
                .toc
                .iter()
                .find(|t| t.chapter_idx == i as i64)
                .map(|t| t.title.clone()),
            char_count: None,
        })
        .collect()
}

/// Cover extraction chain (§4.8 + architecture-review RAM fix): B1's `find_cover_href` →
/// raw bytes via `zip_entry_bytes` → **thumbnail** (≤512px, JPEG) → `covers_dir/{uid}.jpg`.
///
/// The thumbnail is essential at scale: full-res covers (pg84's is 1824×2726 ≈ 19 MB
/// decoded RGBA) held in RAM by WebKitGTK's non-subsample Cairo backend would blow the
/// §1 RAM<400MB / 60fps budget on a 500-book grid. The verbatim original stays available
/// through `vellum://book/{uid}/cover` (B2's serve_cover reads it straight from the zip),
/// so nothing is lost. Any failure → None (no cover, book still imports); the frontend
/// falls back to a generated placeholder.
fn extract_cover(
    covers_dir: &Path,
    uid: &str,
    zip_path: &str,
    archive: &BookArchive,
) -> Option<String> {
    let href = epub_guard(|| crate::epub::find_cover_href(archive)).flatten()?;
    let bytes = match epub_guard(|| crate::epub::zip_entry_bytes(zip_path, &href)) {
        Some(Ok(b)) if !b.is_empty() => b,
        _ => return None,
    };

    // Downscale + re-encode; never fail the import over a cover — fall back to the
    // verbatim original bytes if the format can't be decoded (exotic/animated).
    let thumb = make_cover_thumb(&bytes).unwrap_or(bytes);

    if std::fs::create_dir_all(covers_dir).is_err() {
        return None;
    }
    // Always `.jpg`: make_cover_thumb emits JPEG, and the fallback (rare, undecodable)
    // keeps its original bytes under the same name — B2's cover discovery globs the
    // extension, and serve_cover sniffs the actual bytes for the mime type.
    let file = covers_dir.join(format!("{uid}.jpg"));
    std::fs::write(&file, &thumb).ok()?;
    Some(file.to_string_lossy().into_owned())
}

/// Longest edge of a stored cover thumbnail (px). Balances grid crispness against the
/// §1 RAM budget: 512px JPEG ≈ tens of KB decoded vs ~19 MB for a full-res cover.
const COVER_THUMB_MAX_EDGE: u32 = 512;
/// JPEG quality for cover thumbnails (§ architecture-review: ~82).
const COVER_JPEG_QUALITY: u8 = 82;

/// Decode cover bytes, downscale to ≤[`COVER_THUMB_MAX_EDGE`]px (aspect preserved), and
/// re-encode as JPEG. Returns `Err` only when the input can't be decoded or encoded — the
/// caller falls back to the original bytes, so import never fails on a cover.
///
/// Public + not `cfg(test)` so the integration test in `src-tauri/tests/` (a separate
/// crate) can exercise it directly.
pub fn make_cover_thumb(bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
    use std::io::Cursor;

    let img = image::load_from_memory(bytes)?;
    // `resize` preserves aspect ratio and never upscales past the original when it's
    // already smaller, so small covers pass through at native size (still re-encoded).
    let resized = img.resize(
        COVER_THUMB_MAX_EDGE,
        COVER_THUMB_MAX_EDGE,
        image::imageops::FilterType::Triangle,
    );
    // JPEG has no alpha; flatten to RGB so transparent PNGs don't encode as black.
    let rgb = resized.to_rgb8();

    let mut out = Cursor::new(Vec::new());
    {
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, COVER_JPEG_QUALITY);
        use image::ImageEncoder;
        enc.write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )?;
    }
    Ok(out.into_inner())
}

/// Recursively collect `*.epub` files under `dir` (§4.8 scan_directory): hand-rolled
/// walk, depth cap 8, hidden dirs/files skipped, sorted for deterministic import order.
pub fn collect_epubs(dir: &Path) -> Vec<String> {
    const MAX_DEPTH: usize = 8;
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(dir.to_path_buf(), 0)];
    while let Some((path, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&path) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue; // hidden dirs/files
            }
            let p = entry.path();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if depth + 1 < MAX_DEPTH {
                    stack.push((p, depth + 1));
                }
            } else if name.to_ascii_lowercase().ends_with(".epub") {
                out.push(p.to_string_lossy().into_owned());
            }
        }
    }
    out.sort();
    out
}

// ---------------------------------------------------------------------------
// Test support — `pub` (not cfg(test)) because integration tests in src-tauri/tests/
// are a separate crate and can only see public items (same pattern as search::TEST_DDL).
// ---------------------------------------------------------------------------

pub mod testutil {
    use std::io::Write;
    use std::path::{Path, PathBuf};

    use super::*;
    use crate::db::{self, AppPaths};

    /// Fresh collision-free temp dir (parallel cargo threads + concurrent WP agents).
    pub fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "vellum-b3-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    /// Temp [`AppPaths`] rooted at a fresh dir.
    pub fn temp_paths(tag: &str) -> (AppPaths, PathBuf) {
        let dir = temp_dir(tag);
        let covers = dir.join("covers");
        std::fs::create_dir_all(&covers).unwrap();
        let p = AppPaths {
            data_dir: dir.clone(),
            config_dir: dir.clone(),
            cache_dir: dir.clone(),
            covers_dir: covers,
            backups_dir: dir.join("backups"),
            db_path: dir.join("vellum.db"),
        };
        (p, dir)
    }

    /// Open + migrate a throwaway DB.
    pub fn open_test_db(paths: &AppPaths) -> Connection {
        let c = db::open(paths).expect("open test db");
        db::migrate(&c).expect("migrate test db");
        c
    }

    /// Seed a book row directly (no epub needed) and return its record.
    #[allow(clippy::too_many_arguments)]
    pub fn seed_book(
        c: &Connection,
        uid: &str,
        title: &str,
        authors: &[&str],
        path: &str,
        added_at: i64,
    ) -> BookRecord {
        let rec = BookRecord {
            uid: uid.to_owned(),
            path: path.to_owned(),
            title: title.to_owned(),
            authors: authors.iter().map(|s| s.to_string()).collect(),
            cover_path: None,
            added_at,
            total_chapters: 2,
            size_bytes: 1024,
        };
        upsert_book(c, &rec).expect("seed book");
        rec
    }

    /// 1x1 transparent PNG (smallest valid file with a real PNG signature).
    pub const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    /// Build a minimal but fully spec-shaped EPUB2 (mimetype + container + OPF with
    /// cover-image + NCX + 2 chapters + cover.png) inside `dir`, named `{name}.epub`.
    ///
    /// `dc:identifier` embeds `name`, so two fixtures never share a uid. Exercises B1's
    /// whole parse chain (container → OPF → NCX) exactly like a real book.
    pub fn build_fixture_epub(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(format!("{name}.epub"));
        let file = std::fs::File::create(&path).expect("create fixture epub");
        let mut zw = zip::ZipWriter::new(file);

        // mimetype: first entry, STORED (EPUB spec).
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        let deflated = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        zw.start_file("mimetype", stored).unwrap();
        zw.write_all(b"application/epub+zip").unwrap();

        let container = r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;
        zw.start_file("META-INF/container.xml", deflated).unwrap();
        zw.write_all(container.as_bytes()).unwrap();

        let opf = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Fixture {name}</dc:title>
    <dc:creator opf:role="aut">Author {name}</dc:creator>
    <dc:identifier id="bookid" opf:scheme="UUID">urn:uuid:vellum-fixture-{name}</dc:identifier>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-img" href="cover.png" media-type="image/png"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1" linear="yes"/>
    <itemref idref="ch2" linear="yes"/>
  </spine>
</package>"#
        );
        zw.start_file("OEBPS/content.opf", deflated).unwrap();
        zw.write_all(opf.as_bytes()).unwrap();

        let ncx = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:vellum-fixture-{name}"/></head>
  <docTitle><text>Fixture {name}</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>Chapter One</text></navLabel>
      <content src="ch1.xhtml"/>
    </navPoint>
    <navPoint id="np2" playOrder="2">
      <navLabel><text>Chapter Two</text></navLabel>
      <content src="ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>"#
        );
        zw.start_file("OEBPS/toc.ncx", deflated).unwrap();
        zw.write_all(ncx.as_bytes()).unwrap();

        for (n, body) in [
            (
                1,
                "Alice was beginning to get very tired of sitting by her sister.",
            ),
            (
                2,
                "So she was considering in her own mind whether the game was worth it.",
            ),
        ] {
            let xhtml = format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter {n}</title></head>
<body><h1>Chapter {n}</h1><p>{body}</p></body></html>"#
            );
            zw.start_file(format!("OEBPS/ch{n}.xhtml"), deflated)
                .unwrap();
            zw.write_all(xhtml.as_bytes()).unwrap();
        }

        zw.start_file("OEBPS/cover.png", deflated).unwrap();
        zw.write_all(PNG_1X1).unwrap();

        zw.finish().expect("finish fixture epub");
        path
    }

    /// Is B1's epub parser live? Its scaffold stubs are `unimplemented!()`, so tests that
    /// need real parsing skip (with a printed note) until B1 lands.
    ///
    /// The probe call must be *inside* `catch_unwind` — a stub `unimplemented!()` panics at
    /// the call site, so calling `open_book` first would abort before the guard runs. When
    /// B1 is a stub the panic is caught (→ false); when live, `open_book` on a nonexistent
    /// path returns `Err` without panicking (→ true).
    pub fn b1_available() -> bool {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            crate::epub::open_book("/nonexistent-vellum-probe.epub")
        }))
        .is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;
    use crate::db::progress;
    use crate::dto::{LibrarySort, MissingFilter};
    use std::time::Duration;

    fn filter() -> LibraryFilter {
        LibraryFilter {
            query: None,
            tag: None,
            sort: LibrarySort::Added,
            sort_desc: false,
            missing: MissingFilter::All,
        }
    }

    /// `mark_missing` flips both directions after a file appears/disappears.
    #[test]
    fn mark_missing_tracks_file_lifecycle() {
        let (paths, dir) = temp_paths("missing");
        let c = open_test_db(&paths);
        let epub = dir.join("book.epub");
        std::fs::write(&epub, b"x").unwrap();
        seed_book(&c, "u1", "B", &["A"], &epub.to_string_lossy(), now_ms());

        assert_eq!(mark_missing(&c).unwrap(), 0, "present → no change");
        std::fs::rename(&epub, dir.join("gone.epub")).unwrap();
        assert_eq!(mark_missing(&c).unwrap(), 1, "rename away → 1 changed");
        let b = book_meta(&c, "u1").unwrap().unwrap();
        assert!(b.missing, "must be flagged missing");
        std::fs::rename(dir.join("gone.epub"), &epub).unwrap();
        assert_eq!(mark_missing(&c).unwrap(), 1, "restored → 1 changed back");
        assert!(!book_meta(&c, "u1").unwrap().unwrap().missing);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Tags: replace-all semantics, dedupe/trim, counts, orphan prune.
    #[test]
    fn tags_roundtrip_and_counts() {
        let (paths, dir) = temp_paths("tags");
        let c = open_test_db(&paths);
        seed_book(&c, "u1", "B1", &["A"], "/p1", now_ms());
        seed_book(&c, "u2", "B2", &["A"], "/p2", now_ms());

        set_book_tags(
            &c,
            "u1",
            &[
                "классика".into(),
                " классика ".into(), // dup after trim
                "".into(),           // ignored
                "фантастика".into(),
            ],
        )
        .unwrap();
        set_book_tags(&c, "u2", &["классика".into()]).unwrap();

        let tags = list_tags(&c).unwrap();
        let by_name: std::collections::HashMap<_, _> =
            tags.iter().map(|t| (t.name.as_str(), t.count)).collect();
        assert_eq!(by_name.get("классика").copied(), Some(2));
        assert_eq!(by_name.get("фантастика").copied(), Some(1));

        let b1 = book_meta(&c, "u1").unwrap().unwrap();
        let mut t = b1.tags.clone();
        t.sort();
        assert_eq!(t, ["классика", "фантастика"]);

        // Replace-all: dropping a tag removes the now-orphaned tags row.
        set_book_tags(&c, "u1", &["новое".into()]).unwrap();
        let b1 = book_meta(&c, "u1").unwrap().unwrap();
        assert_eq!(b1.tags, ["новое"]);
        let names: Vec<String> = list_tags(&c).unwrap().into_iter().map(|t| t.name).collect();
        assert!(!names.contains(&"фантастика".to_string()), "orphan pruned");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Sort matrix: title, author, progress, added, desc, and lastOpened nulls-last.
    #[test]
    fn list_filter_sort_matrix() {
        let (paths, dir) = temp_paths("matrix");
        let c = open_test_db(&paths);
        // added_at increasing b1<b2<b3; titles/first-authors chosen to differ.
        seed_book(&c, "b1", "Zebra", &["Мопассан"], "/p1", 100);
        seed_book(&c, "b2", "apple", &["Бунин"], "/p2", 200);
        seed_book(&c, "b3", "Манго", &["Арбузов"], "/p3", 300);

        // title asc, case-insensitive: apple, Zebra, then Cyrillic (Манго collates after)
        let f = LibraryFilter {
            sort: LibrarySort::Title,
            sort_desc: false,
            ..filter()
        };
        let uids: Vec<String> = list_books(&c, &f)
            .unwrap()
            .into_iter()
            .map(|b| b.uid)
            .collect();
        assert_eq!(uids[0], "b2", "apple first (case-insensitive)");

        // author asc: Арбузов, Бунин, Мопассан
        let f = LibraryFilter {
            sort: LibrarySort::Author,
            sort_desc: false,
            ..filter()
        };
        let uids: Vec<String> = list_books(&c, &f)
            .unwrap()
            .into_iter()
            .map(|b| b.uid)
            .collect();
        assert_eq!(uids, ["b3", "b2", "b1"]);

        // added desc
        let f = LibraryFilter {
            sort: LibrarySort::Added,
            sort_desc: true,
            ..filter()
        };
        let uids: Vec<String> = list_books(&c, &f)
            .unwrap()
            .into_iter()
            .map(|b| b.uid)
            .collect();
        assert_eq!(uids, ["b3", "b2", "b1"]);

        // query on author substring
        let f = LibraryFilter {
            query: Some("Мопас".into()),
            ..filter()
        };
        let got = list_books(&c, &f).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].uid, "b1");

        // query on title
        let f = LibraryFilter {
            query: Some("zeb".into()),
            ..filter()
        };
        let got = list_books(&c, &f).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].uid, "b1");

        // lastOpened nulls-last on desc: never-opened (all null here) stay last.
        progress::touch_last_opened(&c, "b2").unwrap();
        let f = LibraryFilter {
            sort: LibrarySort::LastOpened,
            sort_desc: true,
            ..filter()
        };
        let uids: Vec<String> = list_books(&c, &f)
            .unwrap()
            .into_iter()
            .map(|b| b.uid)
            .collect();
        assert_eq!(uids[0], "b2", "opened book first");
        assert!(uids[1..].contains(&"b1".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Tag filter narrows the listing.
    #[test]
    fn tag_filter_narrows() {
        let (paths, dir) = temp_paths("tagfilter");
        let c = open_test_db(&paths);
        seed_book(&c, "u1", "B1", &["A"], "/p1", now_ms());
        seed_book(&c, "u2", "B2", &["A"], "/p2", now_ms());
        set_book_tags(&c, "u1", &["only-u1".into()]).unwrap();
        let f = LibraryFilter {
            tag: Some("only-u1".into()),
            ..filter()
        };
        let got = list_books(&c, &f).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].uid, "u1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Missing filter: hide excludes missing, only shows just missing.
    #[test]
    fn missing_filter_modes() {
        let (paths, dir) = temp_paths("missingfilter");
        let c = open_test_db(&paths);
        let here = dir.join("here.epub");
        std::fs::write(&here, b"x").unwrap();
        seed_book(
            &c,
            "present",
            "P",
            &["A"],
            &here.to_string_lossy(),
            now_ms(),
        );
        seed_book(&c, "absent", "A", &["A"], "/does/not/exist.epub", now_ms());
        mark_missing(&c).unwrap();

        let hide = LibraryFilter {
            missing: MissingFilter::Hide,
            ..filter()
        };
        let uids: Vec<String> = list_books(&c, &hide)
            .unwrap()
            .into_iter()
            .map(|b| b.uid)
            .collect();
        assert_eq!(uids, ["present"]);

        let only = LibraryFilter {
            missing: MissingFilter::Only,
            ..filter()
        };
        let uids: Vec<String> = list_books(&c, &only)
            .unwrap()
            .into_iter()
            .map(|b| b.uid)
            .collect();
        assert_eq!(uids, ["absent"]);

        let all = LibraryFilter {
            missing: MissingFilter::All,
            ..filter()
        };
        assert_eq!(list_books(&c, &all).unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// delete_book removes every related row; with delete_file the epub + cover go too.
    #[test]
    fn delete_removes_rows_and_optional_file() {
        let (paths, dir) = temp_paths("delete");
        let c = open_test_db(&paths);
        let epub = dir.join("book.epub");
        std::fs::write(&epub, b"data").unwrap();
        let cover = paths.covers_dir.join("u1.png");
        std::fs::write(&cover, PNG_1X1).unwrap();

        let rec = BookRecord {
            uid: "u1".into(),
            path: epub.to_string_lossy().into_owned(),
            title: "B".into(),
            authors: vec!["A".into()],
            cover_path: Some(cover.to_string_lossy().into_owned()),
            added_at: now_ms(),
            total_chapters: 1,
            size_bytes: 4,
        };
        upsert_book(&c, &rec).unwrap();
        set_book_tags(&c, "u1", &["t".into()]).unwrap();
        progress::cache_toc(
            &c,
            "u1",
            &[crate::dto::TocEntry {
                title: "T".into(),
                chapter_idx: 0,
                cfi: None,
                level: 1,
                parent_idx: None,
            }],
        )
        .unwrap();
        progress::cache_chapters(
            &c,
            "u1",
            &[ChapterMeta {
                idx: 0,
                href: "c.xhtml".into(),
                title: Some("T".into()),
                char_count: None,
            }],
        )
        .unwrap();
        c.execute(
            "INSERT INTO sessions(book_uid, day) VALUES('u1','2026-01-01')",
            [],
        )
        .unwrap();

        delete_book(&c, "u1", true).unwrap();
        assert!(book_meta(&c, "u1").unwrap().is_none());
        for (table, col) in [
            ("toc", "book_uid"),
            ("chapters", "book_uid"),
            ("book_tags", "book_uid"),
            ("sessions", "book_uid"),
        ] {
            let n: i64 = c
                .query_row(
                    &format!("SELECT count(*) FROM {table} WHERE {col}='u1'"),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 0, "{table} rows must be gone");
        }
        assert!(!epub.exists(), "epub file deleted");
        assert!(!cover.exists(), "cover file deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// delete_book without delete_file keeps the epub on disk but drops rows.
    #[test]
    fn delete_keeps_file_when_flag_false() {
        let (paths, dir) = temp_paths("deletekeep");
        let c = open_test_db(&paths);
        let epub = dir.join("book.epub");
        std::fs::write(&epub, b"data").unwrap();
        seed_book(&c, "u1", "B", &["A"], &epub.to_string_lossy(), now_ms());
        delete_book(&c, "u1", false).unwrap();
        assert!(book_meta(&c, "u1").unwrap().is_none());
        assert!(epub.exists(), "epub must remain");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 500 seeded books → list_books must be fast (§1 library budget). Reports timing.
    #[test]
    fn list_books_500_under_5ms() {
        let (paths, dir) = temp_paths("perf");
        let c = open_test_db(&paths);
        for i in 0..500 {
            let uid = format!("b{i:04}");
            seed_book(
                &c,
                &uid,
                &format!("Title {i}"),
                &[&format!("Author {i}")],
                &format!("/p{i}"),
                i as i64,
            );
            if i % 3 == 0 {
                c.execute(
                    "UPDATE books SET progress = ?1 WHERE uid = ?2",
                    params![(i as f64) / 500.0, uid],
                )
                .unwrap();
            }
            if i % 7 == 0 {
                set_book_tags(&c, &uid, &[format!("tag{}", i % 5)]).unwrap();
            }
        }

        // Warm the plan cache, then time a representative filtered listing.
        let f = LibraryFilter {
            query: Some("Title 2".into()),
            sort: LibrarySort::Title,
            ..filter()
        };
        for _ in 0..5 {
            list_books(&c, &f).unwrap();
        }
        let t0 = std::time::Instant::now();
        let n = 50;
        for _ in 0..n {
            list_books(&c, &f).unwrap();
        }
        let per = t0.elapsed() / n;
        println!("[b3] list_books(500 rows, query+title sort) = {per:?}");
        assert!(
            per < Duration::from_millis(5),
            "list_books too slow: {per:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Import path with B1 live: a self-built fixture epub parses, dedupes, covers, caches.
    /// Skipped (with a note) while B1's `open_book` is still `unimplemented!()`.
    #[test]
    fn import_fixture_epub_roundtrip() {
        if !b1_available() {
            println!("[b3] SKIP import_fixture_epub_roundtrip — needs B1 (epub::open_book stub)");
            return;
        }
        let (paths, dir) = temp_paths("import");
        let c = open_test_db(&paths);
        let epub = build_fixture_epub(&dir, "alice");

        let out = import_epub(&c, &paths.covers_dir, &epub.to_string_lossy()).unwrap();
        let book = out.imported.expect("imported");
        assert!(
            book.title.contains("alice"),
            "title from OPF: {}",
            book.title
        );
        assert_eq!(book.total_chapters, 2, "two linear spine items");
        assert!(book.cover_url.is_some(), "cover detected");
        // cover file written under covers_dir/{uid}.{ext}
        let uid = book.uid.clone();
        assert!(
            paths
                .covers_dir
                .read_dir()
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().starts_with(&uid)),
            "cover file exists"
        );

        // toc + chapters cached.
        let detail = get_book(&c, &uid).unwrap().unwrap();
        assert_eq!(detail.chapters.len(), 2);
        assert_eq!(detail.chapters[0].href, "OEBPS/ch1.xhtml");
        assert!(detail.chapters[0].title.is_some(), "toc title propagated");
        assert!(!detail.toc.is_empty(), "toc cached");

        // Re-import same file → skipped ("already in library"), no duplicate row.
        let out2 = import_epub(&c, &paths.covers_dir, &epub.to_string_lossy()).unwrap();
        let skipped = out2.skipped.expect("skipped");
        assert_eq!(skipped.reason, "already in library");
        let count: i64 = c
            .query_row("SELECT count(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "no duplicate");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Import a nonexistent file → failed, not panic.
    #[test]
    fn import_missing_file_is_failed() {
        let (paths, dir) = temp_paths("importfail");
        let c = open_test_db(&paths);
        let out = import_epub(&c, &paths.covers_dir, "/no/such/book.epub").unwrap();
        assert!(out.failed.is_some(), "missing file → failed");
        assert!(out.imported.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// collect_epubs walks recursively, depth-capped, skips hidden dirs, matches case-insensitively.
    #[test]
    fn collect_epubs_walk() {
        let dir = temp_dir("collect");
        std::fs::create_dir_all(dir.join("sub/deep")).unwrap();
        std::fs::create_dir_all(dir.join(".hidden")).unwrap();
        std::fs::write(dir.join("a.epub"), b"").unwrap();
        std::fs::write(dir.join("UPPER.EPUB"), b"").unwrap();
        std::fs::write(dir.join("b.txt"), b"").unwrap();
        std::fs::write(dir.join("sub/c.epub"), b"").unwrap();
        std::fs::write(dir.join(".hidden/skip.epub"), b"").unwrap();

        let found = collect_epubs(&dir);
        assert!(found.iter().any(|p| p.ends_with("a.epub")));
        assert!(
            found.iter().any(|p| p.ends_with("UPPER.EPUB")),
            "case-insensitive ext"
        );
        assert!(found.iter().any(|p| p.ends_with("sub/c.epub")), "recursive");
        assert!(
            !found.iter().any(|p| p.contains("skip.epub")),
            "hidden dir skipped"
        );
        assert!(
            !found.iter().any(|p| p.ends_with("b.txt")),
            "non-epub skipped"
        );
        assert_eq!(found.len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Cover thumbnailing (architecture-review RAM fix): 800x1200 PNG → decodable JPEG,
    /// max edge ≤ 512, aspect preserved.
    #[test]
    fn cover_thumb_downscales_to_jpeg() {
        // Build a solid-colour 800x1200 PNG with the image crate.
        let src = image::RgbImage::from_pixel(800, 1200, image::Rgb([200, 30, 60]));
        let mut png_bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(src)
            .write_to(&mut png_bytes, image::ImageFormat::Png)
            .unwrap();

        let t0 = std::time::Instant::now();
        let thumb = make_cover_thumb(&png_bytes.into_inner()).expect("thumb");
        let elapsed = t0.elapsed();
        println!(
            "[b3] make_cover_thumb(800x1200 png) = {elapsed:?}, {} bytes",
            thumb.len()
        );

        // Output must decode, be JPEG, and have max edge ≤ 512 with aspect preserved.
        let img = image::load_from_memory(&thumb).expect("thumb decodes");
        assert!(matches!(
            image::guess_format(&thumb),
            Ok(image::ImageFormat::Jpeg)
        ));
        let (w, h) = (img.width(), img.height());
        assert!(w.max(h) <= 512, "max edge {w}x{h} must be ≤ 512");
        // 800x1200 scaled to max edge 512 → 341x512 (aspect ~0.667).
        assert_eq!(h, 512);
        assert!((330..=355).contains(&w), "width {w} keeps aspect");
        // Colour survives the RGB flatten (JPEG is lossy, allow slack). to_rgb8() gives an
        // RgbImage with an inherent get_pixel, so no trait import is needed.
        let px = img.to_rgb8().get_pixel(w / 2, h / 2).0;
        assert!(px[0] > 150 && px[1] < 90 && px[2] < 110, "colour {px:?}");
    }

    /// Undecodable input → Err, so the caller falls back to the verbatim bytes instead of
    /// failing the import.
    #[test]
    fn cover_thumb_rejects_garbage() {
        assert!(make_cover_thumb(b"not an image at all").is_err());
        assert!(make_cover_thumb(&[]).is_err());
    }
}
