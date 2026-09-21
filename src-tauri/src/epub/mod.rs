//! EPUB parsing (§11.1) — owned by B1.
//!
//! `open_book` reads container.xml → OPF → NCX/nav from the zip (never keeps the archive
//! open), resolves toc `chapter_idx` against the spine and computes the stable uid.
//! `extract_text` is a streaming lol_html text-only extraction used by B5 for FTS indexing.

pub mod container;
pub mod ncx;
pub mod opf;
pub mod rewrite;
pub mod serve;

use std::cell::RefCell;
use std::fs::File;
use std::io::{BufReader, ErrorKind, Read};
use std::path::Path;
use std::rc::Rc;

use lol_html::html_content::TextType;
use lol_html::{doc_text, element, HtmlRewriter, Settings};
use sha1::{Digest, Sha1};
use zip::ZipArchive;

use crate::dto::TocEntry;

pub use ncx::find_nav_href;

/// Cheap handle to an opened EPUB (§11.1). Owns Strings only → `Send + 'static`.
#[derive(Debug, Clone, Default)]
pub struct BookArchive {
    pub uid: String,
    pub path: String,
    /// Directory of the OPF inside the zip (e.g. `OPS`, `""` when at root), no trailing `/`.
    pub container_dir: String,
    pub metadata: BookMetadata,
    pub manifest: Vec<ManifestItem>,
    pub spine: Vec<SpineItem>,
    pub toc: Vec<TocEntry>,
    pub cover_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct BookMetadata {
    pub title: String,
    pub authors: Vec<String>,
    pub language: Option<String>,
    pub identifier: Option<String>,
    pub cover_href: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ManifestItem {
    pub id: String,
    pub href: String,
    pub media_type: String,
    /// e.g. `cover-image`, `nav`.
    pub properties: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SpineItem {
    pub idref: String,
    /// Normalized to zip-root-relative, percent-decoded storage form.
    pub href: String,
    pub linear: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavKind {
    Ncx,
    Nav,
}

/// Parse container.xml + OPF + NCX/nav into a [`BookArchive`].
///
/// The zip is closed before returning (B2/protocol own archive caching). Any zip/parse
/// failure is an `Err`; malformed input never panics.
pub fn open_book(path: &str) -> anyhow::Result<BookArchive> {
    let p = Path::new(path);
    if !p.is_file() {
        return Err(anyhow::anyhow!("not a file: {path}"));
    }
    let file = File::open(p)?;
    let mut archive = ZipArchive::new(BufReader::new(file))
        .map_err(|e| anyhow::anyhow!("not a valid zip archive ({path}): {e}"))?;

    let container_bytes = read_entry(&mut archive, "META-INF/container.xml")
        .map_err(|e| anyhow::anyhow!("META-INF/container.xml unreadable: {e}"))?;
    let opf_raw_path = container::opf_path(&container_bytes)?;
    let opf_path = opf::percent_decode(&opf_raw_path);

    let opf_bytes = read_entry(&mut archive, &opf_path)
        .map_err(|e| anyhow::anyhow!("OPF {opf_path} unreadable: {e}"))?;
    let parsed = opf::parse(&opf_bytes, &opf_path)?;

    // Navigation document: EPUB3 nav.xhtml preferred, else NCX (§11.1 find_nav_href).
    let mut toc: Vec<TocEntry> = Vec::new();
    if let Some((nav_href, kind)) = ncx::find_nav_href(&parsed.manifest, &parsed.spine) {
        if let Ok(nav_bytes) = read_entry(&mut archive, &nav_href) {
            let nav_dir = opf::dir_of(&nav_href);
            let parsed_toc = match kind {
                NavKind::Ncx => ncx::parse_ncx_in(&nav_bytes, &nav_dir),
                NavKind::Nav => ncx::parse_nav_in(&nav_bytes, &nav_dir),
            };
            if let Ok(mut entries) = parsed_toc {
                let spine_hrefs: Vec<String> =
                    parsed.spine.iter().map(|s| s.href.clone()).collect();
                ncx::resolve_chapter_indices(&mut entries, &spine_hrefs);
                toc = entries;
            }
        }
    }

    let uid = compute_uid(&parsed.metadata, p)?;
    let mut book = BookArchive {
        uid,
        path: path.to_string(),
        container_dir: parsed.dir,
        metadata: parsed.metadata,
        manifest: parsed.manifest,
        spine: parsed.spine,
        toc,
        cover_id: parsed.cover_id,
    };
    book.metadata.cover_href = find_cover_href(&book);
    Ok(book)
}

/// sha1 hex (lowercase) of `dc:identifier` when non-empty, else of size + first 64 KiB.
///
/// Fallback hash input: the file size as decimal ASCII followed by the first 64 KiB of file
/// bytes (deterministic across calls; §4.8 "file size + first 64 KiB").
pub fn compute_uid(meta: &BookMetadata, path: &Path) -> anyhow::Result<String> {
    if let Some(id) = &meta.identifier {
        let trimmed = id.trim();
        if !trimmed.is_empty() {
            let mut h = Sha1::new();
            h.update(trimmed.as_bytes());
            return Ok(hex_lower(&h.finalize()));
        }
    }
    let mut f = File::open(path)?;
    let size = f.metadata()?.len();
    const CHUNK: usize = 64 * 1024;
    let mut buf = vec![0u8; CHUNK];
    let mut filled = 0usize;
    while filled < CHUNK {
        match f.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(ref e) if e.kind() == ErrorKind::Interrupted => continue,
            Err(e) => return Err(e.into()),
        }
    }
    let mut h = Sha1::new();
    h.update(size.to_string().as_bytes());
    h.update(&buf[..filled]);
    Ok(hex_lower(&h.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub fn manifest_by_id<'a>(b: &'a BookArchive, id: &str) -> Option<&'a ManifestItem> {
    b.manifest.iter().find(|m| m.id == id)
}

/// cover-image property → `meta name=cover` → `cover.*` filename → first image in manifest.
///
/// Concretely (§11.1 order): (1) manifest item with `properties` containing "cover-image";
/// (2) the item id captured from `<meta name="cover" content="ID">` (`cover_id`); (3) an
/// image item whose id matches /cover/i; (4) the first image/* item whose href matches
/// /cover/i; (5) the first image/* item. Steps 3–5 require an image media type (or an
/// image-like file extension) so a CSS/JS item named e.g. "cover-style" never wins.
/// Returns the normalized zip path (percent-decoded storage form).
pub fn find_cover_href(b: &BookArchive) -> Option<String> {
    // 1. EPUB3 cover-image property.
    if let Some(m) = b
        .manifest
        .iter()
        .find(|m| m.properties.iter().any(|p| p == "cover-image"))
    {
        return Some(m.href.clone());
    }
    // 2. <meta name="cover" content="ID"> (or cover-image id, same field).
    if let Some(id) = &b.cover_id {
        if let Some(m) = manifest_by_id(b, id) {
            return Some(m.href.clone());
        }
    }
    // 3. Manifest item id matching /cover/i (image-like only).
    if let Some(m) = b.manifest.iter().find(|m| {
        m.id.to_ascii_lowercase().contains("cover")
            && (m.media_type.starts_with("image/") || has_image_ext(&m.href))
    }) {
        return Some(m.href.clone());
    }
    // 4. First image/* whose href matches /cover/i.
    if let Some(m) = b.manifest.iter().find(|m| {
        m.media_type.starts_with("image/") && m.href.to_ascii_lowercase().contains("cover")
    }) {
        return Some(m.href.clone());
    }
    // 5. First image/* in manifest.
    b.manifest
        .iter()
        .find(|m| m.media_type.starts_with("image/"))
        .map(|m| m.href.clone())
}

fn has_image_ext(href: &str) -> bool {
    let lower = href.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    matches!(
        ext,
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "bmp" | "avif"
    )
}

/// Low-level single-entry read from a zip on disk (no caching).
///
/// `entry` is the stored (percent-decoded) form; lookup tries the exact name first, then the
/// percent-encoded form, then a scan comparing percent-decoded zip names.
pub fn zip_entry_bytes(path: &str, entry: &str) -> anyhow::Result<Vec<u8>> {
    let file = File::open(path)?;
    let mut archive = ZipArchive::new(BufReader::new(file))
        .map_err(|e| anyhow::anyhow!("not a valid zip archive ({path}): {e}"))?;
    read_entry(&mut archive, entry)
}

fn read_entry<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    entry: &str,
) -> anyhow::Result<Vec<u8>> {
    // 1. Exact name.
    if let Ok(mut f) = archive.by_name(entry) {
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf)?;
        return Ok(buf);
    }
    // 2. Percent-encoded form (some packers store the encoded IRI as the zip name).
    let encoded = opf::percent_encode_path(entry);
    if encoded != entry {
        if let Ok(mut f) = archive.by_name(&encoded) {
            let mut buf = Vec::with_capacity(f.size() as usize);
            f.read_to_end(&mut buf)?;
            return Ok(buf);
        }
    }
    // 3. Scan: match on the percent-decoded zip name.
    let target = opf::percent_decode(entry);
    let mut found: Option<usize> = None;
    for (i, name) in archive.file_names().enumerate() {
        if name == entry || opf::percent_decode(name) == target {
            found = Some(i);
            break;
        }
    }
    if let Some(i) = found {
        let mut f = archive.by_index(i)?;
        let mut buf = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut buf)?;
        return Ok(buf);
    }
    Err(anyhow::anyhow!("zip entry not found: {entry}"))
}

/// Parse NCX (`kind = Ncx`) or EPUB3 nav.xhtml (`kind = Nav`) into a flat toc list.
///
/// Standalone use returns entries with `level`/`parent_idx`/titles resolved but
/// `chapter_idx = -1` and `cfi = None` (spine context is required for resolution —
/// `open_book` does that and returns fully resolved entries).
pub fn nav_or_ncx_toc(bytes: &[u8], kind: NavKind) -> anyhow::Result<Vec<TocEntry>> {
    let mut toc = match kind {
        NavKind::Ncx => ncx::parse_ncx(bytes)?,
        NavKind::Nav => ncx::parse_nav(bytes)?,
    };
    ncx::resolve_chapter_indices(&mut toc, &[]);
    Ok(toc)
}

// ---------------------------------------------------------------------------
// extract_text (lol_html streaming text-only sink — used by B5 for FTS)
// ---------------------------------------------------------------------------

/// Block-level elements: a newline marker is pushed when one opens, so paragraph/heading
/// boundaries survive whitespace collapsing as `\n\n`.
const BLOCK_SELECTOR: &str = "address,article,aside,blockquote,body,br,caption,center,col,\
colgroup,dd,details,dialog,dir,div,dl,dt,fieldset,figcaption,figure,footer,form,h1,h2,h3,h4,\
h5,h6,header,hgroup,hr,html,legend,li,main,menu,nav,ol,optgroup,option,p,pre,section,summary,\
table,tbody,td,tfoot,th,thead,tr,ul";

struct TextSink {
    out: String,
    /// A whitespace run is pending; if `boundary`, it must become a paragraph break.
    pending_ws: bool,
    boundary: bool,
    /// Buffers the current text node (lol_html fragments nodes; `last_in_text_node` flushes).
    node: String,
}

/// Plain text of an XHTML document (lol_html text-only sink) — used by B5 indexing.
///
/// Skips `<script>`, `<style>` and `<title>` content (their text arrives as non-`Data`
/// `TextType`s and is dropped), collapses whitespace runs to single spaces and keeps
/// paragraph breaks as `\n\n`. Never panics on malformed HTML; on rewriter failure returns
/// whatever was extracted so far.
pub fn extract_text(html: &[u8]) -> String {
    let sink = Rc::new(RefCell::new(TextSink {
        out: String::with_capacity(html.len() / 2 + 64),
        pending_ws: false,
        boundary: false,
        node: String::new(),
    }));
    {
        let s_blocks = Rc::clone(&sink);
        let s_text = Rc::clone(&sink);
        let mut rewriter = HtmlRewriter::new(
            Settings::new()
                .append_element_content_handler(element!(BLOCK_SELECTOR, move |el| {
                    // Opening a block element: the next text run starts a new paragraph.
                    s_blocks.borrow_mut().boundary = true;
                    // Closing it too, so `<div>…</div>text` breaks as well. Void elements
                    // (br/hr/col) have no end tag — on_end_tag errors, which we ignore.
                    let s_end = Rc::clone(&s_blocks);
                    let _ = el.on_end_tag(lol_html::end_tag!(move |_end| {
                        s_end.borrow_mut().boundary = true;
                        Ok(())
                    }));
                    Ok(())
                }))
                .append_document_content_handler(doc_text!(move |t| {
                    let mut s = s_text.borrow_mut();
                    if matches!(t.text_type(), TextType::Data | TextType::CDataSection) {
                        s.node.push_str(t.as_str());
                        if t.last_in_text_node() {
                            let node = std::mem::take(&mut s.node);
                            let mut unescaped = String::with_capacity(node.len());
                            push_unescaped(&mut unescaped, &node);
                            push_ws_and_literal(&mut s, &unescaped);
                        }
                    } else {
                        // script/style/title/textarea content: drop it, reset the buffer.
                        s.node.clear();
                    }
                    Ok(())
                })),
            |_: &[u8]| {},
        );
        // Poisoned rewriters panic on further use — only end() when write() succeeded.
        if rewriter.write(html).is_ok() {
            let _ = rewriter.end();
        }
    }
    let mut s = sink.borrow_mut();
    if !s.node.is_empty() {
        let node = std::mem::take(&mut s.node);
        let mut unescaped = String::with_capacity(node.len());
        push_unescaped(&mut unescaped, &node);
        push_ws_and_literal(&mut s, &unescaped);
    }
    s.out.trim().to_string()
}

/// Push literal text: ASCII-whitespace runs → pending flag; the first non-whitespace char
/// flushes the pending separator (`\n\n` when a block boundary was crossed, else one space)
/// and consumes the boundary. Non-breaking space (U+00A0) is content, not whitespace.
fn push_ws_and_literal(s: &mut TextSink, text: &str) {
    for ch in text.chars() {
        if ch.is_ascii_whitespace() {
            s.pending_ws = true;
        } else {
            if s.pending_ws && !s.out.is_empty() {
                if s.boundary {
                    s.out.push_str("\n\n");
                } else {
                    s.out.push(' ');
                }
            }
            s.pending_ws = false;
            s.boundary = false;
            s.out.push(ch);
        }
    }
}

/// Append `text` to `out`, resolving HTML entities (numeric + a table of common named ones
/// + the XML predefined five). Unknown named entities are kept verbatim.
fn push_unescaped(out: &mut String, text: &str) {
    if !text.contains('&') {
        out.push_str(text);
        return;
    }
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i + 1..];
        let semicolon = rest.find(';');
        if let Some(j) = semicolon {
            if j <= 32 && push_entity_resolved(out, &rest[..j]) {
                rest = &rest[j + 1..];
                continue;
            }
        }
        out.push('&');
    }
    out.push_str(rest);
}

