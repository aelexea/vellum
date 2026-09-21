//! Background FTS5 build + progress events (§4.5) — owned by B5.
//!
//! Runs in `spawn_blocking` with its **own** rusqlite connection (WAL lets the reader
//! keep writing while we index); emits `index-progress {bookUid,done,total}` every ~10
//! chapters, then `index-done` / `index-error`. One task per book via [`IN_FLIGHT`].
//!
//! ## Testability seam
//! [`index_book_with`] takes the two epub-side operations as callbacks (read a zip entry,
//! extract its text) instead of calling `crate::epub` directly. Production passes
//! [`crate::epub::zip_entry_bytes`] / [`crate::epub::extract_text`] — B1 stays the single
//! source of truth for text extraction; tests pass a local mirror so the transaction,
//! progress, idempotency and error machinery are verifiable independently of B1.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::LazyLock;

use dashmap::DashMap;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Books with a running index task. Claimed *before* the spawn so two rapid callers
/// (double-click, `open_book` + explicit reindex) can never double-index a book.
static IN_FLIGHT: LazyLock<DashMap<String, ()>> = LazyLock::new(DashMap::new);

/// Live `(done, total)` per book being indexed, for `get_index_status` (§4.8).
static PROGRESS: LazyLock<DashMap<String, (i64, i64)>> = LazyLock::new(DashMap::new);

/// Number of index tasks claimed since process start. Test hook for the one-task-per-book
/// guarantee; never read by production code.
static SPAWN_COUNT: AtomicUsize = AtomicUsize::new(0);

/// Emit `index-progress` at least every this many chapters (§4.5).
const PROGRESS_EVERY: i64 = 10;

/// Reads one zip entry. Production: [`crate::epub::zip_entry_bytes`].
pub type ReadEntry<'a> = &'a (dyn Fn(&str, &str) -> anyhow::Result<Vec<u8>> + Sync);
/// Extracts plain text from chapter XHTML. Production: [`crate::epub::extract_text`].
pub type ExtractText<'a> = &'a (dyn Fn(&[u8]) -> String + Sync);
/// Progress callback `(done, total)`. Production: emits the Tauri event.
pub type OnProgress<'a> = &'a (dyn Fn(i64, i64) + Sync);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload<'a> {
    book_uid: &'a str,
    done: i64,
    total: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BookPayload<'a> {
    book_uid: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload<'a> {
    book_uid: &'a str,
    message: &'a str,
}

/// A spine chapter scheduled for indexing.
struct ChapterPlan {
    idx: i64,
    href: String,
    title: String,
}

/// Releases the claim on drop — including on panic — so a crashed task can never wedge a
/// book at `indexed = 1` for the rest of the session.
struct FlightGuard(String);

impl Drop for FlightGuard {
    fn drop(&mut self) {
        IN_FLIGHT.remove(&self.0);
        PROGRESS.remove(&self.0);
    }
}

// ---------------------------------------------------------------------------
// Public entry points (spawned paths)
// ---------------------------------------------------------------------------

/// Auto-index hook (§4.5), called by B3's `open_book`. Reads `books.indexed` under a short
/// db lock and spawns a task only when the book was never indexed (`0`).
///
/// `1` (indexing) → no-op, the in-flight task owns it. `2` (ready) and `-1` (error) →
/// no-op; recovering from an error needs the explicit `force` path.
///
/// Non-async, returns immediately: the work runs on a blocking thread.
pub fn maybe_reindex(app: &AppHandle, book_uid: &str) {
    let Some((db_path, indexed)) = db_path_and_indexed(app, book_uid) else {
        return; // unknown book or poisoned db lock — nothing to do
    };
    if !should_auto_index(indexed) {
        return;
    }
    claim_and_spawn(Some(app.clone()), db_path, book_uid);
}

/// Explicit (re)index (§4.8 `reindex_book`). `force` rebuilds even when `indexed == 2`;
/// without it only `indexed == 0` triggers work.
pub fn reindex_book(app: &AppHandle, uid: &str, force: bool) {
    let Some((db_path, indexed)) = db_path_and_indexed(app, uid) else {
        return;
    };
    if !should_reindex(indexed, force) {
        return;
    }
    claim_and_spawn(Some(app.clone()), db_path, uid);
}

/// Is an index task running for `uid`?
pub fn in_flight(uid: &str) -> bool {
    IN_FLIGHT.contains_key(uid)
}

