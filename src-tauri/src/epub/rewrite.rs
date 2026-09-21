//! lol_html chapter rewrite + CSS url() absolutization (§4.3 step 2, §11.2) — owned by B2.
//!
//! Contract: remove `<script>`, `on*=` attributes and `<meta http-equiv="refresh">`; rewrite
//! `href`/`src`/`xlink:href`/`srcset` of a/img/link/video/audio/source/image/use/iframe to
//! `vellum://book/{uid}/asset/{enc}`; internal spine links become `#vellum-link:{idx}:{fragment}`;
//! external http(s) links get `data-vellum-external="1"`; inject `<base href>`; ensure
//! `<meta charset="utf-8">`; add `class="vellum-doc"` to `<html>`.
//!
//! Structure: the bottom half of this file is a **pure** URL/path/CSS layer with no lol_html and
//! no I/O, so it is fully unit-testable on its own; the top half is the thin streaming pass that
//! applies it. Everything is one pass over the document bytes.

use std::borrow::Cow;
use std::cell::Cell;
use std::rc::Rc;

use lol_html::html_content::{ContentType, DocumentEnd, Element, TextChunk};
use lol_html::{element, end, text, ElementContentHandlers, HtmlRewriter, Selector, Settings};

/// Context needed to absolutize relative asset paths inside one chapter.
#[derive(Debug, Clone, Copy)]
pub struct RewriteCtx<'a> {
    pub uid: &'a str,
    /// Zip-relative directory of the chapter document (e.g. `OPS/text`).
    pub chapter_zip_dir: &'a str,
}

// ---------------------------------------------------------------------------
// streaming pass
// ---------------------------------------------------------------------------

/// Marker attribute put on the `<base>`/`<meta charset>` we inject, so a second pass over an
/// already-rewritten document recognizes its own output instead of duplicating it.
const INJECTED: &str = "data-vellum-injected";

/// Class added to `<html>` so the reader theme can hook the document (§4.3 step 2).
const DOC_CLASS: &str = "vellum-doc";

/// Sanitize + absolutize one XHTML chapter document.
///
/// Single streaming pass, never allocates a full-document `String`. On the (practically
/// unreachable) rewriter error path the bytes produced so far are returned — those are already
/// sanitized, so a failure can never leak unsanitized markup.
pub fn rewrite_chapter(html: &[u8], ctx: &RewriteCtx) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::with_capacity(html.len() + 512);

    // Injected once per document at the top of <head>: a base for any relative URL we do not
    // rewrite ourselves, plus the encoding declaration.
    let head_prefix = format!(
        concat!(
            r#"<base href="vellum://book/{uid}/asset/{dir}" {inj}="1">"#,
            r#"<meta charset="utf-8" {inj}="1">"#
        ),
        uid = ctx.uid,
        // Trailing slash only when there is a directory to root at (so a root-level chapter gets
        // `asset/`, not `asset//`).
        dir = with_trailing_slash(&pct_encode_path(ctx.chapter_zip_dir)),
        inj = INJECTED,
    );

    // Buffer for inline <style> text (chunks of one text node arrive separately).
    let mut style_buf = String::new();

    // Idempotency: if this document already carries our marker (a second pass over rewritten
    // output), do not inject a duplicate base/charset pair. Cheap byte scan, no allocation.
    let already_injected = contains_bytes(html, INJECTED.as_bytes());

    // Set when the <head> handler got to inject. A bare fragment can reach the end of the document
    // without any <head> token, and then the charset declaration would be missing entirely.
    let head_injected = Rc::new(Cell::new(false));

    let settings = Settings::new()
        // Real-world EPUBs contain markup the tokenizer finds ambiguous; never bail on it.
        .with_strict(false)
        // 1. drop <script> entirely (start tag, content, end tag)
        .append_element_content_handler(element!("script", |el: &mut Element| {
            el.remove();
            Ok(())
        }))
        // 2. <meta>: kill refresh redirects and stale encoding declarations
        .append_element_content_handler(element!("meta", |el: &mut Element| {
            if el.has_attribute(INJECTED) {
                return Ok(());
            }
            let equiv = el.get_attribute("http-equiv");
            if equiv
                .as_deref()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("refresh"))
            {
                el.remove();
                return Ok(());
            }
            // Our own <meta charset="utf-8"> is injected first; any book-supplied charset or
            // Content-Type meta is redundant (and possibly names an encoding we cannot convert).
            if equiv
                .as_deref()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("content-type"))
                || el.has_attribute("charset")
            {
                el.remove();
            }
            Ok(())
        }))
        // 3. a book-supplied <base> would resolve against the zip layout, which is meaningless in
        //    the srcdoc context — ours (injected first) replaces it.
        .append_element_content_handler(element!("base", |el: &mut Element| {
            if !el.has_attribute(INJECTED) {
                el.remove();
            }
            Ok(())
        }))
        // 4. <head>: inject base + charset as its first children (once per document)
        .append_element_content_handler(element!("head", |el: &mut Element| {
            if !already_injected {
                el.prepend(&head_prefix, ContentType::Html);
                head_injected.set(true);
            }
            Ok(())
        }))
        // 5. <html>: theme hook class
        .append_element_content_handler(element!("html", |el: &mut Element| {
            let class = el.get_attribute("class").unwrap_or_default();
            if !class.split_ascii_whitespace().any(|c| c == DOC_CLASS) {
                let next = if class.is_empty() {
                    DOC_CLASS.to_owned()
                } else {
                    format!("{class} {DOC_CLASS}")
                };
                el.set_attribute("class", &next)?;
            }
            Ok(())
        }))
        // 6. inline <style> blocks: absolutize url() the same way served CSS is
        .append_element_content_handler(text!("style", |t: &mut TextChunk| {
            style_buf.push_str(t.as_str());
            if t.last_in_text_node() {
                let rewritten = rewrite_css(&style_buf, ctx.chapter_zip_dir, ctx.uid);
                style_buf.clear();
                t.replace(&rewritten, ContentType::Html);
            } else {
                // Suppress the partial chunk; the whole node is emitted above once complete.
                t.remove();
            }
            Ok(())
        }))
        // 7. every element: strip on* handlers and absolutize URL attributes, then normalize
        //    XHTML-style self-closing tags. Order matters — see close_self_closing_non_void.
        .append_element_content_handler((
            Cow::Owned("*".parse::<Selector>().expect("universal selector")),
            ElementContentHandlers::default().element(|el: &mut Element| {
                // `sanitize_element` early-returns when there are no attributes, but the
                // normalization below must still apply to a bare `<div/>`.
                sanitize_element(el, ctx);
                close_self_closing_non_void(el);
                Ok(())
            }),
        ))
        // 8. fallback for headless fragments: a bare `<p>hi</p>` produces no <head> token at all,
        //    so the handler above never fires. Emit the charset declaration at the end of the
        //    document instead — still valid, still one declaration.
        .append_document_content_handler(end!({
            let injected = head_injected.clone();
            move |doc_end: &mut DocumentEnd| {
                if !already_injected && !injected.get() {
                    doc_end.append(
                        &format!(r#"<meta charset="utf-8" {INJECTED}="1">"#),
                        ContentType::Html,
                    );
                    injected.set(true);
                }
                Ok(())
            }
        }));

    {
        let mut rewriter = HtmlRewriter::new(settings, |chunk: &[u8]| out.extend_from_slice(chunk));
        // write/end errors leave `out` holding the sanitized prefix; never fall back to `html`.
        let _ = rewriter.write(html);
        let _ = rewriter.end();
    }
    out
}

