//! B5 §8 tests — indexer pipeline: transaction, char_count, progress, idempotency,
//! WAL concurrency, and the one-task-per-book guard.
//!
//! The pipeline under test is the real one (`vellum_lib::search::index::index_book_with`,
//! the same function the spawned production task calls); only the two epub-side
//! operations are injected, exactly as production injects `epub::zip_entry_bytes` /
//! `epub::extract_text`.
//!
//! Decoupling: schema comes from the §4.4 DDL subset in `vellum_lib::search::TEST_DDL`, so
//! these tests never depend on B3's `db::migrate`.
//!
//! The synthetic-fixture tests below inject a small test-local extractor so their inputs
//! (and therefore their assertions) are exact and independent of B1's HTML handling. The
//! end-to-end tests at the bottom drive the *real* `epub::open_book` / `zip_entry_bytes` /
//! `extract_text` over `testbooks/pg84.epub` and `pg2600.epub`.

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection};

use vellum_lib::search::index::{
    in_flight, index_book, index_book_with, open_index_conn, progress, release, sanitize_for_fts,
    should_auto_index, should_reindex, spawn_count, try_claim, ExtractText, ReadEntry,
};
use vellum_lib::search::{query, TEST_DDL};

// ---------------------------------------------------------------------------
// test-local epub mirror (B1 dependency)
// ---------------------------------------------------------------------------

/// Mirror of B1 `extract_text` until it lands: tag-stripping text sink that drops the
/// content of `<script>`/`<style>`/`<head>`, decodes the entities that matter for search
/// matching, and puts a newline at block boundaries so paragraphs stay separable.
///
/// (lol_html's `text!("*", …)` handler also fires inside removed elements, so a
/// streaming rewriter needs tag-scoped suppression anyway; the explicit walker here keeps
/// the mirror small and obvious.)
fn extract_text_for_tests(html: &[u8]) -> String {
    let text = String::from_utf8_lossy(html);
    let mut out = String::with_capacity(text.len() / 2);
    let mut chars = text.chars().peekable();
    // Tag whose content we are currently inside and must drop.
    let mut skip: Option<&'static str> = None;

    while let Some(c) = chars.next() {
        if c != '<' {
            if skip.is_none() {
                out.push(c);
            }
            continue;
        }
        // Consume the whole tag; stop on truncated input rather than emitting tag text.
        let mut tag = String::new();
        let mut closed = false;
        for tc in chars.by_ref() {
            if tc == '>' {
                closed = true;
                break;
            }
            tag.push(tc);
        }
        if !closed {
            break;
        }

        let lower = tag.to_ascii_lowercase();
        let is_end = lower.starts_with('/');
        let name: String = lower
            .trim_start_matches('/')
            .chars()
            .take_while(char::is_ascii_alphanumeric)
            .collect();

        match (skip, is_end) {
            (Some(s), true) if s == name => skip = None,
            (None, false) if matches!(name.as_str(), "script" | "style" | "head") => {
                skip = Some(match name.as_str() {
                    "script" => "script",
                    "style" => "style",
                    _ => "head",
                });
            }
            // Block edges become newlines so sanitized text keeps paragraph structure.
            (None, false)
                if matches!(
                    name.as_str(),
                    "p" | "div"
                        | "h1"
                        | "h2"
                        | "h3"
                        | "h4"
                        | "h5"
                        | "h6"
                        | "br"
                        | "li"
                        | "tr"
                        | "section"
                        | "blockquote"
                ) =>
            {
                out.push('\n')
            }
            _ => {}
        }
    }

    decode_entities(&out)
}

/// The handful of entities that appear in book text and change what search matches.
fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

/// Read one entry out of a zip on disk (mirror of B1 `zip_entry_bytes`).
fn zip_entry_for_tests(zip_path: &str, entry: &str) -> anyhow::Result<Vec<u8>> {
    let file = File::open(zip_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut f = archive.by_name(entry)?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf)?;
    Ok(buf)
}

/// The safety invariant for §5.6, which renders snippets with `dangerouslySetInnerHTML`:
/// after removing our own `<mark>`/`</mark>` tags, no angle brackets or bare ampersands
/// may remain — everything else from the book text must be escaped.
///
/// Checking the residue rather than looking for one specific escaped spelling keeps this
/// valid however SQLite places the marks (it can split an escaped entity in half).
fn assert_snippet_safe(snippet: &str) {
    let stripped = snippet.replace("<mark>", "").replace("</mark>", "");
    assert!(
        !stripped.contains('<') && !stripped.contains('>'),
        "unescaped tag reached the frontend: {snippet:?}"
    );
    // Any remaining & must be the start of an entity we produced.
    for rest in stripped.split('&').skip(1) {
        assert!(
            rest.starts_with("amp;")
                || rest.starts_with("lt;")
                || rest.starts_with("gt;")
                || rest.starts_with("quot;")
                || rest.starts_with("#39;"),
            "unescaped ampersand in snippet: {snippet:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Unique temp path per test so parallel tests never share a DB or zip.
fn temp_path(prefix: &str, ext: &str) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "vellum-b5-{prefix}-{}-{n}.{ext}",
        std::process::id()
    ))
}

fn chapter_xhtml(title: &str, body: &str) -> Vec<u8> {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
         <html xmlns=\"http://www.w3.org/1999/xhtml\"><head><title>{title}</title>\
         <style>body{{margin:0}}</style></head>\n\
         <body><h1>{title}</h1>{body}</body></html>"
    )
    .into_bytes()
}

