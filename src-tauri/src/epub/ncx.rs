//! NCX + EPUB3 nav.xhtml → `Vec<TocEntry>` (§3) — owned by B1.
//!
//! Streaming quick-xml parse; nesting depth → `level` (1-based), recursion stack →
//! `parent_idx` (0-based index into the flat vec, `None` at top level). Document order is
//! preserved (parents are emitted when their own label/content is seen, before descendants).
//!
//! ## href transport through `cfi`
//!
//! `TocEntry` (frozen dto.rs) has no href field, but `resolve_chapter_indices` must map each
//! entry to a spine position. The parsers therefore stash the **normalized** target href
//! (fragment kept) in `TocEntry::cfi` as an internal transport; [`resolve_chapter_indices`]
//! consumes it — resolves `chapter_idx` (or -1) from the fragment-less path and leaves `cfi`
//! holding just the `#fragment` of a mid-chapter entry (`None` otherwise), so distinct entries
//! into one chapter keep their anchor (deviation from §11.1's cfi=null: the reader resolves
//! `#fragment` via the controller). Callers of `parse_ncx`/`parse_nav`/`nav_or_ncx_toc` that
//! persist entries MUST run `resolve_chapter_indices` first.

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

use crate::dto::TocEntry;

use super::opf::{attr, collapse_ws, normalize_href, push_entity};
use super::{ManifestItem, SpineItem};

/// Parse `toc.ncx` bytes into a flat TocEntry list (levels/parents resolved).
///
/// `cfi` carries the raw target href until [`resolve_chapter_indices`] is called (see module
/// docs). Sources are treated as zip-root relative; use the crate-internal
/// `parse_ncx_in` when the NCX lives in a subdirectory (open_book does).
pub fn parse_ncx(bytes: &[u8]) -> anyhow::Result<Vec<TocEntry>> {
    parse_ncx_in(bytes, "")
}

/// Parse EPUB3 `nav.xhtml` bytes (the nav document with `epub:type="toc"`).
///
/// Same `cfi` transport contract as [`parse_ncx`].
pub fn parse_nav(bytes: &[u8]) -> anyhow::Result<Vec<TocEntry>> {
    parse_nav_in(bytes, "")
}

/// Resolve `chapter_idx` for each entry against spine hrefs; -1 when unresolved.
///
/// Consumes the href stashed in `cfi` (module docs): strips the fragment for the lookup,
/// resolves `chapter_idx` against `spine_hrefs` (already-normalized zip-relative storage
/// forms, both sides percent-decoded), then leaves `cfi` holding just the `#fragment` of a
/// **resolved** mid-chapter entry so the reader can jump to the anchor instead of collapsing
/// every entry into its chapter's top; `None` when the href had no fragment or the entry did
/// not resolve (a fragment without a chapter is not navigable). Idempotent: entries whose
/// `cfi` is already `None` or an already-resolved `#fragment` keep their `chapter_idx`.
pub fn resolve_chapter_indices(toc: &mut [TocEntry], spine_hrefs: &[String]) {
    for e in toc.iter_mut() {
        let Some(src) = e.cfi.take() else {
            continue;
        };
        // An already-resolved entry carries its bare `#fragment`; that is not a transport
        // href, so a second pass must leave it (and the resolved chapter_idx) alone.
        if src.starts_with('#') && e.chapter_idx >= 0 {
            e.cfi = Some(src);
            continue;
        }
        let path = src.split('#').next().unwrap_or("").trim();
        e.chapter_idx = spine_hrefs
            .iter()
            .position(|h| h == path)
            // Case-insensitive fallback for sloppy packers (exact match always wins).
            .or_else(|| {
                spine_hrefs
                    .iter()
                    .position(|h| h.eq_ignore_ascii_case(path))
            })
            .map(|i| i as i64)
            .unwrap_or(-1);
        e.cfi = if e.chapter_idx >= 0 {
            src.find('#').map(|i| src[i..].to_string())
        } else {
            None
        };
    }
}

