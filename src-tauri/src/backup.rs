//! DB/settings/annotation backup + import (§4.7) — owned by B8.
//!
//! Everything here is plain file/SQL work on a borrowed `AppPaths` or `Connection` so it can
//! be unit-tested without a running Tauri app (§8). The `AppState`-taking wrappers exist for
//! the §4.8 commands.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::AppPaths;
use crate::dto::{Bookmark, Highlight, Note};
use crate::settings::{self, Settings};
use crate::state::AppState;

/// Auto-backup filename prefix/suffix: `vellum-<yyyymmdd>.db`.
const BACKUP_PREFIX: &str = "vellum-";
const BACKUP_SUFFIX: &str = ".db";
/// How many dated backups to keep (§4.7).
const KEEP_BACKUPS: usize = 5;
/// Re-run the auto-backup only when the newest one is older than this (§4.7).
const BACKUP_INTERVAL_DAYS: i64 = 7;

// ---------------------------------------------------------------------------
// DB snapshots
// ---------------------------------------------------------------------------

/// `VACUUM INTO ?path` snapshot of the live database (§4.7).
pub fn backup_db(state: &AppState, path: &str) -> anyhow::Result<()> {
    let conn = state
        .db
        .lock()
        .map_err(|_| anyhow::anyhow!("database is locked"))?;
    backup_db_conn(&conn, Path::new(path))
}

/// `VACUUM INTO ?1` against a borrowed connection.
///
/// `VACUUM INTO` refuses to overwrite an existing file, so `dest` is removed first. The
/// result is a fully compacted, standalone (non-WAL) copy that opens like a normal db.
pub fn backup_db_conn(conn: &Connection, dest: &Path) -> anyhow::Result<()> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    if dest.exists() {
        std::fs::remove_file(dest)?;
    }
    let dest_str = dest.to_string_lossy();
    conn.execute("VACUUM INTO ?1", params![dest_str])?;
    Ok(())
}

/// Startup auto-backup (§4.7), safe to call from `spawn_blocking`:
///
/// 1. find the newest `vellum-*.db` in `backups_dir` (newest by the date in its name);
/// 2. if there is none, or it is older than [`BACKUP_INTERVAL_DAYS`] days, write
///    `vellum-<yyyymmdd>.db` via `VACUUM INTO`;
/// 3. prune: keep the newest [`KEEP_BACKUPS`], delete older ones (only files whose name
///    matches `vellum-<8 digits>.db` exactly — anything else in the dir is left alone).
///
/// A second call on the same day is a no-op (today's file is 0 days old).
pub fn auto_backup(paths: &AppPaths) -> anyhow::Result<()> {
    std::fs::create_dir_all(&paths.backups_dir)?;

    let mut existing = list_backups(&paths.backups_dir)?;
    existing.sort_by_key(|b| std::cmp::Reverse(b.date_days)); // newest first

    let today_days = today_days();
    let needs_backup = match existing.first() {
        None => true,
        Some(newest) => today_days - newest.date_days >= BACKUP_INTERVAL_DAYS,
    };

    // Nothing to snapshot before the db exists (first launch), but still prune leftovers.
    if needs_backup && paths.db_path.exists() {
        let dest = paths.backups_dir.join(format!(
            "{BACKUP_PREFIX}{}.db",
            yyyymmdd_from_days(today_days)
        ));
        // Same-day file already there → VACUUM INTO would just rewrite it; skip.
        if !dest.exists() {
            let conn = Connection::open(&paths.db_path)?;
            conn.busy_timeout(std::time::Duration::from_secs(5))?;
            backup_db_conn(&conn, &dest)?;
            existing.push(BackupFile {
                path: dest.clone(),
                date_days: today_days,
            });
            existing.sort_by_key(|b| std::cmp::Reverse(b.date_days));
        }
    }

    for stale in existing.iter().skip(KEEP_BACKUPS) {
        if let Err(e) = std::fs::remove_file(&stale.path) {
            eprintln!(
                "[vellum] backup: cannot prune {}: {e}",
                stale.path.display()
            );
        }
    }
    Ok(())
}

