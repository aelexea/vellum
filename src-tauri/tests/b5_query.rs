//! B5 §8 tests — query layer: FTS5 MATCH + snippet + sanitization.
//!
//! These run against the real public API (`vellum_lib::search::query`) with a temp DB
//! built from the §4.4 DDL subset (`vellum_lib::search::TEST_DDL`), so they depend on
//! neither B3's `db::migrate` nor B1's `epub::extract_text`: chapter bodies are inserted
//! as *already extracted* plain text, which is exactly what the query layer sees in
//! production.
//!
//! Indexer-pipeline tests (which do need text extraction) live in `b5_index.rs`.

use rusqlite::{params, Connection};

use vellum_lib::search::{query, TEST_DDL};

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

/// A fresh in-memory DB with the §4.4 tables B5 touches.
fn db() -> Connection {
    let conn = Connection::open_in_memory().expect("open in-memory db");
    conn.execute_batch(TEST_DDL).expect("apply test DDL");
    conn
}

fn insert_hit(conn: &Connection, uid: &str, idx: i64, title: Option<&str>, body: &str) {
    conn.execute(
        "INSERT INTO book_search(book_uid, chapter_idx, chapter_title, body) \
         VALUES (?1, ?2, ?3, ?4)",
        params![uid, idx, title, body],
    )
    .expect("insert fts row");
}

/// Frankenstein-flavoured fixture: three chapters for `u1`, one for `u2` (book filter),
/// plus `u3` for the limit tests.
///
/// Deliberate tokenizer details the tests rely on:
/// * ch0 has the exact token `monster`; ch1 only has `monstrous`, which the porter
///   stemmer reduces to `monstr` — so `monster` matches ch0 alone while the prefix
///   `monst` matches both.
/// * ch2 contains a *literal* `<script>` string and an ampersand, which is what makes
///   snippet HTML-escaping observable.
fn fixture() -> Connection {
    let conn = db();
    insert_hit(
        &conn,
        "u1",
        0,
        Some("Chapter One"),
        "the monster of frankenstein rose from the slab and the monster stirred again",
    );
    insert_hit(
        &conn,
        "u1",
        1,
        Some("Chapter Two"),
        "the creature watched frankenstein with monstrous intent across the frozen wastes",
    );
    insert_hit(
        &conn,
        "u1",
        2,
        Some("Chapter Three"),
        "the page contained the literal string <script>alert(1)</script> & nothing else",
    );
    // A chapter with no title must still be searchable and map to "".
    insert_hit(
        &conn,
        "u1",
        3,
        None,
        "an untitled chapter mentioning monster once",
    );
    insert_hit(
        &conn,
        "u2",
        0,
        Some("Other Book"),
        "the monster lives in another book entirely",
    );
    conn
}

/// Run a search, failing loudly on a SQL error (several tests assert "no error").
fn search(conn: &Connection, uid: &str, q: &str) -> Vec<vellum_lib::dto::SearchHit> {
    query::search(conn, uid, q, 100).expect("search must not error")
}

/// The safety invariant for §5.6, which renders snippets with `dangerouslySetInnerHTML`:
/// after removing our own `<mark>`/`</mark>` tags, no angle brackets or bare ampersands
/// may remain — everything else from the book text must be escaped.
///
/// Checking the residue rather than one exact escaped spelling keeps this valid however
/// SQLite places the marks (it can split an escaped entity in half, e.g.
/// `&lt;<mark>script</mark>&gt;`).
fn assert_snippet_safe(snippet: &str) {
    let stripped = snippet.replace("<mark>", "").replace("</mark>", "");
    assert!(
        !stripped.contains('<') && !stripped.contains('>'),
        "unescaped tag reached the frontend: {snippet:?}"
    );
    // Any remaining & must start one of the entities we produce.
    for rest in stripped.split('&').skip(1) {
        assert!(
            ["amp;", "lt;", "gt;", "quot;", "#39;"]
                .iter()
                .any(|e| rest.starts_with(e)),
            "unescaped ampersand in snippet: {snippet:?}"
        );
    }
}

