//! B2 §8 tests: serving entries out of real zip archives via the zip cache.
//!
//! Fixtures are built programmatically with the `zip` crate — `testbooks/` is never touched.
//! Nothing here depends on B1: only `serve_cover`/`serve_chapter` (spine-order) do, and those are
//! covered by `#[ignore]`d tests at the bottom.

use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use vellum_lib::epub::serve::{
    get_zip, mime_for, serve_asset, serve_asset_entry, serve_chapter, serve_chapter_entry, Served,
    ZipCache,
};

static SEQ: AtomicU64 = AtomicU64::new(0);

/// One PNG-ish blob (content is irrelevant; bytes just have to round-trip exactly).
const PNG_BYTES: &[u8] = &[
    0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x42, 0xff,
];

/// Build a temp zip from `(entry_name, bytes)` pairs and return its path.
fn fixture_zip(entries: &[(&str, &[u8])]) -> PathBuf {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let path =
        std::env::temp_dir().join(format!("vellum-b2-serve-{}-{n}.epub", std::process::id()));
    let file = File::create(&path).expect("create fixture zip");
    let mut zw = zip::ZipWriter::new(file);
    let opts: zip::write::SimpleFileOptions = Default::default();
    for (name, bytes) in entries {
        zw.start_file(*name, opts).expect("start_file");
        zw.write_all(bytes).expect("write entry");
    }
    zw.finish().expect("finish zip");
    path
}

struct Fixture {
    uid: &'static str,
    zip_path: PathBuf,
    zips: ZipCache,
}

/// A book zip laid out like a real EPUB, already inserted into a fresh cache.
fn fixture() -> Fixture {
    let css = b"body{background:url(../img/bg.png);color:red}".as_slice();
    let chapter = br#"<html><head><title>C</title></head><body><p>hi</p><script>evil()</script></body></html>"#.as_slice();
    let js = b"alert(1)".as_slice();
    let container = br#"<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>"#.as_slice();
    let opf = br#"<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0" unique-identifier="id"><metadata><dc:title>B2 fixture</dc:title><dc:language>en</dc:language><dc:identifier id="id">b2-fixture-uid</dc:identifier></metadata><manifest><item id="ch1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="css" href="css/main.css" media-type="text/css"/></manifest><spine><itemref idref="ch1"/></spine></package>"#.as_slice();
    let zip_path = fixture_zip(&[
        ("mimetype", b"application/epub+zip"),
        ("META-INF/container.xml", container),
        ("OPS/content.opf", opf),
        ("OPS/text/ch1.xhtml", chapter),
        ("OPS/css/main.css", css),
        ("OPS/img/bg.png", PNG_BYTES),
        ("OPS/img/a b.png", PNG_BYTES),
        ("OPS/js/evil.js", js),
    ]);
    let uid = "b2uid0000000000000000000000000000000000";
    let zips: ZipCache = ZipCache::new();
    get_zip(&zips, uid, zip_path.to_str().unwrap()).expect("zip opens");
    Fixture {
        uid,
        zip_path,
        zips,
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.zip_path);
    }
}

fn zip_str(f: &Fixture) -> &str {
    f.zip_path.to_str().expect("utf-8 temp path")
}

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------

#[test]
fn asset_round_trips_exact_bytes() {
    let f = fixture();
    match serve_asset_entry(f.uid, zip_str(&f), "OPS/img/bg.png", &f.zips) {
        Served::Ok {
            body,
            mime,
            cache_secs,
        } => {
            assert_eq!(body, PNG_BYTES, "bytes altered");
            assert_eq!(mime, "image/png");
            assert_eq!(cache_secs, 86_400, "assets must be cached for a day");
        }
        Served::NotFound => panic!("present asset reported 404"),
    }
}

#[test]
fn asset_name_with_space_round_trips() {
    let f = fixture();
    match serve_asset_entry(f.uid, zip_str(&f), "OPS/img/a b.png", &f.zips) {
        Served::Ok { body, .. } => assert_eq!(body, PNG_BYTES),
        Served::NotFound => panic!("spaced asset 404"),
    }
}

#[test]
fn missing_asset_is_not_found() {
    let f = fixture();
    assert!(matches!(
        serve_asset_entry(f.uid, zip_str(&f), "OPS/img/nope.png", &f.zips),
        Served::NotFound
    ));
}

#[test]
fn dotdot_escape_is_refused_without_touching_disk() {
    let f = fixture();
    for bad in [
        "../../../etc/passwd",
        "OPS/../../../etc/passwd",
        "/etc/passwd",
        "..",
        "",
    ] {
        assert!(
            matches!(
                serve_asset_entry(f.uid, zip_str(&f), bad, &f.zips),
                Served::NotFound
            ),
            "escape not refused: {bad:?}"
        );
    }
}