/// Name-compatible alias for the frozen `lib.rs` call site (scaffold deviation #5): if that
/// call is ever repointed into this module, this is the symbol it lands on.
pub fn auto_backup_stub(paths: &AppPaths) -> anyhow::Result<()> {
    auto_backup(paths)
}

/// Spawn [`auto_backup`] off the UI thread at startup (§4.9).
pub fn spawn_auto_backup(state: &AppState) {
    spawn_auto_backup_paths(state.paths.clone());
}

/// [`spawn_auto_backup`] taking the paths directly, for call sites that only have an
/// `AppPaths` (e.g. the frozen lib.rs setup spawn).
pub fn spawn_auto_backup_paths(paths: AppPaths) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = auto_backup(&paths) {
            eprintln!("[vellum] auto-backup skipped: {e}");
        }
    });
}

/// A `vellum-<yyyymmdd>.db` file in `backups_dir`, with its date as days since the epoch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupFile {
    pub path: PathBuf,
    pub date_days: i64,
}

/// Enumerate the backups in `dir`, ignoring anything that is not exactly
/// `vellum-<8 digits>.db` (so a user's own files in that dir are never touched).
pub fn list_backups(dir: &Path) -> anyhow::Result<Vec<BackupFile>> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(stem) = name
            .strip_prefix(BACKUP_PREFIX)
            .and_then(|n| n.strip_suffix(BACKUP_SUFFIX))
        else {
            continue;
        };
        if stem.len() != 8 || !stem.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let Some(date_days) = days_from_yyyymmdd(stem) else {
            continue;
        };
        out.push(BackupFile {
            path: entry.path(),
            date_days,
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Date helpers (no chrono — §11.3)
// ---------------------------------------------------------------------------

/// Today as days since 1970-01-01 (UTC, matching `db::today_str`).
fn today_days() -> i64 {
    crate::db::now_ms().div_euclid(86_400_000)
}

/// `yyyymmdd` → days since the epoch (Howard Hinnant's `days_from_civil`).
fn days_from_yyyymmdd(s: &str) -> Option<i64> {
    if s.len() != 8 {
        return None;
    }
    let y: i64 = s[0..4].parse().ok()?;
    let m: i64 = s[4..6].parse().ok()?;
    let d: i64 = s[6..8].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    Some(era * 146_097 + doe - 719_468)
}

/// Days since the epoch → `yyyymmdd` (Howard Hinnant's `civil_from_days`, no chrono).
fn yyyymmdd_from_days(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], Mar=0
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = y + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}")
}

// ---------------------------------------------------------------------------
// Settings export / import
// ---------------------------------------------------------------------------

/// Export the current settings to `dest`: copy `settings.json` if present, otherwise write
/// the §6.6 defaults. Always atomic (tmp + rename).
pub fn export_settings(paths: &AppPaths, dest: &str) -> anyhow::Result<()> {
    let src = settings::path(paths);
    let bytes = if src.exists() {
        std::fs::read(&src)?
    } else {
        serde_json::to_string_pretty(&Settings::default())?.into_bytes()
    };
    write_atomic(Path::new(dest), &bytes)
}

/// Import settings from `src`: parse (merging over the defaults so a partial file works),
/// persist as the live settings, and return the result (§4.8 `import_settings`).
pub fn import_settings(paths: &AppPaths, src: &str) -> anyhow::Result<Settings> {
    let raw = std::fs::read(src)?;
    let value: serde_json::Value = serde_json::from_slice(&raw)
        .map_err(|e| anyhow::anyhow!("settings file is corrupted: {e}"))?;
    let imported = settings::settings_from_value(value)?;
    settings::save(paths, &imported)?;
    Ok(imported)
}

