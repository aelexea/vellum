//! Google Translate keyless endpoints (§11.4 "Provider endpoint reality") — owned by B7.
//!
//! Fallback chain, first working response wins:
//! 1. `translate.googleapis.com/translate_a/single?client=gtx&dt=t&dt=bd` — rich nested
//!    arrays (`[[translated, orig, null, null, conf], …]`, source lang at `[2]` or
//!    `[8][0]`, `bd` dictionary senses parsed gracefully but not used for the result —
//!    dict data comes from dictionaryapi).
//! 2. `clients5.google.com/translate_a/t?client=dict-chrome-ex` — flat shapes:
//!    `["translated"]` (explicit sl), `[["translated","detected"]]` (sl=auto, real
//!    capture 2026-09), or `{"sentences":[{"trans":…}],"src":…}` object.
//!
//! A real browser UA is mandatory on every request or Google answers 403/"Sorry…" HTML.
//! All parsing is behind pure `parse_*` functions over `&str` so tests never touch the
//! network (§8: fixtures only).

use serde_json::Value;

use crate::dto::{ProviderConfig, TranslateResult};
use crate::net::translate::{BoxFuture, TranslateProvider};
use crate::net::{query_string, BROWSER_UA};

pub struct Google;

/// Rich gtx endpoint (no key required).
pub const ENDPOINT: &str = "https://translate.googleapis.com/translate_a/single";
/// Flat fallback endpoint (probed working 2026-09 while gtx returned "Sorry…" HTML).
pub const FALLBACK_ENDPOINT: &str = "https://clients5.google.com/translate_a/t";

/// Long texts are chunked at sentence boundaries, ≤ 1500 chars per request.
const CHUNK_MAX: usize = 1500;
/// Texts longer than this get chunked at all.
const CHUNK_THRESHOLD: usize = 1800;
/// Safety cap on sequential chunk requests (WP spec: translate what fits, then stop).
const CHUNK_CAP: usize = 8;
/// Max paragraph requests before extra paragraphs are merged into the last one.
const PARA_REQUEST_CAP: usize = 3;

impl TranslateProvider for Google {
    fn id(&self) -> &str {
        "google"
    }
    fn name(&self) -> &str {
        "Google Translate"
    }
    fn needs_config(&self) -> bool {
        false
    }

    fn translate<'a>(
        &'a self,
        c: &'a reqwest::Client,
        _cfg: &'a ProviderConfig,
        text: &'a str,
        from: &'a str,
        to: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<TranslateResult>> {
        Box::pin(async move {
            let (units, sep) = plan_requests(text);
            anyhow::ensure!(!units.is_empty(), "nothing to translate");

            let mut parts: Vec<String> = Vec::with_capacity(units.len());
            let mut detected = String::new();

            for unit in &units {
                let r = translate_once(c, unit, from, to).await?;
                if detected.is_empty() && !r.detected_source_lang.is_empty() {
                    detected = r.detected_source_lang.clone();
                }
                parts.push(r.translated_text);
            }

            Ok(TranslateResult {
                translated_text: parts.join(sep),
                detected_source_lang: detected,
                target_lang: to.to_owned(),
                provider_id: "google".to_owned(),
            })
        })
    }