/// Live `(done, total)` for a book currently indexing, if any.
pub fn progress(uid: &str) -> Option<(i64, i64)> {
    PROGRESS.get(uid).map(|v| *v.value())
}

/// Test hook: how many index tasks have been claimed so far.
#[doc(hidden)]
pub fn spawn_count() -> usize {
    SPAWN_COUNT.load(Ordering::SeqCst)
}

// ---------------------------------------------------------------------------
// Public entry points (synchronous paths — tests and headless use)
// ---------------------------------------------------------------------------

/// Index one book synchronously on the calling thread, opening its own connection and
/// using the production epub callbacks. Same work and same `indexed` transitions as the
/// spawned path, but deterministic: returns when the index is complete.
pub fn index_book(db_path: &Path, uid: &str) -> anyhow::Result<()> {
    let conn = open_index_conn(db_path)?;
    let read_entry: ReadEntry<'_> = &|path, entry| crate::epub::zip_entry_bytes(path, entry);
    let extract: ExtractText<'_> = &|html| crate::epub::extract_text(html);
    index_book_with(&conn, uid, read_entry, extract, None)
}

/// The whole indexing job for one book, with the epub operations injected.
///
/// Sets `indexed = 1`, purges this book's old rows, inserts every spine chapter inside a
/// single transaction, then sets `indexed = 2` (or `-1` with `Err`). Idempotent: running
/// it twice yields the same rows.
///
/// Panics are caught and reported as `Err` with `indexed = -1`. That matters because
/// [`maybe_reindex`] reads `indexed = 1` as "a task owns this book": a panic that escaped
/// would wedge the book in the indexing state until the app restarts, with no way to
/// retry from the UI.
pub fn index_book_with(
    conn: &Connection,
    uid: &str,
    read_entry: ReadEntry<'_>,
    extract: ExtractText<'_>,
    on_progress: Option<OnProgress<'_>>,
) -> anyhow::Result<()> {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        index_body(conn, uid, read_entry, extract, on_progress)
    }));

    let result = match outcome {
        Ok(inner) => inner,
        Err(_) => Err(anyhow::anyhow!("index task panicked for {uid}")),
    };

    if let Err(e) = result {
        // Any failure leaves a retryable state so the UI can offer "Build index".
        let _ = set_indexed(conn, uid, -1);
        return Err(e);
    }
    // If marking it ready fails, fall back to the error state: leaving `indexed = 1`
    // would look like a live task to `maybe_reindex` and wedge the book.
    if let Err(e) = set_indexed(conn, uid, 2) {
        let _ = set_indexed(conn, uid, -1);
        return Err(e);
    }
    Ok(())
}

/// Open a second connection with the same pragmas as `db::open` (§4.4).
pub fn open_index_conn(db_path: &Path) -> anyhow::Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/// `indexed` value + db path, under one short lock (§11.3: never held across the spawn).
fn db_path_and_indexed(app: &AppHandle, uid: &str) -> Option<(PathBuf, i64)> {
    let state = app.state::<crate::state::AppState>();
    let db_path = state.paths.db_path.clone();
    let conn = state.db.lock().ok()?;
    let indexed: i64 = conn
        .query_row("SELECT indexed FROM books WHERE uid = ?1", [uid], |r| {
            r.get(0)
        })
        // Missing row → error state, so we never index an unknown uid.
        .unwrap_or(-1);
    Some((db_path, indexed))
}

/// §4.5 gate for the auto-index path: only a never-indexed book is picked up.
///
/// `1` (indexing) is owned by a live task, `2` (ready) needs no work, and `-1` (error)
/// deliberately waits for an explicit `force` rebuild rather than retrying on every open.
pub fn should_auto_index(indexed: i64) -> bool {
    indexed == 0
}

/// §4.5 gate for the explicit command: `force` rebuilds whatever state we are in.
pub fn should_reindex(indexed: i64, force: bool) -> bool {
    indexed == 0 || force
}

/// Try to become the owner of an index task for `uid`. `false` means one is already
/// running, so the caller must not spawn a second (double-click protection).
///
/// Split out from [`claim_and_spawn`] because the guard is the part tests need to pin
/// down, and it does not need a Tauri app handle.
pub fn try_claim(uid: &str) -> bool {
    IN_FLIGHT.insert(uid.to_string(), ()).is_none()
}