#[test]
fn css_asset_is_rewritten_and_served_as_text_css() {
    let f = fixture();
    match serve_asset_entry(f.uid, zip_str(&f), "OPS/css/main.css", &f.zips) {
        Served::Ok {
            body,
            mime,
            cache_secs,
        } => {
            let css = String::from_utf8(body).expect("css is utf-8");
            assert!(
                css.contains(&format!(
                    "url(vellum://book/{}/asset/OPS/img/bg.png)",
                    f.uid
                )),
                "url() not absolutized: {css}"
            );
            assert!(!css.contains("../img"), "relative url survived: {css}");
            // Unrelated declarations are untouched.
            assert!(css.contains("color:red"), "css body mangled: {css}");
            assert_eq!(mime, "text/css;charset=utf-8");
            assert_eq!(cache_secs, 86_400);
        }
        Served::NotFound => panic!("css 404"),
    }
}

#[test]
fn js_is_neutralized_to_plain_text() {
    let f = fixture();
    match serve_asset_entry(f.uid, zip_str(&f), "OPS/js/evil.js", &f.zips) {
        Served::Ok { mime, .. } => assert_eq!(
            mime, "text/plain;charset=utf-8",
            "book JS must never be served as executable"
        ),
        Served::NotFound => panic!("js 404"),
    }
    assert_eq!(mime_for("a/b.js"), "text/plain;charset=utf-8");
    assert_eq!(mime_for("a/b.xhtml"), "application/xhtml+xml");
    assert_eq!(mime_for("a/b.otf"), "font/otf");
    assert_eq!(mime_for("a/b.eot"), "application/vnd.ms-fontobject");
    assert_eq!(mime_for("a/b.mp4"), "video/mp4");
    assert_eq!(mime_for("a/b.zzz"), "application/octet-stream");
}

#[test]
fn frozen_five_arg_serve_asset_uses_either_path_argument() {
    let f = fixture();
    let zip = zip_str(&f).to_owned();
    // §11.2 passes the archive path twice; both must work.
    assert!(matches!(
        serve_asset(f.uid, &zip, "", "OPS/img/bg.png", &f.zips),
        Served::Ok { .. }
    ));
    assert!(matches!(
        serve_asset(f.uid, "", &zip, "OPS/img/bg.png", &f.zips),
        Served::Ok { .. }
    ));
}

#[test]
fn unknown_book_path_is_not_found() {
    let f = fixture();
    // Cache is keyed by uid, so an uncached uid forces a real File::open of a bogus path.
    assert!(matches!(
        serve_asset_entry("deadbeef", "/nonexistent/book.epub", "a.png", &f.zips),
        Served::NotFound
    ));
}

// ---------------------------------------------------------------------------
// chapters
// ---------------------------------------------------------------------------

#[test]
fn chapter_entry_is_rewritten_and_never_cached() {
    let f = fixture();
    match serve_chapter_entry(f.uid, zip_str(&f), "OPS/text/ch1.xhtml", &f.zips) {
        Served::Ok {
            body,
            mime,
            cache_secs,
        } => {
            let html = String::from_utf8(body).expect("chapter is utf-8");
            assert!(!html.contains("<script"), "script survived: {html}");
            assert!(!html.contains("evil()"), "script body survived: {html}");
            assert!(html.contains("<p>hi</p>"), "content lost: {html}");
            assert!(
                html.contains(r#"<meta charset="utf-8""#),
                "no charset: {html}"
            );
            assert!(html.contains("vellum-doc"), "no doc class: {html}");
            assert_eq!(mime, "application/xhtml+xml;charset=utf-8");
            assert_eq!(cache_secs, 0, "chapters must be no-cache");
        }
        Served::NotFound => panic!("chapter 404"),
    }
}

#[test]
fn chapter_relative_resolution_uses_entry_dir() {
    // The chapter lives in OPS/text, so a sibling-dir reference must resolve against it.
    let zip_path = fixture_zip(&[(
        "OPS/text/c.xhtml",
        br#"<html><head></head><body><img src="../img/x.png"/></body></html>"#.as_slice(),
    )]);
    let uid = "b2uid111111111111111111111111111111111";
    let zips: ZipCache = ZipCache::new();
    get_zip(&zips, uid, zip_path.to_str().unwrap()).unwrap();
    match serve_chapter_entry(uid, zip_path.to_str().unwrap(), "OPS/text/c.xhtml", &zips) {
        Served::Ok { body, .. } => {
            let html = String::from_utf8(body).unwrap();
            assert!(
                html.contains(&format!("vellum://book/{uid}/asset/OPS/img/x.png")),
                "not resolved against chapter dir: {html}"
            );
        }
        Served::NotFound => panic!("404"),
    }
    let _ = std::fs::remove_file(&zip_path);
}

#[test]
fn chapter_dotdot_entry_is_refused() {
    let f = fixture();
    assert!(matches!(
        serve_chapter_entry(f.uid, zip_str(&f), "../../etc/passwd", &f.zips),
        Served::NotFound
    ));
}

// ---------------------------------------------------------------------------
// zip cache
// ---------------------------------------------------------------------------

#[test]
fn get_zip_caches_and_is_reused() {
    let f = fixture();
    // Already inserted by `fixture()`; a second call must not reopen or error.
    get_zip(&f.zips, f.uid, zip_str(&f)).expect("idempotent");
    assert!(f.zips.contains_key(f.uid));
    // A poisoned-free, still-readable archive: serve twice from the same cached handle.
    for _ in 0..3 {
        assert!(matches!(
            serve_asset_entry(f.uid, zip_str(&f), "OPS/img/bg.png", &f.zips),
            Served::Ok { .. }
        ));
    }
}

#[test]
fn get_zip_rejects_non_zip_file() {
    let dir = std::env::temp_dir();
    let path = dir.join(format!("vellum-b2-notzip-{}.txt", std::process::id()));
    let mut fh = File::create(&path).unwrap();
    fh.write_all(b"this is not a zip archive at all").unwrap();
    drop(fh);
    let zips: ZipCache = ZipCache::new();
    let err = get_zip(&zips, "uid-x", path.to_str().unwrap());
    assert!(err.is_err(), "non-zip accepted");
    assert!(
        !zips.contains_key("uid-x"),
        "failed open polluted the cache"
    );
    let _ = std::fs::remove_file(&path);
}

#[test]
fn concurrent_asset_serves_from_one_cache() {
    // WebKit fires many asset requests at once; the Mutex-guarded archive must serialize safely.
    let f = fixture();
    let zips: ZipCache = ZipCache::new();
    get_zip(&zips, f.uid, zip_str(&f)).unwrap();
    let zips = std::sync::Arc::new(zips);
    let zip_path = zip_str(&f).to_owned();
    let uid = f.uid.to_owned();
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let zips = zips.clone();
            let zip_path = zip_path.clone();
            let uid = uid.clone();
            std::thread::spawn(move || {
                let entry = if i % 2 == 0 {
                    "OPS/img/bg.png"
                } else {
                    "OPS/css/main.css"
                };
                matches!(
                    serve_asset_entry(&uid, &zip_path, entry, &zips),
                    Served::Ok { .. }
                )
            })
        })
        .collect();
    for h in handles {
        assert!(
            h.join().expect("worker panicked"),
            "concurrent serve failed"
        );
    }
}