/// Give an XHTML-style self-closing **non-void** tag an explicit end tag.
///
/// Chapters are injected via iframe `srcdoc`, which is always HTML-parsed — never XML. In HTML the
/// `/` of `<a id="chap05"/>` is ignored, so the parser sees an *open* anchor and, through
/// formatting-element reconstruction, swallows the rest of the chapter inside it (measured on pg84:
/// a single `<a id="chap05"/>` absorbed 35 elements / ~13 KB). That paints the whole chapter with
/// `a { color: … }` and makes `closest('a')` resolve to a hrefless chapter-wide anchor, killing
/// in-page `#frag` and `vellum-link://` clicks. lol_html passes `/>` through verbatim, so we
/// normalize it ourselves.
///
/// Implementation note (verified empirically against lol_html 3.0.1, not assumed): content-level
/// mutations cannot do this. `Element::append("")` is a no-op — an unmodified token is emitted as
/// its raw source bytes, so clearing the self-closing flag has no effect on the output — and
/// `set_inner_content("")` is actively wrong, because lol_html treats `<a/>` as spanning to the
/// implied end tag (at the enclosing `</div>`), so it deletes the swallowed content outright.
/// `start_tag().after("</a>")` leaves the stray slash (`<a id="x"/></a>`). Only replacing the start
/// token with an explicit open+close pair yields clean `<a id="x"></a>`.
///
/// Must run **after** [`sanitize_element`]: the replacement serializes the attribute list into a
/// literal string, so doing it first would freeze the attributes and silently discard every
/// href/src rewrite and every `on*` removal on that element.
///
/// The `can_have_content()` guard keeps this surgical. HTML void elements (`img`, `br`, `hr`,
/// `meta`, `link`, `input`, `source`, …) report false and keep their `/>`; foreign-content
/// self-closing tags (`<path/>`, `<circle/>` inside `<svg>`) also report false, because the HTML
/// parser already honors self-closing in foreign content — so SVG in chapters is left correct.
fn close_self_closing_non_void(el: &mut Element<'_, '_, lol_html::LocalHandlerTypes>) {
    if !el.is_self_closing() || !el.can_have_content() {
        return;
    }
    // Re-serialize the (already sanitized) start tag as an open+close pair.
    let name = el.tag_name_preserve_case();
    let mut tag = String::with_capacity(32 + name.len() * 2);
    tag.push('<');
    tag.push_str(&name);
    for attr in el.attributes() {
        tag.push(' ');
        tag.push_str(&attr.name_preserve_case());
        // `value()` yields the raw source text (entities intact); only `"` needs escaping now that
        // we always emit a double-quoted value. Valueless attributes become `name=""`, which is
        // equivalent for every boolean HTML attribute.
        tag.push_str("=\"");
        tag.push_str(&attr.value().replace('"', "&quot;"));
        tag.push('"');
    }
    tag.push_str("></");
    tag.push_str(&name);
    tag.push('>');
    el.start_tag().replace(&tag, ContentType::Html);
}