/// Give up an index claim without spawning (used when a spawn fails, and by tests).
pub fn release(uid: &str) {
    IN_FLIGHT.remove(uid);
    PROGRESS.remove(uid);
}

/// Claim the book, then hand the blocking work to the async runtime.
fn claim_and_spawn(emitter: Option<AppHandle>, db_path: PathBuf, uid: &str) {
    // Claim before spawning: a `false` here means somebody beat us to it.
    if !try_claim(uid) {
        return;
    }
    SPAWN_COUNT.fetch_add(1, Ordering::SeqCst);

    let uid_owned = uid.to_string();
    // The claim is ours from here; if the spawn itself fails, give it back.
    if let Err(e) = spawn_task(emitter, db_path, uid_owned.clone()) {
        release(&uid_owned);
        SPAWN_COUNT.fetch_sub(1, Ordering::SeqCst);
        eprintln!("[vellum] index spawn failed for {uid_owned}: {e}");
    }
}

fn spawn_task(
    emitter: Option<AppHandle>,
    db_path: PathBuf,
    uid: String,
) -> Result<(), std::io::Error> {
    tauri::async_runtime::spawn_blocking(move || {
        // Held for the whole body; releases the claim on every exit path, panic included.
        let _guard = FlightGuard(uid.clone());
        index_task_body(&emitter, &db_path, &uid);
    });
    Ok(())
}

/// Body of the blocking task: index the book and emit the matching event.
fn index_task_body(emitter: &Option<AppHandle>, db_path: &Path, uid: &str) {
    let read_entry: ReadEntry<'_> = &|path, entry| crate::epub::zip_entry_bytes(path, entry);
    let extract: ExtractText<'_> = &|html| crate::epub::extract_text(html);

    // Emit index-progress from inside the loop when there is a live AppHandle to emit to.
    let emit_progress = |done: i64, total: i64| {
        if let Some(app) = emitter {
            let _ = app.emit(
                "index-progress",
                ProgressPayload {
                    book_uid: uid,
                    done,
                    total,
                },
            );
        }
    };

    let result = open_index_conn(db_path).and_then(|conn| {
        index_book_with(
            &conn,
            uid,
            read_entry,
            extract,
            // Only wire the callback when events can actually go somewhere.
            emitter
                .as_ref()
                .map(|_| &emit_progress as &(dyn Fn(i64, i64) + Sync)),
        )
    });

    match result {
        Ok(()) => {
            if let Some(app) = emitter {
                let _ = app.emit("index-done", BookPayload { book_uid: uid });
            }
        }
        Err(e) => {
            let message = format!("{e:#}");
            eprintln!("[vellum] index failed for {uid}: {message}");
            if let Some(app) = emitter {
                let _ = app.emit(
                    "index-error",
                    ErrorPayload {
                        book_uid: uid,
                        message: &message,
                    },
                );
            }
        }
    }
}

/// Set `indexed`. Errors propagate so a failed transition surfaces as an index error.
fn set_indexed(conn: &Connection, uid: &str, value: i64) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE books SET indexed = ?1 WHERE uid = ?2",
        rusqlite::params![value, uid],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The indexing job
// ---------------------------------------------------------------------------