/// Write `bytes` to `dest` via tmp + rename.
fn write_atomic(dest: &Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let tmp = dest.with_extension(format!(
        "{}.tmp",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("part")
    ));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Annotation export / import
// ---------------------------------------------------------------------------

/// JSON envelope for an annotation export (§4.7). Every section is optional on import so a
/// hand-trimmed or older file still loads.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationsExport {
    pub version: u32,
    pub exported_at: i64,
    #[serde(default)]
    pub highlights: Vec<Highlight>,
    #[serde(default)]
    pub notes: Vec<Note>,
    #[serde(default)]
    pub bookmarks: Vec<Bookmark>,
}

/// Export annotations (highlights/notes/bookmarks) as `json` or `md`. Returns row count.
/// `uid = None` exports every book.
pub fn export_annotations(
    state: &AppState,
    uid: Option<&str>,
    path: &str,
    format: &str,
) -> anyhow::Result<usize> {
    let conn = state
        .db
        .lock()
        .map_err(|_| anyhow::anyhow!("database is locked"))?;
    export_annotations_conn(&conn, uid, path, format)
}

/// [`export_annotations`] against a borrowed connection.
pub fn export_annotations_conn(
    conn: &Connection,
    uid: Option<&str>,
    path: &str,
    format: &str,
) -> anyhow::Result<usize> {
    let highlights = read_highlights(conn, uid)?;
    let notes = read_notes(conn, uid)?;
    let bookmarks = read_bookmarks(conn, uid)?;
    let count = highlights.len() + notes.len() + bookmarks.len();

    let bytes = match format {
        "json" => {
            let export = AnnotationsExport {
                version: 1,
                exported_at: crate::db::now_ms(),
                highlights,
                notes,
                bookmarks,
            };
            serde_json::to_string_pretty(&export)?.into_bytes()
        }
        "md" | "markdown" => {
            render_markdown(conn, uid, &highlights, &notes, &bookmarks)?.into_bytes()
        }
        other => anyhow::bail!("unknown export format: {other}"),
    };

    write_atomic(Path::new(path), &bytes)?;
    Ok(count)
}

/// Import annotations from a json export, upserting by natural keys (§4.7).
/// Returns the number of rows written (inserted + updated); duplicates are skipped.
pub fn import_annotations(state: &AppState, path: &str) -> anyhow::Result<usize> {
    let conn = state
        .db
        .lock()
        .map_err(|_| anyhow::anyhow!("database is locked"))?;
    import_annotations_conn(&conn, path)
}