/// Strip `on*` handlers and rewrite the URL-bearing attributes of one start tag.
fn sanitize_element(el: &mut Element<'_, '_, lol_html::LocalHandlerTypes>, ctx: &RewriteCtx<'_>) {
    if el.attributes().is_empty() {
        return;
    }
    let tag = el.tag_name();
    // `a`/`area` hrefs may address another chapter; everything else is an asset reference.
    let anchor = matches!(tag.as_str(), "a" | "area");

    // `attributes()` borrows the element, so collect the work first and mutate afterwards.
    let mut removals: Vec<String> = Vec::new();
    let mut updates: Vec<(Cow<'static, str>, String)> = Vec::new();
    let mut external = false;

    for attr in el.attributes() {
        let name = attr.name();
        let value = attr.value();
        if is_event_handler_attr(&name) {
            removals.push(name);
            continue;
        }
        match name.as_str() {
            "srcset" => {
                let rewritten = rewrite_srcset(&value, ctx.chapter_zip_dir, ctx.uid);
                if rewritten != value {
                    updates.push((Cow::Owned(name), rewritten));
                }
            }
            "style" => {
                let rewritten = rewrite_css(&value, ctx.chapter_zip_dir, ctx.uid);
                if rewritten != value {
                    updates.push((Cow::Owned(name), rewritten));
                }
            }
            "href" | "src" | "xlink:href" | "poster" | "data" | "longdesc" | "background" => {
                let is_anchor_ref = anchor && name == "href";
                match classify_ref(&value, ctx.chapter_zip_dir, ctx.uid, is_anchor_ref) {
                    RefAction::Keep => {}
                    RefAction::Remove => removals.push(name.clone()),
                    RefAction::Replace(new) => updates.push((Cow::Owned(name.clone()), new)),
                    RefAction::External(new) => {
                        updates.push((Cow::Owned(name.clone()), new));
                        if is_anchor_ref {
                            external = true;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    for name in &removals {
        el.remove_attribute(name);
    }
    for (name, value) in &updates {
        let _ = el.set_attribute(name, value);
    }
    if external {
        // §4.3: the frontend opens these with the opener plugin instead of navigating.
        let _ = el.set_attribute("data-vellum-external", "1");
        let _ = el.set_attribute("target", "_blank");
        let _ = el.set_attribute("rel", "noopener");
    }
}

/// True for HTML event-handler attributes (`onclick`, `onerror`, …) — any name starting with
/// `on` that is not exactly `on`.
fn is_event_handler_attr(name: &str) -> bool {
    name.len() > 2 && name.starts_with("on") && name.as_bytes()[2].is_ascii_alphabetic()
}

/// `""` → `""`, `"OPS/text"` → `"OPS/text/"` (a base href must end in `/` to act as a directory).
fn with_trailing_slash(s: &str) -> Cow<'_, str> {
    if s.is_empty() || s.ends_with('/') {
        Cow::Borrowed(s)
    } else {
        Cow::Owned(format!("{s}/"))
    }
}

/// Substring search over bytes (used once per document for the idempotency marker).
fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack.len() >= needle.len()
        && haystack.windows(needle.len()).any(|w| w == needle)
}

// ---------------------------------------------------------------------------
// pure path / URL layer
// ---------------------------------------------------------------------------

/// Percent-decode `s`. Invalid escapes (`%zz`, trailing `%`) are copied through verbatim so a
/// malformed reference never loses bytes. Non-ASCII is decoded as UTF-8 with lossy fallback.
pub(crate) fn pct_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_owned();
    }
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
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

/// Percent-encode every `/`-separated segment of a zip path (separators preserved).
///
/// Unreserved set per RFC 3986 (`A-Za-z0-9-._~`) stays literal; everything else — spaces,
/// Cyrillic, `#`, `?`, `%` — becomes `%XX` over its UTF-8 bytes. That makes the result safe to
/// embed in `vellum://book/{uid}/asset/{enc}` and to decode back with [`pct_decode`].
pub(crate) fn pct_encode_path(path: &str) -> String {
    // Uppercase hex, matching RFC 3986 convention and what browsers/percent-encoding emit.
    // Decoding is case-insensitive, so this is purely cosmetic — but it keeps rewritten URLs
    // stable across a second pass (idempotency) and byte-identical to the route-table fixtures.
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(path.len() + 8);
    for (i, seg) in path.split('/').enumerate() {
        if i > 0 {
            out.push('/');
        }
        for &b in seg.as_bytes() {
            let unreserved = b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~');
            if unreserved {
                out.push(b as char);
            } else {
                out.push('%');
                out.push(HEX[(b >> 4) as usize] as char);
                out.push(HEX[(b & 0xf) as usize] as char);
            }
        }
    }
    out
}

/// Normalize `dir` + `rel` (both zip-root-relative, `/`-separated, already percent-decoded) into
/// a single zip entry path. `.` and empty segments collapse, `..` walks up; `None` when the
/// result escapes the zip root or is empty (callers leave such references untouched).
pub(crate) fn resolve_zip_path(dir: &str, rel: &str) -> Option<String> {
    // A root-absolute reference ignores the chapter dir entirely.
    let dir = if rel.starts_with('/') { "" } else { dir };
    let mut segs: Vec<&str> = Vec::new();
    for part in dir.split('/').chain(rel.split('/')) {
        match part {
            "" | "." => {}
            ".." => {
                segs.pop()?; // escapes the zip root
            }
            s => segs.push(s),
        }
    }
    if segs.is_empty() {
        None
    } else {
        Some(segs.join("/"))
    }
}

/// Split a URL reference into (path, query, fragment). The query/fragment keep their delimiter.
pub(crate) fn split_ref(r: &str) -> (&str, Option<&str>, Option<&str>) {
    let (before_frag, frag) = match r.find('#') {
        Some(i) => (&r[..i], Some(&r[i..])),
        None => (r, None),
    };
    match before_frag.find('?') {
        Some(i) => (&before_frag[..i], Some(&before_frag[i..]), frag),
        None => (before_frag, None, frag),
    }
}

/// True when `s` starts with a URL scheme (`http:`, `data:`, `vellum:`, `mailto:`, …).
/// Scheme grammar: `ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"`.
pub(crate) fn has_scheme(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for c in chars {
        match c {
            ':' => return true,
            '/' | '?' | '#' => return false, // path/query/fragment before any ':' → relative
            c if c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.') => {}
            _ => return false,
        }
    }
    false
}

/// True for references we must never touch: already-`vellum://`, our `vellum-link://` marker and
/// inline `data:` URIs.
pub(crate) fn is_passthrough_ref(s: &str) -> bool {
    let l = s.trim_start().to_ascii_lowercase();
    l.starts_with("vellum:") || l.starts_with("vellum-link:") || l.starts_with("data:")
}

/// True when a resolved zip path looks like an XHTML document (spine-sibling candidate).
pub(crate) fn is_xhtml_path(zip_path: &str) -> bool {
    let p = zip_path.to_ascii_lowercase();
    p.ends_with(".xhtml") || p.ends_with(".html") || p.ends_with(".htm") || p.ends_with(".xht")
}

/// True for `javascript:` (and other script-executing pseudo-schemes) after collapsing the
/// whitespace/control chars browsers ignore inside schemes (`java\tscript:`).
pub(crate) fn is_script_scheme(s: &str) -> bool {
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_ascii_control() && !c.is_ascii_whitespace())
        .collect();
    let l = cleaned.to_ascii_lowercase();
    l.starts_with("javascript:") || l.starts_with("vbscript:") || l.starts_with("livescript:")
}

/// True for `http:`/`https:` references (case-insensitive, leading space tolerated).
pub(crate) fn is_http_ref(s: &str) -> bool {
    let l = s.trim_start().to_ascii_lowercase();
    l.starts_with("http:") || l.starts_with("https:")
}

/// The rewritten `vellum://book/{uid}/asset/{enc}` URL for a resolved zip path.
pub(crate) fn asset_url(uid: &str, zip_path: &str) -> String {
    format!("vellum://book/{}/asset/{}", uid, pct_encode_path(zip_path))
}

/// The rewritten `vellum-link://{enc}` marker for an internal chapter link (frontend resolves it
/// to a spine index — see DEVIATIONS in the B2 report). `fragment` keeps its leading `#`.
pub(crate) fn chapter_link_url(zip_path: &str, fragment: Option<&str>) -> String {
    match fragment {
        Some(f) if f.len() > 1 => format!("vellum-link://{}{}", pct_encode_path(zip_path), f),
        _ => format!("vellum-link://{}", pct_encode_path(zip_path)),
    }
}

/// What to do with one URL-bearing attribute value.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RefAction {
    /// Leave the attribute exactly as it is.
    Keep,
    /// Drop the attribute (script pseudo-scheme).
    Remove,
    /// Replace the value.
    Replace(String),
    /// Replace the value and mark the element as an external link.
    External(String),
}

/// Resolve one `href`/`src`/`xlink:href`/`poster`/`data` value found in a chapter living in
/// `dir` of book `uid`. `is_anchor` selects internal-chapter-link handling (`<a href>`); asset
/// references strip query+fragment, chapter links keep the fragment.
pub(crate) fn classify_ref(value: &str, dir: &str, uid: &str, is_anchor: bool) -> RefAction {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return RefAction::Keep;
    }
    if is_script_scheme(trimmed) {
        return RefAction::Remove;
    }
    if is_passthrough_ref(trimmed) {
        return RefAction::Keep;
    }
    // Fragment-only (`#foo`) and empty-path refs stay untouched.
    if trimmed.starts_with('#') {
        return RefAction::Keep;
    }
    if is_http_ref(trimmed) {
        if is_anchor {
            return RefAction::External(trimmed.to_owned());
        }
        // Remote images/stylesheets: nothing local to point at, leave the URL alone.
        return RefAction::Keep;
    }
    if has_scheme(trimmed) {
        // Any other scheme (mailto:, tel:, ftp:, …) is not a zip reference.
        return if is_anchor {
            RefAction::External(trimmed.to_owned())
        } else {
            RefAction::Keep
        };
    }

    let (path, _query, frag) = split_ref(trimmed);
    if path.is_empty() {
        // e.g. `?x=1` — not addressable inside the zip.
        return RefAction::Keep;
    }
    let decoded = decode_segments(path);
    let Some(resolved) = resolve_zip_path(dir, &decoded) else {
        return RefAction::Keep; // escapes the zip root → leave as-is
    };
    if is_anchor && is_xhtml_path(&resolved) {
        return RefAction::Replace(chapter_link_url(&resolved, frag));
    }
    RefAction::Replace(asset_url(uid, &resolved))
}

/// Percent-decode each `/`-separated segment of a reference path. A segment whose decoding would
/// introduce a `/` (`%2F`) keeps its raw form — zip entry names cannot contain separators.
fn decode_segments(path: &str) -> String {
    path.split('/')
        .map(|seg| {
            let d = pct_decode(seg);
            if d.contains('/') {
                Cow::Borrowed(seg)
            } else {
                Cow::Owned(d)
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// Rewrite a `srcset` value: `url [descriptor]` candidates separated by commas, each URL resolved
/// like a `src`. Descriptors (`1x`, `2x`, `600w`) are preserved verbatim.
///
/// The URL is collected as a run of **non-whitespace**, not by splitting on `,`: a `data:` URL
/// legitimately contains commas (`data:image/png;base64,AA`), and a naive comma split would shred
/// it into two broken candidates. This follows the HTML srcset parsing algorithm.
pub(crate) fn rewrite_srcset(value: &str, dir: &str, uid: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = String::with_capacity(value.len() + 64);
    let mut i = 0usize;
    let mut emitted = false;

    while i < bytes.len() {
        // Skip the inter-candidate separators.
        while i < bytes.len() && (bytes[i].is_ascii_whitespace() || bytes[i] == b',') {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        // URL = run of non-whitespace.
        let url_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut url_end = i;
        // A trailing comma is a candidate delimiter, not part of the URL.
        while url_end > url_start && bytes[url_end - 1] == b',' {
            url_end -= 1;
        }
        i = url_end.max(i);
        let url = &value[url_start..url_end];
        if url.is_empty() {
            continue;
        }
        // Descriptor = the rest up to the next comma.
        let desc_start = i;
        while i < bytes.len() && bytes[i] != b',' {
            i += 1;
        }
        let desc = value[desc_start..i].trim();

        if emitted {
            out.push_str(", ");
        }
        emitted = true;
        match classify_ref(url, dir, uid, false) {
            RefAction::Replace(new) | RefAction::External(new) => out.push_str(&new),
            RefAction::Keep | RefAction::Remove => out.push_str(url),
        }
        if !desc.is_empty() {
            out.push(' ');
            out.push_str(desc);
        }
    }
    out
}

/// Absolutize `url(...)` and `@import "..."` references in a CSS document.
///
/// Hand-rolled scanner (no regex dep): comments are copied through untouched, quoted strings are
/// copied verbatim except the first one after `@import`, `data:`/absolute/`vellum:` URLs are
/// skipped, and relative URLs resolve against `css_zip_dir`.
pub fn rewrite_css(css: &str, css_zip_dir: &str, uid: &str) -> String {
    let bytes = css.as_bytes();
    let mut out = String::with_capacity(css.len() + 64);
    let mut i = 0usize;
    let mut pending_import = false;

    while i < bytes.len() {
        // /* comment */ — copy verbatim so commented-out urls stay inert.
        if bytes[i] == b'/' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            let end = css[i + 2..]
                .find("*/")
                .map(|p| i + 4 + p)
                .unwrap_or(bytes.len());
            out.push_str(&css[i..end]);
            i = end;
            continue;
        }
        // Quoted string: rewrite only when it is the `@import` target.
        if bytes[i] == b'"' || bytes[i] == b'\'' {
            let q = bytes[i];
            let end = find_string_end(bytes, i + 1, q);
            let raw = &css[i + 1..end];
            if pending_import {
                out.push(q as char);
                out.push_str(
                    &css_url_value(raw, css_zip_dir, uid).unwrap_or_else(|| raw.to_owned()),
                );
                out.push(q as char);
                pending_import = false;
            } else {
                out.push_str(
                    &css[i..end.min(bytes.len()) + (if end < bytes.len() { 1 } else { 0 })],
                );
            }
            i = if end < bytes.len() { end + 1 } else { end };
            continue;
        }
        // @import keyword arms the next string/url for rewriting.
        if matches_ci(css, i, "@import") {
            out.push_str(&css[i..i + 7]);
            i += 7;
            pending_import = true;
            continue;
        }
        // url( ... )
        if matches_ci_token(css, i, "url(") {
            let close = find_paren_close(bytes, i + 4);
            if close >= bytes.len() {
                // Unterminated `url(` — truncated CSS. Copy the remainder verbatim: guessing at a
                // rewrite here would fabricate a reference the author never wrote.
                out.push_str(&css[i..]);
                break;
            }
            out.push_str(&css[i..i + 3]); // "url"
            i += 3;
            let paren = i; // at '('
            let inner_start = paren + 1;
            let inner = css[inner_start..close].trim();
            // strip one layer of quotes if present
            let (unquoted, had_quote) = if inner.len() >= 2
                && ((inner.starts_with('"') && inner.ends_with('"'))
                    || (inner.starts_with('\'') && inner.ends_with('\'')))
            {
                (
                    &inner[1..inner.len() - 1],
                    Some(inner.as_bytes()[0] as char),
                )
            } else {
                (inner, None)
            };
            let rewritten = css_url_value(unquoted, css_zip_dir, uid);
            out.push('(');
            match (rewritten, had_quote) {
                (Some(new), Some(q)) => {
                    out.push(q);
                    out.push_str(&new);
                    out.push(q);
                }
                (Some(new), None) => out.push_str(&new),
                (None, _) => out.push_str(inner),
            }
            if close < bytes.len() {
                out.push(')');
                i = close + 1;
            } else {
                i = close;
            }
            continue;
        }
        // Ordinary byte: copy a whole UTF-8 character, never a single byte of one (a CSS
        // `content:"Текст"` string must survive intact).
        let ch_len = utf8_char_len(bytes[i]);
        out.push_str(&css[i..(i + ch_len).min(bytes.len())]);
        i += ch_len;
    }
    out
}

/// Length in bytes of the UTF-8 character starting with `lead` (1 for anything not a lead byte).
fn utf8_char_len(lead: u8) -> usize {
    match lead {
        0x00..=0x7f => 1,
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf7 => 4,
        _ => 1, // continuation byte in lead position: malformed input, copy it as-is
    }
}

/// The rewritten absolute URL for a CSS reference, or `None` when it must be left alone.
fn css_url_value(raw: &str, css_zip_dir: &str, uid: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if is_passthrough_ref(trimmed) || is_script_scheme(trimmed) {
        return None;
    }
    if trimmed.starts_with("//") || (has_scheme(trimmed) && !is_http_ref(trimmed)) {
        return None;
    }
    if is_http_ref(trimmed) {
        return None; // remote: nothing local to point at
    }
    if trimmed.starts_with('#') {
        return None;
    }
    let (path, _q, _f) = split_ref(trimmed);
    if path.is_empty() {
        return None;
    }
    let resolved = resolve_zip_path(css_zip_dir, &decode_segments(path))?;
    Some(asset_url(uid, &resolved))
}

/// Index of the closing quote of a CSS string starting at `from`, or `bytes.len()`.
fn find_string_end(bytes: &[u8], from: usize, q: u8) -> usize {
    let mut i = from;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            c if c == q => return i,
            _ => i += 1,
        }
    }
    bytes.len()
}

/// Index of the `)` closing a `url(` at `open` (the byte after `(`), or `bytes.len()`.
fn find_paren_close(bytes: &[u8], open: usize) -> usize {
    let mut i = open;
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'\'' => {
                let q = bytes[i];
                i = find_string_end(bytes, i + 1, q);
                i += 1;
            }
            b')' => return i,
            _ => i += 1,
        }
    }
    bytes.len()
}

/// Case-insensitive literal match of `needle` at byte offset `i`.
fn matches_ci(haystack: &str, i: usize, needle: &str) -> bool {
    let end = i + needle.len();
    if end > haystack.len() {
        return false;
    }
    haystack[i..end].eq_ignore_ascii_case(needle)
}

/// Like [`matches_ci`] but the match must start at a token boundary (not mid-identifier), so
/// `-webkit-url(` is not mistaken for `url(`.
fn matches_ci_token(haystack: &str, i: usize, needle: &str) -> bool {
    if !matches_ci(haystack, i, needle) {
        return false;
    }
    match i.checked_sub(1).map(|p| haystack.as_bytes()[p]) {
        None => true,
        Some(b) => !(b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
    }
}

#[cfg(test)]
mod pure_tests {
    use super::*;

    #[test]
    fn decode_plain_and_percent() {
        assert_eq!(pct_decode("a%20b.png"), "a b.png");
        assert_eq!(pct_decode("plain.png"), "plain.png");
        assert_eq!(
            pct_decode("%D0%BA%D0%BD%D0%B8%D0%B3%D0%B0.png"),
            "книга.png"
        );
        // malformed escapes survive verbatim
        assert_eq!(pct_decode("100%.png"), "100%.png");
        assert_eq!(pct_decode("%zz.png"), "%zz.png");
        assert_eq!(pct_decode("%2"), "%2");
    }

    #[test]
    fn encode_unreserved_and_everything_else() {
        assert_eq!(
            pct_encode_path("OPS/img/a-b_c.d~e.png"),
            "OPS/img/a-b_c.d~e.png"
        );
        assert_eq!(pct_encode_path("OPS/img/a b.png"), "OPS/img/a%20b.png");
        assert_eq!(
            pct_encode_path("OPS/книга.png"),
            "OPS/%D0%BA%D0%BD%D0%B8%D0%B3%D0%B0.png"
        );
        assert_eq!(pct_encode_path("a/b#c?d%e.png"), "a/b%23c%3Fd%25e.png");
        assert_eq!(pct_encode_path(""), "");
    }

    #[test]
    fn encode_decode_roundtrip() {
        for p in [
            "OPS/img/a b.png",
            "OPS/книга/обложка.jpeg",
            "a/b#c?d%e.png",
            "images/cover.png",
        ] {
            assert_eq!(pct_decode(&pct_encode_path(p)), p, "roundtrip {p}");
        }
    }

    #[test]
    fn resolve_relative_and_parent_dirs() {
        assert_eq!(
            resolve_zip_path("OPS/text", "img/a.png").as_deref(),
            Some("OPS/text/img/a.png")
        );
        assert_eq!(
            resolve_zip_path("OPS/text", "../images/a.png").as_deref(),
            Some("OPS/images/a.png")
        );
        assert_eq!(
            resolve_zip_path("OPS/text", "../../images/a.png").as_deref(),
            Some("images/a.png")
        );
        assert_eq!(
            resolve_zip_path("OPS/text", "./a.png").as_deref(),
            Some("OPS/text/a.png")
        );
        // root-absolute ignores the dir
        assert_eq!(
            resolve_zip_path("OPS/text", "/images/a.png").as_deref(),
            Some("images/a.png")
        );
        // escapes the zip root → None
        assert_eq!(resolve_zip_path("OPS", "../../etc/passwd"), None);
        assert_eq!(resolve_zip_path("", "../a.png"), None);
        // `..` from OPS/text lands on OPS (still inside the archive)
        assert_eq!(resolve_zip_path("OPS/text", "..").as_deref(), Some("OPS"));
        // collapses to nothing
        assert_eq!(resolve_zip_path("", ""), None);
    }

    #[test]
    fn split_ref_parts() {
        assert_eq!(split_ref("a.png"), ("a.png", None, None));
        assert_eq!(split_ref("a.png#f"), ("a.png", None, Some("#f")));
        assert_eq!(split_ref("a.png?v=1"), ("a.png", Some("?v=1"), None));
        assert_eq!(
            split_ref("a.png?v=1#f"),
            ("a.png", Some("?v=1"), Some("#f"))
        );
        assert_eq!(split_ref("#f"), ("", None, Some("#f")));
    }

    #[test]
    fn scheme_detection() {
        assert!(has_scheme("http://x/y"));
        assert!(has_scheme("data:image/png;base64,AA"));
        assert!(has_scheme("vellum://book/u/asset/x"));
        assert!(has_scheme("mailto:a@b.c"));
        assert!(has_scheme("a+b-c.d:e"));
        assert!(!has_scheme("/abs/path"));
        assert!(!has_scheme("rel/path.png"));
        assert!(!has_scheme("a.png#frag:ment"));
        assert!(!has_scheme("1http://x")); // scheme must start with a letter
        assert!(!has_scheme(""));
    }

    #[test]
    fn passthrough_and_script_schemes() {
        assert!(is_passthrough_ref("vellum://book/u/asset/a.png"));
        assert!(is_passthrough_ref("vellum-link://OPS/a.xhtml"));
        assert!(is_passthrough_ref("data:image/png;base64,AA"));
        assert!(is_passthrough_ref("  DATA:image/gif,x"));
        assert!(!is_passthrough_ref("http://x/a.png"));

        assert!(is_script_scheme("javascript:alert(1)"));
        assert!(is_script_scheme("JaVaScRiPt:alert(1)"));
        assert!(is_script_scheme("java\tscript:alert(1)"));
        assert!(is_script_scheme(" javascript:alert(1)"));
        assert!(is_script_scheme("vbscript:x"));
        assert!(!is_script_scheme("http://x/javascript:alert(1)"));
        assert!(!is_script_scheme("a.js"));
    }

    #[test]
    fn xhtml_detection() {
        assert!(is_xhtml_path("OPS/text/ch1.xhtml"));
        assert!(is_xhtml_path("OPS/text/ch1.HTML"));
        assert!(is_xhtml_path("a.htm"));
        assert!(!is_xhtml_path("OPS/style.css"));
        assert!(!is_xhtml_path("OPS/img.png"));
    }

    #[test]
    fn classify_asset_refs() {
        let uid = "abc123";
        let dir = "OPS/text";
        // simple relative
        assert_eq!(
            classify_ref("../images/a.png", dir, uid, false),
            RefAction::Replace("vellum://book/abc123/asset/OPS/images/a.png".into())
        );
        // spaces + cyrillic get percent-encoded
        assert_eq!(
            classify_ref("../img/обложка 1.png", dir, uid, false),
            RefAction::Replace(
                "vellum://book/abc123/asset/OPS/img/%D0%BE%D0%B1%D0%BB%D0%BE%D0%B6%D0%BA%D0%B0%201.png"
                    .into()
            )
        );
        // already-encoded input is decoded then re-encoded (idempotent form)
        assert_eq!(
            classify_ref("../img/a%20b.png", dir, uid, false),
            RefAction::Replace("vellum://book/abc123/asset/OPS/img/a%20b.png".into())
        );
        // query + fragment stripped for assets
        assert_eq!(
            classify_ref("../images/a.png?v=2#frag", dir, uid, false),
            RefAction::Replace("vellum://book/abc123/asset/OPS/images/a.png".into())
        );
        // root-absolute
        assert_eq!(
            classify_ref("/images/a.png", dir, uid, false),
            RefAction::Replace("vellum://book/abc123/asset/images/a.png".into())
        );
        // passthrough
        assert_eq!(
            classify_ref("data:image/png;base64,AA", dir, uid, false),
            RefAction::Keep
        );
        assert_eq!(
            classify_ref(
                "vellum://book/abc123/asset/OPS/images/a.png",
                dir,
                uid,
                false
            ),
            RefAction::Keep
        );
        // fragment-only untouched
        assert_eq!(classify_ref("#sec1", dir, uid, false), RefAction::Keep);
        // script scheme → drop the attribute
        assert_eq!(
            classify_ref("javascript:alert(1)", dir, uid, false),
            RefAction::Remove
        );
        // remote image src: kept (nothing local to point at)
        assert_eq!(
            classify_ref("https://x.example/a.png", dir, uid, false),
            RefAction::Keep
        );
        // escaping the zip root → untouched
        assert_eq!(
            classify_ref("../../../../etc/passwd", dir, uid, false),
            RefAction::Keep
        );
    }

    #[test]
    fn classify_anchor_refs() {
        let uid = "abc123";
        let dir = "OPS/text";
        // internal chapter link keeps the fragment, becomes the vellum-link marker
        assert_eq!(
            classify_ref("ch2.xhtml", dir, uid, true),
            RefAction::Replace("vellum-link://OPS/text/ch2.xhtml".into())
        );
        assert_eq!(
            classify_ref("ch2.xhtml#sec1", dir, uid, true),
            RefAction::Replace("vellum-link://OPS/text/ch2.xhtml#sec1".into())
        );
        assert_eq!(
            classify_ref("../nav/toc.html", dir, uid, true),
            RefAction::Replace("vellum-link://OPS/nav/toc.html".into())
        );
        // non-xhtml targets are assets even from an anchor
        assert_eq!(
            classify_ref("../images/a.png", dir, uid, true),
            RefAction::Replace("vellum://book/abc123/asset/OPS/images/a.png".into())
        );
        // external http(s) → marked external, URL preserved verbatim
        assert_eq!(
            classify_ref("https://example.com/page?a=1#f", dir, uid, true),
            RefAction::External("https://example.com/page?a=1#f".into())
        );
        // mailto is external too (opener plugin handles it)
        assert_eq!(
            classify_ref("mailto:a@b.c", dir, uid, true),
            RefAction::External("mailto:a@b.c".into())
        );
        // javascript: removed
        assert_eq!(
            classify_ref("  JAVASCRIPT:void(0)", dir, uid, true),
            RefAction::Remove
        );
        // fragment-only stays a plain in-page anchor
        assert_eq!(classify_ref("#frag", dir, uid, true), RefAction::Keep);
    }

    #[test]
    fn srcset_candidates() {
        let uid = "abc123";
        let dir = "OPS/text";
        assert_eq!(
            rewrite_srcset("../img/a.png 1x, ../img/b.png 2x", dir, uid),
            "vellum://book/abc123/asset/OPS/img/a.png 1x, \
             vellum://book/abc123/asset/OPS/img/b.png 2x"
        );
        assert_eq!(
            rewrite_srcset("../img/a.png 600w, ../img/b.png 1200w", dir, uid),
            "vellum://book/abc123/asset/OPS/img/a.png 600w, \
             vellum://book/abc123/asset/OPS/img/b.png 1200w"
        );
        // no descriptor
        assert_eq!(
            rewrite_srcset("../img/a.png", dir, uid),
            "vellum://book/abc123/asset/OPS/img/a.png"
        );
        // data: candidate untouched, stray comma tolerated
        assert_eq!(
            rewrite_srcset("data:image/png;base64,AA 2x,", dir, uid),
            "data:image/png;base64,AA 2x"
        );
        // encoded name round-trips
        assert_eq!(
            rewrite_srcset("../img/a%20b.png 2x", dir, uid),
            "vellum://book/abc123/asset/OPS/img/a%20b.png 2x"
        );
    }

    #[test]
    fn css_url_forms() {
        let uid = "abc123";
        let dir = "OPS/css";
        assert_eq!(
            rewrite_css("body{background:url(../img/bg.png)}", dir, uid),
            "body{background:url(vellum://book/abc123/asset/OPS/img/bg.png)}"
        );
        assert_eq!(
            rewrite_css("@font-face{src:url('../fonts/f.woff2')}", dir, uid),
            "@font-face{src:url('vellum://book/abc123/asset/OPS/fonts/f.woff2')}"
        );
        assert_eq!(
            rewrite_css("@font-face{src:url(\"../fonts/f.woff2\")}", dir, uid),
            "@font-face{src:url(\"vellum://book/abc123/asset/OPS/fonts/f.woff2\")}"
        );
        // spaces / cyrillic encoded
        assert_eq!(
            rewrite_css("a{background:url('../img/a b.png')}", dir, uid),
            "a{background:url('vellum://book/abc123/asset/OPS/img/a%20b.png')}"
        );
        assert_eq!(
            rewrite_css("a{background:url(../img/обложка.png)}", dir, uid),
            "a{background:url(vellum://book/abc123/asset/OPS/img/%D0%BE%D0%B1%D0%BB%D0%BE%D0%B6%D0%BA%D0%B0.png)}"
        );
        // URL() uppercase + whitespace inside parens
        assert_eq!(
            rewrite_css("a{background:URL(  ../img/x.png  )}", dir, uid),
            "a{background:URL(vellum://book/abc123/asset/OPS/img/x.png)}"
        );
    }

    #[test]
    fn css_skips_and_imports() {
        let uid = "abc123";
        let dir = "OPS/css";
        // data:, absolute http(s), protocol-relative and vellum: untouched
        assert_eq!(
            rewrite_css("a{background:url(data:image/png;base64,AA)}", dir, uid),
            "a{background:url(data:image/png;base64,AA)}"
        );
        assert_eq!(
            rewrite_css("a{background:url(https://x.example/a.png)}", dir, uid),
            "a{background:url(https://x.example/a.png)}"
        );
        assert_eq!(
            rewrite_css("a{background:url(//x.example/a.png)}", dir, uid),
            "a{background:url(//x.example/a.png)}"
        );
        assert_eq!(
            rewrite_css(
                "a{background:url(vellum://book/abc123/asset/OPS/img/a.png)}",
                dir,
                uid
            ),
            "a{background:url(vellum://book/abc123/asset/OPS/img/a.png)}"
        );
        // @import string + url() forms
        assert_eq!(
            rewrite_css("@import \"other.css\";", dir, uid),
            "@import \"vellum://book/abc123/asset/OPS/css/other.css\";"
        );
        assert_eq!(
            rewrite_css("@import 'sub/other.css' screen;", dir, uid),
            "@import 'vellum://book/abc123/asset/OPS/css/sub/other.css' screen;"
        );
        assert_eq!(
            rewrite_css("@import url(other.css);", dir, uid),
            "@import url(vellum://book/abc123/asset/OPS/css/other.css);"
        );
        // comments are inert
        assert_eq!(
            rewrite_css("/* url(../img/nope.png) */ a{color:red}", dir, uid),
            "/* url(../img/nope.png) */ a{color:red}"
        );
        // ordinary strings (content:) are not treated as urls
        assert_eq!(
            rewrite_css("a:after{content:\"url(../img/x.png)\"}", dir, uid),
            "a:after{content:\"url(../img/x.png)\"}"
        );
        // javascript: url left alone (it cannot execute from CSS, and rewriting would 404 oddly)
        assert_eq!(
            rewrite_css("a{background:url(javascript:alert(1))}", dir, uid),
            "a{background:url(javascript:alert(1))}"
        );
    }

    #[test]
    fn css_identifier_boundary() {
        // `-webkit-url(` must not be mistaken for `url(`
        let out = rewrite_css(
            "a{-webkit-url(x.png);background:url(x.png)}",
            "OPS/css",
            "u1",
        );
        assert!(out.contains("-webkit-url(x.png)"), "{out}");
        assert!(
            out.contains("vellum://book/u1/asset/OPS/css/x.png"),
            "{out}"
        );
    }

    #[test]
    fn css_unterminated_is_lossless() {
        // A truncated CSS file must not lose bytes or panic.
        let css = "a{background:url(../img/x.png";
        assert_eq!(rewrite_css(css, "OPS/css", "u1"), css);
        let css2 = "a{content:\"unterminated";
        assert_eq!(rewrite_css(css2, "OPS/css", "u1"), css2);
    }

    #[test]
    fn css_root_dir_is_empty_string() {
        // A stylesheet at the zip root resolves against "".
        assert_eq!(
            rewrite_css("a{background:url(img/x.png)}", "", "u1"),
            "a{background:url(vellum://book/u1/asset/img/x.png)}"
        );
    }
}

#[cfg(test)]
mod rewrite_tests {
    use super::*;

    const UID: &str = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
    const DIR: &str = "OPS/text";

    fn rw(html: &str) -> String {
        let out = rewrite_chapter(html.as_bytes(), &ctx());
        String::from_utf8(out).expect("rewrite output is valid utf-8")
    }

    fn ctx() -> RewriteCtx<'static> {
        RewriteCtx {
            uid: UID,
            chapter_zip_dir: DIR,
        }
    }

    fn asset(rel: &str) -> String {
        asset_url(UID, rel)
    }

    /// A fixture exercising every rewrite rule at once (§8 B2).
    const FIXTURE: &str = r##"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink">
<head>
<title>Ch 1</title>
<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"/>
<meta http-equiv="refresh" content="0;url=http://evil.example"/>
<link rel="stylesheet" type="text/css" href="../css/main.css"/>
<style>body{background:url(../img/bg.png)}</style>
<script type="text/javascript">alert("xss");</script>
</head>
<body onload="steal()" class="chapter">
<h1>Title</h1>
<p>Text with <a href="ch2.xhtml#sec3">next chapter</a> and
<a href="#local-anchor">in-page</a> and
<a href="https://external.example/page?a=1">outside</a> and
<a href="javascript:alert(1)">bad</a>.</p>
<img src="../images/cover.png" alt="c" onerror="pwn()"/>
<img src="../img/a%20b.png" srcset="../img/a%20b.png 1x, ../img/big.png 2x"/>
<img srcset="../img/small.png 600w, ../img/large.png 1200w" src="../img/fallback.png"/>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
<image xlink:href="../img/svg-ref.png" width="10" height="10"/>
<use xlink:href="#in-page-symbol"/>
</svg>
<video poster="../img/poster.jpg" controls="controls"><source src="../media/v.mp4" type="video/mp4"/></video>
<div style="background-image:url('../img/inline.png')">styled</div>
<iframe src="../embed/thing.html"></iframe>
<object data="../embed/obj.swf"></object>
</body>
</html>"##;

    #[test]
    fn removes_scripts_and_their_content() {
        let out = rw(FIXTURE);
        assert!(!out.contains("<script"), "{out}");
        assert!(
            !out.contains("alert(\"xss\")"),
            "script body survived: {out}"
        );
    }

    #[test]
    fn removes_meta_refresh_and_stale_charset() {
        let out = rw(FIXTURE);
        assert!(
            !out.to_ascii_lowercase().contains("http-equiv=\"refresh\""),
            "meta refresh survived: {out}"
        );
        assert!(
            !out.contains("evil.example"),
            "refresh target survived: {out}"
        );
        // The book's own iso-8859-1 declaration must not outlive our utf-8 one.
        assert!(!out.contains("iso-8859-1"), "stale charset survived: {out}");
    }

    #[test]
    fn strips_event_handler_attributes() {
        let out = rw(FIXTURE);
        assert!(!out.contains("onload"), "onload survived: {out}");
        assert!(!out.contains("onerror"), "onerror survived: {out}");
        assert!(
            !out.contains("steal()") && !out.contains("pwn()"),
            "handler body survived: {out}"
        );
        // The elements themselves stay.
        assert!(out.contains("<body"), "body removed: {out}");
        assert!(out.contains("alt=\"c\""), "sibling attribute lost: {out}");
    }

    #[test]
    fn removes_javascript_href() {
        let out = rw(FIXTURE);
        assert!(
            !out.to_ascii_lowercase().contains("javascript:"),
            "javascript: url survived: {out}"
        );
        // The anchor text stays, only the dangerous href goes.
        assert!(out.contains(">bad</a>"), "anchor text lost: {out}");
    }

    #[test]
    fn absolutizes_css_and_image_assets() {
        let out = rw(FIXTURE);
        assert!(
            out.contains(&format!(r#"href="{}""#, asset("OPS/css/main.css"))),
            "{out}"
        );
        assert!(
            out.contains(&format!(r#"src="{}""#, asset("OPS/images/cover.png"))),
            "{out}"
        );
        // percent-encoded input decodes then re-encodes to the canonical form
        assert!(
            out.contains(&format!(r#"src="{}""#, asset("OPS/img/a b.png"))),
            "{out}"
        );
        assert!(
            out.contains(&format!(r#"poster="{}""#, asset("OPS/img/poster.jpg"))),
            "{out}"
        );
        assert!(
            out.contains(&format!(r#"src="{}""#, asset("OPS/media/v.mp4"))),
            "{out}"
        );
        assert!(
            out.contains(&format!(r#"src="{}""#, asset("OPS/embed/thing.html"))),
            "{out}"
        );
        assert!(
            out.contains(&format!(r#"data="{}""#, asset("OPS/embed/obj.swf"))),
            "{out}"
        );
        // no stale relative references remain
        assert!(!out.contains("\"../"), "relative reference survived: {out}");
    }

    #[test]
    fn rewrites_srcset_candidates() {
        let out = rw(FIXTURE);
        assert!(
            out.contains(&format!(
                "{} 1x, {} 2x",
                asset("OPS/img/a b.png"),
                asset("OPS/img/big.png")
            )),
            "srcset descriptors not preserved: {out}"
        );
        assert!(
            out.contains(&format!(
                "{} 600w, {} 1200w",
                asset("OPS/img/small.png"),
                asset("OPS/img/large.png")
            )),
            "width descriptors not preserved: {out}"
        );
    }

    #[test]
    fn rewrites_svg_xlink_href_but_keeps_fragment_use() {
        let out = rw(FIXTURE);
        assert!(
            out.contains(&format!(r#"xlink:href="{}""#, asset("OPS/img/svg-ref.png"))),
            "svg xlink:href not rewritten: {out}"
        );
        // `<use xlink:href="#sym">` is an in-document reference and must be left alone.
        assert!(
            out.contains(r##"xlink:href="#in-page-symbol""##),
            "in-page use lost: {out}"
        );
    }

    #[test]
    fn rewrites_style_attribute_and_inline_style_element() {
        let out = rw(FIXTURE);
        // The style attribute used a quoted url('...'); the quoting style must be preserved.
        assert!(
            out.contains(&format!("url('{}')", asset("OPS/img/inline.png"))),
            "style attribute url() not rewritten: {out}"
        );
        // The <style> element used an unquoted url(...); it stays unquoted.
        assert!(
            out.contains(&format!("url({})", asset("OPS/img/bg.png"))),
            "<style> element url() not rewritten: {out}"
        );
    }

    #[test]
    fn internal_chapter_links_become_vellum_link_markers() {
        let out = rw(FIXTURE);
        assert!(
            out.contains(&format!(
                r#"href="vellum-link://{}#sec3""#,
                pct_encode_path("OPS/text/ch2.xhtml")
            )),
            "chapter link marker missing: {out}"
        );
    }

    #[test]
    fn fragment_only_links_untouched() {
        let out = rw(FIXTURE);
        assert!(
            out.contains(r##"href="#local-anchor""##),
            "in-page anchor rewritten: {out}"
        );
    }

    #[test]
    fn external_links_marked_for_opener() {
        let out = rw(FIXTURE);
        assert!(
            out.contains(r#"href="https://external.example/page?a=1""#),
            "external url changed: {out}"
        );
        assert!(
            out.contains(r#"data-vellum-external="1""#),
            "not marked external: {out}"
        );
        assert!(out.contains(r#"target="_blank""#), "target missing: {out}");
        assert!(out.contains(r#"rel="noopener""#), "rel missing: {out}");
    }

    #[test]
    fn injects_charset_base_and_doc_class() {
        let out = rw(FIXTURE);
        assert!(
            out.contains(r#"<meta charset="utf-8""#),
            "charset missing: {out}"
        );
        assert!(
            out.contains(&format!(
                r#"<base href="vellum://book/{UID}/asset/{}/""#,
                pct_encode_path(DIR)
            )),
            "base href missing/wrong: {out}"
        );
        assert!(
            out.contains(r#"class="vellum-doc""#),
            "doc class missing: {out}"
        );
        // The injected pair must be the first children of <head>.
        let head = out.find("<head>").expect("head present") + "<head>".len();
        let tail = &out[head..];
        assert!(
            tail.starts_with("<base "),
            "base is not first in head: {tail}"
        );
        assert!(
            tail.contains(r#"<meta charset="utf-8""#),
            "charset not near top: {tail}"
        );
    }

    #[test]
    fn preserves_existing_html_class() {
        let out = rewrite_chapter(
            br#"<html class="foo"><head></head><body>x</body></html>"#,
            &ctx(),
        );
        let out = String::from_utf8(out).unwrap();
        assert!(out.contains(r#"class="foo vellum-doc""#), "{out}");
    }

    #[test]
    fn second_pass_is_idempotent() {
        let once = rw(FIXTURE);
        let twice = {
            let out = rewrite_chapter(once.as_bytes(), &ctx());
            String::from_utf8(out).expect("utf-8")
        };
        // Exactly one base + one charset, no duplicated doc class, assets already absolute and
        // therefore passed through untouched.
        assert_eq!(
            twice.matches("<base ").count(),
            1,
            "base injected twice: {twice}"
        );
        assert_eq!(
            twice.matches(r#"<meta charset="utf-8""#).count(),
            1,
            "charset injected twice: {twice}"
        );
        assert_eq!(
            twice.matches("vellum-doc").count(),
            once.matches("vellum-doc").count(),
            "doc class duplicated: {twice}"
        );
        assert_eq!(once, twice, "second pass changed the document");
    }

    #[test]
    fn replaces_book_supplied_base() {
        let out = rewrite_chapter(
            br#"<html><head><base href="../"/><link href="a.css"/></head><body/></html>"#,
            &ctx(),
        );
        let out = String::from_utf8(out).unwrap();
        assert_eq!(out.matches("<base ").count(), 1, "two base elements: {out}");
        assert!(
            out.contains(&format!(r#"href="vellum://book/{UID}/asset/OPS/text/""#)),
            "{out}"
        );
        assert!(!out.contains(r#"href="../""#), "book base survived: {out}");
    }

    #[test]
    fn nested_dirs_and_parent_paths() {
        let out = rewrite_chapter(
            br#"<html><head></head><body><img src="../../images/deep/a.png"/><img src="sub/b.png"/></body></html>"#,
            &RewriteCtx {
                uid: UID,
                chapter_zip_dir: "OPS/text/chapters",
            },
        );
        let out = String::from_utf8(out).unwrap();
        // two `..` from OPS/text/chapters land on OPS
        assert!(
            out.contains(&format!(r#"src="{}""#, asset("OPS/images/deep/a.png"))),
            "{out}"
        );
        assert!(
            out.contains(&format!(
                r#"src="{}""#,
                asset("OPS/text/chapters/sub/b.png")
            )),
            "{out}"
        );
    }

    #[test]
    fn cyrillic_and_space_asset_names() {
        let out = rewrite_chapter(
            "<html><head></head><body><img src=\"../img/Обложка книги.png\"/></body></html>"
                .as_bytes(),
            &ctx(),
        );
        let out = String::from_utf8(out).unwrap();
        let expected = asset("OPS/img/Обложка книги.png");
        assert!(out.contains(&format!(r#"src="{expected}""#)), "{out}");
        // The encoded form must round-trip back to the original entry name.
        let enc = expected.rsplit_once("/asset/").unwrap().1;
        assert_eq!(pct_decode(enc), "OPS/img/Обложка книги.png");
    }

    #[test]
    fn data_urls_and_absolute_vellum_urls_pass_through() {
        let out = rw(
            r#"<html><head></head><body><img src="data:image/png;base64,iVBORw0KGgo="/><img src="vellum://book/x/asset/a.png"/></body></html>"#,
        );
        assert!(out.contains("data:image/png;base64,iVBORw0KGgo="), "{out}");
        assert!(out.contains("vellum://book/x/asset/a.png"), "{out}");
        assert_eq!(
            out.matches("vellum://book/x/asset/a.png").count(),
            1,
            "rewritten twice: {out}"
        );
    }

    #[test]
    fn fragment_only_document_still_declares_charset() {
        // A bare fragment emits no <head> token, so the head handler never fires; the document-end
        // fallback must still guarantee the encoding declaration. (A <base> is deliberately not
        // appended at the end — it would come after the content it is supposed to root, so it
        // could not do its job. Real chapters always carry a <head> and get both injections.)
        let out = rw("<p>hi</p>");
        assert!(
            out.contains(r#"<meta charset="utf-8""#),
            "no charset: {out}"
        );
        assert!(out.contains("<p>hi</p>"), "content lost: {out}");
    }

    #[test]
    fn escaping_zip_root_reference_left_alone() {
        let out = rw(
            r#"<html><head></head><body><img src="../../../../../../etc/passwd"/></body></html>"#,
        );
        assert!(
            out.contains("../../../../../../etc/passwd"),
            "escaping ref rewritten: {out}"
        );
        assert!(
            !out.contains("vellum://book") || out.contains("<base "),
            "{out}"
        );
    }

    #[test]
    fn malformed_html_does_not_panic_or_leak_script() {
        let bad = br#"<html><head><script>var x = "</head><body><img src=a.png onerror=alert(1)"#;
        let out = rewrite_chapter(bad, &ctx());
        let s = String::from_utf8_lossy(&out);
        assert!(
            !s.contains("alert(1)"),
            "handler leaked from malformed doc: {s}"
        );
        assert!(
            !s.contains("<script"),
            "script leaked from malformed doc: {s}"
        );
    }

    #[test]
    fn empty_input_yields_only_the_charset_declaration() {
        // No <head> token exists, so the document-end fallback supplies the encoding declaration —
        // the one invariant that holds for every input, including an empty one.
        let out = rewrite_chapter(b"", &ctx());
        let s = String::from_utf8(out).expect("utf-8");
        assert_eq!(s.matches(r#"<meta charset="utf-8""#).count(), 1, "{s}");
        assert!(
            !s.contains("<base "),
            "no base expected for an empty doc: {s}"
        );
        assert!(s.len() < 120, "unexpected extra output: {s}");
    }

    /// §11.2 PERF: a 300 KB chapter must rewrite in well under 20 ms.
    #[test]
    fn perf_300kb_chapter_under_budget() {
        // Build a ~300 KB document with the same attribute density as a real chapter.
        let mut doc = String::from(
            r#"<html xmlns="http://www.w3.org/1999/xhtml"><head><title>P</title></head><body>"#,
        );
        let mut i = 0;
        while doc.len() < 300 * 1024 {
            doc.push_str(&format!(
                r#"<p id="p{i}">Some text for padding, quite a lot of it. <a href="ch{i}.xhtml#f{i}">link</a> <img src="../img/pic{i}.png" alt="a {i}"/><span style="background:url('../img/bg{i}.png')">x</span></p>"#,
                i = i
            ));
            i += 1;
        }
        doc.push_str("</body></html>");
        let bytes = doc.as_bytes();
        assert!(
            bytes.len() >= 300 * 1024,
            "fixture only {} bytes",
            bytes.len()
        );

        // Warm the allocator, then measure.
        let _ = rewrite_chapter(bytes, &ctx());
        let mut best = std::time::Duration::MAX;
        for _ in 0..5 {
            let t = std::time::Instant::now();
            let out = rewrite_chapter(bytes, &ctx());
            best = best.min(t.elapsed());
            assert!(
                out.len() > bytes.len(),
                "rewrite shrank the doc: {}",
                out.len()
            );
        }
        let profile = if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        };
        println!(
            "[B2 PERF] rewrite_chapter {} KiB in {best:?} (best of 5, {profile} build)",
            bytes.len() / 1024
        );
        // §11.2 budget is 20 ms for a 300 KB chapter; enforced in release, where the measured cost
        // is a few ms. Debug builds run several times slower, so they get a loose bound that still
        // catches accidental quadratic behavior.
        let budget = if cfg!(debug_assertions) { 400 } else { 20 };
        assert!(
            best < std::time::Duration::from_millis(budget),
            "too slow for a {budget} ms budget: {best:?}"
        );
    }

    // --- self-closing non-void normalization (srcdoc is always HTML-parsed) ---

    #[test]
    fn self_closing_anchor_gets_explicit_end_tag_and_does_not_swallow_chapter() {
        let out = rw(
            r#"<html><head></head><body><div><a id="x"/>Hello <p>World</p></div></body></html>"#,
        );
        // The `/` must become a real end tag, so the anchor is empty…
        assert!(
            out.contains(r#"<a id="x"></a>"#),
            "no explicit end tag: {out}"
        );
        assert!(
            !out.contains(r#"<a id="x"/>"#),
            "self-closing survived: {out}"
        );
        // …and the following content must NOT be nested inside it. In the broken form the HTML
        // parser keeps the anchor open and swallows everything after it; with the explicit end
        // tag the anchor is closed before "Hello" appears.
        let anchor_close = out.find(r#"<a id="x"></a>"#).expect("anchor end tag");
        let hello = out.find("Hello").expect("text present");
        let para = out.find("<p>World</p>").expect("paragraph present");
        assert!(
            anchor_close < hello && hello < para,
            "content not after the closed anchor: {out}"
        );
    }

    #[test]
    fn self_closing_anchor_leaves_no_element_children() {
        // Re-parse our own output and assert the anchor is empty — the DOM-level property the
        // reader actually depends on (closest('a') must not resolve to a chapter-wide anchor).
        let out = rw(
            r#"<html><head></head><body><div><a id="x"/>Hello <p>World</p></div></body></html>"#,
        );
        let start = out.find(r#"<a id="x">"#).expect("anchor start tag") + r#"<a id="x">"#.len();
        let end = out[start..].find("</a>").expect("anchor end tag") + start;
        let inner = &out[start..end];
        assert!(
            inner.trim().is_empty(),
            "anchor swallowed children: {inner:?}"
        );
        // The paragraph survived as a sibling, outside the anchor.
        assert!(out[end..].contains("<p>World</p>"), "paragraph lost: {out}");
    }

    #[test]
    fn self_closing_div_without_attributes_is_closed() {
        // The normalization must run even when there are no attributes to sanitize — the handler
        // that does it cannot early-return like sanitize_element does.
        let out = rw(r#"<html><head></head><body><div/><p>After</p></body></html>"#);
        assert!(out.contains("<div></div>"), "bare div not closed: {out}");
        let div_end = out.find("<div></div>").expect("closed div") + "<div></div>".len();
        assert!(
            out[div_end..].contains("<p>After</p>"),
            "paragraph nested inside div: {out}"
        );
    }

    #[test]
    fn void_elements_keep_self_closing_syntax() {
        let out = rw(
            r#"<html><head></head><body><img src="a.png"/><br/><hr/><input type="text"/><link rel="stylesheet" href="a.css"/></body></html>"#,
        );
        // Void elements are already empty in HTML; they must not gain an end tag or content.
        for void in ["img", "br", "hr", "input", "link"] {
            assert!(
                !out.contains(&format!("</{void}>")),
                "void element {void} gained an end tag: {out}"
            );
        }
        // lol_html re-serializes a start tag it modified with a space before `/>` (`<img … />`)
        // and leaves an untouched one tight (`<br/>`); both are byte-cosmetic and parse
        // identically in HTML5.
        assert!(
            out.contains("<br/>"),
            "untouched void element changed: {out}"
        );
        // The img src must still have been rewritten — void elements are sanitized as usual — and
        // the tag must still be self-closing (no `</img>`, asserted above).
        assert!(
            out.contains(&format!(r#"<img src="{}" />"#, asset("OPS/text/a.png"))),
            "img src not rewritten or lost its self-closing form: {out}"
        );
        assert!(
            out.contains(&format!(r#"href="{}""#, asset("OPS/text/a.css"))),
            "link href not rewritten: {out}"
        );
    }

    #[test]
    fn foreign_content_self_closing_is_left_correct() {
        // HTML honors `/>` in foreign content (SVG/MathML), so these must not be rewritten into
        // explicit end tags with swallowed content.
        let out = rw(
            r#"<html><head></head><body><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/><circle r="1"/></svg><p>After</p></body></html>"#,
        );
        assert!(out.contains("<path"), "path lost: {out}");
        assert!(out.contains("<circle"), "circle lost: {out}");
        // Whatever form the svg children keep, the following paragraph must still be a sibling of
        // the svg rather than content inside it.
        let svg_close = out.find("</svg>").expect("svg end tag");
        let para = out.find("<p>After</p>").expect("paragraph present");
        assert!(svg_close < para, "paragraph swallowed by svg: {out}");
    }

    /// Guards the sanitize-then-close ordering. `close_self_closing_non_void` serializes the
    /// attribute list into a literal string, so if it ever ran first, every href rewrite and every
    /// `on*` removal on that element would be silently discarded — leaving live event handlers in
    /// the output. That is a security regression, not a cosmetic one, so it gets its own test.
    #[test]
    fn sanitization_survives_self_closing_normalization() {
        let out = rw(
            r##"<html><head></head><body><div><a id="chap05" href="ch2.xhtml#f" onclick="bad()" onmouseover="worse()"/>After <p>P</p></div></body></html>"##,
        );
        // on* handlers must be gone even though this element also needed closing.
        assert!(
            !out.contains("onclick"),
            "onclick survived on a self-closing tag: {out}"
        );
        assert!(!out.contains("onmouseover"), "onmouseover survived: {out}");
        assert!(
            !out.contains("bad()") && !out.contains("worse()"),
            "handler body survived: {out}"
        );
        // The href rewrite must have been applied before the tag was serialized.
        assert!(
            out.contains(&format!(
                r#"href="vellum-link://{}#f""#,
                pct_encode_path("OPS/text/ch2.xhtml")
            )),
            "href rewrite lost by self-closing normalization: {out}"
        );
        // And the element is still properly closed, not swallowing the chapter.
        assert!(
            out.contains("</a>After"),
            "anchor not closed before following text: {out}"
        );
    }

    #[test]
    fn self_closing_normalization_survives_a_second_pass() {
        let once = rw(r#"<html><head></head><body><a id="x"/>Hi</body></html>"#);
        assert!(once.contains(r#"<a id="x"></a>"#), "{once}");
        let twice = String::from_utf8(rewrite_chapter(once.as_bytes(), &ctx())).unwrap();
        assert_eq!(once, twice, "second pass changed the document");
    }
}