    fn detect<'a>(
        &'a self,
        c: &'a reqwest::Client,
        text: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<String>> {
        Box::pin(async move {
            // sl=auto probe: the response carries the detected source language
            let url = single_url(text, "auto", "en");
            let body = http_get(c, &url).await?;
            let parsed = parse_single(&body).map_err(|e| anyhow::anyhow!("{e}"))?;
            anyhow::ensure!(
                !parsed.detected_source_lang.is_empty(),
                "google detect: no source language in response"
            );
            Ok(parsed.detected_source_lang)
        })
    }
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

/// Rich endpoint URL. `from = "auto"` → `sl=auto` (supported by gtx).
pub fn single_url(text: &str, from: &str, to: &str) -> String {
    format!(
        "{ENDPOINT}?{}",
        query_string(&[
            ("client", "gtx"),
            ("sl", from),
            ("tl", to),
            ("dt", "t"),
            ("dt", "bd"),
            ("q", text),
        ])
    )
}

/// Flat fallback endpoint URL.
pub fn fallback_url(text: &str, from: &str, to: &str) -> String {
    format!(
        "{FALLBACK_ENDPOINT}?{}",
        query_string(&[
            ("client", "dict-chrome-ex"),
            ("sl", from),
            ("tl", to),
            ("q", text),
        ])
    )
}

// ---------------------------------------------------------------------------
// Request pipeline (HTTP) — the only networked code; parsers below are pure
// ---------------------------------------------------------------------------

/// Translate one unit: try the rich endpoint, fall back to the flat one.
async fn translate_once(
    c: &reqwest::Client,
    text: &str,
    from: &str,
    to: &str,
) -> anyhow::Result<TranslateResult> {
    if text.is_empty() {
        return Ok(TranslateResult {
            translated_text: String::new(),
            detected_source_lang: String::new(),
            target_lang: to.to_owned(),
            provider_id: "google".to_owned(),
        });
    }

    // (1) rich gtx endpoint — any HTTP error or unparseable body falls through
    if let Ok(body) = http_get(c, &single_url(text, from, to)).await {
        if let Ok(mut r) = parse_single(&body) {
            if r.translated_text.is_empty() {
                r.translated_text = text.to_owned();
            }
            r.target_lang = to.to_owned();
            return Ok(r);
        }
    }

    // (2) flat fallback endpoint
    let body = http_get(c, &fallback_url(text, from, to)).await?;
    let mut r = parse_flat(&body).map_err(|e| anyhow::anyhow!("google fallback: {e}"))?;
    if r.translated_text.is_empty() {
        r.translated_text = text.to_owned();
    }
    r.target_lang = to.to_owned();
    Ok(r)
}

/// GET with browser UA; any non-2xx (403 "Sorry…", 429, 5xx) is an error so the
/// caller falls back to the next endpoint.
async fn http_get(c: &reqwest::Client, url: &str) -> anyhow::Result<String> {
    let resp = c
        .get(url)
        .header(reqwest::header::USER_AGENT, BROWSER_UA)
        .send()
        .await?;
    let status = resp.status();
    let body = resp.text().await?;
    anyhow::ensure!(status.is_success(), "HTTP {status}");
    Ok(body)
}

// ---------------------------------------------------------------------------
// Pure parsers (test seam — fixture-driven, no network)
// ---------------------------------------------------------------------------

/// Parse the rich `translate_a/single` nested-array response.
///
/// Shape: `[[[trans, orig, null, null, conf], …], bd?, src?, …]` — translated segments
/// in `[0][i][0]`, source language at `[2]` (string) or `[8][0][0]`, dictionary senses
/// in `[1]` (parsed gracefully, ignored for the result per WP spec).
pub fn parse_single(body: &str) -> Result<TranslateResult, String> {
    let trimmed = body.trim();
    if !trimmed.starts_with('[') {
        return Err("not a JSON array (HTML/blocked response?)".to_owned());
    }
    let v: Value = serde_json::from_str(trimmed).map_err(|e| format!("json: {e}"))?;
    let root = v.as_array().ok_or("root is not an array")?;

    // translated text: concat of [0][i][0]
    let segments = root
        .first()
        .and_then(Value::as_array)
        .ok_or("no segments")?;
    let mut translated = String::new();
    for seg in segments {
        if let Some(s) = seg.get(0).and_then(Value::as_str) {
            translated.push_str(s);
        }
    }

    // source lang: [2] when a non-empty string, else [8][0][0]
    let mut src = root.get(2).and_then(Value::as_str).unwrap_or("").to_owned();
    if src.is_empty() {
        if let Some(s) = root
            .get(8)
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_array)
            .and_then(|a| a.first())
            .and_then(Value::as_str)
        {
            src = s.to_owned();
        }
    }

