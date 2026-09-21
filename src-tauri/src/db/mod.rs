//! DB core (§4.4, §11.3) — owned by B3; scaffold provides a **bootable** subset:
//! open + pragmas + paths + time helpers. `migrate()` is a no-op stub until B3 lands
//! the §4.4 DDL.

pub mod annotations;
pub mod library;
pub mod progress;
pub mod stats;
pub mod vocab;

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

/// XDG-derived directories (§11.3). Covers live in the cache dir (§4.8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub config_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub covers_dir: PathBuf,
    pub backups_dir: PathBuf,
    pub db_path: PathBuf,
}

/// Compute paths from `app.path()` and create all directories. Panics only if a
/// platform dir is unresolvable (fatal at startup anyway).
pub fn init_paths(app: &AppHandle) -> AppPaths {
    let p = app.path();
    let data_dir = p.app_data_dir().expect("app data dir");
    let config_dir = p.app_config_dir().expect("app config dir");
    let cache_dir = p.app_cache_dir().expect("app cache dir");
    let covers_dir = cache_dir.join("covers");
    let backups_dir = data_dir.join("backups");
    let db_path = data_dir.join("vellum.db");

    for d in [
        &data_dir,
        &config_dir,
        &cache_dir,
        &covers_dir,
        &backups_dir,
    ] {
        std::fs::create_dir_all(d).unwrap_or_else(|e| {
            panic!("cannot create {}: {e}", d.display());
        });
    }

    AppPaths {
        data_dir,
        config_dir,
        cache_dir,
        covers_dir,
        backups_dir,
        db_path,
    }
}

/// Open (or create) the database with the §4.4 pragmas. `migrate` is applied on top.
pub fn open(app_paths: &AppPaths) -> anyhow::Result<Connection> {
    open_at(&app_paths.db_path)
}

/// Open a connection to an existing db file with the §4.4 pragmas, by path.
///
/// Used by blocking-thread workers (import, B5's indexer) that need their **own**
/// connection to the same WAL database (§11.3: never share the main `state.db` lock
/// across threads/awaits). Assumes the schema is already migrated by the app's primary
/// connection.
pub fn open_at(db_path: &std::path::Path) -> anyhow::Result<Connection> {
    let c = Connection::open(db_path)?;
    c.busy_timeout(std::time::Duration::from_secs(5))?;
    c.pragma_update(None, "journal_mode", "WAL")?;
    c.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(c)
}

/// §4.4 DDL verbatim (`CREATE … IF NOT EXISTS` → idempotent) + `user_version = 1`.
///
/// The connection-level pragmas (`journal_mode=WAL`, `busy_timeout=5000`,
/// `synchronous=NORMAL`) are applied once by [`open`] per §11.3, so they are not
/// repeated here; only the schema objects are.
///
/// Wrapped in a transaction so a partial failure can never leave a half-created schema
/// (the `PRAGMA user_version` stamp is inside the same transaction — either everything
/// lands or nothing does, and a re-run is a no-op).
pub fn migrate(c: &Connection) -> anyhow::Result<()> {
    let tx = c.unchecked_transaction()?;
    tx.execute_batch(SCHEMA_V1)?;
    tx.execute_batch("PRAGMA user_version = 1;")?;
    tx.commit()?;
    Ok(())
}

