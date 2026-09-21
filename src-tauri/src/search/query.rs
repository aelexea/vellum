//! FTS5 MATCH + snippet queries (§4.5) — owned by B5.
//!
//! Two halves: [`sanitize_query`] turns arbitrary user input into safe FTS5 syntax, and
//! [`search`] runs it against `book_search` and returns HTML-ready [`SearchHit`]s.
//!
//! ## Safety
//! Every value reaches SQLite as a bound parameter, so there is no injection path. The
//! sanitization exists because FTS5 has its *own* query grammar: a bare `NEAR`, `(` or
//! `"` typed by the user would otherwise be a syntax error. Quoting each token as a
//! string literal (`"tok"*`) makes the whole user input inert, and the doubled internal
//! quotes are FTS5's own escape for a quote inside a literal.

use rusqlite::Connection;

use crate::dto::SearchHit;
use crate::state::AppState;

/// Default result cap when the caller passes none (§4.8: `limit` defaults to 100).
pub const DEFAULT_LIMIT: i64 = 100;
/// Hard ceiling, so a hostile/buggy caller cannot ask for the whole book.
pub const MAX_LIMIT: i64 = 500;

/// Markers we inject via `snippet()`; the only HTML allowed through [`escape_snippet`].
const MARK_OPEN: &str = "<mark>";
const MARK_CLOSE: &str = "</mark>";

/// Sanitize a user query into safe FTS5 syntax (§4.5).
///
/// * trimmed and empty → `""`, which callers treat as "no results" (never executed);
/// * wrapped in `"…"` → phrase search, exact, with internal quotes doubled;
/// * otherwise each whitespace-separated token is reduced to alphanumeric runs and
///   emitted as a quoted prefix term `"tok"*`, joined with `AND` (multiword = all words
///   must occur in the chapter).
///
/// An empty result also covers input made entirely of punctuation (`***`, `(((`) — there
/// is nothing to search for, and running it would be an FTS5 syntax error.
pub fn sanitize_query(q: &str) -> String {
    let trimmed = q.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // Phrase mode: the whole quoted string is one exact sequence of tokens.
    if trimmed.len() >= 2 && trimmed.starts_with('"') && trimmed.ends_with('"') {
        let inner = &trimmed[1..trimmed.len() - 1];
        let escaped = escape_phrase(inner);
        if escaped.is_empty() {
            return String::new();
        }
        return format!("\"{escaped}\"");
    }

    // Prefix mode: punctuation becomes a separator, so `don't` → `don` + `t` and
    // `frank*` → `frank` (our own trailing `*` restores the prefix intent).
    let terms: Vec<String> = split_terms(trimmed)
        .into_iter()
        .map(|t| format!("\"{}\"*", escape_phrase(cyr_stem(t))))
        .collect();
    if terms.is_empty() {
        return String::new();
    }
    terms.join(" AND ")
}

/// Whitespace-separated runs, with non-alphanumeric characters acting as separators.
/// Yields nothing when no alphanumeric run survives.
fn split_terms(s: &str) -> Vec<&str> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Cyrillic morphology helper for prefix queries.
///
/// FTS5's `porter` stemmer is English-only: an inflected Cyrillic word (`корову`,
/// `коровы`) is tokenized by `unicode61` and indexed verbatim, so a dictionary-form
/// query (`корова`) would match nothing but the exact nominative. Truncating a long
/// Cyrillic token to its first [`CYR_STEM`] characters turns the prefix term into a stem
/// match — `войн*` covers война/войну/войны/войне, `коро*` covers корова/корову/коровы —
/// trading a little precision (`коро*` also hits короткий/королева) for the recall a
/// reader expects. Latin tokens are left to porter. Short tokens (≤ `CYR_STEM` chars) are
/// kept whole: `мир*` already covers мира/миру, and truncating further would over-match.
///
/// Char-boundary safe (Cyrillic is multi-byte in UTF-8).
const CYR_STEM: usize = 4;
fn cyr_stem(tok: &str) -> &str {
    if tok.chars().count() <= CYR_STEM {
        return tok;
    }
    if !tok.chars().any(is_cyrillic) {
        return tok;
    }
    match tok.char_indices().nth(CYR_STEM) {
        Some((i, _)) => &tok[..i],
        None => tok,
    }
}

fn is_cyrillic(c: char) -> bool {
    matches!(c, '\u{0400}'..='\u{04FF}' | '\u{0500}'..='\u{052F}')
}

