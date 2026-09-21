//! B2 §8 tests: `vellum://` URI parsing and route dispatch.
//!
//! Pure parsing needs no app state. `dispatch` is driven against a temp-dir SQLite DB (created with
//! the §4.4 `books`/`chapters` DDL directly, since B3's `migrate()` is still a no-op stub) and a
//! temp-dir zip fixture + covers dir — so the whole route table is testable without a Tauri app.

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::http::StatusCode;
use vellum_lib::epub::serve::ZipCache;
use vellum_lib::protocol::{dispatch, parse_vellum_uri, ProtocolCtx, Route};

static SEQ: AtomicU64 = AtomicU64::new(0);

fn next_id(tag: &str) -> u64 {
    let _ = tag;
    SEQ.fetch_add(1, Ordering::Relaxed)
}

// ---------------------------------------------------------------------------
// parse_vellum_uri — pure, table-driven
// ---------------------------------------------------------------------------

#[test]
fn parse_chapter_route() {
    assert_eq!(
        parse_vellum_uri("vellum://book/abc123/chapter/0"),
        Route::Chapter {
            uid: "abc123".into(),
            idx: 0
        }
    );
    assert_eq!(
        parse_vellum_uri("vellum://book/abc123/chapter/42"),
        Route::Chapter {
            uid: "abc123".into(),
            idx: 42
        }
    );
    // case-insensitive route kind
    assert_eq!(
        parse_vellum_uri("vellum://book/abc123/Chapter/7"),
        Route::Chapter {
            uid: "abc123".into(),
            idx: 7
        }
    );
    // authority may arrive as a `localhost` host with `book` as first path segment
    assert_eq!(
        parse_vellum_uri("vellum://localhost/book/abc123/chapter/3"),
        Route::Chapter {
            uid: "abc123".into(),
            idx: 3
        }
    );
}

#[test]
fn parse_asset_route_decodes_and_preserves_case() {
    assert_eq!(
        parse_vellum_uri("vellum://book/abc123/asset/OPS/img/bg.png"),
        Route::Asset {
            uid: "abc123".into(),
            path: "OPS/img/bg.png".into()
        }
    );
    // percent-encoded space and separators survive as one entry path
    assert_eq!(
        parse_vellum_uri("vellum://book/abc123/asset/OPS/img/a%20b.png"),
        Route::Asset {
            uid: "abc123".into(),
            path: "OPS/img/a b.png".into()
        }
    );
    // cyrillic decodes
    assert_eq!(
        parse_vellum_uri("vellum://book/abc123/asset/OPS/%D0%BA%D0%BD%D0%B8%D0%B3%D0%B0.png"),
        Route::Asset {
            uid: "abc123".into(),
            path: "OPS/книга.png".into()
        }
    );
    // uid case is preserved (it is a hash, not a host-normalized token in the path form)
    assert_eq!(
        parse_vellum_uri("vellum://book/AbC123/asset/x.png"),
        Route::Asset {
            uid: "AbC123".into(),
            path: "x.png".into()
        }
    );
    // query and fragment are dropped before decoding
    assert_eq!(
        parse_vellum_uri("vellum://book/abc123/asset/OPS/x.png?v=2#frag"),
        Route::Asset {
            uid: "abc123".into(),
            path: "OPS/x.png".into()
        }
    );
    assert_eq!(
        parse_vellum_uri("vellum://localhost/book/abc123/asset/OPS/x.png"),
        Route::Asset {
            uid: "abc123".into(),
            path: "OPS/x.png".into()
        }
    );
}

#[test]
fn parse_cover_routes() {
    assert_eq!(
        parse_vellum_uri("vellum://book/abc123/cover"),
        Route::BookCover {
            uid: "abc123".into()
        }
    );
    assert_eq!(
        parse_vellum_uri("vellum://covers/abc123"),
        Route::Covers {
            uid: "abc123".into()
        }
    );
    assert_eq!(
        parse_vellum_uri("vellum://COVERS/abc123"),
        Route::Covers {
            uid: "abc123".into()
        }
    );
}

#[test]
fn parse_rejects_malformed() {
    for bad in [
        "",
        "vellum:",
        "vellum://",
        "vellum://book",
        "vellum://book/",
        "vellum://book/abc123",
        "vellum://book/abc123/",
        "vellum://book//chapter/0",
        "vellum://book/abc123/chapter",     // no index
        "vellum://book/abc123/chapter/",    // empty index
        "vellum://book/abc123/chapter/x",   // non-numeric
        "vellum://book/abc123/chapter/1/2", // too many segments
        "vellum://book/abc123/asset",       // no path
        "vellum://book/abc123/asset/",      // empty path
        "vellum://covers",                  // no uid
        "vellum://covers/",
        "vellum://unknown/abc123/thing",
        "http://book/abc123/chapter/0", // wrong scheme
        "vellum-link://OPS/x.xhtml",    // frontend marker, not a server route
        "vellum://book/abc123/vellum-link://x",
    ] {
        assert_eq!(
            parse_vellum_uri(bad),
            Route::NotFound,
            "should be NotFound: {bad:?}"
        );
    }
}