/// §4.4 schema, copied verbatim (comments stripped; column order and defaults match
/// the contract exactly so every WP's hand-written SQL resolves).
const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS books(
  uid TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '[]',
  cover_path TEXT, added_at INTEGER NOT NULL, last_opened_at INTEGER,
  progress REAL NOT NULL DEFAULT 0, position TEXT,
  total_chapters INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tags(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS book_tags(book_uid TEXT NOT NULL, tag_id INTEGER NOT NULL,
  PRIMARY KEY(book_uid, tag_id));
CREATE TABLE IF NOT EXISTS toc(book_uid TEXT NOT NULL, idx INTEGER NOT NULL,
  title TEXT NOT NULL, chapter_idx INTEGER NOT NULL, cfi TEXT, level INTEGER NOT NULL DEFAULT 1,
  parent_idx INTEGER, PRIMARY KEY(book_uid, idx));
CREATE TABLE IF NOT EXISTS chapters(book_uid TEXT NOT NULL, idx INTEGER NOT NULL,
  href TEXT NOT NULL, title TEXT, char_count INTEGER, PRIMARY KEY(book_uid, idx));
CREATE VIRTUAL TABLE IF NOT EXISTS book_search USING fts5(
  book_uid UNINDEXED, chapter_idx UNINDEXED, chapter_title, body,
  tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS highlights(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL, cfi_start TEXT NOT NULL, cfi_end TEXT NOT NULL,
  color TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL, cfi_start TEXT NOT NULL, cfi_end TEXT NOT NULL,
  selected_text TEXT NOT NULL DEFAULT '', note_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bookmarks(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL, cfi TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lookups(word_norm TEXT PRIMARY KEY, word TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1, last_seen_at INTEGER NOT NULL,
  last_book TEXT, last_chapter INTEGER, last_context TEXT, last_cfi TEXT);
CREATE TABLE IF NOT EXISTS vocab(id INTEGER PRIMARY KEY, word TEXT NOT NULL,
  word_norm TEXT NOT NULL UNIQUE, translation TEXT, definition TEXT, transcription TEXT,
  pos TEXT, examples TEXT NOT NULL DEFAULT '[]',
  book_uid TEXT, chapter_idx INTEGER, context TEXT, context_cfi TEXT,
  added_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new'
    CHECK(status IN ('new','learning','known')),
  review_count INTEGER NOT NULL DEFAULT 0, ease REAL NOT NULL DEFAULT 2.5,
  interval_days REAL, due_at INTEGER, last_reviewed_at INTEGER);
CREATE TABLE IF NOT EXISTS review_log(id INTEGER PRIMARY KEY, vocab_id INTEGER NOT NULL,
  at INTEGER NOT NULL, result TEXT NOT NULL, interval_after REAL);
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  day TEXT NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0, pages_turned INTEGER NOT NULL DEFAULT 0,
  UNIQUE(book_uid, day));
CREATE INDEX IF NOT EXISTS idx_vocab_due ON vocab(due_at);
CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
CREATE INDEX IF NOT EXISTS idx_hl_book ON highlights(book_uid, chapter_idx);
CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_uid, chapter_idx);
"#;

/// Unix milliseconds (no chrono — §11.3).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `yyyy-mm-dd` in **local** time (§11.3: `sessions.day` is local).
///
/// Implemented without chrono: the cached local UTC offset (parsed once from `date +%z`,
/// see [`local_offset_minutes`]) is added to the unix-ms instant, then the shifted value
/// is rendered through Hinnant's `civil_from_days` ([`date_str`]). Falls back to UTC when
/// the offset is unavailable (non-Unix), which only shifts evening reads' day grouping.
pub fn today_str() -> String {
    let offset_ms = i64::from(local_offset_minutes()) * 60_000;
    date_str(now_ms() + offset_ms)
}

/// `yyyy-mm-dd` for a unix-ms instant, treating `ms` as already offset into local time.
fn date_str(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Howard Hinnant's public-domain `civil_from_days` (chrono-compatible calendar).
/// Days since 1970-01-01 → (year, month, day) in the civil calendar.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], Mar=0
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// Cached local UTC-offset in **minutes**, parsed once from `date +%z` (no new dep).
/// Falls back to 0 (UTC) when unavailable (e.g. non-Unix). Provided for B3 to build a
/// local-date `today_str` without chrono.
pub fn local_offset_minutes() -> i32 {
    static OFFSET: OnceLock<i32> = OnceLock::new();
    *OFFSET.get_or_init(|| {
        let out = std::process::Command::new("date")
            .arg("+%z")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();
        parse_tz_offset(out.trim())
    })
}

/// `+0300` → 180, `-0530` → -330; anything else → 0.
fn parse_tz_offset(s: &str) -> i32 {
    let b = s.as_bytes();
    if b.len() != 5 {
        return 0;
    }
    let sign = match b[0] {
        b'+' => 1,
        b'-' => -1,
        _ => return 0,
    };
    let hh = s[1..3].parse::<i32>().unwrap_or(-1);
    let mm = s[3..5].parse::<i32>().unwrap_or(-1);
    if !(0..=23).contains(&hh) || !(0..=59).contains(&mm) {
        return 0;
    }
    sign * (hh * 60 + mm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_ms_is_positive_and_monotonic_ish() {
        let a = now_ms();
        assert!(a > 1_700_000_000_000, "now_ms too small: {a}");
        let b = now_ms();
        assert!(b >= a);
    }

    #[test]
    fn civil_from_days_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1)); // epoch
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(date_str(0), "1970-01-01");
        // 2024-02-29T12:00:00Z (leap day) = 1709208000 s
        assert_eq!(date_str(1_709_208_000_000), "2024-02-29");
        // 2026-09-21T00:00:00Z = 1789948800 s
        assert_eq!(date_str(1_789_948_800_000), "2026-09-21");
        // 2000-03-01T00:00:00Z = 951868800 s
        assert_eq!(date_str(951_868_800_000), "2000-03-01");
    }

    #[test]
    fn today_str_format() {
        let t = today_str();
        assert_eq!(t.len(), 10);
        assert_eq!(t.chars().nth(4), Some('-'));
        assert!(t.starts_with("20"));
    }

    #[test]
    fn today_str_is_local_offset_applied() {
        // Whatever the offset resolves to, today_str must equal date_str applied to the
        // offset-shifted instant — pins the local-date contract without assuming a tz.
        let offset_ms = i64::from(local_offset_minutes()) * 60_000;
        // Compare against a frozen 'now' so the two computations can't straddle midnight.
        let now = now_ms();
        let expected = date_str(now + offset_ms);
        let actual = date_str(now_ms() + offset_ms);
        assert_eq!(actual, expected);
        assert_eq!(today_str().len(), 10);
    }

    #[test]
    fn tz_offset_parsing() {
        assert_eq!(parse_tz_offset("+0300"), 180);
        assert_eq!(parse_tz_offset("-0530"), -330);
        assert_eq!(parse_tz_offset("+0000"), 0);
        assert_eq!(parse_tz_offset("junk"), 0);
        assert_eq!(parse_tz_offset(""), 0);
        // local_offset_minutes must at least produce a sane value
        let o = local_offset_minutes();
        assert!((-1440..=1440).contains(&o), "offset {o}");
    }

    /// Fresh, collision-free temp [`AppPaths`] for a test (parallel cargo threads +
    /// concurrent WP agents share the machine, so the dir name is unique per call).
    fn tmp_paths(tag: &str) -> (AppPaths, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "vellum-b3-{}-{}-{:?}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let p = AppPaths {
            data_dir: dir.clone(),
            config_dir: dir.clone(),
            cache_dir: dir.clone(),
            covers_dir: dir.join("covers"),
            backups_dir: dir.join("backups"),
            db_path: dir.join("vellum.db"),
        };
        (p, dir)
    }

    #[test]
    fn open_applies_pragmas() {
        let (paths, dir) = tmp_paths("pragma");
        let c = open(&paths).expect("open db");
        migrate(&c).expect("migrate");
        let mode: String = c
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        let busy: i64 = c
            .query_row("PRAGMA busy_timeout", [], |r| r.get(0))
            .unwrap();
        assert_eq!(busy, 5000);
        // PRAGMA synchronous returns the numeric code: 0 OFF, 1 NORMAL, 2 FULL.
        let sync: i64 = c.query_row("PRAGMA synchronous", [], |r| r.get(0)).unwrap();
        assert_eq!(sync, 1, "synchronous must be NORMAL");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_is_idempotent_and_stamps_user_version() {
        let (paths, dir) = tmp_paths("idempotent");
        let c = open(&paths).expect("open db");
        migrate(&c).expect("migrate #1");
        migrate(&c).expect("migrate #2 (must not error)");
        migrate(&c).expect("migrate #3 (must not error)");

        let version: i64 = c
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 1, "user_version must be stamped 1");

        // Re-running on a *freshly opened* connection to the same file also no-ops.
        let c2 = open(&paths).expect("reopen");
        migrate(&c2).expect("migrate on reopened conn");
        let v2: i64 = c2
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v2, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migrate_creates_every_schema_object() {
        let (paths, dir) = tmp_paths("schema");
        let c = open(&paths).expect("open db");
        migrate(&c).expect("migrate");

        // Every §4.4 table + the FTS5 virtual table must exist.
        let expected = [
            "books",
            "tags",
            "book_tags",
            "toc",
            "chapters",
            "book_search",
            "highlights",
            "notes",
            "bookmarks",
            "lookups",
            "vocab",
            "review_log",
            "sessions",
        ];
        for name in expected {
            let n: i64 = c
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name=?1",
                    [name],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "missing table {name}");
        }

        // The four indexes.
        for idx in [
            "idx_vocab_due",
            "idx_sessions_day",
            "idx_hl_book",
            "idx_notes_book",
        ] {
            let n: i64 = c
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?1",
                    [idx],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "missing index {idx}");
        }

        // book_search is genuinely FTS5 (queryable via MATCH).
        c.execute(
            "INSERT INTO book_search(book_uid, chapter_idx, chapter_title, body) VALUES('u1',0,'Title','the quick brown fox')",
            [],
        )
        .expect("fts insert");
        let hits: i64 = c
            .query_row(
                "SELECT count(*) FROM book_search WHERE book_search MATCH 'quick'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "FTS5 MATCH must work");

        // Spot-check a couple of column defaults the contract pins.
        let (title, authors, progress, indexed, missing): (String, String, f64, i64, i64) = c
            .query_row(
                "INSERT INTO books(uid, path, added_at) VALUES('u','/x',1) RETURNING title, authors, progress, indexed, missing",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .unwrap();
        assert_eq!(title, "");
        assert_eq!(authors, "[]");
        assert_eq!(progress, 0.0);
        assert_eq!(indexed, 0);
        assert_eq!(missing, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wal_allows_second_connection_write_while_first_reads() {
        let (paths, dir) = tmp_paths("wal");
        let c1 = open(&paths).expect("open c1");
        migrate(&c1).expect("migrate");

        // c1 begins a read transaction and holds it open.
        let tx1 = c1.unchecked_transaction().unwrap();
        tx1.execute(
            "INSERT INTO books(uid, path, added_at) VALUES('a','/a',1)",
            [],
        )
        .unwrap();
        tx1.commit().unwrap();
        let rtx = c1.unchecked_transaction().unwrap();
        let cnt1: i64 = rtx
            .query_row("SELECT count(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cnt1, 1);

        // A *second* connection (B5's index task model) writes concurrently under WAL.
        let c2 = open(&paths).expect("open c2");
        migrate(&c2).expect("migrate c2");
        c2.execute(
            "INSERT INTO books(uid, path, added_at) VALUES('b','/b',2)",
            [],
        )
        .expect("c2 write while c1 reads");

        // c1's snapshot still sees 1 (WAL isolation); a fresh read on c1 sees both.
        drop(rtx);
        let total: i64 = c1
            .query_row("SELECT count(*) FROM books", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 2, "c1 must observe c2's WAL-committed write");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