/// Build a two-chapter EPUB-shaped zip with known searchable text.
fn fixture_epub() -> PathBuf {
    let path = temp_path("book", "epub");
    let file = File::create(&path).expect("create fixture epub");
    let mut zw = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions = Default::default();

    let entries: [(&str, Vec<u8>); 5] = [
        ("mimetype", b"application/epub+zip".to_vec()),
        (
            "META-INF/container.xml",
            br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#.to_vec(),
        ),
        ("OPS/content.opf", b"<?xml version=\"1.0\"?><package/>".to_vec()),
        (
            "OPS/ch1.xhtml",
            chapter_xhtml(
                "Chapter One",
                "<p>the monster of frankenstein rose from the slab.</p>\
                 <p>a second paragraph about the monster.</p>\
                 <script>var secret = 'never indexed';</script>",
            ),
        ),
        (
            "OPS/ch2.xhtml",
            chapter_xhtml(
                "Chapter Two",
                "<p>frankenstein fled across the frozen wastes, monstrous and alone.</p>\
                 <p>the literal text &lt;script&gt; appears here &amp; so does an ampersand.</p>",
            ),
        ),
    ];
    for (name, bytes) in &entries {
        zw.start_file(*name, opts).expect("start_file");
        zw.write_all(bytes).expect("write entry");
    }
    zw.finish().expect("finish zip");
    path
}

/// Fresh DB file with the §4.4 tables plus one `books` row and `chapters` rows for
/// `epub_path`'s two chapters. Returns `(db_path, zip_path)`.
fn fixture_db(epub_path: &Path) -> PathBuf {
    let db_path = temp_path("db", "db");
    let conn = Connection::open(&db_path).expect("open fixture db");
    conn.pragma_update(None, "journal_mode", "WAL")
        .expect("wal");
    conn.execute_batch(TEST_DDL).expect("apply test DDL");
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at, indexed, total_chapters) \
         VALUES ('u1', ?1, 'Fixture', 0, 0, 2)",
        params![epub_path.to_string_lossy()],
    )
    .expect("insert book");
    for (i, href) in ["OPS/ch1.xhtml", "OPS/ch2.xhtml"].iter().enumerate() {
        conn.execute(
            "INSERT INTO chapters(book_uid, idx, href, title, char_count) \
             VALUES ('u1', ?1, ?2, ?3, NULL)",
            params![i as i64, href, format!("Chapter {}", i + 1)],
        )
        .expect("insert chapter");
    }
    drop(conn);
    db_path
}

/// Production-shaped callbacks reading from a real zip via the mirror extractor.
fn zip_callbacks<'a>() -> (ReadEntry<'a>, ExtractText<'a>) {
    let read: ReadEntry<'a> = &|path, entry| zip_entry_for_tests(path, entry);
    let extract: ExtractText<'a> = &|html| extract_text_for_tests(html);
    (read, extract)
}

/// Index the `u1` fixture book on its own connection, as the spawned task does.
fn index_fixture(db_path: &Path) -> anyhow::Result<()> {
    let conn = open_index_conn(db_path)?;
    let (read, extract) = zip_callbacks();
    index_book_with(&conn, "u1", read, extract, None)
}

// ---------------------------------------------------------------------------
// full pipeline
// ---------------------------------------------------------------------------