// ---------------------------------------------------------------------------
// basic matching
// ---------------------------------------------------------------------------

#[test]
fn word_search_hits_and_snippet_is_marked() {
    let conn = fixture();
    let hits = search(&conn, "u1", "monster");
    // ch0 (twice), ch3 (once) — ch1 only has "monstrous", which is a different token.
    assert_eq!(hits.len(), 2, "expected ch0 + ch3, got {hits:?}");
    assert!(hits.iter().any(|h| h.chapter_idx == 0));
    assert!(hits.iter().any(|h| h.chapter_idx == 3));

    let ch0 = hits.iter().find(|h| h.chapter_idx == 0).unwrap();
    assert_eq!(ch0.chapter_title, "Chapter One");
    assert!(
        ch0.snippet.contains("<mark>monster</mark>"),
        "snippet: {:?}",
        ch0.snippet
    );
}

#[test]
fn prefix_search_matches_longer_words() {
    let conn = fixture();
    // §8: «frank» must hit «frankenstein».
    let hits = search(&conn, "u1", "frank");
    assert_eq!(
        hits.len(),
        2,
        "frank* should reach both frankenstein chapters: {hits:?}"
    );
    assert!(hits
        .iter()
        .all(|h| h.chapter_idx == 0 || h.chapter_idx == 1));
}

#[test]
fn porter_stemming_shares_a_prefix_but_not_an_exact_word() {
    let conn = fixture();
    // Both "monster" and "monstrous"→"monstr" start with "monst".
    assert_eq!(
        search(&conn, "u1", "monst").len(),
        3,
        "monst* covers ch0, ch1, ch3"
    );
    // The exact token only matches the chapter that really says "monster".
    assert_eq!(
        search(&conn, "u1", "monster").len(),
        2,
        "monster* excludes monstrous"
    );
}

#[test]
fn phrase_query_is_exact_and_ordered() {
    let conn = fixture();
    let hits = search(&conn, "u1", "\"monster of frankenstein\"");
    assert_eq!(
        hits.len(),
        1,
        "adjacent phrase must match ch0 only: {hits:?}"
    );
    assert_eq!(hits[0].chapter_idx, 0);

    // Reversing the phrase must not match: phrase search is positional.
    assert!(search(&conn, "u1", "\"frankenstein of monster\"").is_empty());
    // A partial adjacent phrase still matches.
    assert_eq!(search(&conn, "u1", "\"of frankenstein\"").len(), 1);
}

#[test]
fn multiword_query_uses_and_semantics() {
    let conn = fixture();
    // Both words occur only in ch0.
    let hits = search(&conn, "u1", "monster frankenstein");
    assert_eq!(hits.len(), 1, "AND must require every word: {hits:?}");
    assert_eq!(hits[0].chapter_idx, 0);

    // AND is order-independent.
    assert_eq!(search(&conn, "u1", "frankenstein monster").len(), 1);
    // A word that appears nowhere kills the whole query.
    assert!(search(&conn, "u1", "monster walrus").is_empty());
}

#[test]
fn no_match_returns_empty_not_an_error() {
    let conn = fixture();
    assert!(search(&conn, "u1", "zzzqqq").is_empty());
    assert!(search(&conn, "u1", "the quick brown fox").is_empty());
}

// ---------------------------------------------------------------------------
// book filter (§4.4: book_uid is UNINDEXED, filtered by equality not MATCH)
// ---------------------------------------------------------------------------

#[test]
fn results_are_restricted_to_the_requested_book() {
    let conn = fixture();
    let u1 = search(&conn, "u1", "monster");
    let u2 = search(&conn, "u2", "monster");

    assert!(
        !u1.is_empty() && !u2.is_empty(),
        "both books contain 'monster'"
    );
    assert_eq!(u2.len(), 1);
    assert_eq!(u2[0].chapter_title, "Other Book");

    // The u2 row must never leak into u1 results (same token, different book).
    assert!(u1.iter().all(|h| h.chapter_title != "Other Book"));

    // An unknown uid matches nothing rather than everything.
    assert!(search(&conn, "nosuchbook", "monster").is_empty());
}

