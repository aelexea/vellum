//! B3 integration tests — import pipeline against real Gutenberg testbooks (§8).
//!
//! These exercise the public `vellum_lib::db` surface exactly as another crate (or a
//! future integration harness) would: temp-dir DB → migrate → import → list → tags →
//! position → rescan → delete.
//!
//! Everything that parses an epub is gated on `b1_available()`: while B1's scaffold stubs
//! are still `unimplemented!()`, those tests skip with a printed note instead of failing
//! (the DB-side behaviour is already covered by inline unit tests in db/library.rs and
//! db/progress.rs, which run unconditionally).

use std::path::Path;

use vellum_lib::db::library::{self, testutil::*};
use vellum_lib::db::progress;
use vellum_lib::dto::{LibraryFilter, LibrarySort, MissingFilter, ReadMode, ReadingPosition};

/// Repo-root testbooks dir (fixtures are read-only; never mutated).
fn testbooks_dir() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("repo root")
        .join("testbooks")
}

fn default_filter() -> LibraryFilter {
    LibraryFilter {
        query: None,
        tag: None,
        sort: LibrarySort::LastOpened,
        sort_desc: true,
        missing: MissingFilter::All,
    }
}

/// Import pg84 (Frankenstein) end-to-end: row fields, toc/chapters cached, cover
/// thumbnail on disk, dedupe on re-import, then the full read/annotate-free lifecycle.
#[test]
fn import_pg84_full_lifecycle() {
    if !b1_available() {
        println!("[b3] SKIP import_pg84_full_lifecycle — needs B1 (epub parser stub)");
        return;
    }
    let pg84 = testbooks_dir().join("pg84.epub");
    if !pg84.is_file() {
        println!("[b3] SKIP import_pg84_full_lifecycle — testbooks/pg84.epub absent");
        return;
    }

    let (paths, dir) = temp_paths("pg84");
    let c = open_test_db(&paths);

    let t0 = std::time::Instant::now();
    let out = library::import_epub(&c, &paths.covers_dir, &pg84.to_string_lossy())
        .expect("import must not error");
    let import_ms = t0.elapsed();
    println!("[b3] import pg84 = {import_ms:?}");

    let book = out.imported.expect("pg84 imported");
    assert!(!book.title.is_empty(), "title parsed");
    assert!(!book.authors.is_empty(), "author parsed");
    assert!(book.total_chapters > 0, "spine counted");
    assert!(book.size_bytes > 100_000, "real file size");
    assert!(!book.missing);
    assert_eq!(book.uid.len(), 40, "sha1 hex uid");
    assert!(
        book.uid
            .chars()
            .all(|ch| ch.is_ascii_hexdigit() && !ch.is_ascii_uppercase()),
        "uid lowercase hex: {}",
        book.uid
    );

    // §8 B1: cover found for pg84 → thumbnailed jpg on disk + cover_url set.
    assert!(book.cover_url.is_some(), "pg84 has a cover");
    let cover_file = paths.covers_dir.join(format!("{}.jpg", book.uid));
    assert!(cover_file.is_file(), "thumbnail written");
    let thumb_len = std::fs::metadata(&cover_file).unwrap().len();
    assert!(thumb_len < 512 * 1024, "thumbnail is small: {thumb_len} B");

    // Detail: toc + chapters cached, chapter hrefs are zip paths, titles propagate.
    let detail = library::get_book(&c, &book.uid).unwrap().unwrap();
    assert!(!detail.toc.is_empty(), "toc cached");
    assert_eq!(detail.chapters.len() as i64, count_spine(&pg84));
    assert!(
        detail
            .chapters
            .iter()
            .all(|ch| ch.href.ends_with(".xhtml") || ch.href.ends_with(".html")),
        "chapter hrefs look like documents"
    );
    assert!(
        detail.chapters.iter().any(|ch| ch.title.is_some()),
        "at least one chapter got a toc title"
    );

    // Re-import → skipped with the §4.8 reason, no duplicate row.
    let out2 = library::import_epub(&c, &paths.covers_dir, &pg84.to_string_lossy()).unwrap();
    assert_eq!(out2.skipped.expect("skipped").reason, "already in library");
    let n: i64 = c
        .query_row("SELECT count(*) FROM books", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 1);

    // Tags + position + listing see the imported book.
    library::set_book_tags(&c, &book.uid, &["классика".into(), "готика".into()]).unwrap();
    let pos = ReadingPosition {
        cfi: Some("epubcfi(/4/2/4/2:0)".into()),
        chapter_idx: 0,
        pct_within_chapter: 0.0,
        page_index: Some(0),
        page_count: Some(12),
        mode: ReadMode::Paginated,
        global_pct: 0.01,
        saved_at: vellum_lib::db::now_ms(),
    };
    progress::save_position(&c, &book.uid, &pos).unwrap();

    let listed = library::list_books(&c, &default_filter()).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].uid, book.uid);
    assert_eq!(listed[0].position_chapter_idx, Some(0));
    let mut tags = listed[0].tags.clone();
    tags.sort();
    assert_eq!(tags, ["готика", "классика"]);

    // Delete with file removal clears rows + epub stays (we don't delete fixtures: the
    // fixture path lives in testbooks/, so use deleteFile=false semantics here).
    library::delete_book(&c, &book.uid, false).unwrap();
    assert!(library::book_meta(&c, &book.uid).unwrap().is_none());
    assert!(pg84.is_file(), "fixture untouched");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Full-spine chapter count for cross-checking the cached rows (independent of B3's
/// import: re-parses via B1).
fn count_spine(path: &Path) -> i64 {
    let archive = vellum_lib::epub::open_book(&path.to_string_lossy()).expect("open");
    archive.spine.len() as i64
}

/// pg2600 (War and Peace, ~260 chapters, 1.8 MB): import timing (§1 perf discipline).
/// Reported, asserted only against a generous ceiling so slow CI doesn't flake.
#[test]
fn import_pg2600_timing() {
    if !b1_available() {
        println!("[b3] SKIP import_pg2600_timing — needs B1 (epub parser stub)");
        return;
    }
    let pg2600 = testbooks_dir().join("pg2600.epub");
    if !pg2600.is_file() {
        println!("[b3] SKIP import_pg2600_timing — testbooks/pg2600.epub absent");
        return;
    }

    let (paths, dir) = temp_paths("pg2600");
    let c = open_test_db(&paths);

    let t0 = std::time::Instant::now();
    let out = library::import_epub(&c, &paths.covers_dir, &pg2600.to_string_lossy()).unwrap();
    let elapsed = t0.elapsed();
    let book = out.imported.expect("pg2600 imported");
    println!(
        "[b3] import pg2600 = {elapsed:?} ({} chapters, {} B cover)",
        book.total_chapters,
        book.cover_url.is_some() as u8
    );
    assert!(book.total_chapters > 100, "W&P has ~260 chapters");
    assert!(elapsed.as_secs() < 15, "import too slow: {elapsed:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// Import all four testbooks through `import_many`, then verify list/filter/sort over a
/// realistic multi-book library and that every uid is distinct + stable across re-import
/// into a fresh DB (§8: uid stable across runs).
#[test]
fn import_all_testbooks_and_list() {
    if !b1_available() {
        println!("[b3] SKIP import_all_testbooks_and_list — needs B1 (epub parser stub)");
        return;
    }
    let books_dir = testbooks_dir();
    let files: Vec<String> = ["pg11.epub", "pg13.epub", "pg84.epub", "pg2600.epub"]
        .iter()
        .map(|n| books_dir.join(n))
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if files.len() < 4 {
        println!("[b3] SKIP import_all_testbooks_and_list — testbooks incomplete");
        return;
    }

    let (paths, dir) = temp_paths("allbooks");
    let c = open_test_db(&paths);
    let report = library::import_many(&c, &paths.covers_dir, &files, &|_, _, _| {}).unwrap();
    assert_eq!(report.imported.len(), 4, "all four imported");
    assert!(report.failed.is_empty(), "failures: {:?}", report.failed);
    assert!(report.skipped.is_empty());

    // uids distinct.
    let mut uids: Vec<String> = report.imported.iter().map(|b| b.uid.clone()).collect();
    uids.sort();
    uids.dedup();
    assert_eq!(uids.len(), 4);

    // Listing sorts by title, query filters by author.
    let by_title = library::list_books(
        &c,
        &LibraryFilter {
            sort: LibrarySort::Title,
            sort_desc: false,
            ..default_filter()
        },
    )
    .unwrap();
    assert_eq!(by_title.len(), 4);

    // Author-substring query: pg11 (Alice) and pg13 (Snark) are BOTH Lewis Carroll, so
    // "carroll" must match exactly those two — proving the authors LIKE arm spans rows.
    let carroll = library::list_books(
        &c,
        &LibraryFilter {
            query: Some("carroll".into()),
            ..default_filter()
        },
    )
    .unwrap();
    assert_eq!(carroll.len(), 2, "both Carroll books match author query");
    assert!(
        carroll
            .iter()
            .all(|b| b.authors.iter().any(|a| a.contains("Carroll"))),
        "every match really has Carroll as author"
    );

    // A single-author query (Shelley → only pg84) must return exactly one.
    let shelley = library::list_books(
        &c,
        &LibraryFilter {
            query: Some("shelley".into()),
            ..default_filter()
        },
    )
    .unwrap();
    assert_eq!(shelley.len(), 1, "author query finds only Frankenstein");

    // Stability: a fresh DB over the same files must produce identical uids.
    let (paths2, dir2) = temp_paths("allbooks2");
    let c2 = open_test_db(&paths2);
    let report2 = library::import_many(&c2, &paths2.covers_dir, &files, &|_, _, _| {}).unwrap();
    let mut uids2: Vec<String> = report2.imported.iter().map(|b| b.uid.clone()).collect();
    uids2.sort();
    assert_eq!(uids, uids2, "uid stable across runs");

    let _ = std::fs::remove_dir_all(&dir);
    let _ = std::fs::remove_dir_all(&dir2);
}