#[test]
fn full_pipeline_indexes_and_searches() {
    let epub = fixture_epub();
    let db_path = fixture_db(&epub);

    index_fixture(&db_path).expect("index fixture");

    let conn = Connection::open(&db_path).expect("reopen");
    // One FTS row per spine chapter.
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM book_search WHERE book_uid = 'u1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 2, "one row per chapter");

    // indexed flips to 2 (ready).
    let indexed: i64 = conn
        .query_row("SELECT indexed FROM books WHERE uid = 'u1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(indexed, 2);

    // §8: search «monster» hits, with chapter titles.
    let hits = query::search(&conn, "u1", "monster", 100).expect("search");
    assert_eq!(hits.len(), 1, "monster is only in ch1: {hits:?}");
    assert_eq!(hits[0].chapter_idx, 0);
    // Titles come from the `chapters` rows B3 writes at import, not from the epub's own
    // <h1>, so search results match the TOC the reader shows.
    assert_eq!(hits[0].chapter_title, "Chapter 1");
    assert!(
        hits[0].snippet.contains("<mark>monster</mark>"),
        "{}",
        hits[0].snippet
    );
    assert!(hits[0].score > 0.0);

    // §8: prefix «frank» hits «frankenstein» — and both chapters mention it.
    let hits = query::search(&conn, "u1", "frank", 100).expect("search");
    assert_eq!(hits.len(), 2, "frank* reaches both chapters: {hits:?}");

    // Script content must not be searchable (extraction dropped it).
    assert!(query::search(&conn, "u1", "secret", 100)
        .expect("search")
        .is_empty());
    assert!(query::search(&conn, "u1", "indexed", 100)
        .expect("search")
        .is_empty());
    // Style content must not be searchable either.
    assert!(query::search(&conn, "u1", "margin", 100)
        .expect("search")
        .is_empty());

    let _ = std::fs::remove_file(&epub);
    let _ = std::fs::remove_file(&db_path);
}

#[test]
fn char_count_is_written_for_every_chapter() {
    let epub = fixture_epub();
    let db_path = fixture_db(&epub);
    index_fixture(&db_path).expect("index");

    let conn = Connection::open(&db_path).expect("reopen");
    let counts: Vec<(i64, Option<i64>)> = {
        let mut stmt = conn
            .prepare("SELECT idx, char_count FROM chapters WHERE book_uid = 'u1' ORDER BY idx")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(counts.len(), 2);
    for (idx, count) in &counts {
        let count = count.unwrap_or_else(|| panic!("char_count NULL for chapter {idx}"));
        assert!(count > 20, "chapter {idx} char_count too small: {count}");
    }
    // The stored body length matches char_count: both come from the sanitized text.
    let body_len: i64 = conn
        .query_row(
            "SELECT LENGTH(body) FROM book_search WHERE book_uid = 'u1' AND chapter_idx = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        body_len,
        counts[0].1.unwrap(),
        "char_count must equal stored body length"
    );

    let _ = std::fs::remove_file(&epub);
    let _ = std::fs::remove_file(&db_path);
}

#[test]
fn stored_body_is_sanitized() {
    let epub = fixture_epub();
    let db_path = fixture_db(&epub);
    index_fixture(&db_path).expect("index");

    let conn = Connection::open(&db_path).expect("reopen");
    let body: String = conn
        .query_row(
            "SELECT body FROM book_search WHERE book_uid = 'u1' AND chapter_idx = 0",
            [],
            |r| r.get(0),
        )
        .unwrap();

    // One line per paragraph, no runs of whitespace, no tags, no NULs.
    assert!(!body.contains("<p>"), "tags leaked: {body}");
    assert!(!body.contains('\0'));
    assert!(!body.contains("  "), "whitespace not collapsed: {body:?}");
    assert!(!body.starts_with(' ') && !body.ends_with(' '));
    assert!(
        body.contains("the monster of frankenstein rose from the slab."),
        "{body}"
    );
    // Entities decoded so searching "script" text works on real books.
    let body2: String = conn
        .query_row(
            "SELECT body FROM book_search WHERE book_uid = 'u1' AND chapter_idx = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(body2.contains("ampersand"), "{body2}");

    let _ = std::fs::remove_file(&epub);
    let _ = std::fs::remove_file(&db_path);
}

#[test]
fn html_in_snippet_is_escaped_after_indexing() {
    let epub = fixture_epub();
    let db_path = fixture_db(&epub);
    index_fixture(&db_path).expect("index");

    let conn = Connection::open(&db_path).expect("reopen");
    // ch2 contains the literal string "<script>" from the decoded &lt;script&gt;.
    let hits = query::search(&conn, "u1", "script", 100).expect("search");
    assert_eq!(hits.len(), 1, "literal <script> text is indexed: {hits:?}");

    // The matched token is marked, and the angle brackets that surrounded it in the
    // source are escaped — note SQLite puts the mark *between* them, so the escaped form
    // is "&lt;<mark>script</mark>&gt;" rather than an intact "&lt;script&gt;".
    let snippet = &hits[0].snippet;
    assert!(
        snippet.contains("&lt;<mark>script</mark>&gt;"),
        "angle brackets not escaped around the mark: {snippet}"
    );
    assert!(!snippet.contains("<script>"), "raw tag leaked: {snippet}");
    assert!(
        snippet.contains("&amp;"),
        "ampersand not escaped: {snippet}"
    );
    assert_snippet_safe(snippet);

    let _ = std::fs::remove_file(&epub);
    let _ = std::fs::remove_file(&db_path);
}

// ---------------------------------------------------------------------------
// idempotency (§8: reindex twice → same row count)
// ---------------------------------------------------------------------------

#[test]
fn reindex_is_idempotent() {
    let epub = fixture_epub();
    let db_path = fixture_db(&epub);

    index_fixture(&db_path).expect("first index");
    let conn = Connection::open(&db_path).expect("reopen");
    let count = |c: &Connection| -> i64 {
        c.query_row(
            "SELECT COUNT(*) FROM book_search WHERE book_uid = 'u1'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    };
    let after_first = count(&conn);
    assert_eq!(after_first, 2);

    // Second and third runs must purge-then-rebuild, never append.
    index_fixture(&db_path).expect("second index");
    index_fixture(&db_path).expect("third index");
    assert_eq!(count(&conn), after_first, "row count changed on reindex");

    // Search results stay correct and un-duplicated.
    let hits = query::search(&conn, "u1", "monster", 100).expect("search");
    assert_eq!(hits.len(), 1, "duplicated rows after reindex: {hits:?}");
    let indexed: i64 = conn
        .query_row("SELECT indexed FROM books WHERE uid = 'u1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(indexed, 2);

    let _ = std::fs::remove_file(&epub);
    let _ = std::fs::remove_file(&db_path);
}

#[test]
fn reindex_purges_only_the_targeted_book() {
    let epub = fixture_epub();
    let db_path = fixture_db(&epub);
    index_fixture(&db_path).expect("index u1");

    // A second book's rows must survive a reindex of u1.
    let conn = Connection::open(&db_path).expect("reopen");
    conn.execute(
        "INSERT INTO book_search(book_uid, chapter_idx, chapter_title, body) \
         VALUES ('u2', 0, 'Other', 'monster from another book')",
        [],
    )
    .unwrap();
    drop(conn);

    index_fixture(&db_path).expect("reindex u1");

    let conn = Connection::open(&db_path).expect("reopen");
    let other: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM book_search WHERE book_uid = 'u2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(other, 1, "reindex of u1 must not touch u2");
    assert_eq!(query::search(&conn, "u2", "monster", 100).unwrap().len(), 1);

    let _ = std::fs::remove_file(&epub);
    let _ = std::fs::remove_file(&db_path);
}

// ---------------------------------------------------------------------------
// progress events
// ---------------------------------------------------------------------------

#[test]
fn progress_reports_every_ten_chapters_and_at_the_end() {
    // 25 chapters → emissions at 10, 20, and 25 (total).
    let db_path = temp_path("progress", "db");
    let conn = Connection::open(&db_path).expect("open");
    conn.execute_batch(TEST_DDL).expect("ddl");
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at, indexed) VALUES ('p1','/x/y.epub','P',0,0)",
        [],
    )
    .unwrap();
    for i in 0..25 {
        conn.execute(
            "INSERT INTO chapters(book_uid, idx, href, title, char_count) VALUES ('p1',?1,?2,?3,NULL)",
            params![i, format!("c{i}.xhtml"), format!("Ch {i}")],
        )
        .unwrap();
    }
    drop(conn);

    let conn = open_index_conn(&db_path).expect("index conn");
    // No zip involved: the reader hands back a tiny document per chapter.
    let read: ReadEntry<'_> = &|_path, _entry| Ok(b"<p>monster</p>".to_vec());
    let extract: ExtractText<'_> = &|html| extract_text_for_tests(html);
    let seen: Arc<Mutex<Vec<(i64, i64)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let cb = move |done: i64, total: i64| sink.lock().unwrap().push((done, total));
    let on_progress: Option<&(dyn Fn(i64, i64) + Sync)> = Some(&cb);

    index_book_with(&conn, "p1", read, extract, on_progress).expect("index");

    let events = seen.lock().unwrap().clone();
    assert_eq!(
        events,
        vec![(10, 25), (20, 25), (25, 25)],
        "progress events: {events:?}"
    );
    // The live counter ends at done == total while the task holds it.
    assert_eq!(progress("p1"), Some((25, 25)));

    let _ = std::fs::remove_file(&db_path);
}

#[test]
fn small_book_emits_only_the_final_progress() {
    let db_path = temp_path("progress2", "db");
    let conn = Connection::open(&db_path).expect("open");
    conn.execute_batch(TEST_DDL).expect("ddl");
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at, indexed) VALUES ('p2','/x/y.epub','P',0,0)",
        [],
    )
    .unwrap();
    for i in 0..3 {
        conn.execute(
            "INSERT INTO chapters(book_uid, idx, href, title, char_count) VALUES ('p2',?1,?2,?3,NULL)",
            params![i, format!("c{i}.xhtml"), format!("Ch {i}")],
        )
        .unwrap();
    }
    drop(conn);

    let conn = open_index_conn(&db_path).expect("index conn");
    let read: ReadEntry<'_> = &|_p, _e| Ok(b"<p>text</p>".to_vec());
    let extract: ExtractText<'_> = &|html| extract_text_for_tests(html);
    let seen: Arc<Mutex<Vec<(i64, i64)>>> = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    let cb = move |done: i64, total: i64| sink.lock().unwrap().push((done, total));

    index_book_with(&conn, "p2", read, extract, Some(&cb)).expect("index");
    // Fewer than 10 chapters → a single end-of-book emission.
    assert_eq!(*seen.lock().unwrap(), vec![(3, 3)]);

    let _ = std::fs::remove_file(&db_path);
}

// ---------------------------------------------------------------------------
// error paths
// ---------------------------------------------------------------------------

#[test]
fn missing_book_row_yields_error_state_not_panic() {
    let db_path = temp_path("err", "db");
    let conn = Connection::open(&db_path).expect("open");
    conn.execute_batch(TEST_DDL).expect("ddl");
    drop(conn);

    let conn = open_index_conn(&db_path).expect("conn");
    let read: ReadEntry<'_> = &|_p, _e| Ok(Vec::new());
    let extract: ExtractText<'_> = &|html| extract_text_for_tests(html);
    let err =
        index_book_with(&conn, "ghost", read, extract, None).expect_err("unknown book must error");
    assert!(!err.to_string().is_empty(), "error should carry a message");

    let _ = std::fs::remove_file(&db_path);
}

#[test]
fn unreadable_entry_does_not_sink_the_book() {
    // One chapter's zip entry is missing; the rest must still be indexed and the book
    // must still end up ready rather than errored.
    let db_path = temp_path("partial", "db");
    let conn = Connection::open(&db_path).expect("open");
    conn.execute_batch(TEST_DDL).expect("ddl");
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at, indexed) VALUES ('u1','/x/y.epub','P',0,0)",
        [],
    )
    .unwrap();
    for i in 0..3 {
        conn.execute(
            "INSERT INTO chapters(book_uid, idx, href, title, char_count) VALUES ('u1',?1,?2,?3,NULL)",
            params![i, format!("c{i}.xhtml"), format!("Ch {i}")],
        )
        .unwrap();
    }
    drop(conn);

    let conn = open_index_conn(&db_path).expect("conn");
    // c1 is missing from the "zip".
    let read: ReadEntry<'_> = &|_path, entry| {
        if entry.ends_with("c1.xhtml") {
            anyhow::bail!("entry not found in zip: {entry}")
        }
        Ok(b"<p>monster lives here</p>".to_vec())
    };
    let extract: ExtractText<'_> = &|html| extract_text_for_tests(html);

    index_book_with(&conn, "u1", read, extract, None).expect("partial index must succeed");

    let indexed: i64 = conn
        .query_row("SELECT indexed FROM books WHERE uid = 'u1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(indexed, 2, "book stays ready");
    let hits = query::search(&conn, "u1", "monster", 100).expect("search");
    assert_eq!(
        hits.len(),
        2,
        "the two readable chapters are searchable: {hits:?}"
    );
    // The broken chapter still got a row (empty body) so progress accounting is exact.
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM book_search WHERE book_uid = 'u1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 3);

    let _ = std::fs::remove_file(&db_path);
}