// ---------------------------------------------------------------------------
// snippet safety (§5.6 renders snippets with dangerouslySetInnerHTML)
// ---------------------------------------------------------------------------

#[test]
fn snippet_escapes_html_but_keeps_our_marks() {
    let conn = fixture();
    let hits = search(&conn, "u1", "script");
    assert_eq!(
        hits.len(),
        1,
        "literal <script> text is searchable: {hits:?}"
    );

    let snippet = &hits[0].snippet;
    // SQLite's snippet() returns raw stored text; our post-pass must escape it.
    assert!(
        !snippet.contains("<script>"),
        "raw tag leaked into snippet: {snippet}"
    );
    assert!(
        snippet.contains("&lt;"),
        "angle bracket not escaped: {snippet}"
    );
    assert!(
        snippet.contains("&amp;"),
        "ampersand not escaped: {snippet}"
    );
    // Our own markers survive so the UI can highlight.
    assert!(
        snippet.contains("<mark>script</mark>"),
        "marks lost: {snippet}"
    );
    // Note SQLite puts the mark *inside* the escaped angle brackets, so the result is
    // "&lt;<mark>script</mark>&gt;" rather than an intact "&lt;script&gt;". Check the
    // invariant instead of one exact spelling.
    assert_snippet_safe(snippet);
    assert!(
        !snippet.contains("<mark>alert"),
        "only the matched term is marked: {snippet}"
    );
}

#[test]
fn snippet_marks_are_balanced_for_every_hit() {
    let conn = fixture();
    for q in ["monster", "frank", "monst", "\"of frankenstein\"", "script"] {
        for hit in search(&conn, "u1", q) {
            let opens = hit.snippet.matches("<mark>").count();
            let closes = hit.snippet.matches("</mark>").count();
            assert_eq!(opens, closes, "unbalanced marks for {q:?}: {}", hit.snippet);
            assert!(opens > 0, "no marks for {q:?}: {}", hit.snippet);
            assert_snippet_safe(&hit.snippet);
        }
    }
}

#[test]
fn missing_chapter_title_becomes_empty_string() {
    let conn = fixture();
    let hits = search(&conn, "u1", "untitled");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].chapter_title, "", "NULL title must map to \"\"");
    assert_eq!(hits[0].chapter_idx, 3);
}

// ---------------------------------------------------------------------------
// empty / hostile input (must never reach SQLite as FTS5 syntax)
// ---------------------------------------------------------------------------

#[test]
fn empty_query_returns_empty_without_touching_the_db() {
    let conn = fixture();
    for q in ["", "   ", "\t", "\n", " \u{a0} "] {
        assert!(
            query::search(&conn, "u1", q, 100)
                .expect("no error")
                .is_empty(),
            "query {q:?}"
        );
    }
}

#[test]
fn fts_special_characters_never_cause_a_sql_error() {
    let conn = fixture();
    // Every one of these would be an FTS5 syntax error if passed through verbatim.
    let hostile = [
        "\"",
        "*",
        "***",
        "(",
        ")",
        "()",
        "NEAR",
        "NEAR(a b)",
        "a:b",
        "-x",
        "^y",
        "{",
        "}",
        "\"unterminated",
        "monster\"",
        "\"\"",
        "::",
        "AND",
        "OR",
        "NOT",
        "monster AND",
        "\"monster",
        "col:umn",
        "bo~olean",
        "mon*ster",
        "don't",
        "well-known",
        "@#$%",
    ];
    for q in hostile {
        let r = query::search(&conn, "u1", q, 100);
        assert!(r.is_ok(), "query {q:?} produced a SQL error: {:?}", r.err());
    }
}