#[test]
fn parse_asset_with_empty_decoded_segment_still_routes() {
    // A trailing slash yields an empty final segment; the joined path must stay non-empty.
    assert_eq!(
        parse_vellum_uri("vellum://book/u/asset/a/"),
        Route::Asset {
            uid: "u".into(),
            path: "a".into()
        }
    );
}

// ---------------------------------------------------------------------------
// dispatch — real temp DB + zip + covers dir
// ---------------------------------------------------------------------------

struct Harness {
    dir: PathBuf,
    db: Mutex<Connection>,
    zips: ZipCache,
    covers_dir: PathBuf,
    uid: String,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Build a full protocol harness: temp dir, SQLite with the §4.4 books/chapters tables populated
/// for one book, a zip fixture on disk, and a covers dir with an extracted cover file.
fn harness() -> Harness {
    let id = next_id("h");
    let dir = std::env::temp_dir().join(format!("vellum-b2-proto-{}-{id}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let covers_dir = dir.join("covers");
    std::fs::create_dir_all(&covers_dir).unwrap();

    // --- book zip fixture ---
    let book_zip = dir.join("book.epub");
    {
        let file = File::create(&book_zip).unwrap();
        let mut zw = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = Default::default();
        zw.start_file("OPS/text/ch0.xhtml", opts).unwrap();
        zw.write_all(br#"<html><head><title>T</title></head><body><p>Ch0</p><img src="../img/pic.png"/></body></html>"#).unwrap();
        zw.start_file("OPS/img/pic.png", opts).unwrap();
        zw.write_all(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a]).unwrap();
        zw.finish().unwrap();
    }

    // --- extracted cover file (§4.8 writes covers_dir/{uid}.{ext}) ---
    let uid = format!("b2uid{id:032}");
    let cover_file = covers_dir.join(format!("{uid}.png"));
    let mut cf = File::create(&cover_file).unwrap();
    cf.write_all(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
        .unwrap();

    // --- DB with the §4.4 tables this route needs ---
    let db_path = dir.join("vellum.db");
    let conn = Connection::open(&db_path).unwrap();
    conn.execute_batch(
        "CREATE TABLE books(uid TEXT PRIMARY KEY, path TEXT NOT NULL);
         CREATE TABLE chapters(book_uid TEXT NOT NULL, idx INTEGER NOT NULL, href TEXT NOT NULL,
             PRIMARY KEY(book_uid, idx));",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO books(uid, path) VALUES(?1, ?2)",
        rusqlite::params![uid, book_zip.to_str().unwrap()],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO chapters(book_uid, idx, href) VALUES(?1, 0, 'OPS/text/ch0.xhtml')",
        [&uid],
    )
    .unwrap();

    Harness {
        dir,
        db: Mutex::new(conn),
        zips: ZipCache::new(),
        covers_dir,
        uid,
    }
}

impl Harness {
    fn ctx(&self) -> ProtocolCtx<'_> {
        ProtocolCtx {
            db: &self.db,
            zips: &self.zips,
            covers_dir: &self.covers_dir,
        }
    }
    fn go(&self, uri: &str) -> tauri::http::Response<Vec<u8>> {
        dispatch(parse_vellum_uri(uri), &self.ctx())
    }
    fn header<'a>(r: &'a tauri::http::Response<Vec<u8>>, k: &str) -> &'a str {
        r.headers()
            .get(k)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    }
}

#[test]
fn dispatch_chapter_returns_rewritten_xhtml() {
    let h = harness();
    let resp = h.go(&format!("vellum://book/{}/chapter/0", h.uid));
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        Harness::header(&resp, "content-type"),
        "application/xhtml+xml;charset=utf-8"
    );
    assert_eq!(Harness::header(&resp, "access-control-allow-origin"), "*");
    assert_eq!(Harness::header(&resp, "cache-control"), "no-cache");
    let html = String::from_utf8(resp.body().clone()).unwrap();
    assert!(html.contains("<p>Ch0</p>"), "content lost: {html}");
    assert!(
        html.contains(&format!("vellum://book/{}/asset/OPS/img/pic.png", h.uid)),
        "asset not absolutized: {html}"
    );
}