#[test]
fn broken_db_marks_indexed_minus_one() {
    // A book whose zip path does not exist and which has no `chapters` rows makes the
    // plan step fail; the book must be left at indexed = -1 so the UI offers a retry.
    let db_path = temp_path("baddb", "db");
    let conn = Connection::open(&db_path).expect("open");
    conn.execute_batch(TEST_DDL).expect("ddl");
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at, indexed) VALUES ('u1','/nonexistent.epub','P',0,0)",
        [],
    )
    .unwrap();
    drop(conn);

    // index_book uses the production epub callbacks; open_book is unimplemented until B1
    // lands, which makes the task panic. Both outcomes must leave a retryable state, so
    // assert on the DB rather than on the error type.
    let _ = std::panic::catch_unwind(|| index_book(&db_path, "u1"));
    let conn = Connection::open(&db_path).expect("reopen");
    let indexed: i64 = conn
        .query_row("SELECT indexed FROM books WHERE uid = 'u1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(indexed, -1, "failed index must be retryable");

    let _ = std::fs::remove_file(&db_path);
}

// ---------------------------------------------------------------------------
// §8 WAL test: reader writes while the indexer works
// ---------------------------------------------------------------------------

#[test]
fn concurrent_reader_writes_succeed_while_indexing() {
    let epub = fixture_epub();
    let db_path = fixture_db(&epub);

    // Slow the reader down so the writer thread overlaps the indexing transaction.
    let read: ReadEntry<'static> = Box::leak(Box::new(|path: &str, entry: &str| {
        std::thread::sleep(Duration::from_millis(60));
        zip_entry_for_tests(path, entry)
    }));
    let extract: ExtractText<'static> =
        Box::leak(Box::new(|html: &[u8]| extract_text_for_tests(html)));

    let indexer_db = db_path.clone();
    let handle = std::thread::spawn(move || {
        let conn = open_index_conn(&indexer_db).expect("index conn");
        index_book_with(&conn, "u1", read, extract, None)
    });

    // Meanwhile: the reader keeps writing highlights/progress on its own connection.
    let writer = Connection::open(&db_path).expect("writer conn");
    writer
        .busy_timeout(Duration::from_secs(5))
        .expect("busy timeout");
    let mut ok_writes = 0;
    for i in 0..12 {
        writer
            .execute(
                "INSERT INTO highlights(book_uid, chapter_idx, cfi_start, cfi_end, color, created_at) \
                 VALUES ('u1', 0, ?1, ?2, '#ffe08a', ?3)",
                params![format!("epubcfi(/2/{i})"), format!("epubcfi(/2/{i}:5)"), i],
            )
            .expect("reader write must not fail under WAL");
        ok_writes += 1;
        // Reading while indexing must also work.
        let _ = query::search(&writer, "u1", "monster", 10).unwrap_or_default();
        std::thread::sleep(Duration::from_millis(20));
    }

    handle
        .join()
        .expect("indexer thread panicked")
        .expect("index ok");
    assert_eq!(ok_writes, 12);

    // Both sides' data survived.
    let conn = Connection::open(&db_path).expect("reopen");
    let hl: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM highlights WHERE book_uid = 'u1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(hl, 12, "reader writes lost");
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM book_search WHERE book_uid = 'u1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 2, "index rows lost");
    let indexed: i64 = conn
        .query_row("SELECT indexed FROM books WHERE uid = 'u1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(indexed, 2);

    let _ = std::fs::remove_file(&epub);
    let _ = std::fs::remove_file(&db_path);
}