    // bd dictionary senses: parse gracefully (shape check only — result unused)
    let _senses = parse_bd(root.get(1));

    if translated.is_empty() {
        return Err("no translated segments".to_owned());
    }
    Ok(TranslateResult {
        translated_text: translated,
        detected_source_lang: src,
        target_lang: String::new(), // filled by caller (tl is known there)
        provider_id: "google".to_owned(),
    })
}

/// `bd` block → (pos, terms) pairs. IGNORED for `TranslateResult` (dict comes from
/// dictionaryapi) but parsed so unexpected shapes never break the main path.
pub(crate) fn parse_bd(bd: Option<&Value>) -> Vec<(String, Vec<String>)> {
    let Some(arr) = bd.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in arr {
        let Some(e) = entry.as_array() else { continue };
        let pos = e.first().and_then(Value::as_str).unwrap_or("").to_owned();
        let terms = e
            .get(1)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !pos.is_empty() || !terms.is_empty() {
            out.push((pos, terms));
        }
    }
    out
}

/// Parse the flat `clients5 translate_a/t` response. Real observed shapes:
/// - `["translated"]` — explicit `sl` (captured 2026-09: `["Hallo"]`)
/// - `[["translated","en"]]` — `sl=auto`: pairs of (text, detected lang); detected
///   taken from the first pair, texts concatenated (captured: `[["привет","en"]]`)
/// - `{"sentences":[{"trans":…}],"src":…}` — object form (documented in addendum)
pub fn parse_flat(body: &str) -> Result<TranslateResult, String> {
    let trimmed = body.trim();
    if trimmed.starts_with('<') || trimmed.is_empty() {
        return Err("HTML/empty response".to_owned());
    }
    let v: Value = serde_json::from_str(trimmed).map_err(|e| format!("json: {e}"))?;

    match &v {
        Value::Array(arr) => {
            let mut translated = String::new();
            let mut src = String::new();
            for item in arr {
                match item {
                    // ["translated"]
                    Value::String(s) => translated.push_str(s),
                    // [["translated","detected"]]
                    Value::Array(pair) => {
                        if let Some(s) = pair.first().and_then(Value::as_str) {
                            translated.push_str(s);
                        }
                        if src.is_empty() {
                            if let Some(s) = pair.get(1).and_then(Value::as_str) {
                                src = s.to_owned();
                            }
                        }
                    }
                    _ => {}
                }
            }
            if translated.is_empty() {
                return Err("no translation in array".to_owned());
            }
            Ok(TranslateResult {
                translated_text: translated,
                detected_source_lang: src,
                target_lang: String::new(),
                provider_id: "google".to_owned(),
            })
        }
        Value::Object(_) => {
            // {"sentences":[{"trans":…}],"src":…} — also tolerate a flat {"trans":…}
            let mut translated = String::new();
            if let Some(sents) = v.get("sentences").and_then(Value::as_array) {
                for s in sents {
                    if let Some(t) = s.get("trans").and_then(Value::as_str) {
                        translated.push_str(t);
                    }
                }
            }
            if translated.is_empty() {
                if let Some(t) = v.get("trans").and_then(Value::as_str) {
                    translated.push_str(t);
                }
            }
            let src = v
                .get("src")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            if translated.trim().is_empty() {
                return Err("no translation in object".to_owned());
            }
            Ok(TranslateResult {
                translated_text: translated.trim_end().to_owned(),
                detected_source_lang: src,
                target_lang: String::new(),
                provider_id: "google".to_owned(),
            })
        }
        Value::String(s) => {
            // some deployments answer with a bare JSON string
            if s.trim().is_empty() {
                return Err("empty string response".to_owned());
            }
            Ok(TranslateResult {
                translated_text: s.clone(),
                detected_source_lang: String::new(),
                target_lang: String::new(),
                provider_id: "google".to_owned(),
            })
        }
        _ => Err("unexpected json shape".to_owned()),
    }
}

