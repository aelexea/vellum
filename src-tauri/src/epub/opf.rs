//! OPF parsing: metadata, manifest, spine, cover detection (§3) — owned by B1.
//!
//! Streaming quick-xml parse, tolerant of: namespace prefixes (resolved via xmlns map with a
//! `dc:` literal fallback), attribute order, EPUB2 (no `properties`) and EPUB3, CDATA text,
//! entities (quick-xml 0.42 emits `GeneralRef` events), weird whitespace, missing optional
//! elements, self-closing vs paired tags.

use std::collections::HashMap;

use quick_xml::events::{BytesRef, BytesStart, Event};
use quick_xml::{Reader, XmlVersion};

use super::{BookMetadata, ManifestItem, SpineItem};

const DC_NS: &str = "http://purl.org/dc/elements/1.1/";

/// Parsed OPF document.
#[derive(Debug, Clone, Default)]
pub struct Opf {
    pub metadata: BookMetadata,
    pub manifest: Vec<ManifestItem>,
    pub spine: Vec<SpineItem>,
    /// manifest id marked `properties="cover-image"` or `meta name="cover"`.
    pub cover_id: Option<String>,
    /// Directory of the OPF inside the zip, normalized with trailing `/` stripped.
    pub dir: String,
    /// `spine@toc` — manifest id of the NCX (EPUB2).
    pub toc_id: Option<String>,
}

/// Which metadata element's text is currently being accumulated.
enum Capture {
    Title,
    Creator,
    Language,
    Identifier(Option<String>),
}

/// One manifest item's raw attributes, shared by the `Start`/`Empty` arms.
struct ItemAttrs {
    id: String,
    href: String,
    media_type: String,
    properties: Vec<String>,
}

fn item_attrs(e: &BytesStart<'_>) -> ItemAttrs {
    let id = attr(e, "id").unwrap_or_default();
    let raw_href = attr(e, "href").unwrap_or_default();
    let media_type = attr(e, "media-type").unwrap_or_default();
    let properties: Vec<String> = attr(e, "properties")
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_string)
        .collect();
    ItemAttrs {
        id,
        href: raw_href,
        media_type,
        properties,
    }
}