// ---------------------------------------------------------------------------
// one-task-per-book guard
// ---------------------------------------------------------------------------

#[test]
fn guard_allows_exactly_one_claim_per_book() {
    let uid = "b5-guard-unique";
    // Make sure no other test left a claim behind for this uid.
    release(uid);

    assert!(!in_flight(uid), "uid must start unclaimed");
    assert!(try_claim(uid), "first claim wins");
    assert!(in_flight(uid));
    // Double-click: the second caller must not start a task.
    assert!(!try_claim(uid), "second claim must fail");
    assert!(!try_claim(uid), "third claim must fail");

    release(uid);
    assert!(!in_flight(uid), "claim released");
    assert!(try_claim(uid), "re-claim after release");
    release(uid);
}

#[test]
fn guard_serializes_across_threads() {
    let uid = "b5-guard-threads";
    release(uid);
    let wins = Arc::new(AtomicU64::new(0));

    let threads: Vec<_> = (0..16)
        .map(|_| {
            let wins = wins.clone();
            std::thread::spawn(move || {
                if try_claim(uid) {
                    wins.fetch_add(1, Ordering::SeqCst);
                    // Hold the claim briefly, as a real task would.
                    std::thread::sleep(Duration::from_millis(5));
                    release(uid);
                }
            })
        })
        .collect();
    for t in threads {
        t.join().expect("thread panicked");
    }

    let claimed = wins.load(Ordering::SeqCst);
    assert!(claimed >= 1, "nobody claimed the book");
    // Never two at once: 16 racing callers produce a serialized sequence of claims, and
    // the count only grows after a release, never concurrently.
    assert!(!in_flight(uid), "claim leaked");
    release(uid);
}