#[test]
fn hostile_queries_return_sane_results() {
    let conn = fixture();
    // Punctuation-only input has nothing to search for.
    for q in ["***", "()", "\"\"", "{", "}", "::", "@#$%"] {
        assert!(
            query::search(&conn, "u1", q, 100).expect("ok").is_empty(),
            "query {q:?}"
        );
    }
    // Operators are treated as ordinary words, so they simply match nothing here.
    assert!(search(&conn, "u1", "NEAR").is_empty());
    // Leading/trailing punctuation is stripped and the word still matches.
    assert_eq!(search(&conn, "u1", "-monster").len(), 2);
    assert_eq!(search(&conn, "u1", "(monster)").len(), 2);
    assert_eq!(search(&conn, "u1", "monster!").len(), 2);
    // Apostrophes/hyphens split like unicode61 does, so both halves must be present.
    assert!(search(&conn, "u1", "don't").is_empty());
}

#[test]
fn cyrillic_queries_work() {
    let conn = db();
    insert_hit(&conn, "ru", 0, Some("Tom 1"), "война и мир том первый");
    insert_hit(&conn, "ru", 1, Some("Tom 2"), "мир и покой");
    assert_eq!(search(&conn, "ru", "война").len(), 1);
    assert_eq!(search(&conn, "ru", "война мир").len(), 1);
    assert_eq!(
        search(&conn, "ru", "мир война").len(),
        1,
        "AND is order-independent"
    );
    assert_eq!(search(&conn, "ru", "мир").len(), 2);
    assert_eq!(search(&conn, "ru", "\"война и мир\"").len(), 1, "phrase");
    assert_eq!(search(&conn, "ru", "во").len(), 1, "prefix");
}

// ---------------------------------------------------------------------------
// limit + ranking
// ---------------------------------------------------------------------------

#[test]
fn limit_is_honored() {
    let conn = db();
    for i in 0..25 {
        insert_hit(
            &conn,
            "u1",
            i,
            Some(&format!("Ch {i}")),
            "monster everywhere",
        );
    }
    assert_eq!(
        search(&conn, "u1", "monster").len(),
        25,
        "all rows under the default"
    );
    assert_eq!(
        query::search(&conn, "u1", "monster", 3).expect("ok").len(),
        3
    );
    assert_eq!(
        query::search(&conn, "u1", "monster", 1).expect("ok").len(),
        1
    );
}

#[test]
fn non_positive_limit_falls_back_to_the_default_and_never_means_unlimited() {
    let conn = db();
    for i in 0..150 {
        insert_hit(
            &conn,
            "u1",
            i,
            Some(&format!("Ch {i}")),
            "monster everywhere",
        );
    }
    // SQLite's LIMIT -1 means "no limit"; 0 must not mean that either.
    assert_eq!(
        query::search(&conn, "u1", "monster", -1).expect("ok").len(),
        query::DEFAULT_LIMIT as usize
    );
    assert_eq!(
        query::search(&conn, "u1", "monster", 0).expect("ok").len(),
        query::DEFAULT_LIMIT as usize
    );
}

#[test]
fn limit_is_capped_at_max() {
    let conn = db();
    for i in 0..600 {
        insert_hit(
            &conn,
            "u1",
            i,
            Some(&format!("Ch {i}")),
            "monster everywhere",
        );
    }
    assert_eq!(
        query::search(&conn, "u1", "monster", 5000)
            .expect("ok")
            .len(),
        query::MAX_LIMIT as usize
    );
    // Exactly at the cap is allowed through unchanged.
    assert_eq!(
        query::search(&conn, "u1", "monster", query::MAX_LIMIT)
            .expect("ok")
            .len(),
        query::MAX_LIMIT as usize
    );
}

#[test]
fn score_is_positive_and_results_come_best_first() {
    let conn = db();
    // ch0 mentions the term far more often, so bm25 should rank it first.
    insert_hit(
        &conn,
        "u1",
        0,
        Some("Dense"),
        "monster monster monster monster monster monster monster monster",
    );
    insert_hit(
        &conn,
        "u1",
        1,
        Some("Sparse"),
        "one monster among many other unrelated words here",
    );

    let hits = search(&conn, "u1", "monster");
    assert_eq!(hits.len(), 2);
    // score = -bm25: positive, higher is better.
    assert!(
        hits.iter().all(|h| h.score > 0.0),
        "scores: {:?}",
        hits.iter().map(|h| h.score).collect::<Vec<_>>()
    );
    assert_eq!(hits[0].chapter_idx, 0, "best match first");
    assert!(
        hits[0].score >= hits[1].score,
        "scores not descending: {hits:?}"
    );
}