fn push_entity_resolved(out: &mut String, name: &str) -> bool {
    if let Some(n) = name.strip_prefix('#') {
        let code = if let Some(hex) = n.strip_prefix(['x', 'X']) {
            u32::from_str_radix(hex, 16).ok()
        } else {
            n.parse::<u32>().ok()
        };
        if let Some(c) = code.and_then(char::from_u32) {
            if c != '\0' {
                out.push(c);
                return true;
            }
        }
        return false;
    }
    if let Some(repl) = opf::named_entity(name) {
        out.push_str(repl);
        return true;
    }
    if let Some(repl) = quick_xml::escape::resolve_predefined_entity(name) {
        out.push_str(repl);
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn testbook(name: &str) -> String {
        format!("{}/../testbooks/{name}.epub", env!("CARGO_MANIFEST_DIR"))
    }

    // ---- real testbooks (§8 B1) ----

    #[test]
    fn testbook_pg11_alice() {
        let b = open_book(&testbook("pg11")).unwrap();
        assert!(!b.spine.is_empty());
        assert!(!b.toc.is_empty());
        assert_eq!(b.metadata.title, "Alice's Adventures in Wonderland");
        assert_eq!(b.metadata.authors, vec!["Lewis Carroll".to_string()]);
        assert_eq!(b.metadata.language.as_deref(), Some("en"));
        assert_eq!(b.container_dir, "OEBPS");
        assert!(b.metadata.cover_href.is_some());
        // toc resolution: every entry points at a spine chapter
        assert!(b.toc.iter().all(|e| e.chapter_idx >= 0));
        // pg11's NCX targets all carry a fragment; each resolved entry keeps it as `#frag`
        // (never the full href transport).
        assert!(b
            .toc
            .iter()
            .all(|e| e.cfi.as_ref().is_none_or(|c| c.starts_with('#'))));
        assert!(b.toc.iter().any(|e| e.cfi.is_some()));
        assert!(b
            .toc
            .iter()
            .any(|e| e.title.contains("DOWN THE RABBIT-HOLE")
                || e.title.to_lowercase().contains("rabbit")));
    }

    #[test]
    fn testbook_pg13_poetry() {
        let b = open_book(&testbook("pg13")).unwrap();
        assert!(!b.spine.is_empty());
        assert!(!b.toc.is_empty());
        assert!(b.metadata.title.contains("Hunting of the Snark"));
        assert_eq!(b.metadata.authors, vec!["Lewis Carroll".to_string()]);
    }

    #[test]
    fn testbook_pg84_frankenstein_cover() {
        let b = open_book(&testbook("pg84")).unwrap();
        assert!(!b.spine.is_empty());
        assert!(!b.toc.is_empty());
        assert!(b.metadata.title.contains("Frankenstein"));
        assert!(!b.metadata.authors.is_empty());
        assert!(b.metadata.authors[0].contains("Shelley"));
        let cover = find_cover_href(&b).expect("pg84 cover");
        assert!(cover.ends_with(".jpg"), "cover: {cover}");
        assert!(cover.contains("cover"));
        // cover bytes are actually readable from the zip
        let bytes = zip_entry_bytes(&b.path, &cover).unwrap();
        assert!(bytes.len() > 1000);
    }

    #[test]
    fn testbook_pg2600_war_and_peace_cover() {
        let b = open_book(&testbook("pg2600")).unwrap();
        assert!(!b.spine.is_empty());
        assert!(b.spine.len() > 100, "huge book, spine: {}", b.spine.len());
        assert!(!b.toc.is_empty());
        assert_eq!(b.metadata.title, "War and Peace");
        assert!(b.metadata.authors.iter().any(|a| a.contains("Tolstoy")));
        let cover = find_cover_href(&b).expect("pg2600 cover");
        assert!(cover.ends_with(".jpg"));
        let bytes = zip_entry_bytes(&b.path, &cover).unwrap();
        assert!(bytes.len() > 1000);
        // NCX fragments (#pgepubid…) resolve to chapters, not -1
        let resolved = b.toc.iter().filter(|e| e.chapter_idx >= 0).count();
        assert!(
            resolved as f64 / b.toc.len() as f64 > 0.9,
            "toc resolved {resolved}/{}",
            b.toc.len()
        );
    }

    #[test]
    fn uid_stable_across_calls_and_lowercase_hex_sha1() {
        for name in ["pg11", "pg13", "pg84", "pg2600"] {
            let b1 = open_book(&testbook(name)).unwrap();
            let b2 = open_book(&testbook(name)).unwrap();
            assert_eq!(b1.uid, b2.uid, "{name}: uid unstable");
            assert_eq!(b1.uid.len(), 40);
            assert!(
                b1.uid
                    .chars()
                    .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
                "uid not lowercase hex: {}",
                b1.uid
            );
        }
        // Gutenberg identifier-based: sha1 of the dc:identifier string
        let b = open_book(&testbook("pg11")).unwrap();
        let mut h = Sha1::new();
        h.update(b.metadata.identifier.as_deref().unwrap().as_bytes());
        assert_eq!(b.uid, hex_lower(&h.finalize()));
    }

    #[test]
    fn compute_uid_fallback_size_plus_first_64k() {
        // No identifier → size + first 64 KiB hash; stable across calls.
        let meta = BookMetadata::default();
        let pb = testbook("pg11");
        let path = Path::new(&pb);
        let u1 = compute_uid(&meta, path).unwrap();
        let u2 = compute_uid(&meta, path).unwrap();
        assert_eq!(u1, u2);
        assert_eq!(u1.len(), 40);
        // Different identifier → different uid
        let mut m = BookMetadata {
            identifier: Some("abc".into()),
            ..Default::default()
        };
        assert_ne!(compute_uid(&m, path).unwrap(), u1);
        // Whitespace-only identifier counts as empty
        m.identifier = Some("   ".into());
        assert_eq!(compute_uid(&m, path).unwrap(), u1);
    }

    #[test]
    fn book_archive_is_send_and_static() {
        fn assert_send_static<T: Send + 'static>() {}
        assert_send_static::<BookArchive>();
    }

    // ---- malformed input: Err, never panic ----

    #[test]
    fn malformed_zip_is_err_not_panic() {
        let dir = std::env::temp_dir();
        let garbage = dir.join(format!("vellum-b1-garbage-{}.epub", std::process::id()));
        std::fs::write(&garbage, b"this is not a zip file at all").unwrap();
        assert!(open_book(garbage.to_str().unwrap()).is_err());
        assert!(zip_entry_bytes(garbage.to_str().unwrap(), "mimetype").is_err());
        let _ = std::fs::remove_file(&garbage);

        // Truncated zip (valid header, cut middle).
        let full = std::fs::read(testbook("pg11")).unwrap();
        let trunc = dir.join(format!("vellum-b1-trunc-{}.epub", std::process::id()));
        std::fs::write(&trunc, &full[..full.len() / 2]).unwrap();
        let r = open_book(trunc.to_str().unwrap());
        assert!(r.is_err() || r.is_ok(), "must not panic"); // either, but no panic
        let _ = std::fs::remove_file(&trunc);

        // Nonexistent path.
        assert!(open_book("/nonexistent/vellum/book.epub").is_err());
        assert!(zip_entry_bytes("/nonexistent/vellum/book.epub", "x").is_err());
    }

    #[test]
    fn missing_entry_is_err() {
        let r = zip_entry_bytes(&testbook("pg11"), "OEBPS/definitely-not-here.xhtml");
        assert!(r.is_err());
    }

    #[test]
    fn zip_entry_bytes_exact_lookup() {
        let bytes = zip_entry_bytes(&testbook("pg11"), "META-INF/container.xml").unwrap();
        assert!(bytes.windows(10).any(|w| w == b"rootfiles>"));
        let mime = zip_entry_bytes(&testbook("pg11"), "mimetype").unwrap();
        assert_eq!(mime, b"application/epub+zip");
    }

    // ---- nav_or_ncx_toc standalone ----

    #[test]
    fn nav_or_ncx_toc_standalone_shape() {
        let ncx = zip_entry_bytes(&testbook("pg84"), "OEBPS/toc.ncx").unwrap();
        let toc = nav_or_ncx_toc(&ncx, NavKind::Ncx).unwrap();
        assert!(!toc.is_empty());
        assert!(toc.iter().all(|e| e.cfi.is_none()), "cfi must be null");
        assert!(toc.iter().all(|e| e.chapter_idx == -1), "no spine context");
        assert!(toc.iter().all(|e| !e.title.is_empty()));
        // Garbage → Err or empty Ok, never panic (tolerant parsers).
        for input in [&b"<<<>>>"[..], b"", b"<ncx", &[0xFF, 0x00, 0xFE][..]] {
            let _ = nav_or_ncx_toc(input, NavKind::Ncx);
            let _ = nav_or_ncx_toc(input, NavKind::Nav);
        }
        // Structurally-empty input parses to an empty list.
        assert!(nav_or_ncx_toc(b"", NavKind::Ncx).unwrap().is_empty());
        assert!(nav_or_ncx_toc(b"", NavKind::Nav).unwrap().is_empty());
    }

    // ---- extract_text ----

    #[test]
    fn extract_text_basic_shape() {
        let html = r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1 — Skip Me</title>
<style>body { color: red; }  .skip {}</style>
<script>var evil = "skip me too";</script></head>
<body>
<h1>  Chapter   One </h1>
<p>First   paragraph with <em>inline <b>deep</b> markup</em> and
   wrapped lines.</p>
<p>Second paragraph &amp; entities: &ldquo;quotes&rdquo; &#8212; dash &nbsp;nbsp-end.</p>
<div><p>Nested</p></div>
Line break:<br/>after br.
</body></html>"#
            .as_bytes();
        let text = extract_text(html);
        assert!(!text.contains("Skip Me"), "title text must be dropped");
        assert!(!text.contains("color: red"), "style text must be dropped");
        assert!(!text.contains("evil"), "script text must be dropped");
        assert!(text.contains("Chapter One"));
        assert!(text.contains("First paragraph with inline deep markup and wrapped lines."));
        assert!(text.contains("Second paragraph & entities: \u{201c}quotes\u{201d} \u{2014} dash"));
        assert!(text.contains("\u{a0}nbsp-end"));
        // Paragraph breaks are \n\n
        assert!(text.contains("wrapped lines.\n\nSecond paragraph"));
        assert!(text.contains("Chapter One\n\nFirst paragraph"));
        assert!(text.contains("Nested\n\nLine break:"));
        // No leading/trailing whitespace, no double spaces
        assert_eq!(text, text.trim());
        assert!(!text.contains("  "));
    }

    #[test]
    fn extract_text_unicode_and_entities_split() {
        let html = "<p>Русский текст — «война и мир» &amp; more</p><p>éèê 日本語</p>".as_bytes();
        let text = extract_text(html);
        assert!(text.contains("Русский текст — «война и мир» & more"));
        assert!(text.contains("éèê 日本語"));
    }

    #[test]
    fn extract_text_malformed_no_panic() {
        assert_eq!(extract_text(b""), "");
        // lol_html is an HTML5 parser: garbage may still yield stray text — never panic.
        let _ = extract_text(b"<<<not html>>>");
        let _ = extract_text(&[0xFF, 0xFE, 0x00, b'<', b'p'][..]);
        let text = extract_text(b"<p>unclosed paragraph <b>bold");
        assert!(text.contains("unclosed paragraph"));
        assert!(text.contains("bold"));
        // Unterminated script swallows the rest per HTML rules — must not panic.
        let text2 = extract_text(b"<script>var x = 1;<p>after</p>");
        assert!(
            !text2.contains("evil") && !text2.contains("var x"),
            "script dropped"
        );
    }

    #[test]
    fn extract_text_lone_ampersand_kept() {
        let text = extract_text(b"<p>A & B &amp; C &unknown; D &#38; E</p>");
        assert!(text.contains("A & B & C"));
        assert!(text.contains("&unknown;"));
        assert!(text.contains("D & E"));
    }

    // ---- find_cover_href fallback chain ----

    #[test]
    fn find_cover_chain_fallbacks() {
        let img = |id: &str, href: &str| ManifestItem {
            id: id.into(),
            href: href.into(),
            media_type: "image/jpeg".into(),
            properties: vec![],
        };
        // 5. first image wins when nothing else
        let b = BookArchive {
            manifest: vec![
                ManifestItem {
                    id: "css".into(),
                    href: "s.css".into(),
                    media_type: "text/css".into(),
                    properties: vec![],
                },
                img("i1", "a/pic1.png"),
                img("i2", "b/pic2.png"),
            ],
            ..Default::default()
        };
        assert_eq!(find_cover_href(&b).as_deref(), Some("a/pic1.png"));
        // 4. image whose href matches /cover/i
        let mut b2 = b.clone();
        b2.manifest.push(img("i3", "images/my_cover_art.jpg"));
        assert_eq!(
            find_cover_href(&b2).as_deref(),
            Some("images/my_cover_art.jpg")
        );
        // 3. id matching /cover/i (image only — a css "cover-style" must not win)
        let mut b3 = b.clone();
        b3.manifest.push(ManifestItem {
            id: "cover-style".into(),
            href: "cover.css".into(),
            media_type: "text/css".into(),
            properties: vec![],
        });
        b3.manifest.push(img("cover-img", "c.jpg"));
        assert_eq!(find_cover_href(&b3).as_deref(), Some("c.jpg"));
        // 2. meta name=cover id (cover_id) beats filename heuristics
        let mut b4 = b3.clone();
        b4.cover_id = Some("i2".into());
        assert_eq!(find_cover_href(&b4).as_deref(), Some("b/pic2.png"));
        // 1. cover-image property beats everything
        let mut b5 = b4.clone();
        b5.manifest.push(ManifestItem {
            id: "ci".into(),
            href: "ci.png".into(),
            media_type: "image/png".into(),
            properties: vec!["cover-image".into()],
        });
        assert_eq!(find_cover_href(&b5).as_deref(), Some("ci.png"));
        // no images at all
        let b6 = BookArchive::default();
        assert_eq!(find_cover_href(&b6), None);
    }

    // ---- performance (§ contract: open_book pg2600 < 300 ms, extract_text < 100 ms) ----

    #[test]
    fn perf_open_book_pg2600_under_300ms() {
        let path = testbook("pg2600");
        // Warm the file cache once (real-world: books are re-opened from library).
        let _ = open_book(&path).unwrap();
        let t = std::time::Instant::now();
        let b = open_book(&path).unwrap();
        let el = t.elapsed();
        println!(
            "[B1 perf] open_book(pg2600): {:?} (spine={}, toc={}, entries={})",
            el,
            b.spine.len(),
            b.toc.len(),
            b.manifest.len()
        );
        assert!(el.as_millis() < 300, "open_book took {el:?}");
    }

    #[test]
    fn perf_extract_text_biggest_chapter_under_100ms() {
        let b = open_book(&testbook("pg2600")).unwrap();
        // Find the biggest spine chapter by decompressed size.
        let mut biggest: Option<(usize, String)> = None;
        for s in &b.spine {
            if let Ok(bytes) = zip_entry_bytes(&b.path, &s.href) {
                if biggest
                    .as_ref()
                    .map(|(n, _)| bytes.len() > *n)
                    .unwrap_or(true)
                {
                    biggest = Some((bytes.len(), s.href.clone()));
                }
            }
        }
        let (size, href) = biggest.expect("spine chapter readable");
        let html = zip_entry_bytes(&b.path, &href).unwrap();
        let t = std::time::Instant::now();
        let text = extract_text(&html);
        let el = t.elapsed();
        println!(
            "[B1 perf] extract_text({href}, {size} B): {:?} -> {} chars",
            el,
            text.len()
        );
        assert!(el.as_millis() < 100, "extract_text took {el:?}");
        assert!(text.len() > 1000);
    }
}