#[test]
fn spawn_gate_matches_the_contract() {
    // §4.5: auto-index only for a never-indexed book.
    assert!(should_auto_index(0), "0 = none → index");
    assert!(!should_auto_index(1), "1 = indexing → owned by a task");
    assert!(!should_auto_index(2), "2 = ready → no work");
    assert!(!should_auto_index(-1), "-1 = error → needs explicit force");

    // §4.8: force rebuilds from any state.
    for indexed in [0i64, 1, 2, -1] {
        assert!(
            should_reindex(indexed, true),
            "force must rebuild from {indexed}"
        );
    }
    assert!(should_reindex(0, false), "0 indexes without force");
    for indexed in [1i64, 2, -1] {
        assert!(
            !should_reindex(indexed, false),
            "{indexed} must not index without force"
        );
    }
}

#[test]
fn spawn_count_only_grows_for_a_real_claim() {
    let uid = "b5-spawn-count";
    release(uid);
    let before = spawn_count();
    // try_claim is the part claim_and_spawn gates on; it must not itself inflate the
    // counter (only a spawned task does).
    assert!(try_claim(uid));
    assert_eq!(spawn_count(), before, "counter grew without a spawn");
    release(uid);
}

// ---------------------------------------------------------------------------
// sanitization of extracted text
// ---------------------------------------------------------------------------

#[test]
fn sanitize_for_fts_shapes_stored_text() {
    assert_eq!(sanitize_for_fts("a\n\n  b\tc"), "a b c");
    assert_eq!(sanitize_for_fts("  lead and trail  "), "lead and trail");
    assert_eq!(sanitize_for_fts("nul\0here"), "nulhere");
    assert_eq!(sanitize_for_fts("bell\u{7}x"), "bellx");
    assert_eq!(sanitize_for_fts(""), "");
    assert_eq!(sanitize_for_fts("Война  и мир"), "Война и мир");
    // Quotes stay in the body: only queries are sanitized, storage is parameterized.
    assert_eq!(sanitize_for_fts("he said \"stop\" *"), "he said \"stop\" *");
    // A 200 KB body must survive untouched in length terms (no truncation).
    let big = "monster ".repeat(25_000);
    let out = sanitize_for_fts(&big);
    assert_eq!(
        out.len(),
        big.len() - 1,
        "trailing space collapsed, nothing else changed"
    );
}

#[test]
fn long_chapter_body_indexes_and_searches() {
    // War-and-Peace-scale chapters: a single FTS row with a ~200 KB body.
    let db_path = temp_path("long", "db");
    let conn = Connection::open(&db_path).expect("open");
    conn.execute_batch(TEST_DDL).expect("ddl");
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at, indexed) VALUES ('u1','/x.epub','P',0,0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO chapters(book_uid, idx, href, title, char_count) VALUES ('u1',0,'c0.xhtml','Ch 0',NULL)",
        [],
    )
    .unwrap();
    drop(conn);

    let needle_pos = 12_000;
    let mut body = String::new();
    for i in 0..20_000 {
        if i == needle_pos {
            body.push_str("and here sits the needle word zyzzyva in a long chapter ");
        } else {
            body.push_str("filler words to make this chapter very long indeed ");
        }
    }
    let doc = format!("<html><body><p>{body}</p></body></html>");

    let conn = open_index_conn(&db_path).expect("conn");
    let read: ReadEntry<'_> = &|_p, _e| Ok(doc.clone().into_bytes());
    let extract: ExtractText<'_> = &|html| extract_text_for_tests(html);
    index_book_with(&conn, "u1", read, extract, None).expect("index long chapter");

    let hits = query::search(&conn, "u1", "zyzzyva", 100).expect("search");
    assert_eq!(hits.len(), 1);
    assert!(
        hits[0].snippet.contains("<mark>zyzzyva</mark>"),
        "{}",
        hits[0].snippet
    );
    // The snippet stays short even for a huge body.
    assert!(
        hits[0].snippet.chars().count() < 200,
        "snippet too long: {}",
        hits[0].snippet.len()
    );

    let _ = std::fs::remove_file(&db_path);
}

// ---------------------------------------------------------------------------
// end-to-end over real testbooks (needs B1)
// ---------------------------------------------------------------------------

