//! Chapter/asset/cover fetching from the zip cache (§4.3, §11.2) — owned by B2.
//!
//! Resolution split (see DEVIATIONS in the B2 report): `protocol.rs` maps `{uid, chapter_idx}` to
//! a concrete zip entry via the `books`/`chapters` tables (B3), then calls the `*_entry` functions
//! here. That keeps the OPF out of the hot path — serving a chapter must not re-parse the whole
//! archive — and keeps this module free of DB and B1 dependencies except in `serve_cover`.

use std::fs::File;
use std::io::{BufReader, Read};
use std::sync::Mutex;

use crate::epub::rewrite::{rewrite_chapter, rewrite_css, RewriteCtx};

/// Canonical alias lives in the frozen `state.rs` (§4.2); re-exported here so B2/B5 code
/// can refer to `epub::serve::ZipCache` per §11.2.
pub use crate::state::ZipCache;

/// Hard cap on a single zip entry we are willing to read into memory (64 MiB).
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;

/// `Cache-Control: max-age` for immutable book content (§4.3).
pub const ASSET_CACHE_SECS: u32 = 86_400;

/// Result of a `vellum://` serve call.
pub enum Served {
    Ok {
        body: Vec<u8>,
        mime: String,
        cache_secs: u32,
    },
    NotFound,
}

/// Serve spine item `chapter_idx` of book `uid`, rewritten (§4.3 pipeline).
///
/// Frozen §11.2 signature. Resolves the spine index through B1's `open_book`; the protocol uses
/// [`serve_chapter_entry`] instead (the index→href mapping comes from the DB there), so this path
/// is only for callers that already hold a book path and want spine-order semantics.
pub fn serve_chapter(uid: &str, path: &str, chapter_idx: usize, zips: &ZipCache) -> Served {
    let entry = match spine_entry(path, chapter_idx) {
        Some(e) => e,
        None => return Served::NotFound,
    };
    serve_chapter_entry(uid, path, &entry, zips)
}

/// Serve one already-resolved spine entry (zip path such as `OPS/text/ch1.xhtml`), rewritten.
pub fn serve_chapter_entry(uid: &str, path: &str, entry: &str, zips: &ZipCache) -> Served {
    if !is_safe_entry(entry) {
        return Served::NotFound;
    }
    if get_zip(zips, uid, path).is_err() {
        return Served::NotFound;
    }
    let raw = match read_cached_entry(zips, uid, entry) {
        Ok(b) => b,
        Err(_) => return Served::NotFound,
    };
    let ctx = RewriteCtx {
        uid,
        chapter_zip_dir: zip_dir_of(entry),
    };
    Served::Ok {
        body: rewrite_chapter(&raw, &ctx),
        mime: mime_with_charset(mime_for(entry)),
        // Chapters are re-fetched on every open and are cheap; never let WebKit cache stale ones.
        cache_secs: 0,
    }
}

/// Serve one raw zip entry with mime by extension; `entry` is the percent-decoded zip path.
///
/// `path` and `zip_path` both name the book archive (§11.2 duplicate); `zip_path` wins when set.
pub fn serve_asset(uid: &str, path: &str, zip_path: &str, entry: &str, zips: &ZipCache) -> Served {
    let zip = if zip_path.is_empty() { path } else { zip_path };
    serve_asset_entry(uid, zip, entry, zips)
}

/// Body of [`serve_asset`]: `zip_path` is the book archive on disk.
pub fn serve_asset_entry(uid: &str, zip_path: &str, entry: &str, zips: &ZipCache) -> Served {
    if !is_safe_entry(entry) {
        return Served::NotFound;
    }
    if get_zip(zips, uid, zip_path).is_err() {
        return Served::NotFound;
    }
    let bytes = match read_cached_entry(zips, uid, entry) {
        Ok(b) => b,
        Err(_) => return Served::NotFound,
    };
    let mime = mime_for(entry);
    // Stylesheets carry relative url() references that only make sense against the zip layout.
    let body = if mime == "text/css" {
        match String::from_utf8(bytes) {
            Ok(css) => rewrite_css(&css, zip_dir_of(entry), uid).into_bytes(),
            // Non-UTF-8 CSS: serve the bytes untouched rather than lossily mangling them.
            Err(e) => e.into_bytes(),
        }
    } else {
        bytes
    };
    Served::Ok {
        body,
        mime: mime_with_charset(mime),
        cache_secs: ASSET_CACHE_SECS,
    }
}