// ---------------------------------------------------------------------------
// Chunking (pure — test seam)
// ---------------------------------------------------------------------------

/// Plan the sequential request units for `text`, returning `(units, join_separator)`.
///
/// - single paragraph ≤ 1800 chars → one unit;
/// - single paragraph > 1800 chars → sentence-boundary chunks ≤ 1500 chars, ≤ 8 chunks,
///   joined with `""` (chunks split mid-paragraph);
/// - multiple paragraphs → paragraphs grouped into ≤ 3 requests, joined with `"\n"`
///   (the separator reconstructs the original text exactly);
/// - all-blank input → no units.
///
/// Reconstructing the source from the plan is always `units.join(sep)` (used by tests to
/// prove nothing is lost within the cap). Text beyond the chunk cap is intentionally not
/// translated (WP spec: "translate what fits"; see DEVIATIONS in the report).
pub fn plan_requests(text: &str) -> (Vec<String>, &'static str) {
    let paragraphs: Vec<&str> = text.split('\n').collect();

    // single paragraph (no newline at all)
    if paragraphs.len() == 1 {
        let p = paragraphs[0];
        if p.chars().count() <= CHUNK_THRESHOLD {
            return (vec![p.to_owned()], "");
        }
        return (chunk_long(p), "");
    }

    // multi-paragraph: nothing but blank lines → no work
    if paragraphs.iter().all(|p| p.trim().is_empty()) {
        return (Vec::new(), "\n");
    }

    // distribute paragraphs over ≤ PARA_REQUEST_CAP groups, preserving order and blanks
    let per = paragraphs.len().div_ceil(PARA_REQUEST_CAP).max(1);
    let units: Vec<String> = paragraphs
        .chunks(per)
        .map(|group| group.join("\n"))
        .collect();
    (units, "\n")
}

/// Sentence-boundary chunking: greedily pack sentences up to [`CHUNK_MAX`] chars,
/// hard-split runaway sentences (no terminator), cap at [`CHUNK_CAP`] chunks.
/// Concatenating the chunks reproduces the (possibly truncated) input exactly.
fn chunk_long(text: &str) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_len = 0usize;

    for sentence in split_sentences(text) {
        let slen = sentence.chars().count();

        // runaway sentence longer than a whole chunk → hard-split by chars
        if slen > CHUNK_MAX {
            if cur_len > 0 {
                chunks.push(std::mem::take(&mut cur));
                cur_len = 0;
                if chunks.len() >= CHUNK_CAP {
                    return chunks;
                }
            }
            let chars: Vec<char> = sentence.chars().collect();
            for piece in chars.chunks(CHUNK_MAX) {
                chunks.push(piece.iter().collect());
                if chunks.len() >= CHUNK_CAP {
                    return chunks;
                }
            }
            continue;
        }

        // greedy pack: flush current chunk if this sentence would overflow it
        if cur_len + slen > CHUNK_MAX && cur_len > 0 {
            chunks.push(std::mem::take(&mut cur));
            cur_len = 0;
            if chunks.len() >= CHUNK_CAP {
                return chunks;
            }
        }
        cur.push_str(&sentence);
        cur_len += slen;
    }

    if cur_len > 0 && chunks.len() < CHUNK_CAP {
        chunks.push(cur);
    }
    chunks.truncate(CHUNK_CAP);
    chunks
}