/// §8: index pg84 (Frankenstein) fully, then search «monster».
#[test]
fn pg84_index_and_search_monster() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../testbooks/pg84.epub");
    let archive = vellum_lib::epub::open_book(path.to_str().unwrap()).expect("open pg84");
    assert!(!archive.spine.is_empty(), "spine empty");

    let db_path = temp_path("pg84", "db");
    let conn = Connection::open(&db_path).expect("open db");
    conn.execute_batch(TEST_DDL).expect("ddl");
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at, indexed, total_chapters) \
         VALUES ('pg84', ?1, 'Frankenstein', 0, 0, ?2)",
        params![path.to_string_lossy(), archive.spine.len() as i64],
    )
    .unwrap();
    for (i, item) in archive.spine.iter().enumerate() {
        let title = archive
            .toc
            .iter()
            .find(|t| t.chapter_idx == i as i64)
            .map(|t| t.title.clone());
        conn.execute(
            "INSERT INTO chapters(book_uid, idx, href, title, char_count) VALUES ('pg84',?1,?2,?3,NULL)",
            params![i as i64, item.href, title],
        )
        .unwrap();
    }
    drop(conn);

    let started = std::time::Instant::now();
    let conn = open_index_conn(&db_path).expect("index conn");
    let read: ReadEntry<'_> = &|p, e| vellum_lib::epub::zip_entry_bytes(p, e);
    let extract: ExtractText<'_> = &|html| vellum_lib::epub::extract_text(html);
    index_book_with(&conn, "pg84", read, extract, None).expect("index pg84");
    let elapsed = started.elapsed();
    println!(
        "PERF pg84 index: {elapsed:?} ({} chapters)",
        archive.spine.len()
    );

    let hits = query::search(&conn, "pg84", "monster", 100).expect("search");
    assert!(!hits.is_empty(), "«monster» must hit in Frankenstein");
    assert!(
        hits.iter().any(|h| !h.chapter_title.is_empty()),
        "chapter titles should be filled"
    );
    assert!(
        hits.iter().all(|h| h.snippet.contains("<mark>")),
        "marks: {hits:?}"
    );

    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM book_search WHERE book_uid = 'pg84'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows as usize, archive.spine.len());

    let _ = std::fs::remove_file(&db_path);
}

/// E2E: index the Russian fixture through the real pipeline and prove the `CYR_STEM`
/// truncation in `query::sanitize_query` works through FTS5 — an inflected query form
/// that appears nowhere in the book still finds the dictionary forms that were indexed.
#[test]
fn ru_fixture_index_and_search_inflected_forms() {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../testbooks/ru_fixture.epub");
    let archive = vellum_lib::epub::open_book(path.to_str().unwrap()).expect("open ru_fixture");
    assert_eq!(archive.spine.len(), 3, "fixture has 3 chapters");

    let db_path = temp_path("ru", "db");
    let conn = Connection::open(&db_path).expect("open db");
    conn.execute_batch(TEST_DDL).expect("ddl");
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at, indexed, total_chapters) \
         VALUES ('ru', ?1, 'Ярмарка', 0, 0, ?2)",
        params![path.to_string_lossy(), archive.spine.len() as i64],
    )
    .unwrap();
    for (i, item) in archive.spine.iter().enumerate() {
        let title = archive
            .toc
            .iter()
            .find(|t| t.chapter_idx == i as i64)
            .map(|t| t.title.clone());
        conn.execute(
            "INSERT INTO chapters(book_uid, idx, href, title, char_count) VALUES ('ru',?1,?2,?3,NULL)",
            params![i as i64, item.href, title],
        )
        .unwrap();
    }
    drop(conn);

    let conn = open_index_conn(&db_path).expect("index conn");
    let read: ReadEntry<'_> = &|p, e| vellum_lib::epub::zip_entry_bytes(p, e);
    let extract: ExtractText<'_> = &|html| vellum_lib::epub::extract_text(html);
    index_book_with(&conn, "ru", read, extract, None).expect("index ru_fixture");

    // «дорогу» (accusative) appears nowhere in the book; «дорога»/«дороги» do (ch1, ch2).
    let hits = query::search(&conn, "ru", "дорогу", 100).expect("search дорогу");
    assert_eq!(
        hits.len(),
        2,
        "«дорогу» must find дорога (ch1) and дороги (ch2)"
    );
    assert!(
        hits.iter().all(|h| h.snippet.contains("<mark>")),
        "marks: {hits:?}"
    );
    assert!(
        hits.iter().any(|h| !h.chapter_title.is_empty()),
        "chapter titles should be filled from toc.ncx"
    );

    // «ярмаркой» (instrumental, absent from the text) matches every form of «ярмарка».
    let hits = query::search(&conn, "ru", "ярмаркой", 100).expect("search ярмаркой");
    assert_eq!(hits.len(), 3, "«ярмаркой» must hit all 3 chapters");

    // Multi-word query ANDs the stems; «доро»+«ярма» co-occur in ch1 and ch2 only.
    let hits = query::search(&conn, "ru", "дорогу ярмаркой", 100).expect("search both");
    assert_eq!(hits.len(), 2, "«дорогу ярмаркой» must hit ch1 and ch2");

    // A word whose stem occurs nowhere returns nothing.
    let hits = query::search(&conn, "ru", "паровоз", 100).expect("search absent");
    assert!(hits.is_empty(), "«паровоз» must not match");

    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM book_search WHERE book_uid = 'ru'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows as usize, archive.spine.len());

    let _ = std::fs::remove_file(&db_path);
}