/// FTS5 string-literal escape: a quote inside a quoted term is written twice.
fn escape_phrase(s: &str) -> String {
    s.replace('"', "\"\"")
}

/// Clamp the caller's limit: `null`/non-positive → 100, anything above → 500.
///
/// Non-positive must not reach SQLite, where `LIMIT -1` means "no limit".
fn normalize_limit(limit: i64) -> i64 {
    if limit <= 0 {
        DEFAULT_LIMIT
    } else {
        limit.min(MAX_LIMIT)
    }
}

/// Run a search against an open connection (short-lived lock in the command layer).
///
/// `book_uid` is an UNINDEXED FTS5 column, so it cannot appear in the MATCH expression;
/// it is filtered with a plain equality on the same row instead.
///
/// Returns `[]` for an empty/unsearchable query without touching the database.
pub fn search(
    conn: &Connection,
    uid: &str,
    query: &str,
    limit: i64,
) -> anyhow::Result<Vec<SearchHit>> {
    let fts = sanitize_query(query);
    if fts.is_empty() {
        return Ok(Vec::new());
    }
    let limit = normalize_limit(limit);

    // `rank` is bm25(): negative, and more negative = better match. `score` flips the sign
    // so the frontend can sort descending on a positive number.
    const SQL: &str = "SELECT chapter_idx, chapter_title, \
         snippet(book_search, 3, '<mark>', '</mark>', '…', 16), rank \
         FROM book_search \
         WHERE book_uid = ?2 AND book_search MATCH ?1 \
         ORDER BY rank LIMIT ?3";

    let mut stmt = conn.prepare(SQL)?;
    let rows = stmt.query_map(rusqlite::params![fts, uid, limit], |r| {
        let raw: String = r.get(2)?;
        Ok(SearchHit {
            chapter_idx: r.get(0)?,
            chapter_title: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            snippet: escape_snippet(&raw),
            score: -r.get::<_, f64>(3)?,
        })
    })?;

    let mut hits = Vec::new();
    for row in rows {
        hits.push(row?);
    }
    Ok(hits)
}

/// Convenience wrapper over [`search`] using the shared app connection.
///
/// The lock is held only for the duration of the query (§11.3: short-lived locks).
pub fn search_in_book(
    state: &AppState,
    uid: &str,
    query: &str,
    limit: i64,
) -> anyhow::Result<Vec<SearchHit>> {
    if sanitize_query(query).is_empty() {
        return Ok(Vec::new()); // skip the lock entirely
    }
    let conn = state
        .db
        .lock()
        .map_err(|_| anyhow::anyhow!("database is busy"))?;
    search(&conn, uid, query, limit)
}

/// HTML-escape a `snippet()` result while preserving our own `<mark>` tags.
///
/// `snippet()` returns the *raw* stored text, so a chapter containing `<script>` or `&`
/// would otherwise be injected verbatim into the frontend's `dangerouslySetInnerHTML`
/// (§5.6). We split on the markers we asked SQLite to insert and escape everything else.
fn escape_snippet(snippet: &str) -> String {
    let mut out = String::with_capacity(snippet.len() + 32);
    let mut rest = snippet;

    while let Some((marker, at)) = next_marker(rest) {
        // Markers are pure ASCII, so `at` is always a char boundary.
        let (before, tail) = rest.split_at(at);
        out.push_str(&html_escape(before));
        out.push_str(marker);
        rest = &tail[marker.len()..];
    }

    out.push_str(&html_escape(rest));
    out
}

/// Earliest `<mark>`/`</mark>` occurrence, with its byte offset.
fn next_marker(s: &str) -> Option<(&'static str, usize)> {
    match (s.find(MARK_OPEN), s.find(MARK_CLOSE)) {
        (Some(o), Some(c)) if o <= c => Some((MARK_OPEN, o)),
        (Some(o), None) => Some((MARK_OPEN, o)),
        (_, Some(c)) => Some((MARK_CLOSE, c)),
        (None, None) => None,
    }
}