/// Serve the detected cover image of a book (or `Served::NotFound`).
///
/// Cover detection is B1's `find_cover_href`. Until B1 lands that call panics, which on a protocol
/// worker thread would leave the responder unanswered and hang the frontend's `<img>` forever — so
/// the panic is contained and reported as a plain 404 (the frontend already renders its gradient
/// fallback for exactly that case).
pub fn serve_cover(uid: &str, zip_path: &str, zips: &ZipCache) -> Served {
    let entry = match catch_cover_href(zip_path) {
        Some(e) => e,
        None => return Served::NotFound,
    };
    serve_asset_entry(uid, zip_path, &entry, zips)
}

/// Extension → mime. Scripts are served as `text/plain` (off) for safety.
pub fn mime_for(path: &str) -> &'static str {
    let ext = path
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "xhtml" | "html" | "htm" | "xht" => "application/xhtml+xml",
        "css" => "text/css",
        // Never hand WebKit an executable script: book JS is neutralized as plain text.
        "js" | "mjs" | "cjs" => "text/plain;charset=utf-8",
        "json" => "application/json",
        "xml" | "opf" | "ncx" | "smil" => "application/xml",
        "png" => "image/png",
        "jpg" | "jpeg" | "jpe" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "mp4" | "m4v" => "video/mp4",
        "ogg" | "oga" => "audio/ogg",
        "ogv" => "video/ogg",
        "wav" => "audio/wav",
        "webm" => "video/webm",
        "txt" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// Append `charset=utf-8` to the text-ish mimes so WebKit never guesses a legacy encoding.
fn mime_with_charset(mime: &'static str) -> String {
    // `mime_for` may already carry a charset (the neutralized-script case).
    if mime.contains("charset=") {
        return mime.to_owned();
    }
    let textual = mime.starts_with("text/")
        || matches!(
            mime,
            "application/xhtml+xml" | "application/xml" | "application/json" | "image/svg+xml"
        );
    if textual {
        format!("{mime};charset=utf-8")
    } else {
        mime.to_owned()
    }
}

/// Open `path` as a zip and insert into the cache when absent.
pub fn get_zip(zips: &ZipCache, uid: &str, path: &str) -> anyhow::Result<()> {
    if zips.contains_key(uid) {
        return Ok(());
    }
    let file = File::open(path)?;
    let archive = zip::ZipArchive::new(BufReader::new(file))?;
    zips.insert(uid.to_owned(), Mutex::new(archive));
    Ok(())
}

/// Directory part of a zip entry path (`OPS/text/ch1.xhtml` → `OPS/text`); `""` at the root.
pub(crate) fn zip_dir_of(entry: &str) -> &str {
    match entry.rfind('/') {
        Some(i) => &entry[..i],
        None => "",
    }
}

/// Reject anything that could address outside the archive: empty, root-absolute, backslash or
/// Windows-drive forms, NUL bytes, and any `..` segment.
pub(crate) fn is_safe_entry(entry: &str) -> bool {
    if entry.is_empty() || entry.contains('\0') {
        return false;
    }
    if entry.starts_with('/') || entry.contains('\\') || entry.contains(':') {
        return false;
    }
    entry.split('/').all(|seg| seg != "..")
}

/// Read one entry out of the cached archive. Falls back to a case-insensitive/normalized name
/// match, since real EPUBs sometimes disagree with the OPF href on casing.
fn read_cached_entry(zips: &ZipCache, uid: &str, entry: &str) -> anyhow::Result<Vec<u8>> {
    let slot = zips
        .get(uid)
        .ok_or_else(|| anyhow::anyhow!("no cached archive for {uid}"))?;
    let mut archive = slot
        .value()
        .lock()
        .map_err(|_| anyhow::anyhow!("zip cache mutex poisoned for {uid}"))?;

    let mut resolved: Option<String> = None;
    if let Ok(file) = archive.by_name(entry) {
        return read_capped(file);
    }
    // Miss: scan the name table once (small — hundreds of entries at most).
    let want = entry.to_ascii_lowercase();
    for name in archive.file_names() {
        if name.eq_ignore_ascii_case(entry) || name.to_ascii_lowercase() == want {
            resolved = Some(name.to_owned());
            break;
        }
    }
    let Some(name) = resolved else {
        anyhow::bail!("entry not found in archive: {entry}");
    };
    let file = archive.by_name(&name)?;
    read_capped(file)
}