/// Split keeping terminators attached: `"A. B!"` → `["A. ", "B!"]` is wrong (the space
/// belongs to the next sentence); we attach the terminator only: `["A.", " B!"]`.
fn split_sentences(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for c in text.chars() {
        cur.push(c);
        if matches!(c, '.' | '!' | '?' | '…') {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/");

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{FIX}{name}"))
            .unwrap_or_else(|e| panic!("fixture {name}: {e}"))
    }

    // -- parse_single -------------------------------------------------------

    #[test]
    fn parse_single_rich_fixture() {
        let body = fixture("b7_google_single.json");
        let r = parse_single(&body).expect("parse");
        assert_eq!(r.translated_text, "приветздравствуйте");
        assert_eq!(r.detected_source_lang, "en");
        assert_eq!(r.provider_id, "google");
    }

    #[test]
    fn parse_single_src_from_index_8() {
        // [2] is null → fall back to [8][0][0]
        let body = r#"[[["ок","ok",null,null,10]],null,null,null,null,null,null,null,[["ru"],null,[["ок","ok",null,null,10]]]]"#;
        let r = parse_single(body).expect("parse");
        assert_eq!(r.translated_text, "ок");
        assert_eq!(r.detected_source_lang, "ru");
    }

    #[test]
    fn parse_single_rejects_html() {
        let body = fixture("b7_google_sorry.html");
        assert!(parse_single(&body).is_err(), "Sorry-HTML must be rejected");
    }

    #[test]
    fn parse_single_rejects_garbage() {
        assert!(parse_single("").is_err());
        assert!(parse_single("[[]]").is_err()); // segment has no [0] string
        assert!(parse_single("{\"a\":1}").is_err());
    }

    #[test]
    fn parse_bd_shapes() {
        let body = fixture("b7_google_single.json");
        let v: Value = serde_json::from_str(&body).unwrap();
        let senses = parse_bd(v.get(1));
        assert_eq!(senses.len(), 2);
        assert_eq!(senses[0].0, "exclamation");
        assert!(senses[0].1.contains(&"привет".to_owned()));
        assert_eq!(senses[1].0, "noun");
        // malformed bd → empty, no panic
        assert!(parse_bd(None).is_empty());
        assert!(parse_bd(Some(&serde_json::json!("nope"))).is_empty());
        assert!(parse_bd(Some(&serde_json::json!([[]]))).is_empty());
    }

    // -- parse_flat ---------------------------------------------------------

    #[test]
    fn parse_flat_auto_pairs_fixture() {
        let body = fixture("b7_google_flat_auto.json");
        let r = parse_flat(&body).expect("parse");
        assert_eq!(r.translated_text, "привет");
        assert_eq!(r.detected_source_lang, "en");
    }

    #[test]
    fn parse_flat_explicit_string_fixture() {
        let body = fixture("b7_google_flat_explicit.json");
        let r = parse_flat(&body).expect("parse");
        assert_eq!(r.translated_text, "Hallo");
        assert_eq!(r.detected_source_lang, "");
    }

    #[test]
    fn parse_flat_object_fixture() {
        let body = fixture("b7_google_flat_object.json");
        let r = parse_flat(&body).expect("parse");
        assert_eq!(r.translated_text, "Привет, как дела? Меня зовут Джон.");
        assert_eq!(r.detected_source_lang, "en");
    }

    #[test]
    fn parse_flat_rejects_html_and_garbage() {
        assert!(parse_flat("<html>Sorry</html>").is_err());
        assert!(parse_flat("").is_err());
        assert!(parse_flat("[]").is_err());
        assert!(parse_flat("[[]]").is_err());
        assert!(parse_flat("null").is_err());
    }

    #[test]
    fn parse_flat_bare_string() {
        let r = parse_flat("\"привет\"").expect("parse");
        assert_eq!(r.translated_text, "привет");
    }

    // -- URL building -------------------------------------------------------

    #[test]
    fn urls_are_encoded() {
        let u = single_url("good morning", "auto", "ru");
        assert!(u.starts_with(ENDPOINT));
        assert!(u.contains("client=gtx"));
        assert!(u.contains("sl=auto") && u.contains("tl=ru"));
        assert!(u.contains("dt=t") && u.contains("dt=bd"));
        assert!(u.contains("q=good%20morning"));

        let f = fallback_url("привет", "ru", "en");
        assert!(f.starts_with(FALLBACK_ENDPOINT));
        assert!(f.contains("client=dict-chrome-ex"));
        assert!(f.contains("q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82"));
    }

    // -- plan_requests (paragraph + chunk planning) --------------------------

    #[test]
    fn plan_single_short_text_one_unit() {
        let (units, sep) = plan_requests("hello");
        assert_eq!(units, vec!["hello".to_owned()]);
        assert_eq!(sep, "");
    }

    #[test]
    fn plan_multi_paragraph_max_three_requests_roundtrip() {
        let text = "p1\np2\np3\np4\np5\np6\np7";
        let (units, sep) = plan_requests(text);
        assert!(units.len() <= PARA_REQUEST_CAP, "got {} units", units.len());
        assert_eq!(sep, "\n");
        // every paragraph present exactly once, order kept
        assert_eq!(units.join(sep), text);
    }

    #[test]
    fn plan_two_paragraphs_one_request_each() {
        // §WP: multi-paragraph splits on \n and translates the parts (≤3 requests);
        // joining with the separator reconstructs the source exactly.
        let (units, sep) = plan_requests("first\nsecond");
        assert_eq!(units, vec!["first".to_owned(), "second".to_owned()]);
        assert_eq!(sep, "\n");
        assert_eq!(units.join(sep), "first\nsecond");
    }

    #[test]
    fn plan_preserves_blank_lines() {
        let (units, sep) = plan_requests("a\n\nb");
        assert_eq!(units, vec!["a".to_owned(), String::new(), "b".to_owned()]);
        assert_eq!(units.join(sep), "a\n\nb");
    }

    #[test]
    fn plan_all_blank_is_empty() {
        let (units, _) = plan_requests("\n\n\n");
        assert!(units.is_empty());
    }

    #[test]
    fn plan_long_text_chunks_at_sentence_boundaries() {
        // 48 sentences × 50 chars ≈ 2400 chars > 1800 threshold
        let sentence = "This is a fairly long test sentence for chunking. ";
        let text: String = sentence.repeat(48);
        assert!(text.chars().count() > CHUNK_THRESHOLD);
        let (units, sep) = plan_requests(&text);
        assert!(units.len() > 1);
        assert!(units.len() <= CHUNK_CAP);
        assert_eq!(sep, "");
        for u in &units {
            assert!(
                u.chars().count() <= CHUNK_MAX,
                "chunk too big: {}",
                u.chars().count()
            );
        }
        // nothing lost: concatenation equals the source
        assert_eq!(units.join(sep), text);
    }

    #[test]
    fn plan_caps_chunks_at_eight() {
        // one runaway 15000-char sentence → would be 10 hard chunks, capped to 8
        let text = "word ".repeat(3000);
        let (units, _) = plan_requests(&text);
        assert_eq!(units.len(), CHUNK_CAP, "cap violated: {}", units.len());
    }

    #[test]
    fn chunk_long_runaway_sentence_no_panic() {
        let text = "x".repeat(4000);
        let chunks = chunk_long(&text);
        assert!(!chunks.is_empty());
        assert!(chunks.iter().all(|c| c.chars().count() <= CHUNK_MAX));
        assert!(chunks.len() <= CHUNK_CAP);
    }

    #[test]
    fn split_sentences_keeps_terminators() {
        assert_eq!(
            split_sentences("A. B! C? D"),
            vec!["A.", " B!", " C?", " D"]
        );
        assert_eq!(split_sentences(""), Vec::<String>::new());
        // reconstruction is lossless
        let s = "One. Two! Three?";
        assert_eq!(split_sentences(s).concat(), s);
    }

    #[test]
    fn plan_many_paragraphs_exact_cap() {
        let text = (0..20)
            .map(|i| format!("paragraph {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let (units, sep) = plan_requests(&text);
        assert_eq!(units.len(), PARA_REQUEST_CAP);
        assert_eq!(units.join(sep), text);
    }
}