#[test]
fn cache_entry_is_mutex_guarded_per_book() {
    let f = fixture();
    let slot = f.zips.get(f.uid).expect("cached");
    let guard: &Mutex<zip::ZipArchive<std::io::BufReader<File>>> = slot.value();
    let archive = guard.lock().expect("not poisoned");
    assert!(
        archive.len() >= 6,
        "fixture zip too small: {}",
        archive.len()
    );
}

// ---------------------------------------------------------------------------
// B1-dependent (spine order + cover detection)
// ---------------------------------------------------------------------------

/// `serve_chapter` resolves the spine index through B1's `open_book`.
///
/// needs B1
#[test]
fn spine_index_chapter_serving() {
    let f = fixture();
    // With B1 landed this should serve spine item 0 of a real book.
    match vellum_lib::epub::serve::serve_chapter(f.uid, zip_str(&f), 0, &f.zips) {
        Served::Ok { body, .. } => assert!(!body.is_empty()),
        Served::NotFound => panic!("spine chapter 404"),
    }
}

/// `serve_cover` needs B1's `find_cover_href`; until then it must degrade to a 404 rather than
/// panic (the protocol calls it on a worker thread and a panic would hang the request).
#[test]
fn cover_without_b1_degrades_to_not_found() {
    let f = fixture();
    // Panic-contained: either a real cover (B1 landed) or NotFound (stub), never a crash.
    let served = vellum_lib::epub::serve::serve_cover(f.uid, zip_str(&f), &f.zips);
    match served {
        Served::Ok { mime, .. } => assert!(mime.starts_with("image/"), "odd cover mime {mime}"),
        Served::NotFound => {} // expected while B1 is a stub
    }
}

/// End-to-end against a real Gutenberg book — needs B1 for spine resolution.
#[test]
fn end_to_end_chapter_from_pg84() {
    let book = concat!(env!("CARGO_MANIFEST_DIR"), "/../testbooks/pg84.epub");
    assert!(
        PathBuf::from(book).is_file(),
        "fixture book missing: {book}"
    );
    let archive = vellum_lib::epub::open_book(book).expect("B1 open_book");
    assert!(!archive.spine.is_empty(), "empty spine");
    let uid = "b2pg84uid000000000000000000000000000000";
    let zips: ZipCache = ZipCache::new();
    match serve_chapter(uid, book, 0, &zips) {
        Served::Ok { body, mime, .. } => {
            let html = String::from_utf8(body).expect("utf-8 chapter");
            assert!(mime.contains("application/xhtml+xml"), "{mime}");
            assert!(!html.contains("<script"), "script survived in a real book");
            assert!(
                html.contains(r#"<meta charset="utf-8""#),
                "no charset injected"
            );
            assert!(html.contains("vellum-doc"), "no doc class");
            assert!(
                html.contains(&format!("vellum://book/{uid}/asset/")),
                "no absolutized assets: {html}"
            );
        }
        Served::NotFound => panic!("pg84 chapter 0 not found"),
    }
}