fn index_body(
    conn: &Connection,
    uid: &str,
    read_entry: ReadEntry<'_>,
    extract: ExtractText<'_>,
    on_progress: Option<OnProgress<'_>>,
) -> anyhow::Result<()> {
    // Own connection in the spawned case; WAL permits concurrent reader writes (§11.3).
    set_indexed(conn, uid, 1)?;

    let book_path: String =
        conn.query_row("SELECT path FROM books WHERE uid = ?1", [uid], |r| r.get(0))?;
    let chapters = chapter_plan(conn, uid, &book_path)?;
    let total = chapters.len() as i64;
    PROGRESS.insert(uid.to_string(), (0, total));

    // One purge, one transaction for all inserts: an order of magnitude faster than
    // per-chapter commits, and the reader never sees a half-built index.
    conn.execute("DELETE FROM book_search WHERE book_uid = ?1", [uid])?;
    let tx = conn.unchecked_transaction()?;

    // Scoped block: the cached statements borrow `tx`, and `commit()` needs it back.
    {
        let mut ins = tx.prepare_cached(
            "INSERT INTO book_search(book_uid, chapter_idx, chapter_title, body) \
             VALUES (?1, ?2, ?3, ?4)",
        )?;
        let mut upd = tx.prepare_cached(
            "UPDATE chapters SET char_count = ?1 WHERE book_uid = ?2 AND idx = ?3",
        )?;

        let mut done: i64 = 0;
        let mut next_emit = PROGRESS_EVERY;
        for ch in &chapters {
            // A missing or corrupt entry must not sink the whole book: index an empty body
            // so the chapter still counts as done and the rest stays searchable.
            let body = match read_entry(&book_path, &ch.href) {
                Ok(bytes) => sanitize_for_fts(&extract(&bytes)),
                Err(e) => {
                    eprintln!(
                        "[vellum] index: skip {uid} ch{} ({}): {e:#}",
                        ch.idx, ch.href
                    );
                    String::new()
                }
            };
            let char_count = body.chars().count() as i64;

            ins.execute(rusqlite::params![uid, ch.idx, ch.title, body])?;
            // `chapters` rows are optional (toc-less imports), so ignore "no such row".
            let _ = upd.execute(rusqlite::params![char_count, uid, ch.idx]);

            done += 1;
            // Every ~10 chapters and always at the end (§4.5).
            if done >= next_emit || done == total {
                next_emit = done + PROGRESS_EVERY;
                report_progress(uid, done, total, on_progress);
            }
        }
    }

    tx.commit()?;
    Ok(())
}

/// Record progress for `get_index_status` and notify the caller (Tauri event in
/// production).
fn report_progress(uid: &str, done: i64, total: i64, on_progress: Option<OnProgress<'_>>) {
    PROGRESS.insert(uid.to_string(), (done, total));
    if let Some(cb) = on_progress {
        cb(done, total);
    }
}

/// Spine chapters to index: prefer the DB rows B3 wrote at import; fall back to parsing
/// the epub so indexing still works for books whose `chapters` rows are absent.
fn chapter_plan(conn: &Connection, uid: &str, book_path: &str) -> anyhow::Result<Vec<ChapterPlan>> {
    let mut stmt =
        conn.prepare("SELECT idx, href, title FROM chapters WHERE book_uid = ?1 ORDER BY idx")?;
    let rows = stmt
        .query_map([uid], |r| {
            Ok(ChapterPlan {
                idx: r.get(0)?,
                href: r.get::<_, String>(1)?,
                title: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if !rows.is_empty() {
        return Ok(rows);
    }

    let archive = crate::epub::open_book(book_path)?;
    Ok(archive
        .spine
        .iter()
        .enumerate()
        .map(|(i, item)| ChapterPlan {
            idx: i as i64,
            href: item.href.clone(),
            title: archive
                .toc
                .iter()
                .find(|t| t.chapter_idx == i as i64)
                .map(|t| t.title.clone())
                .unwrap_or_default(),
        })
        .collect())
}

/// Prepare extracted text for FTS storage: drop NULs and other control characters, and
/// collapse every whitespace run to a single space (keeps snippets one-line in the UI).
///
/// Values are always bound as parameters, so this is about index quality and snippet
/// shape, not injection safety.
pub fn sanitize_for_fts(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut pending_space = false;
    for c in text.chars() {
        if c == '\0' || (c.is_control() && !c.is_whitespace()) {
            continue;
        }
        if c.is_whitespace() {
            pending_space = true;
            continue;
        }
        // A leading run must not produce a leading space.
        if pending_space && !out.is_empty() {
            out.push(' ');
        }
        pending_space = false;
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_collapses_whitespace_and_drops_control_chars() {
        assert_eq!(sanitize_for_fts("a\n\n  b\tc"), "a b c");
        assert_eq!(
            sanitize_for_fts("  leading and trailing  "),
            "leading and trailing"
        );
        assert_eq!(sanitize_for_fts("nul\0here"), "nulhere");
        assert_eq!(sanitize_for_fts("bell\u{7}x"), "bellx");
        assert_eq!(sanitize_for_fts(""), "");
        // Cyrillic and marks survive untouched.
        assert_eq!(sanitize_for_fts("Война  и мир\u{a0}!"), "Война и мир !");
    }

    #[test]
    fn sanitize_keeps_fts_meaningful_punctuation() {
        // Quotes/asterisks stay in the *stored* body — only queries are sanitized.
        assert_eq!(
            sanitize_for_fts("he said \"stop\" * loudly"),
            "he said \"stop\" * loudly"
        );
    }
}