/// [`import_annotations`] against a borrowed connection.
///
/// Natural keys: highlights `(book_uid, chapter_idx, cfi_start, cfi_end)` — duplicates are
/// skipped; notes the same key — an incoming row wins only when its `updated_at` is newer;
/// bookmarks `(book_uid, cfi)` — duplicates are skipped. Notes go first so that the derived
/// `has_note` flag on re-exported highlights is already correct.
pub fn import_annotations_conn(conn: &Connection, path: &str) -> anyhow::Result<usize> {
    let raw = std::fs::read(path)?;
    let export: AnnotationsExport = serde_json::from_slice(&raw)
        .map_err(|e| anyhow::anyhow!("export file is corrupted: {e}"))?;

    let tx = conn.unchecked_transaction()?;
    let mut written = 0usize;

    for n in &export.notes {
        let existing: Option<(i64, i64)> = tx
            .query_row(
                "SELECT id, updated_at FROM notes
                  WHERE book_uid=?1 AND chapter_idx=?2 AND cfi_start=?3 AND cfi_end=?4",
                params![n.book_uid, n.chapter_idx, n.cfi_start, n.cfi_end],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match existing {
            None => {
                tx.execute(
                    "INSERT INTO notes(book_uid, chapter_idx, cfi_start, cfi_end,
                                       selected_text, note_text, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![
                        n.book_uid,
                        n.chapter_idx,
                        n.cfi_start,
                        n.cfi_end,
                        n.selected_text,
                        n.note_text,
                        n.created_at,
                        n.updated_at
                    ],
                )?;
                written += 1;
            }
            Some((_id, updated_at)) if n.updated_at > updated_at => {
                tx.execute(
                    "UPDATE notes SET selected_text=?1, note_text=?2, updated_at=?3
                      WHERE book_uid=?4 AND chapter_idx=?5 AND cfi_start=?6 AND cfi_end=?7",
                    params![
                        n.selected_text,
                        n.note_text,
                        n.updated_at,
                        n.book_uid,
                        n.chapter_idx,
                        n.cfi_start,
                        n.cfi_end
                    ],
                )?;
                written += 1;
            }
            // incoming row is not newer → keep what we have
            Some(_) => {}
        }
    }

    for h in &export.highlights {
        let dup: Option<i64> = tx
            .query_row(
                "SELECT id FROM highlights
                  WHERE book_uid=?1 AND chapter_idx=?2 AND cfi_start=?3 AND cfi_end=?4",
                params![h.book_uid, h.chapter_idx, h.cfi_start, h.cfi_end],
                |row| row.get(0),
            )
            .optional()?;
        if dup.is_some() {
            continue;
        }
        // `has_note` is derived on read (see HL_SELECT), so the highlight row needs no flag.
        tx.execute(
            "INSERT INTO highlights(book_uid, chapter_idx, cfi_start, cfi_end, color, text,
                                    created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![
                h.book_uid,
                h.chapter_idx,
                h.cfi_start,
                h.cfi_end,
                h.color,
                h.text,
                h.created_at
            ],
        )?;
        written += 1;
    }

    for b in &export.bookmarks {
        let dup: Option<i64> = tx
            .query_row(
                "SELECT id FROM bookmarks WHERE book_uid=?1 AND cfi=?2",
                params![b.book_uid, b.cfi],
                |row| row.get(0),
            )
            .optional()?;
        if dup.is_some() {
            continue;
        }
        tx.execute(
            "INSERT INTO bookmarks(book_uid, chapter_idx, cfi, label, created_at)
             VALUES (?1,?2,?3,?4,?5)",
            params![b.book_uid, b.chapter_idx, b.cfi, b.label, b.created_at],
        )?;
        written += 1;
    }

    tx.commit()?;
    Ok(written)
}

/// Does a note cover exactly this highlight range? (Used by tests and future callers.)
fn note_exists(
    conn: &Connection,
    book_uid: &str,
    chapter_idx: i64,
    cfi_start: &str,
    cfi_end: &str,
) -> anyhow::Result<bool> {
    let n: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM notes
              WHERE book_uid=?1 AND chapter_idx=?2 AND cfi_start=?3 AND cfi_end=?4",
            params![book_uid, chapter_idx, cfi_start, cfi_end],
            |_| Ok(1),
        )
        .optional()?;
    Ok(n.is_some())
}

// ---------------------------------------------------------------------------
// Readers (own SQL — B4's db::annotations is a stub while B8 lands)
// ---------------------------------------------------------------------------

/// The `has_note` field of the DTO is derived, not stored (§4.4 highlights has no such
/// column): compute it with a correlated `EXISTS` so export works against B4's schema as-is.
/// `h.text` is the v1.3 selected-text column; column order mirrors B4's `HL_COLS`.
const HL_SELECT: &str = "SELECT h.id, h.book_uid, h.chapter_idx, h.cfi_start, h.cfi_end, h.color,
                                h.text, h.created_at,
                                EXISTS(SELECT 1 FROM notes n WHERE n.book_uid=h.book_uid
                                       AND n.chapter_idx=h.chapter_idx
                                       AND n.cfi_start=h.cfi_start
                                       AND n.cfi_end=h.cfi_end)
                           FROM highlights h";