// ---------------------------------------------------------------------------
// sanitization contract (pure function, no DB)
// ---------------------------------------------------------------------------

#[test]
fn sanitize_query_shapes() {
    use query::sanitize_query as s;
    assert_eq!(s(""), "");
    assert_eq!(s("   "), "");
    assert_eq!(s("monster"), "\"monster\"*");
    assert_eq!(s("  monster  "), "\"monster\"*");
    assert_eq!(s("quick monster"), "\"quick\"* AND \"monster\"*");
    assert_eq!(s("\"the quick\""), "\"the quick\"");
    // Internal quotes are doubled — FTS5's own literal escape.
    assert_eq!(s("\"say \"hi\" now\""), "\"say \"\"hi\"\" now\"");
    // A lone quote is not a phrase and leaves no searchable term.
    assert_eq!(s("\""), "");
    assert_eq!(s("***"), "");
    assert_eq!(s("(monster)"), "\"monster\"*");
    // Operators become inert literals, never bare FTS5 keywords.
    assert_eq!(s("NEAR"), "\"NEAR\"*");
    assert!(
        !s("NEAR(a b)").contains('('),
        "bare paren leaked: {}",
        s("NEAR(a b)")
    );
    // Punctuation splits, matching how unicode61 tokenized the index.
    assert_eq!(s("don't"), "\"don\"* AND \"t\"*");
    assert_eq!(s("well-known"), "\"well\"* AND \"known\"*");
    assert_eq!(s("mon*ster"), "\"mon\"* AND \"ster\"*");
    // Case is preserved (FTS5 folds it); long Cyrillic tokens are stem-truncated so an
    // inflected dictionary form matches («война» → «войн»* also covers войну/войны).
    // Short Cyrillic tokens keep their full prefix form.
    assert_eq!(s("война мир"), "\"войн\"* AND \"мир\"*");
}

#[test]
fn sanitized_output_never_contains_bare_operators() {
    use query::sanitize_query as s;
    // Outside of quoted literals these would change FTS5's parse of the query.
    for q in [
        "a AND b",
        "a OR b",
        "a NOT b",
        "NEAR(a b)",
        "col:term",
        "(a b)",
        "a^2",
        "a-b",
        "monster NEAR/3 frankenstein",
        "{a b}",
        "a*",
        "\"a\" OR \"b\"",
        "\"a AND b\"",
    ] {
        assert_bare_syntax_inert(&s(q), q);
    }
}

/// Structural check: scanning a sanitized query, the only characters allowed *outside* a
/// quoted literal are our own `AND` separator, the prefix `*`, and spaces.
///
/// That is what makes user text inert — a bare `OR` would be a real OR to FTS5, whereas
/// `"OR"*` is just a word to look for. Checking the structure rather than searching for
/// the letters is what keeps this valid when the user legitimately types "OR".
fn assert_bare_syntax_inert(sanitized: &str, input: &str) {
    if sanitized.is_empty() {
        return;
    }
    let mut chars = sanitized.chars().peekable();
    let mut in_literal = false;

    while let Some(c) = chars.next() {
        if c == '"' {
            // `""` inside a literal is FTS5's escaped quote, not a literal boundary, so
            // user-typed quotes can never terminate the literal early and reopen the grammar.
            if in_literal && chars.peek() == Some(&'"') {
                chars.next();
                continue;
            }
            in_literal = !in_literal;
            continue;
        }
        if in_literal {
            continue;
        }
        match c {
            // The prefix operator we append ourselves.
            '*' | ' ' => {}
            'A' => {
                let word: String = std::iter::once('A').chain(chars.by_ref().take(2)).collect();
                assert_eq!(
                    word, "AND",
                    "bare token {word:?} for input {input:?}: {sanitized:?}"
                );
            }
            other => panic!("bare {other:?} outside a literal for input {input:?}: {sanitized:?}"),
        }
    }
    assert!(
        !in_literal,
        "unterminated literal for input {input:?}: {sanitized:?}"
    );
}