/// Parse OPF bytes; `opf_zip_path` is used to resolve `dir` for relative hrefs.
pub fn parse(opf_bytes: &[u8], opf_zip_path: &str) -> anyhow::Result<Opf> {
    let dir = dir_of(&percent_decode(opf_zip_path));

    let mut reader = Reader::from_reader(opf_bytes);
    // Tolerate broken-but-readable documents (dangling `&`, mismatched end tags).
    reader.config_mut().allow_dangling_amp = true;
    reader.config_mut().check_end_names = false;

    let mut opf = Opf {
        dir,
        ..Default::default()
    };
    let mut prefixes: HashMap<String, String> = HashMap::new();
    let mut unique_identifier: Option<String> = None;
    let mut identifiers: Vec<(Option<String>, String)> = Vec::new();
    let mut titles: Vec<String> = Vec::new();
    let mut creators: Vec<String> = Vec::new();
    let mut languages: Vec<String> = Vec::new();
    let mut meta_cover_id: Option<String> = None;
    let mut cover_image_id: Option<String> = None;
    let mut id_to_href: HashMap<String, String> = HashMap::new();

    let mut in_metadata = false;
    let mut capture: Option<Capture> = None;
    let mut capture_el: String = String::new();
    let mut cur = String::new();

    // Stash the accumulated text of the element currently being captured.
    macro_rules! finish_capture {
        () => {
            if let Some(c) = capture.take() {
                let text = collapse_ws(&cur);
                match c {
                    Capture::Title => titles.push(text),
                    Capture::Creator => {
                        if !text.is_empty() {
                            creators.push(text);
                        }
                    }
                    Capture::Language => languages.push(text),
                    Capture::Identifier(id) => identifiers.push((id, text)),
                }
                cur.clear();
            }
        };
    }

    // Begin capturing text for a metadata element (first-open wins; ignores nested junk).
    macro_rules! begin_capture {
        ($cap:expr, $local:expr) => {
            if capture.is_none() {
                capture = Some($cap);
                capture_el = $local.to_string();
                cur.clear();
            }
        };
    }

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                collect_namespaces(&e, &mut prefixes);
                let full = e.name();
                let (prefix, local) = split_qname(full.as_ref());
                let dc = is_dc(prefix, &prefixes);
                match local {
                    "package" => {
                        if let Some(v) = attr(&e, "unique-identifier") {
                            unique_identifier = Some(v);
                        }
                    }
                    "metadata" => in_metadata = true,
                    "title" if in_metadata && dc => begin_capture!(Capture::Title, local),
                    "creator" if in_metadata && dc => begin_capture!(Capture::Creator, local),
                    "language" if in_metadata && dc => begin_capture!(Capture::Language, local),
                    "identifier" if in_metadata && dc => {
                        let id = attr(&e, "id");
                        begin_capture!(Capture::Identifier(id), local)
                    }
                    "meta" if in_metadata => {
                        // EPUB2: <meta name="cover" content="ID"/>
                        if attr(&e, "name").map(|n| n.eq_ignore_ascii_case("cover")) == Some(true) {
                            if let Some(content) = attr(&e, "content") {
                                if meta_cover_id.is_none() {
                                    meta_cover_id = Some(content);
                                }
                            }
                        }
                    }
                    "item" => {
                        let a = item_attrs(&e);
                        if !a.id.is_empty() && !a.href.is_empty() {
                            let href = normalize_href(&a.href, &opf.dir);
                            if cover_image_id.is_none()
                                && a.properties.iter().any(|p| p == "cover-image")
                            {
                                cover_image_id = Some(a.id.clone());
                            }
                            id_to_href.insert(a.id.clone(), href.clone());
                            opf.manifest.push(ManifestItem {
                                id: a.id,
                                href,
                                media_type: a.media_type,
                                properties: a.properties,
                            });
                        }
                    }
                    "spine" => {
                        if let Some(toc) = attr(&e, "toc") {
                            opf.toc_id = Some(toc);
                        }
                    }
                    "itemref" => {
                        if let Some(idref) = attr(&e, "idref") {
                            let linear = attr(&e, "linear")
                                .map(|v| !v.eq_ignore_ascii_case("no"))
                                .unwrap_or(true);
                            let href = id_to_href.get(&idref).cloned().unwrap_or_default();
                            opf.spine.push(SpineItem {
                                idref,
                                href,
                                linear,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                collect_namespaces(&e, &mut prefixes);
                let full = e.name();
                let (prefix, local) = split_qname(full.as_ref());
                let dc = is_dc(prefix, &prefixes);
                match local {
                    "package" => {
                        if let Some(v) = attr(&e, "unique-identifier") {
                            unique_identifier = Some(v);
                        }
                    }
                    "meta" if in_metadata => {
                        if attr(&e, "name").map(|n| n.eq_ignore_ascii_case("cover")) == Some(true) {
                            if let Some(content) = attr(&e, "content") {
                                if meta_cover_id.is_none() {
                                    meta_cover_id = Some(content);
                                }
                            }
                        }
                    }
                    "item" => {
                        let a = item_attrs(&e);
                        if !a.id.is_empty() && !a.href.is_empty() {
                            let href = normalize_href(&a.href, &opf.dir);
                            if cover_image_id.is_none()
                                && a.properties.iter().any(|p| p == "cover-image")
                            {
                                cover_image_id = Some(a.id.clone());
                            }
                            id_to_href.insert(a.id.clone(), href.clone());
                            opf.manifest.push(ManifestItem {
                                id: a.id,
                                href,
                                media_type: a.media_type,
                                properties: a.properties,
                            });
                        }
                    }
                    "spine" => {
                        if let Some(toc) = attr(&e, "toc") {
                            opf.toc_id = Some(toc);
                        }
                    }
                    "itemref" => {
                        if let Some(idref) = attr(&e, "idref") {
                            let linear = attr(&e, "linear")
                                .map(|v| !v.eq_ignore_ascii_case("no"))
                                .unwrap_or(true);
                            let href = id_to_href.get(&idref).cloned().unwrap_or_default();
                            opf.spine.push(SpineItem {
                                idref,
                                href,
                                linear,
                            });
                        }
                    }
                    // Self-closing metadata elements capture an empty value immediately
                    // (no End event will ever arrive for them).
                    "title" if in_metadata && dc => titles.push(String::new()),
                    "language" if in_metadata && dc => languages.push(String::new()),
                    "identifier" if in_metadata && dc => {
                        identifiers.push((attr(&e, "id"), String::new()))
                    }
                    "creator" => {} // empty creator contributes nothing
                    _ => {}
                }
            }
            Ok(Event::Text(e)) => {
                if capture.is_some() {
                    cur.push_str(e.as_ref());
                }
            }
            Ok(Event::CData(e)) => {
                if capture.is_some() {
                    cur.push_str(e.as_ref());
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if capture.is_some() {
                    push_entity(&mut cur, &r);
                }
            }
            Ok(Event::End(e)) => {
                let local = e.local_name();
                let local = local.as_ref();
                if capture.is_some() && local == capture_el {
                    finish_capture!();
                }
                if local == "metadata" {
                    in_metadata = false;
                }
            }
            Ok(Event::Eof) => {
                // Tolerant: a truncated document keeps what was parsed so far.
                finish_capture!();
                break;
            }
            Err(e) => return Err(anyhow::anyhow!("OPF parse error: {e}")),
            _ => {}
        }
    }

    // Assemble metadata.
    opf.metadata.title = titles
        .into_iter()
        .find(|t| !t.is_empty())
        .unwrap_or_default();
    opf.metadata.authors = creators;
    opf.metadata.language = languages.into_iter().find(|l| !l.is_empty());
    opf.metadata.identifier = pick_identifier(&identifiers, unique_identifier.as_deref());
    opf.cover_id = cover_image_id.or(meta_cover_id);

    Ok(opf)
}

/// Prefer the dc:identifier whose @id matches `package@unique-identifier`; else the first
/// non-empty one.
fn pick_identifier(
    identifiers: &[(Option<String>, String)],
    unique_identifier: Option<&str>,
) -> Option<String> {
    if let Some(uid) = unique_identifier {
        if let Some((_, text)) = identifiers
            .iter()
            .find(|(id, _)| id.as_deref() == Some(uid))
        {
            if !text.is_empty() {
                return Some(text.clone());
            }
        }
    }
    identifiers
        .iter()
        .find(|(_, text)| !text.is_empty())
        .map(|(_, text)| text.clone())
}

fn collect_namespaces(e: &BytesStart<'_>, prefixes: &mut HashMap<String, String>) {
    let mut attrs = e.attributes();
    attrs.with_checks(false);
    for a in attrs.flatten() {
        let key = a.key.as_ref().to_string();
        if let Some(p) = key.strip_prefix("xmlns:") {
            if let Ok(v) = a.normalized_value(XmlVersion::Implicit1_0) {
                prefixes.insert(p.to_string(), v.trim().to_string());
            }
        }
    }
}

/// Is this prefix bound to the Dublin Core namespace? Falls back to the literal `dc` prefix
/// when the document never declared that namespace (broken books do exist).
fn is_dc(prefix: &str, prefixes: &HashMap<String, String>) -> bool {
    match prefixes.get(prefix) {
        Some(uri) => uri == DC_NS,
        None => prefix == "dc",
    }
}

fn split_qname(full: &str) -> (&str, &str) {
    match full.split_once(':') {
        Some((p, l)) => (p, l),
        None => ("", full),
    }
}

/// Read one attribute by local name, entity-unescaped and trimmed.
pub(crate) fn attr(e: &BytesStart<'_>, local: &str) -> Option<String> {
    let mut attrs = e.attributes();
    attrs.with_checks(false);
    for a in attrs.flatten() {
        if a.key.local_name().as_ref() == local {
            if let Ok(v) = a.normalized_value(XmlVersion::Implicit1_0) {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

/// Append the resolved value of an XML entity/char reference (quick-xml 0.42 `GeneralRef`).
///
/// Resolution order: numeric char refs → common HTML named entities ([`named_entity`]) →
/// the XML predefined five → verbatim `&name;` (never silently drop book text).
pub(crate) fn push_entity(out: &mut String, r: &BytesRef<'_>) {
    if let Ok(Some(c)) = r.resolve_char_ref() {
        out.push(c);
        return;
    }
    if let Some(s) = named_entity(r) {
        out.push_str(s);
        return;
    }
    if let Some(s) = quick_xml::escape::resolve_predefined_entity(r) {
        out.push_str(s);
        return;
    }
    // Unknown named entity: keep it readable rather than dropping characters.
    out.push('&');
    out.push_str(r);
    out.push(';');
}

/// The HTML entities that realistically appear in book text and TOC labels (typography,
/// latin-1 letters, symbols). Anything else stays verbatim. Shared with `extract_text`.
pub(crate) fn named_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "nbsp" => "\u{a0}",
        "ldquo" => "\u{201c}",
        "rdquo" => "\u{201d}",
        "lsquo" => "\u{2018}",
        "rsquo" => "\u{2019}",
        "quot" => "\"",
        "apos" => "'",
        "mdash" => "\u{2014}",
        "ndash" => "\u{2013}",
        "hellip" => "\u{2026}",
        "laquo" => "\u{ab}",
        "raquo" => "\u{bb}",
        "copy" => "\u{a9}",
        "reg" => "\u{ae}",
        "trade" => "\u{2122}",
        "deg" => "\u{b0}",
        "times" => "\u{d7}",
        "divide" => "\u{f7}",
        "frac12" => "\u{bd}",
        "frac14" => "\u{bc}",
        "frac34" => "\u{be}",
        "sup2" => "\u{b2}",
        "sup3" => "\u{b3}",
        "para" => "\u{b6}",
        "sect" => "\u{a7}",
        "middot" => "\u{b7}",
        "bull" => "\u{2022}",
        "dagger" => "\u{2020}",
        "Dagger" => "\u{2021}",
        "permil" => "\u{2030}",
        "prime" => "\u{2032}",
        "Prime" => "\u{2033}",
        "lsaquo" => "\u{2039}",
        "rsaquo" => "\u{203a}",
        "euro" => "\u{20ac}",
        "pound" => "\u{a3}",
        "yen" => "\u{a5}",
        "cent" => "\u{a2}",
        "curren" => "\u{a4}",
        "eacute" => "\u{e9}",
        "egrave" => "\u{e8}",
        "ecirc" => "\u{ea}",
        "euml" => "\u{eb}",
        "agrave" => "\u{e0}",
        "aacute" => "\u{e1}",
        "acirc" => "\u{e2}",
        "auml" => "\u{e4}",
        "aring" => "\u{e5}",
        "atilde" => "\u{e3}",
        "aelig" => "\u{e6}",
        "ccedil" => "\u{e7}",
        "eth" => "\u{f0}",
        "iacute" => "\u{ed}",
        "igrave" => "\u{ec}",
        "icirc" => "\u{ee}",
        "iuml" => "\u{ef}",
        "ntilde" => "\u{f1}",
        "oacute" => "\u{f3}",
        "ograve" => "\u{f2}",
        "ocirc" => "\u{f4}",
        "ouml" => "\u{f6}",
        "otilde" => "\u{f5}",
        "oslash" => "\u{f8}",
        "szlig" => "\u{df}",
        "thorn" => "\u{fe}",
        "uacute" => "\u{fa}",
        "ugrave" => "\u{f9}",
        "ucirc" => "\u{fb}",
        "uuml" => "\u{fc}",
        "yacute" => "\u{fd}",
        "yuml" => "\u{ff}",
        "Eacute" => "\u{c9}",
        "Agrave" => "\u{c0}",
        "Auml" => "\u{c4}",
        "Ouml" => "\u{d6}",
        "Uuml" => "\u{dc}",
        "Ccedil" => "\u{c7}",
        "AElig" => "\u{c6}",
        "Oslash" => "\u{d8}",
        "Ntilde" => "\u{d1}",
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        _ => return None,
    })
}

/// Collapse all whitespace runs to single spaces and trim.
pub(crate) fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_ws = false;
    for ch in s.trim().chars() {
        if ch.is_whitespace() {
            if !last_ws {
                out.push(' ');
            }
            last_ws = true;
        } else {
            out.push(ch);
            last_ws = false;
        }
    }
    out
}

/// Directory part of a zip path (no trailing slash; "" when at root).
pub(crate) fn dir_of(zip_path: &str) -> String {
    match zip_path.rfind('/') {
        Some(i) => zip_path[..i].to_string(),
        None => String::new(),
    }
}

/// Lenient percent-decode; invalid sequences are kept verbatim.
pub(crate) fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Percent-encode a path for zip-name fallback lookups (keeps `/` and unreserved chars).
pub(crate) fn percent_encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Resolve `.`/`..` segments and collapse duplicate slashes (operates on the still-encoded
/// form so a literal `%2F` inside a filename never becomes a separator).
fn resolve_dot_segments(path: &str) -> String {
    let mut stack: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                stack.pop();
            }
            other => stack.push(other),
        }
    }
    stack.join("/")
}

/// Normalize a manifest/nav href to a zip-root-relative, percent-decoded storage path:
/// resolve against the OPF directory, handle `../`, collapse duplicate slashes, percent-decode.
pub(crate) fn normalize_href(raw: &str, dir: &str) -> String {
    let raw = raw.trim();
    let joined = if let Some(rest) = raw.strip_prefix('/') {
        // Zip-root absolute (rare, technically invalid): treat as relative to root.
        rest.to_string()
    } else if dir.is_empty() {
        raw.to_string()
    } else {
        format!("{dir}/{raw}")
    };
    percent_decode(&resolve_dot_segments(&joined))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPUB2_OPF: &[u8] = br#"<?xml version='1.0' encoding='UTF-8'?>
<package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata>
    <dc:identifier opf:scheme="URI" id="other">urn:other:1</dc:identifier>
    <dc:identifier id="bookid">urn:uuid:12345</dc:identifier>
    <dc:title>  Test
   Book  </dc:title>
    <dc:creator opf:file-as="Doe, John">John Doe</dc:creator>
    <dc:creator>Jane Roe</dc:creator>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item href="cover.jpg" id="cover-img" media-type="image/jpeg"/>
    <item href="text/ch1.xhtml" id="c1" media-type="application/xhtml+xml"/>
    <item href="../images//pic.png" id="p1" media-type="image/png"/>
    <item href="my%20chapter.xhtml" id="c2" media-type="application/xhtml+xml"/>
    <item href="toc.ncx" id="ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1" linear="yes"/>
    <itemref idref="c2" linear="no"/>
    <itemref idref="missing-item"/>
  </spine>
</package>"#;

    #[test]
    fn parses_epub2_opf() {
        let opf = parse(EPUB2_OPF, "OEBPS/content.opf").unwrap();
        assert_eq!(opf.dir, "OEBPS");
        assert_eq!(opf.metadata.title, "Test Book");
        assert_eq!(opf.metadata.authors, vec!["John Doe", "Jane Roe"]);
        assert_eq!(opf.metadata.language.as_deref(), Some("en"));
        // unique-identifier="bookid" wins over the first dc:identifier.
        assert_eq!(opf.metadata.identifier.as_deref(), Some("urn:uuid:12345"));
        assert_eq!(opf.cover_id.as_deref(), Some("cover-img"));
        assert_eq!(opf.toc_id.as_deref(), Some("ncx"));
        assert_eq!(opf.manifest.len(), 5);
        assert_eq!(opf.spine.len(), 3);
        assert!(opf.spine[0].linear);
        assert!(!opf.spine[1].linear);
        assert_eq!(opf.spine[0].href, "OEBPS/text/ch1.xhtml");
        assert!(opf.spine[2].href.is_empty(), "missing idref -> empty href");
    }

    #[test]
    fn normalizes_hrefs() {
        let opf = parse(EPUB2_OPF, "OEBPS/content.opf").unwrap();
        let by_id = |id: &str| {
            opf.manifest
                .iter()
                .find(|m| m.id == id)
                .unwrap()
                .href
                .clone()
        };
        assert_eq!(by_id("c1"), "OEBPS/text/ch1.xhtml");
        // ../ escapes OEBPS; duplicate slashes collapse.
        assert_eq!(by_id("p1"), "images/pic.png");
        // percent-decoded storage form
        assert_eq!(by_id("c2"), "OEBPS/my chapter.xhtml");
        assert_eq!(by_id("cover-img"), "OEBPS/cover.jpg");
    }

    #[test]
    fn root_level_opf_dir_empty() {
        let opf = parse(EPUB2_OPF, "content.opf").unwrap();
        assert_eq!(opf.dir, "");
        assert_eq!(opf.manifest[1].href, "text/ch1.xhtml");
    }

    #[test]
    fn parses_epub3_properties() {
        let xml = br#"<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="uid">
  <metadata>
    <dc:identifier id="uid">urn:uuid:epub3</dc:identifier>
    <dc:title>EPUB3 Book</dc:title>
    <dc:language>ru</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item href="images/cover.png" id="ci" media-type="image/png" properties="cover-image"/>
    <item href="nav.xhtml" id="nav" media-type="application/xhtml+xml" properties="nav"/>
    <item href="ch1.xhtml" id="c1" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>"#;
        let opf = parse(xml, "OPS/package.opf").unwrap();
        assert_eq!(opf.metadata.title, "EPUB3 Book");
        assert_eq!(opf.metadata.identifier.as_deref(), Some("urn:uuid:epub3"));
        assert_eq!(opf.cover_id.as_deref(), Some("ci"));
        let nav = opf.manifest.iter().find(|m| m.id == "nav").unwrap();
        assert_eq!(nav.properties, vec!["nav"]);
        assert_eq!(nav.href, "OPS/nav.xhtml");
        assert!(opf.spine[0].linear, "linear defaults to yes");
    }

    #[test]
    fn cover_image_property_beats_meta_cover() {
        let xml = br#"<package xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0">
  <metadata>
    <dc:title>T</dc:title><dc:identifier id="i">x</dc:identifier>
    <meta name="cover" content="epub2-cover"/>
  </metadata>
  <manifest>
    <item href="e2.jpg" id="epub2-cover" media-type="image/jpeg"/>
    <item href="e3.png" id="e3" media-type="image/png" properties="cover-image"/>
  </manifest>
  <spine/>
</package>"#;
        let opf = parse(xml, "content.opf").unwrap();
        assert_eq!(opf.cover_id.as_deref(), Some("e3"));
    }

    #[test]
    fn missing_creator_and_cdata_and_entities() {
        let xml = br#"<package xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <metadata>
    <dc:title><![CDATA[  CDATA  &  Title  ]]></dc:title>
    <dc:identifier>id-&amp;-ent</dc:identifier>
    <dc:language>fr</dc:language>
    <dc:creator>   </dc:creator>
  </metadata>
  <manifest><item href="a.xhtml" id="a" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="a"/></spine>
</package>"#;
        let opf = parse(xml, "OEBPS/content.opf").unwrap();
        assert_eq!(opf.metadata.title, "CDATA & Title");
        assert_eq!(opf.metadata.identifier.as_deref(), Some("id-&-ent"));
        assert!(
            opf.metadata.authors.is_empty(),
            "whitespace-only creator dropped"
        );
    }

    #[test]
    fn self_closing_empty_title_no_hang() {
        let xml = br#"<package xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <metadata><dc:title/><dc:identifier>i</dc:identifier><dc:language/></metadata>
  <manifest><item href="a.xhtml" id="a" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="a"/></spine>
</package>"#;
        let opf = parse(xml, "content.opf").unwrap();
        assert_eq!(opf.metadata.title, "");
        assert_eq!(opf.metadata.identifier.as_deref(), Some("i"));
        assert_eq!(opf.metadata.language, None);
    }

    #[test]
    fn unprefixed_dc_via_literal_prefix_fallback() {
        // Broken book: dc: prefix used without any namespace declaration.
        let xml = br#"<package version="2.0">
  <metadata>
    <dc:title>No NS Book</dc:title>
    <dc:identifier>i1</dc:identifier>
  </metadata>
  <manifest><item href="a.xhtml" id="a" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="a"/></spine>
</package>"#;
        let opf = parse(xml, "content.opf").unwrap();
        assert_eq!(opf.metadata.title, "No NS Book");
    }

    #[test]
    fn truncated_opf_partial_not_panic() {
        // Truncated document hits Eof mid-parse; tolerant parse keeps what it saw.
        let r = parse(b"<package><metadata><dc:title>x</dc:title>", "content.opf");
        assert!(r.is_ok());
        assert_eq!(r.unwrap().metadata.title, "x");
    }

    #[test]
    fn garbage_opf_no_panic() {
        // Tolerant parser: garbage may yield Err or an empty Ok — the bar is "never panic".
        let r = parse(b"<<<not xml>>>", "content.opf");
        if let Ok(opf) = r {
            assert!(opf.manifest.is_empty());
            assert!(opf.spine.is_empty());
            assert!(opf.metadata.title.is_empty());
        }
        // Empty input must not panic either.
        let _ = parse(b"", "content.opf");
    }

    #[test]
    fn normalize_href_cases() {
        assert_eq!(normalize_href("a/b.xhtml", "OEBPS"), "OEBPS/a/b.xhtml");
        assert_eq!(normalize_href("../x.xhtml", "OEBPS/text"), "OEBPS/x.xhtml");
        assert_eq!(normalize_href("../../x.xhtml", "OEBPS/text"), "x.xhtml");
        assert_eq!(normalize_href("/abs.xhtml", "OEBPS"), "abs.xhtml");
        assert_eq!(normalize_href("a//b///c.xhtml", ""), "a/b/c.xhtml");
        assert_eq!(normalize_href("./a.xhtml", "d"), "d/a.xhtml");
        assert_eq!(
            normalize_href("%D0%B3%D0%BB.xhtml", "OEBPS"),
            "OEBPS/гл.xhtml"
        );
        assert_eq!(
            normalize_href("sp%20ace.xhtml", "OEBPS"),
            "OEBPS/sp ace.xhtml"
        );
        // Invalid percent sequence kept verbatim.
        assert_eq!(normalize_href("a%zz.xhtml", ""), "a%zz.xhtml");
        // Deep ../ can't escape the zip root.
        assert_eq!(normalize_href("../../../../x", "a/b"), "x");
    }

    #[test]
    fn percent_encode_path_roundtrip() {
        assert_eq!(
            percent_encode_path("OEBPS/my chapter.xhtml"),
            "OEBPS/my%20chapter.xhtml"
        );
        assert_eq!(
            percent_decode(&percent_encode_path("dir/гл ава+file(1).xhtml")),
            "dir/гл ава+file(1).xhtml"
        );
    }

    #[test]
    fn collapse_ws_cases() {
        assert_eq!(collapse_ws("  a \n\t b  "), "a b");
        assert_eq!(collapse_ws(""), "");
        assert_eq!(collapse_ws("   "), "");
    }
}