/// Read a zip file into memory, refusing anything over [`MAX_ENTRY_BYTES`].
///
/// The declared uncompressed size is only a hint (a crafted zip can lie), so the read is capped
/// with `take` and one extra byte is probed to detect overflow without buffering it.
fn read_capped<R: Read>(file: R) -> anyhow::Result<Vec<u8>> {
    let mut capped = file.take(MAX_ENTRY_BYTES + 1);
    let mut buf = Vec::with_capacity(64 * 1024);
    capped.read_to_end(&mut buf)?;
    if buf.len() as u64 > MAX_ENTRY_BYTES {
        anyhow::bail!("entry too large: over {MAX_ENTRY_BYTES} bytes");
    }
    Ok(buf)
}

/// Spine entry for `chapter_idx`, via B1's `open_book`. Panics are contained like in
/// [`serve_cover`] so an unlanded dependency degrades to a 404 instead of hanging a request.
fn spine_entry(path: &str, chapter_idx: usize) -> Option<String> {
    let archive = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        crate::epub::open_book(path)
    }))
    .ok()
    .and_then(Result::ok)?;
    archive.spine.get(chapter_idx).map(|s| s.href.clone())
}

/// Cover href via B1's `open_book` + `find_cover_href`, panic-contained.
fn catch_cover_href(zip_path: &str) -> Option<String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let archive = crate::epub::open_book(zip_path).ok()?;
        crate::epub::find_cover_href(&archive)
    }))
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_for_known_extensions() {
        assert_eq!(mime_for("OPS/ch1.xhtml"), "application/xhtml+xml");
        assert_eq!(mime_for("styles/main.CSS"), "text/css");
        assert_eq!(mime_for("img/a.jpeg"), "image/jpeg");
        assert_eq!(mime_for("fonts/f.woff2"), "font/woff2");
        // scripts are defused
        assert_eq!(mime_for("js/evil.js"), "text/plain;charset=utf-8");
        assert_eq!(mime_for("unknown"), "application/octet-stream");
    }

    #[test]
    fn mime_charset_added_for_text_types() {
        assert_eq!(mime_with_charset("text/css"), "text/css;charset=utf-8");
        assert_eq!(
            mime_with_charset("application/xhtml+xml"),
            "application/xhtml+xml;charset=utf-8"
        );
        assert_eq!(
            mime_with_charset("image/svg+xml"),
            "image/svg+xml;charset=utf-8"
        );
        assert_eq!(mime_with_charset("image/png"), "image/png");
        assert_eq!(mime_with_charset("font/woff2"), "font/woff2");
        // no double charset
        assert_eq!(
            mime_with_charset("text/plain;charset=utf-8"),
            "text/plain;charset=utf-8"
        );
    }

    #[test]
    fn zip_dir_extraction() {
        assert_eq!(zip_dir_of("OPS/text/ch1.xhtml"), "OPS/text");
        assert_eq!(zip_dir_of("ch1.xhtml"), "");
        assert_eq!(zip_dir_of("a/b/c/d.xhtml"), "a/b/c");
    }

    #[test]
    fn entry_safety_guard() {
        assert!(is_safe_entry("OPS/images/a.png"));
        assert!(is_safe_entry("a.png"));
        // escapes
        assert!(!is_safe_entry("../a.png"));
        assert!(!is_safe_entry("OPS/../../etc/passwd"));
        assert!(!is_safe_entry("/etc/passwd"));
        assert!(!is_safe_entry(""));
        assert!(!is_safe_entry("C:\\Windows\\a.png"));
        assert!(!is_safe_entry("a\\b.png"));
        assert!(!is_safe_entry("a\0b.png"));
    }
}