fn map_highlight(row: &rusqlite::Row<'_>) -> rusqlite::Result<Highlight> {
    Ok(Highlight {
        id: row.get(0)?,
        book_uid: row.get(1)?,
        chapter_idx: row.get(2)?,
        cfi_start: row.get(3)?,
        cfi_end: row.get(4)?,
        color: row.get(5)?,
        text: row.get(6)?,
        created_at: row.get(7)?,
        has_note: row.get::<_, i64>(8)? != 0,
    })
}

fn read_highlights(conn: &Connection, uid: Option<&str>) -> anyhow::Result<Vec<Highlight>> {
    let mut out = Vec::new();
    match uid {
        Some(uid) => {
            let mut stmt = conn.prepare(&format!(
                "{HL_SELECT} WHERE h.book_uid=?1 ORDER BY h.chapter_idx, h.id"
            ))?;
            let rows = stmt.query_map(params![uid], map_highlight)?;
            for h in rows {
                out.push(h?);
            }
        }
        None => {
            let mut stmt = conn.prepare(&format!(
                "{HL_SELECT} ORDER BY h.book_uid, h.chapter_idx, h.id"
            ))?;
            let rows = stmt.query_map([], map_highlight)?;
            for h in rows {
                out.push(h?);
            }
        }
    }
    Ok(out)
}

fn read_notes(conn: &Connection, uid: Option<&str>) -> anyhow::Result<Vec<Note>> {
    let mut out = Vec::new();
    match uid {
        Some(uid) => {
            let mut stmt = conn.prepare(
                "SELECT id, book_uid, chapter_idx, cfi_start, cfi_end, selected_text,
                        note_text, created_at, updated_at
                   FROM notes WHERE book_uid=?1 ORDER BY chapter_idx, id",
            )?;
            let rows = stmt.query_map(params![uid], map_note)?;
            for n in rows {
                out.push(n?);
            }
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT id, book_uid, chapter_idx, cfi_start, cfi_end, selected_text,
                        note_text, created_at, updated_at
                   FROM notes ORDER BY book_uid, chapter_idx, id",
            )?;
            let rows = stmt.query_map([], map_note)?;
            for n in rows {
                out.push(n?);
            }
        }
    }
    Ok(out)
}