/// Pick the navigation document: EPUB3 nav (manifest `properties` contains "nav") wins;
/// else the NCX (`media-type="application/x-dtbncx+xml"`). Returns the normalized zip path
/// and which parser to use.
pub fn find_nav_href(
    manifest: &[ManifestItem],
    _spine: &[SpineItem],
) -> Option<(String, super::NavKind)> {
    if let Some(m) = manifest
        .iter()
        .find(|m| m.properties.iter().any(|p| p == "nav"))
    {
        return Some((m.href.clone(), super::NavKind::Nav));
    }
    manifest
        .iter()
        .find(|m| m.media_type == "application/x-dtbncx+xml")
        .map(|m| (m.href.clone(), super::NavKind::Ncx))
}

// ---------------------------------------------------------------------------
// NCX
// ---------------------------------------------------------------------------

/// Stack frame for one open `<navPoint>`.
struct NavPointFrame {
    label: Option<String>,
    emitted: bool,
}

pub(crate) fn parse_ncx_in(bytes: &[u8], ncx_dir: &str) -> anyhow::Result<Vec<TocEntry>> {
    let mut reader = tolerant_reader(bytes);
    let mut out: Vec<TocEntry> = Vec::new();
    let mut last_at_depth: Vec<i64> = Vec::new(); // level-1 -> last entry idx at that level
    let mut stack: Vec<NavPointFrame> = Vec::new();

    let mut in_navmap = false;
    let mut in_navlabel = false;
    let mut capture_label = false;
    let mut cur = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let local = e.local_name();
                match local.as_ref() {
                    "navMap" => in_navmap = true,
                    "navPoint" if in_navmap => {
                        stack.push(NavPointFrame {
                            label: None,
                            emitted: false,
                        });
                    }
                    "navLabel" if in_navmap => in_navlabel = true,
                    "text" if in_navmap && in_navlabel && !stack.is_empty() => {
                        capture_label = true;
                        cur.clear();
                    }
                    // Paired-tag form <content src="…"></content> (some generators).
                    "content" if in_navmap => {
                        emit_ncx_entry(&e, &mut stack, &mut out, &mut last_at_depth, ncx_dir);
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                if in_navmap {
                    let local = e.local_name();
                    if local.as_ref() == "content" {
                        emit_ncx_entry(&e, &mut stack, &mut out, &mut last_at_depth, ncx_dir);
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if capture_label {
                    cur.push_str(e.as_ref());
                }
            }
            Ok(Event::CData(e)) => {
                if capture_label {
                    cur.push_str(e.as_ref());
                }
            }
            Ok(Event::GeneralRef(r)) => {
                if capture_label {
                    push_entity(&mut cur, &r);
                }
            }
            Ok(Event::End(e)) => {
                let local = e.local_name();
                match local.as_ref() {
                    "text" if capture_label => {
                        capture_label = false;
                        if let Some(top) = stack.last_mut() {
                            if top.label.is_none() {
                                let text = collapse_ws(&cur);
                                if !text.is_empty() {
                                    top.label = Some(text);
                                }
                            }
                        }
                        cur.clear();
                    }
                    "navLabel" => in_navlabel = false,
                    "navPoint" => {
                        stack.pop();
                    }
                    "navMap" => in_navmap = false,
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow::anyhow!("NCX parse error: {e}")),
            _ => {}
        }
    }

    fill_missing_titles(&mut out);
    Ok(out)
}

/// Emit the entry for the innermost open navPoint when its `<content src=…>` is seen.
fn emit_ncx_entry(
    e: &BytesStart<'_>,
    stack: &mut [NavPointFrame],
    out: &mut Vec<TocEntry>,
    last_at_depth: &mut Vec<i64>,
    ncx_dir: &str,
) {
    let level = stack.len() as i64;
    let Some(top) = stack.last_mut() else { return };
    if top.emitted {
        return; // one entry per navPoint even with duplicate <content>
    }
    let Some(src) = attr(e, "src").or_else(|| attr(e, "href")) else {
        return;
    };
    top.emitted = true;
    let parent_idx = if level >= 2 {
        last_at_depth.get(level as usize - 2).copied()
    } else {
        None
    };
    let title = top.label.take().unwrap_or_default();
    let idx = out.len() as i64;
    out.push(TocEntry {
        title,
        chapter_idx: -1,
        cfi: Some(normalize_href(&src, ncx_dir)),
        level,
        parent_idx,
    });
    if last_at_depth.len() < level as usize {
        last_at_depth.resize(level as usize, -1);
    }
    last_at_depth[level as usize - 1] = idx;
}

// ---------------------------------------------------------------------------
// EPUB3 nav.xhtml
// ---------------------------------------------------------------------------

/// What element's text is being accumulated inside the toc nav.
enum NavCapture {
    Anchor,
    Span,
}

pub(crate) fn parse_nav_in(bytes: &[u8], nav_dir: &str) -> anyhow::Result<Vec<TocEntry>> {
    let mut reader = tolerant_reader(bytes);
    let mut out: Vec<TocEntry> = Vec::new();
    let mut last_at_depth: Vec<i64> = Vec::new();

    let mut in_toc_nav = false;
    let mut nav_depth: usize = 0; // open <nav> elements inside/including the toc one
    let mut ol_depth: usize = 0;
    let mut capture: Option<NavCapture> = None;
    let mut capture_href: Option<String> = None;
    let mut cur = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let local = e.local_name();
                match local.as_ref() {
                    "nav" => {
                        if !in_toc_nav && is_toc_nav(&e) {
                            in_toc_nav = true;
                            nav_depth = 1;
                            ol_depth = 0;
                        } else if in_toc_nav {
                            nav_depth += 1;
                        }
                    }
                    "ol" if in_toc_nav => ol_depth += 1,
                    "a" if in_toc_nav && capture.is_none() => {
                        capture = Some(NavCapture::Anchor);
                        capture_href = attr(&e, "href");
                        cur.clear();
                    }
                    "span" if in_toc_nav && capture.is_none() => {
                        capture = Some(NavCapture::Span);
                        capture_href = None;
                        cur.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let local = e.local_name();
                match local.as_ref() {
                    "nav" => {
                        // <nav …/> — self-closing toc nav opens and closes immediately.
                        if in_toc_nav {
                            nav_depth = nav_depth.saturating_sub(1);
                            if nav_depth == 0 {
                                in_toc_nav = false;
                            }
                        }
                    }
                    // Self-closing <a/> or <span/> inside toc: emit with empty title.
                    "a" | "span" if in_toc_nav && capture.is_none() => {
                        let href = attr(&e, "href");
                        emit_nav_entry(
                            href.as_deref(),
                            "",
                            ol_depth,
                            &mut out,
                            &mut last_at_depth,
                            nav_dir,
                        );
                    }
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
                match local.as_ref() {
                    "a" if capture.is_some() && matches!(capture, Some(NavCapture::Anchor)) => {
                        let title = collapse_ws(&cur);
                        emit_nav_entry(
                            capture_href.take().as_deref(),
                            &title,
                            ol_depth.max(1),
                            &mut out,
                            &mut last_at_depth,
                            nav_dir,
                        );
                        capture = None;
                        cur.clear();
                    }
                    "span" if capture.is_some() && matches!(capture, Some(NavCapture::Span)) => {
                        let title = collapse_ws(&cur);
                        emit_nav_entry(
                            None,
                            &title,
                            ol_depth.max(1),
                            &mut out,
                            &mut last_at_depth,
                            nav_dir,
                        );
                        capture = None;
                        cur.clear();
                    }
                    "ol" if in_toc_nav => ol_depth = ol_depth.saturating_sub(1),
                    "nav" if in_toc_nav => {
                        nav_depth = nav_depth.saturating_sub(1);
                        if nav_depth == 0 {
                            in_toc_nav = false;
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow::anyhow!("nav.xhtml parse error: {e}")),
            _ => {}
        }
    }

    fill_missing_titles(&mut out);
    Ok(out)
}

/// Is this `<nav>` element the table of contents (epub:type token list contains "toc")?
fn is_toc_nav(e: &BytesStart<'_>) -> bool {
    attr(e, "type")
        .map(|v| v.split_whitespace().any(|t| t == "toc"))
        .unwrap_or(false)
}

#[allow(clippy::too_many_arguments)]
fn emit_nav_entry(
    href: Option<&str>,
    title: &str,
    level: usize,
    out: &mut Vec<TocEntry>,
    last_at_depth: &mut Vec<i64>,
    nav_dir: &str,
) {
    let level = level.max(1) as i64;
    let parent_idx = if level >= 2 {
        last_at_depth.get(level as usize - 2).copied()
    } else {
        None
    };
    let idx = out.len() as i64;
    out.push(TocEntry {
        title: title.to_string(),
        chapter_idx: -1,
        cfi: href.map(|h| normalize_href(h, nav_dir)),
        level,
        parent_idx,
    });
    if last_at_depth.len() < level as usize {
        last_at_depth.resize(level as usize, -1);
    }
    last_at_depth[level as usize - 1] = idx;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn tolerant_reader(bytes: &[u8]) -> Reader<&[u8]> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().allow_dangling_amp = true;
    reader.config_mut().check_end_names = false;
    reader
}

/// Empty titles fall back to "Chapter N" (N = 1-based position in document order).
fn fill_missing_titles(toc: &mut [TocEntry]) {
    for (i, e) in toc.iter_mut().enumerate() {
        if e.title.trim().is_empty() {
            e.title = format!("Chapter {}", i + 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NCX: &[u8] = br#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:depth" content="2"/></head>
  <docTitle><text>Book</text></docTitle>
  <navMap>
    <navPoint id="np-1" playOrder="1">
      <navLabel><text>Part  &amp; One</text></navLabel>
      <content src="text/part1.xhtml"/>
      <navPoint id="np-2" playOrder="2">
        <navLabel><text>  Chapter
        1  </text></navLabel>
        <content src="text/ch1.xhtml#start"/>
      </navPoint>
      <navPoint id="np-3" playOrder="3">
        <navLabel><text>   </text></navLabel>
        <content src="../other/ch2.xhtml"/>
      </navPoint>
    </navPoint>
    <navPoint id="np-4" playOrder="4">
      <navLabel><text>Part Two</text></navLabel>
      <content src="nowhere.xhtml"/>
    </navPoint>
  </navMap>
  <pageList><pageTarget><navLabel><text>1</text></navLabel><content src="p.xhtml"/></pageTarget></pageList>
</ncx>"#;

    #[test]
    fn parses_ncx_levels_parents_order() {
        let toc = parse_ncx_in(NCX, "OEBPS").unwrap();
        assert_eq!(toc.len(), 4, "pageList entries must not leak in");
        assert_eq!(toc[0].title, "Part & One");
        assert_eq!(toc[0].level, 1);
        assert_eq!(toc[0].parent_idx, None);
        assert_eq!(toc[1].title, "Chapter 1");
        assert_eq!(toc[1].level, 2);
        assert_eq!(toc[1].parent_idx, Some(0));
        assert_eq!(toc[1].cfi.as_deref(), Some("OEBPS/text/ch1.xhtml#start"));
        assert_eq!(toc[2].title, "Chapter 3", "empty label -> fallback");
        assert_eq!(toc[2].level, 2);
        assert_eq!(toc[2].parent_idx, Some(0));
        assert_eq!(
            toc[2].cfi.as_deref(),
            Some("other/ch2.xhtml"),
            "../ escapes"
        );
        assert_eq!(toc[3].title, "Part Two");
        assert_eq!(toc[3].level, 1);
        assert_eq!(toc[3].parent_idx, None);
    }

    #[test]
    fn ncx_labels_decode_named_and_numeric_entities() {
        let ncx = br#"<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
  <navPoint id="a"><navLabel><text>Caf&eacute; &amp; Bar &mdash; 5 &#8211; 6</text></navLabel><content src="a.xhtml"/></navPoint>
  <navPoint id="b"><navLabel><text>&lt;tag&gt; &quot;q&quot; &#x41f;&#x438;&#x440;</text></navLabel><content src="b.xhtml"/></navPoint>
  <navPoint id="c"><navLabel><text>Unknown &myent; kept</text></navLabel><content src="c.xhtml"/></navPoint>
</navMap></ncx>"#;
        let toc = parse_ncx(ncx).unwrap();
        assert_eq!(toc[0].title, "Caf\u{e9} & Bar \u{2014} 5 \u{2013} 6");
        assert_eq!(toc[1].title, "<tag> \"q\" \u{41f}\u{438}\u{440}");
        assert_eq!(
            toc[2].title, "Unknown &myent; kept",
            "unknown entity kept verbatim"
        );
    }

    #[test]
    fn nav_labels_decode_entities() {
        let html = br#"<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
  <li><a href="a.xhtml">Caf&eacute; &mdash; &#x427;&#x430;&#x439;</a></li>
</ol></nav></body></html>"#;
        let toc = parse_nav(html).unwrap();
        assert_eq!(toc[0].title, "Caf\u{e9} \u{2014} \u{427}\u{430}\u{439}");
    }

    #[test]
    fn resolve_sets_chapter_idx_and_keeps_fragment() {
        let mut toc = parse_ncx_in(NCX, "OEBPS").unwrap();
        let spine = vec![
            "OEBPS/text/part1.xhtml".to_string(),
            "OEBPS/text/ch1.xhtml".to_string(),
            "other/ch2.xhtml".to_string(),
        ];
        resolve_chapter_indices(&mut toc, &spine);
        assert_eq!(toc[0].chapter_idx, 0);
        assert_eq!(toc[0].cfi, None, "no fragment -> no cfi");
        assert_eq!(toc[1].chapter_idx, 1, "fragment stripped before lookup");
        assert_eq!(
            toc[1].cfi.as_deref(),
            Some("#start"),
            "mid-chapter entry keeps its fragment"
        );
        assert_eq!(toc[2].chapter_idx, 2);
        assert_eq!(toc[2].cfi, None);
        assert_eq!(toc[3].chapter_idx, -1, "href not in spine");
        assert_eq!(toc[3].cfi, None, "unresolved entry has no navigable target");
        // idempotent: a `#fragment` left in cfi is not a transport href
        let before: Vec<_> = toc.iter().map(|e| (e.chapter_idx, e.cfi.clone())).collect();
        resolve_chapter_indices(&mut toc, &spine);
        let after: Vec<_> = toc.iter().map(|e| (e.chapter_idx, e.cfi.clone())).collect();
        assert_eq!(before, after);
    }

    const NAV_XHTML: &[u8] = br#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Nav</title></head>
<body>
  <nav epub:type="landmarks" hidden="hidden"><ol><li><a href="x.xhtml">Skip me</a></li></ol></nav>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="ch1.xhtml">Chapter <b>One</b></a>
        <ol>
          <li><a href="ch1.xhtml#s1">Section 1.1</a></li>
          <li><span>Section without link</span></li>
        </ol>
      </li>
      <li><a href="../text/ch2.xhtml">Chapter Two</a></li>
      <li><a></a></li>
    </ol>
  </nav>
  <nav epub:type="page-list"><ol><li><a href="p.xhtml">1</a></li></ol></nav>
</body>
</html>"#;

    #[test]
    fn parses_epub3_nav_toc_only() {
        let toc = parse_nav_in(NAV_XHTML, "OEBPS").unwrap();
        // landmarks + page-list navs ignored; 5 entries from the toc nav
        assert_eq!(toc.len(), 5);
        assert_eq!(toc[0].title, "Chapter One", "nested markup text merged");
        assert_eq!(toc[0].level, 1);
        assert_eq!(toc[0].cfi.as_deref(), Some("OEBPS/ch1.xhtml"));
        assert_eq!(toc[1].title, "Section 1.1");
        assert_eq!(toc[1].level, 2);
        assert_eq!(toc[1].parent_idx, Some(0));
        assert_eq!(toc[1].cfi.as_deref(), Some("OEBPS/ch1.xhtml#s1"));
        assert_eq!(toc[2].title, "Section without link");
        assert_eq!(toc[2].level, 2);
        assert_eq!(toc[2].cfi, None);
        assert_eq!(toc[3].title, "Chapter Two");
        assert_eq!(toc[3].cfi.as_deref(), Some("text/ch2.xhtml"));
        assert_eq!(toc[3].parent_idx, None);
        assert_eq!(toc[4].title, "Chapter 5", "empty anchor -> fallback");
    }

    #[test]
    fn nav_resolves_against_spine() {
        let mut toc = parse_nav_in(NAV_XHTML, "OEBPS").unwrap();
        let spine = vec!["OEBPS/ch1.xhtml".to_string(), "text/ch2.xhtml".to_string()];
        resolve_chapter_indices(&mut toc, &spine);
        assert_eq!(toc[0].chapter_idx, 0);
        assert_eq!(toc[1].chapter_idx, 0, "mid-chapter entry keeps chapter");
        assert_eq!(toc[2].chapter_idx, -1, "span entry has no href");
        assert_eq!(toc[3].chapter_idx, 1);
    }

    #[test]
    fn no_toc_nav_gives_empty_not_err() {
        let html = br#"<html><body><nav epub:type="landmarks"><ol><li><a href="a">A</a></li></ol></nav></body></html>"#;
        let toc = parse_nav(html).unwrap();
        assert!(toc.is_empty());
    }

    #[test]
    fn nav_missing_href_attr() {
        let html = br#"<html xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol><li><a>Orphan</a></li></ol></nav></body></html>"#;
        let mut toc = parse_nav(html).unwrap();
        assert_eq!(toc.len(), 1);
        resolve_chapter_indices(&mut toc, &[]);
        assert_eq!(toc[0].chapter_idx, -1);
        assert_eq!(toc[0].cfi, None);
    }

    #[test]
    fn garbage_input_no_panic() {
        // Tolerant parsers: garbage may yield Err or an empty/partial Ok — never panic.
        for input in [
            &b"<<<>>>"[..],
            b"",
            b"<ncx><navMap>",
            b"<html><body><nav",
            &[0xFF, 0xFE, 0x00][..],
        ] {
            let _ = parse_ncx(input);
            let _ = parse_nav(input);
        }
        // Empty input: Eof immediately, empty toc.
        assert!(parse_ncx(b"").unwrap().is_empty());
        assert!(parse_nav(b"").unwrap().is_empty());
    }

    #[test]
    fn find_nav_prefers_epub3_nav_over_ncx() {
        let manifest = vec![
            ManifestItem {
                id: "ncx".into(),
                href: "OEBPS/toc.ncx".into(),
                media_type: "application/x-dtbncx+xml".into(),
                properties: vec![],
            },
            ManifestItem {
                id: "nav".into(),
                href: "OEBPS/nav.xhtml".into(),
                media_type: "application/xhtml+xml".into(),
                properties: vec!["nav".into()],
            },
        ];
        let (href, kind) = find_nav_href(&manifest, &[]).unwrap();
        assert_eq!(href, "OEBPS/nav.xhtml");
        assert_eq!(kind, super::super::NavKind::Nav);
    }

    #[test]
    fn find_nav_falls_back_to_ncx() {
        let manifest = vec![ManifestItem {
            id: "ncx".into(),
            href: "toc.ncx".into(),
            media_type: "application/x-dtbncx+xml".into(),
            properties: vec![],
        }];
        let (href, kind) = find_nav_href(&manifest, &[]).unwrap();
        assert_eq!(href, "toc.ncx");
        assert_eq!(kind, super::super::NavKind::Ncx);
    }

    #[test]
    fn find_nav_none_when_absent() {
        let manifest = vec![ManifestItem {
            id: "c1".into(),
            href: "ch1.xhtml".into(),
            media_type: "application/xhtml+xml".into(),
            properties: vec![],
        }];
        assert!(find_nav_href(&manifest, &[]).is_none());
    }
}