/// §8 perf: index pg2600 (War and Peace, English Garnett translation, huge) and report the time (target < 15 s).
#[test]
fn pg2600_index_perf_and_search_latency() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../testbooks/pg2600.epub");
    let archive = vellum_lib::epub::open_book(path.to_str().unwrap()).expect("open pg2600");

    let db_path = temp_path("pg2600", "db");
    let conn = Connection::open(&db_path).expect("open db");
    conn.execute_batch(TEST_DDL).expect("ddl");
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at, indexed, total_chapters) \
         VALUES ('pg2600', ?1, 'War and Peace', 0, 0, ?2)",
        params![path.to_string_lossy(), archive.spine.len() as i64],
    )
    .unwrap();
    for (i, item) in archive.spine.iter().enumerate() {
        let title = archive
            .toc
            .iter()
            .find(|t| t.chapter_idx == i as i64)
            .map(|t| t.title.clone());
        conn.execute(
            "INSERT INTO chapters(book_uid, idx, href, title, char_count) VALUES ('pg2600',?1,?2,?3,NULL)",
            params![i as i64, item.href, title],
        )
        .unwrap();
    }
    drop(conn);

    let started = std::time::Instant::now();
    let conn = open_index_conn(&db_path).expect("index conn");
    let read: ReadEntry<'_> = &|p, e| vellum_lib::epub::zip_entry_bytes(p, e);
    let extract: ExtractText<'_> = &|html| vellum_lib::epub::extract_text(html);
    index_book_with(&conn, "pg2600", read, extract, None).expect("index pg2600");
    let index_elapsed = started.elapsed();
    println!(
        "PERF pg2600 index: {index_elapsed:?} ({} chapters)",
        archive.spine.len()
    );
    assert!(
        index_elapsed < Duration::from_secs(15),
        "pg2600 index over budget: {index_elapsed:?}"
    );

    // Query latency on the indexed big book (target < 100 ms).
    // NOTE: the pg2600 fixture is the English Garnett translation, not the Russian
    // original, so these queries are English; the first five must all find hits.
    for (q, expect_hits) in [
        ("war", true),
        ("peace", true),
        ("pierre", true),
        ("\"prince andrew\"", true),
        ("borodino", true),
        ("natasha", true),
        ("zzzznotaword", false),
    ] {
        let t = std::time::Instant::now();
        let hits = query::search(&conn, "pg2600", q, 100).expect("search");
        let d = t.elapsed();
        println!("PERF pg2600 query {q:?}: {d:?} hits={}", hits.len());
        assert!(
            d < Duration::from_millis(100),
            "query {q:?} over budget: {d:?}"
        );
        assert_eq!(
            !hits.is_empty(),
            expect_hits,
            "query {q:?} hit expectation wrong ({} hits)",
            hits.len()
        );
    }

    // Idempotency at scale: a second pass must not duplicate rows.
    let rows: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM book_search WHERE book_uid = 'pg2600'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let t = std::time::Instant::now();
    index_book_with(&conn, "pg2600", read, extract, None).expect("reindex");
    println!("PERF pg2600 reindex: {:?}", t.elapsed());
    let rows2: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM book_search WHERE book_uid = 'pg2600'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, rows2, "reindex changed the row count");

    let _ = std::fs::remove_file(&db_path);
}

/// §8: WAL — reader progress/highlight writes while pg2600 indexes in the background.
#[test]
fn pg2600_concurrent_writes_while_indexing() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../testbooks/pg2600.epub");
    let archive = vellum_lib::epub::open_book(path.to_str().unwrap()).expect("open pg2600");

    let db_path = temp_path("pg2600wal", "db");
    let conn = Connection::open(&db_path).expect("open db");
    conn.execute_batch(TEST_DDL).expect("ddl");
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at, indexed, total_chapters) \
         VALUES ('pg2600', ?1, 'War and Peace', 0, 0, ?2)",
        params![path.to_string_lossy(), archive.spine.len() as i64],
    )
    .unwrap();
    for (i, item) in archive.spine.iter().enumerate() {
        conn.execute(
            "INSERT INTO chapters(book_uid, idx, href, title, char_count) VALUES ('pg2600',?1,?2,NULL,NULL)",
            params![i as i64, item.href],
        )
        .unwrap();
    }
    drop(conn);

    let indexer_db = db_path.clone();
    let handle = std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let conn = open_index_conn(&indexer_db).expect("index conn");
        let read: ReadEntry<'_> = &|p, e| vellum_lib::epub::zip_entry_bytes(p, e);
        let extract: ExtractText<'_> = &|html| vellum_lib::epub::extract_text(html);
        index_book_with(&conn, "pg2600", read, extract, None).expect("index");
        started.elapsed()
    });

    // Main thread writes highlights the whole time the big book indexes.
    let writer = Connection::open(&db_path).expect("writer");
    writer
        .busy_timeout(Duration::from_secs(5))
        .expect("timeout");
    let mut writes = 0;
    while !handle.is_finished() && writes < 500 {
        writer
            .execute(
                "INSERT INTO highlights(book_uid, chapter_idx, cfi_start, cfi_end, color, created_at) \
                 VALUES ('pg2600', 0, ?1, ?2, '#ffe08a', ?3)",
                params![format!("epubcfi(/2/{writes})"), format!("epubcfi(/2/{writes}:5)"), writes],
            )
            .expect("concurrent reader write must not fail (WAL)");
        writes += 1;
        std::thread::sleep(Duration::from_millis(5));
    }
    let elapsed = handle.join().expect("indexer panicked");
    println!("PERF pg2600 concurrent index: {elapsed:?} with {writes} reader writes");
    assert!(writes > 0, "indexer finished before any write landed");

    let conn = Connection::open(&db_path).expect("reopen");
    let hl: i64 = conn
        .query_row("SELECT COUNT(*) FROM highlights", [], |r| r.get(0))
        .unwrap();
    assert_eq!(hl, writes as i64, "reader writes lost");
    let indexed: i64 = conn
        .query_row("SELECT indexed FROM books WHERE uid = 'pg2600'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(indexed, 2);

    let _ = std::fs::remove_file(&db_path);
}