fn map_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<Note> {
    Ok(Note {
        id: row.get(0)?,
        book_uid: row.get(1)?,
        chapter_idx: row.get(2)?,
        cfi_start: row.get(3)?,
        cfi_end: row.get(4)?,
        selected_text: row.get(5)?,
        note_text: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn read_bookmarks(conn: &Connection, uid: Option<&str>) -> anyhow::Result<Vec<Bookmark>> {
    let mut out = Vec::new();
    match uid {
        Some(uid) => {
            let mut stmt = conn.prepare(
                "SELECT id, book_uid, chapter_idx, cfi, label, created_at
                   FROM bookmarks WHERE book_uid=?1 ORDER BY chapter_idx, id",
            )?;
            let rows = stmt.query_map(params![uid], map_bookmark)?;
            for b in rows {
                out.push(b?);
            }
        }
        None => {
            let mut stmt = conn.prepare(
                "SELECT id, book_uid, chapter_idx, cfi, label, created_at
                   FROM bookmarks ORDER BY book_uid, chapter_idx, id",
            )?;
            let rows = stmt.query_map([], map_bookmark)?;
            for b in rows {
                out.push(b?);
            }
        }
    }
    Ok(out)
}

fn map_bookmark(row: &rusqlite::Row<'_>) -> rusqlite::Result<Bookmark> {
    Ok(Bookmark {
        id: row.get(0)?,
        book_uid: row.get(1)?,
        chapter_idx: row.get(2)?,
        cfi: row.get(3)?,
        label: row.get(4)?,
        created_at: row.get(5)?,
    })
}

// ---------------------------------------------------------------------------
// Markdown rendering (§4.7: human-readable, grouped by book)
// ---------------------------------------------------------------------------

/// Append `v` to `out` unless already present (small lists — linear scan is fine).
fn push_unique(out: &mut Vec<i64>, v: i64) {
    if !out.contains(&v) {
        out.push(v);
    }
}

/// Book title lookup; falls back to the uid when the book row is gone.
fn book_title(conn: &Connection, uid: &str) -> String {
    conn.query_row("SELECT title FROM books WHERE uid=?1", params![uid], |r| {
        r.get::<_, String>(0)
    })
    .ok()
    .filter(|t| !t.trim().is_empty())
    .unwrap_or_else(|| uid.to_owned())
}

fn render_markdown(
    conn: &Connection,
    uid: Option<&str>,
    highlights: &[Highlight],
    notes: &[Note],
    bookmarks: &[Bookmark],
) -> anyhow::Result<String> {
    let mut uids: Vec<String> = Vec::new();
    for h in highlights {
        if !uids.contains(&h.book_uid) {
            uids.push(h.book_uid.clone());
        }
    }
    for n in notes {
        if !uids.contains(&n.book_uid) {
            uids.push(n.book_uid.clone());
        }
    }
    for b in bookmarks {
        if !uids.contains(&b.book_uid) {
            uids.push(b.book_uid.clone());
        }
    }
    if let Some(only) = uid {
        uids.retain(|u| u == only);
    }
    uids.sort();

    let mut md = String::new();
    md.push_str("# Highlights and notes\n\n");
    md.push_str(&format!("Exported: {}\n", crate::db::today_str()));

    for book in &uids {
        md.push_str(&format!("\n## {}\n", book_title(conn, book)));

        // Chapter numbers that carry anything for this book, ascending.
        let mut chapters: Vec<i64> = Vec::new();
        for h in highlights.iter().filter(|h| &h.book_uid == book) {
            push_unique(&mut chapters, h.chapter_idx);
        }
        for n in notes.iter().filter(|n| &n.book_uid == book) {
            push_unique(&mut chapters, n.chapter_idx);
        }
        chapters.sort_unstable();

        for ch in chapters {
            md.push_str(&format!("\n### Chapter {}\n\n", ch + 1));

            // Notes first: blockquote of the selected text, then the note itself.
            for n in notes
                .iter()
                .filter(|n| n.book_uid == *book && n.chapter_idx == ch)
            {
                if !n.selected_text.trim().is_empty() {
                    for line in n.selected_text.lines() {
                        md.push_str(&format!("> {}\n", line.trim_end()));
                    }
                }
                if !n.note_text.trim().is_empty() {
                    md.push_str(&format!("\n— {}\n\n", n.note_text.trim()));
                } else {
                    md.push('\n');
                }
            }

            // Highlights without a note: quote the v1.3 `text` column. Legacy rows (created
            // before v1.3) store "", so fall back to a colour + position line for those.
            let bare: Vec<&Highlight> = highlights
                .iter()
                .filter(|h| h.book_uid == *book && h.chapter_idx == ch && !h.has_note)
                .collect();
            if !bare.is_empty() {
                md.push_str("Highlights:\n\n");
                for h in bare {
                    if h.text.trim().is_empty() {
                        md.push_str(&format!("- {} — `{}`\n", h.color, h.cfi_start));
                    } else {
                        for line in h.text.lines() {
                            md.push_str(&format!("> {}\n", line.trim_end()));
                        }
                        md.push('\n');
                    }
                }
            }
        }

        let marks: Vec<&Bookmark> = bookmarks.iter().filter(|b| &b.book_uid == book).collect();
        if !marks.is_empty() {
            md.push_str("\n### Bookmarks\n\n");
            for b in marks {
                match b.label.as_deref().filter(|l| !l.trim().is_empty()) {
                    Some(label) => {
                        md.push_str(&format!("- chapter {} — {}\n", b.chapter_idx + 1, label))
                    }
                    None => md.push_str(&format!("- chapter {}\n", b.chapter_idx + 1)),
                }
            }
        }
    }

    if uids.is_empty() {
        md.push_str("\nEmpty: no highlights, notes or bookmarks.\n");
    }

    Ok(md)
}