#[test]
fn dispatch_unknown_chapter_idx_is_404() {
    let h = harness();
    let resp = h.go(&format!("vellum://book/{}/chapter/99", h.uid));
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert!(resp.body().is_empty(), "404 must have empty body");
    assert_eq!(Harness::header(&resp, "access-control-allow-origin"), "*");
}

#[test]
fn dispatch_asset_returns_bytes_and_day_cache() {
    let h = harness();
    let resp = h.go(&format!("vellum://book/{}/asset/OPS/img/pic.png", h.uid));
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(Harness::header(&resp, "content-type"), "image/png");
    assert_eq!(Harness::header(&resp, "cache-control"), "max-age=86400");
    assert_eq!(
        Harness::header(&resp, "content-length"),
        resp.body().len().to_string()
    );
    assert_eq!(resp.body(), &[0x89, b'P', b'N', b'G', 0x0d, 0x0a]);
}

#[test]
fn dispatch_missing_asset_is_404() {
    let h = harness();
    let resp = h.go(&format!("vellum://book/{}/asset/OPS/img/nope.png", h.uid));
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert!(resp.body().is_empty());
}

#[test]
fn dispatch_asset_escape_is_404() {
    let h = harness();
    // percent-encoded ../ must not walk out of the archive
    for enc in [
        "..%2F..%2Fetc%2Fpasswd",
        "%2Fetc%2Fpasswd",
        "OPS/../../etc/passwd",
    ] {
        let resp = h.go(&format!("vellum://book/{}/asset/{enc}", h.uid));
        assert_eq!(
            resp.status(),
            StatusCode::NOT_FOUND,
            "escape not refused: {enc}"
        );
    }
}

#[test]
fn dispatch_covers_serves_extracted_file() {
    let h = harness();
    let resp = h.go(&format!("vellum://covers/{}", h.uid));
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(Harness::header(&resp, "content-type"), "image/png");
    assert_eq!(Harness::header(&resp, "cache-control"), "max-age=86400");
    assert!(!resp.body().is_empty());
}

#[test]
fn dispatch_covers_missing_is_404() {
    let h = harness();
    let resp = h.go("vellum://covers/ffffffffffffffffffffffffffffffff");
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert!(resp.body().is_empty());
}

#[test]
fn dispatch_book_cover_prefers_extracted_file() {
    let h = harness();
    // covers_dir/{uid}.png exists, so this resolves without B1's find_cover_href.
    let resp = h.go(&format!("vellum://book/{}/cover", h.uid));
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(Harness::header(&resp, "content-type").starts_with("image/"));
}

#[test]
fn dispatch_unknown_book_is_404() {
    let h = harness();
    let resp = h.go("vellum://book/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/chapter/0");
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let resp2 = h.go("vellum://book/deadbeefdeadbeefdeadbeefdeadbeefdeadbeef/asset/a.png");
    assert_eq!(resp2.status(), StatusCode::NOT_FOUND);
}

#[test]
fn dispatch_notfound_route_is_404() {
    let h = harness();
    let resp = h.go("vellum://book/abc/junk/thing");
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    assert!(resp.body().is_empty());
}

#[test]
fn dispatch_every_response_has_cors() {
    let h = harness();
    for uri in [
        format!("vellum://book/{}/chapter/0", h.uid),
        format!("vellum://book/{}/asset/OPS/img/pic.png", h.uid),
        format!("vellum://covers/{}", h.uid),
        "vellum://book/nope/asset/x.png".to_string(),
    ] {
        let resp = h.go(&uri);
        assert_eq!(
            Harness::header(&resp, "access-control-allow-origin"),
            "*",
            "missing CORS on {uri}"
        );
    }
}

#[test]
fn dispatch_survives_missing_db_tables() {
    // B3's migrate() is a no-op stub today: a DB without books/chapters must 404, not panic.
    let id = next_id("noddl");
    let dir = std::env::temp_dir().join(format!("vellum-b2-noddl-{}-{id}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let conn = Connection::open(dir.join("empty.db")).unwrap();
    let zips: ZipCache = ZipCache::new();
    let ctx = ProtocolCtx {
        db: &Mutex::new(conn),
        zips: &zips,
        covers_dir: &dir,
    };
    let resp = dispatch(
        Route::Chapter {
            uid: "abc".into(),
            idx: 0,
        },
        &ctx,
    );
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn dispatch_covers_dir_path_traversal_uid_rejected() {
    let h = harness();
    // A uid containing path separators must not be used to build a covers_dir path.
    let resp = dispatch(
        Route::Covers {
            uid: "../../etc/passwd".into(),
        },
        &h.ctx(),
    );
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}