/// Minimal HTML escaping for text nodes (and attribute-free display).
fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- sanitize_query -------------------------------------------------

    #[test]
    fn empty_and_whitespace_queries_are_inert() {
        assert_eq!(sanitize_query(""), "");
        assert_eq!(sanitize_query("   \t\n "), "");
    }

    #[test]
    fn single_word_becomes_quoted_prefix() {
        assert_eq!(sanitize_query("monster"), "\"monster\"*");
        assert_eq!(sanitize_query("  frank  "), "\"frank\"*");
    }

    #[test]
    fn multiword_is_and_joined_prefixes() {
        assert_eq!(
            sanitize_query("quick monster"),
            "\"quick\"* AND \"monster\"*"
        );
    }

    #[test]
    fn phrase_mode_is_exact_and_escaped() {
        assert_eq!(
            sanitize_query("\"the quick monster\""),
            "\"the quick monster\""
        );
        // Internal quotes doubled per FTS5 literal escaping.
        assert_eq!(
            sanitize_query("\"say \"hi\" now\""),
            "\"say \"\"hi\"\" now\""
        );
        // A lone quote is not a phrase (and leaves no term).
        assert_eq!(sanitize_query("\""), "");
    }

    #[test]
    fn fts_special_chars_never_reach_the_grammar() {
        // Operators and syntax chars must not survive as bare FTS5 tokens.
        for q in [
            "NEAR",
            "NEAR(a b)",
            "(monster)",
            "*",
            "***",
            "\"",
            "a:b",
            "-x",
            "^y",
        ] {
            let out = sanitize_query(q);
            assert!(
                out.is_empty() || out.chars().all(|c| c != '(' && c != ')' && c != ':'),
                "unsafe FTS syntax leaked for {q:?}: {out:?}"
            );
        }
        assert_eq!(sanitize_query("NEAR"), "\"NEAR\"*"); // literal term, not an operator
        assert_eq!(sanitize_query("(monster)"), "\"monster\"*");
        assert_eq!(sanitize_query("***"), ""); // nothing searchable left
        assert_eq!(sanitize_query("mon*ster"), "\"mon\"* AND \"ster\"*");
    }

    #[test]
    fn apostrophes_and_hyphens_split_like_the_tokenizer() {
        // unicode61 also treats these as separators, so query and index agree.
        assert_eq!(sanitize_query("don't"), "\"don\"* AND \"t\"*");
        assert_eq!(sanitize_query("well-known"), "\"well\"* AND \"known\"*");
    }

    #[test]
    fn cyrillic_tokens_survive() {
        // Long Cyrillic tokens are stem-truncated (porter is English-only, so inflected
        // forms like «войну» are indexed verbatim): «война» → «войн»* matches every case.
        // Short tokens keep their full prefix semantics.
        assert_eq!(sanitize_query("война мир"), "\"войн\"* AND \"мир\"*");
        assert_eq!(sanitize_query("корова"), "\"коро\"*");
        assert_eq!(sanitize_query("монстр"), "\"монс\"*");
        // Mixed-script tokens are truncated too (Cyrillic present → user means Russian).
        assert_eq!(sanitize_query("EPUB книга"), "\"EPUB\"* AND \"книг\"*");
    }

    // ---- escape_snippet -------------------------------------------------

    #[test]
    fn snippet_escapes_html_but_keeps_marks() {
        let raw = "a <script>alert(1)</script> & <mark>monster</mark> \"x\" 'y'";
        let out = escape_snippet(raw);
        assert_eq!(
            out,
            "a &lt;script&gt;alert(1)&lt;/script&gt; &amp; <mark>monster</mark> &quot;x&quot; &#39;y&#39;"
        );
    }

    #[test]
    fn snippet_handles_adjacent_and_repeated_marks() {
        assert_eq!(
            escape_snippet("<mark>a</mark><mark>b</mark>"),
            "<mark>a</mark><mark>b</mark>"
        );
        assert_eq!(escape_snippet("plain & simple"), "plain &amp; simple");
        assert_eq!(escape_snippet(""), "");
    }

    #[test]
    fn snippet_keeps_ellipsis_separator() {
        assert_eq!(escape_snippet("…<mark>x</mark>…"), "…<mark>x</mark>…");
    }

    // ---- limit ----------------------------------------------------------

    #[test]
    fn limit_is_clamped_and_non_positive_never_means_unlimited() {
        assert_eq!(normalize_limit(0), DEFAULT_LIMIT);
        assert_eq!(normalize_limit(-1), DEFAULT_LIMIT);
        assert_eq!(normalize_limit(7), 7);
        assert_eq!(normalize_limit(5000), MAX_LIMIT);
    }
}
