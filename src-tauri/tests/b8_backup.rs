//! B8 §8 — backup / export / import round-trips.
//!
//! `db::migrate` is still B3's stub, so these tests create the §4.4 tables they need
//! directly. Nothing here touches a real Tauri app: every entry point takes an `AppPaths`
//! or a borrowed `Connection`.

use std::path::{Path, PathBuf};

use rusqlite::Connection;
use vellum_lib::backup;
use vellum_lib::db::annotations as ann;
use vellum_lib::db::AppPaths;
use vellum_lib::dto::Highlight;
use vellum_lib::settings::{self, Settings};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "vellum-b8-backup-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create temp root");
        TempDir(root)
    }
    fn join(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn test_paths(tmp: &TempDir) -> AppPaths {
    let data_dir = tmp.join("data");
    let backups_dir = data_dir.join("backups");
    std::fs::create_dir_all(&backups_dir).expect("backups dir");
    let config_dir = tmp.join("config");
    std::fs::create_dir_all(&config_dir).expect("config dir");
    AppPaths {
        db_path: data_dir.join("vellum.db"),
        cache_dir: tmp.join("cache"),
        covers_dir: tmp.join("cache/covers"),
        data_dir,
        config_dir,
        backups_dir,
    }
}

/// §4.4 subset needed by the annotation export/import paths.
const DDL: &str = "
CREATE TABLE books(uid TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '[]', cover_path TEXT, added_at INTEGER NOT NULL,
  last_opened_at INTEGER, progress REAL NOT NULL DEFAULT 0, position TEXT,
  total_chapters INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0);
CREATE TABLE highlights(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL, chapter_idx INTEGER NOT NULL,
  cfi_start TEXT NOT NULL, cfi_end TEXT NOT NULL, color TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE notes(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL, chapter_idx INTEGER NOT NULL,
  cfi_start TEXT NOT NULL, cfi_end TEXT NOT NULL, selected_text TEXT NOT NULL DEFAULT '',
  note_text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE bookmarks(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL, chapter_idx INTEGER NOT NULL,
  cfi TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL);
";

fn open_db(paths: &AppPaths) -> Connection {
    let conn = Connection::open(&paths.db_path).expect("open db");
    conn.busy_timeout(std::time::Duration::from_secs(5)).ok();
    conn.pragma_update(None, "journal_mode", "WAL").ok();
    conn.execute_batch(DDL).expect("create test schema");
    conn
}

fn seed_annotations(conn: &Connection) {
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at) VALUES ('book1','/b/1.epub','Франкенштейн',100)",
        [],
    )
    .expect("book row");
    conn.execute(
        "INSERT INTO highlights(book_uid, chapter_idx, cfi_start, cfi_end, color, text, created_at)
         VALUES ('book1', 2, 'epubcfi(/4/2/2)', 'epubcfi(/4/2/2:10)', '#ffe08a',
                 'It was on a dreary night', 1000)",
        [],
    )
    .expect("highlight");
    // A second highlight with no matching note → exercises the bare-quote branch of the md
    // export (v1.3 `text` column) and gives export/import a second row to compare.
    conn.execute(
        "INSERT INTO highlights(book_uid, chapter_idx, cfi_start, cfi_end, color, text, created_at)
         VALUES ('book1', 2, 'epubcfi(/4/2/40)', 'epubcfi(/4/2/4:30)', '#a8e6a3',
                 'the creature opened his dull yellow eye', 1100)",
        [],
    )
    .expect("second highlight");
    conn.execute(
        "INSERT INTO notes(book_uid, chapter_idx, cfi_start, cfi_end, selected_text, note_text,
                           created_at, updated_at)
         VALUES ('book1', 2, 'epubcfi(/4/2/2)', 'epubcfi(/4/2/2:10)', 'It was on a dreary night',
                 'важный момент', 1000, 1000)",
        [],
    )
    .expect("note");
    conn.execute(
        "INSERT INTO bookmarks(book_uid, chapter_idx, cfi, label, created_at)
         VALUES ('book1', 5, 'epubcfi(/4/6/2)', 'финал', 2000)",
        [],
    )
    .expect("bookmark");
}

fn counts(conn: &Connection) -> (i64, i64, i64) {
    let one = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).expect("count query") };
    (
        one("SELECT COUNT(*) FROM highlights"),
        one("SELECT COUNT(*) FROM notes"),
        one("SELECT COUNT(*) FROM bookmarks"),
    )
}

// ---------------------------------------------------------------------------
// backup_db / VACUUM INTO
// ---------------------------------------------------------------------------

#[test]
fn vacuum_into_produces_openable_db_with_data() {
    let tmp = TempDir::new("vacuum");
    let paths = test_paths(&tmp);
    {
        let conn = open_db(&paths);
        seed_annotations(&conn);
        let dest = tmp.join("snapshot.db");
        backup::backup_db_conn(&conn, &dest).expect("VACUUM INTO ok");
        assert!(dest.exists());
    }

    // Reopen the snapshot standalone: it must be a normal (non-WAL) db holding the rows.
    let snap = Connection::open(tmp.join("snapshot.db")).expect("snapshot opens");
    let highlights: i64 = snap
        .query_row("SELECT COUNT(*) FROM highlights", [], |r| r.get(0))
        .expect("snapshot has the table");
    assert_eq!(highlights, 2);
    let title: String = snap
        .query_row("SELECT title FROM books WHERE uid='book1'", [], |r| {
            r.get(0)
        })
        .expect("book row");
    assert_eq!(title, "Франкенштейн");
    // VACUUM INTO never carries the WAL sidecar.
    assert!(!tmp.join("snapshot.db-wal").exists());
}

#[test]
fn backup_overwrites_existing_dest() {
    let tmp = TempDir::new("overwrite");
    let paths = test_paths(&tmp);
    let dest = tmp.join("snapshot.db");
    std::fs::write(&dest, b"not a database at all").expect("pre-existing junk");

    let conn = open_db(&paths);
    seed_annotations(&conn);
    backup::backup_db_conn(&conn, &dest).expect("VACUUM INTO replaces the file");

    let snap = Connection::open(&dest).expect("valid db now");
    let n: i64 = snap
        .query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0))
        .expect("count");
    assert_eq!(n, 1);
}

#[test]
fn backup_creates_missing_parent_dir() {
    let tmp = TempDir::new("mkdirs");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    seed_annotations(&conn);
    let dest = tmp.join("deep/nested/dir/snap.db");
    backup::backup_db_conn(&conn, &dest).expect("ok");
    assert!(dest.exists());
}

// ---------------------------------------------------------------------------
// auto_backup
// ---------------------------------------------------------------------------

/// Write a dummy backup file with the given `yyyymmdd` name (content irrelevant to pruning).
fn dummy_backup(dir: &Path, yyyymmdd: &str) -> PathBuf {
    let p = dir.join(format!("vellum-{yyyymmdd}.db"));
    std::fs::write(&p, b"SQLite format 3\0 dummy").expect("write dummy");
    p
}

#[test]
fn auto_backup_creates_file_when_none_exist() {
    let tmp = TempDir::new("auto-new");
    let paths = test_paths(&tmp);
    {
        let conn = open_db(&paths);
        seed_annotations(&conn);
    }

    backup::auto_backup(&paths).expect("auto_backup ok");

    let files = backup::list_backups(&paths.backups_dir).expect("list");
    assert_eq!(files.len(), 1, "one dated backup created");
    let name = files[0]
        .path
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    assert!(
        name.starts_with("vellum-") && name.ends_with(".db") && name.len() == 18,
        "name shape: {name}"
    );

    // and it is a real snapshot of the data
    let conn = Connection::open(&files[0].path).expect("backup opens");
    let n: i64 = conn
        .query_row("SELECT COUNT(*) FROM bookmarks", [], |r| r.get(0))
        .expect("count");
    assert_eq!(n, 1);
}

#[test]
fn auto_backup_same_day_is_noop() {
    let tmp = TempDir::new("auto-noop");
    let paths = test_paths(&tmp);
    {
        let conn = open_db(&paths);
        seed_annotations(&conn);
    }

    backup::auto_backup(&paths).expect("first run");
    let before = backup::list_backups(&paths.backups_dir).expect("list");
    assert_eq!(before.len(), 1);

    backup::auto_backup(&paths).expect("second run");
    backup::auto_backup(&paths).expect("third run");

    let after = backup::list_backups(&paths.backups_dir).expect("list");
    assert_eq!(after.len(), 1, "today's backup is fresh → no new file");
    assert_eq!(after[0].path, before[0].path);
}

#[test]
fn auto_backup_runs_when_newest_is_older_than_7_days() {
    let tmp = TempDir::new("auto-stale");
    let paths = test_paths(&tmp);
    {
        let conn = open_db(&paths);
        seed_annotations(&conn);
    }
    // An old backup (2020) is far beyond the 7-day window.
    dummy_backup(&paths.backups_dir, "20200101");

    backup::auto_backup(&paths).expect("ok");

    let files = backup::list_backups(&paths.backups_dir).expect("list");
    assert_eq!(files.len(), 2, "old one kept, new one added");
    assert!(files.iter().any(|f| f.date_days > 20_000), "fresh backup");
}

#[test]
fn auto_backup_skips_when_newest_is_recent() {
    let tmp = TempDir::new("auto-recent");
    let paths = test_paths(&tmp);
    {
        let conn = open_db(&paths);
        seed_annotations(&conn);
    }
    // A backup dated one day ago → still inside the 7-day window.
    let yesterday = vellum_lib::db::now_ms() / 86_400_000 - 1;
    dummy_backup(&paths.backups_dir, &days_to_yyyymmdd(yesterday));

    backup::auto_backup(&paths).expect("ok");
    let files = backup::list_backups(&paths.backups_dir).expect("list");
    assert_eq!(files.len(), 1, "recent backup → nothing to do");
}

#[test]
fn auto_backup_prunes_to_five_newest() {
    let tmp = TempDir::new("auto-prune");
    let paths = test_paths(&tmp);
    {
        let conn = open_db(&paths);
        seed_annotations(&conn);
    }
    // Seven old backups, all well past the window → forces a new one, then pruning.
    for d in [
        "20200101", "20200201", "20200301", "20200401", "20200501", "20200601", "20200701",
    ] {
        dummy_backup(&paths.backups_dir, d);
    }
    // Untouchable neighbour: not matching vellum-<8 digits>.db exactly.
    std::fs::write(paths.backups_dir.join("vellum-notes.txt"), b"keep me").unwrap();
    std::fs::write(paths.backups_dir.join("my-own-backup.db"), b"keep me too").unwrap();

    backup::auto_backup(&paths).expect("ok");

    let files = backup::list_backups(&paths.backups_dir).expect("list");
    assert_eq!(files.len(), 5, "keep newest 5, got {}", files.len());
    // newest five dates must be the recent one + the four newest dummies
    let dates: Vec<i64> = files.iter().map(|f| f.date_days).collect();
    assert!(dates.windows(2).all(|w| w[0] >= w[1]), "newest first");
    assert!(files.iter().any(|f| f.date_days > 20_000), "today's kept");
    assert!(
        !files.iter().any(|f| {
            f.path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains("20200101")
        }),
        "oldest dummy pruned"
    );
    // unrelated files untouched
    assert!(paths.backups_dir.join("vellum-notes.txt").exists());
    assert!(paths.backups_dir.join("my-own-backup.db").exists());
}

#[test]
fn list_backups_ignores_non_matching_names() {
    let tmp = TempDir::new("list");
    let paths = test_paths(&tmp);
    let dir = &paths.backups_dir;
    dummy_backup(dir, "20210304");
    std::fs::write(dir.join("vellum-2103.db"), b"x").unwrap(); // wrong digit count
    std::fs::write(dir.join("vellum-abcdefgh.db"), b"x").unwrap(); // not digits
    std::fs::write(dir.join("vellum-20210304.sqlite"), b"x").unwrap(); // wrong ext
    std::fs::write(dir.join("other-20210304.db"), b"x").unwrap(); // wrong prefix
    std::fs::create_dir_all(dir.join("vellum-20210305.db")).unwrap(); // directory, not file

    let files = backup::list_backups(dir).expect("list");
    assert_eq!(files.len(), 1, "only the exact pattern counts");
    assert!(files[0].path.ends_with("vellum-20210304.db"));
}

#[test]
fn list_backups_on_missing_dir_is_empty() {
    let tmp = TempDir::new("list-missing");
    let paths = test_paths(&tmp);
    let _ = std::fs::remove_dir_all(&paths.backups_dir);
    assert!(backup::list_backups(&paths.backups_dir)
        .expect("no error")
        .is_empty());
}

#[test]
fn auto_backup_without_db_file_is_harmless() {
    let tmp = TempDir::new("auto-nodb");
    let paths = test_paths(&tmp);
    let _ = std::fs::remove_file(&paths.db_path);
    backup::auto_backup(&paths).expect("no db yet → Ok, no panic");
    assert!(backup::list_backups(&paths.backups_dir)
        .expect("list")
        .is_empty());
}

/// Local helper mirroring backup's own date math, for building "recent" fixtures.
fn days_to_yyyymmdd(days: i64) -> String {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = y + i64::from(m <= 2);
    format!("{y:04}{m:02}{d:02}")
}

// ---------------------------------------------------------------------------
// settings export / import
// ---------------------------------------------------------------------------

#[test]
fn export_import_settings_roundtrip() {
    let tmp = TempDir::new("settings-rt");
    let paths = test_paths(&tmp);

    let mut s = Settings::default();
    s.ui.theme_id = "oled".into();
    s.page.font_size_px = 26.0;
    s.page.margins_px.top = 3.0;
    s.translate.default_target_lang = "en".into();
    settings::save(&paths, &s).expect("save live settings");

    let dest = tmp.join("exported-settings.json");
    backup::export_settings(&paths, dest.to_str().unwrap()).expect("export");
    assert!(dest.exists());

    // Wipe the live settings, then import from the export.
    settings::save(&paths, &Settings::default()).expect("reset");
    let imported = backup::import_settings(&paths, dest.to_str().unwrap()).expect("import");

    assert_eq!(imported, s, "imported equals what was exported");
    assert_eq!(imported.ui.theme_id, "oled");
    assert_eq!(imported.page.font_size_px, 26.0);
    assert_eq!(imported.page.margins_px.top, 3.0);
    assert_eq!(settings::load(&paths), s, "and it is now the live file");
}

#[test]
fn export_settings_writes_defaults_when_file_missing() {
    let tmp = TempDir::new("settings-defaults");
    let paths = test_paths(&tmp);
    assert!(!settings::path(&paths).exists());

    let dest = tmp.join("fresh.json");
    backup::export_settings(&paths, dest.to_str().unwrap()).expect("export");

    let body = std::fs::read_to_string(&dest).expect("read export");
    let parsed: Settings = serde_json::from_str(&body).expect("parses");
    assert_eq!(parsed, Settings::default());
}

#[test]
fn import_settings_partial_file_fills_defaults() {
    let tmp = TempDir::new("settings-partial");
    let paths = test_paths(&tmp);
    let src = tmp.join("partial.json");
    std::fs::write(&src, r#"{"ui":{"themeId":"sepia"}}"#).expect("write");

    let imported = backup::import_settings(&paths, src.to_str().unwrap()).expect("import");
    assert_eq!(imported.ui.theme_id, "sepia");
    assert_eq!(imported.page.font_size_px, 19.0, "rest defaults");
    assert_eq!(settings::load(&paths).ui.theme_id, "sepia", "persisted");
}

#[test]
fn import_settings_rejects_corrupt_file() {
    let tmp = TempDir::new("settings-corrupt");
    let paths = test_paths(&tmp);
    let src = tmp.join("broken.json");
    std::fs::write(&src, "{ not json").expect("write");

    let err = backup::import_settings(&paths, src.to_str().unwrap())
        .expect_err("corrupt import must fail");
    assert!(err.to_string().contains("corrupted"), "message: {err}");
}

#[test]
fn import_settings_missing_file_errors() {
    let tmp = TempDir::new("settings-absent");
    let paths = test_paths(&tmp);
    assert!(backup::import_settings(&paths, tmp.join("nope.json").to_str().unwrap()).is_err());
}

// ---------------------------------------------------------------------------
// annotation export / import
// ---------------------------------------------------------------------------

#[test]
fn export_annotations_json_reports_count_and_shape() {
    let tmp = TempDir::new("exp-json");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    seed_annotations(&conn);

    let dest = tmp.join("annotations.json");
    let n = backup::export_annotations_conn(&conn, None, dest.to_str().unwrap(), "json")
        .expect("export");
    assert_eq!(n, 4, "2 highlights + 1 note + 1 bookmark");

    let body = std::fs::read_to_string(&dest).expect("read");
    let v: serde_json::Value = serde_json::from_str(&body).expect("valid json");
    assert_eq!(v["version"], 1);
    assert!(
        v["exportedAt"].as_i64().unwrap() > 0,
        "camelCase exportedAt"
    );
    assert_eq!(v["highlights"].as_array().unwrap().len(), 2);
    assert_eq!(v["notes"].as_array().unwrap().len(), 1);
    assert_eq!(v["bookmarks"].as_array().unwrap().len(), 1);
    // DTO camelCase on disk
    let hl = &v["highlights"][0];
    assert_eq!(hl["bookUid"], "book1");
    assert_eq!(hl["cfiStart"], "epubcfi(/4/2/2)");
    assert_eq!(hl["hasNote"], true, "derived from the matching note");
    assert_eq!(hl["text"], "It was on a dreary night", "v1.3 text column");
    let bare = &v["highlights"][1];
    assert_eq!(bare["hasNote"], false, "no note covers this range");
    assert_eq!(bare["text"], "the creature opened his dull yellow eye");
}

#[test]
fn export_annotations_filtered_by_uid() {
    let tmp = TempDir::new("exp-uid");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    seed_annotations(&conn);
    conn.execute(
        "INSERT INTO bookmarks(book_uid, chapter_idx, cfi, label, created_at)
         VALUES ('book2', 0, 'epubcfi(/4/2)', NULL, 5)",
        [],
    )
    .unwrap();

    let dest = tmp.join("only-book1.json");
    let n = backup::export_annotations_conn(&conn, Some("book1"), dest.to_str().unwrap(), "json")
        .expect("export");
    assert_eq!(n, 4, "book2's bookmark excluded");

    let v: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&dest).unwrap()).unwrap();
    assert_eq!(v["bookmarks"].as_array().unwrap().len(), 1);

    let dest_all = tmp.join("all.json");
    let n_all = backup::export_annotations_conn(&conn, None, dest_all.to_str().unwrap(), "json")
        .expect("export all");
    assert_eq!(n_all, 5);
}

#[test]
fn export_annotations_md_contains_book_title_and_quote() {
    let tmp = TempDir::new("exp-md");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    seed_annotations(&conn);

    let dest = tmp.join("annotations.md");
    let n = backup::export_annotations_conn(&conn, None, dest.to_str().unwrap(), "md")
        .expect("md export");
    assert_eq!(n, 4, "md reports the same row count");

    let body = std::fs::read_to_string(&dest).expect("read");
    assert!(body.contains("Франкенштейн"), "book title present");
    assert!(
        body.contains("> It was on a dreary night"),
        "note is a blockquote"
    );
    assert!(
        body.contains("> the creature opened his dull yellow eye"),
        "note-less highlight is quoted from the v1.3 text column: {body}"
    );
    assert!(body.contains("важный момент"), "note text present");
    assert!(body.contains("Bookmarks"), "bookmarks section");
    assert!(body.contains("финал"), "bookmark label");
    assert!(body.contains("Chapter 3"), "1-based chapter heading");
    assert!(body.starts_with('#'), "markdown heading first");
}

#[test]
fn export_annotations_md_without_book_row_falls_back_to_uid() {
    let tmp = TempDir::new("exp-md-orphan");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    conn.execute(
        "INSERT INTO highlights(book_uid, chapter_idx, cfi_start, cfi_end, color, text, created_at)
         VALUES ('orphanuid', 0, 'a', 'b', '#fff', '', 1)",
        [],
    )
    .unwrap();

    let dest = tmp.join("orphan.md");
    backup::export_annotations_conn(&conn, None, dest.to_str().unwrap(), "md").expect("ok");
    let body = std::fs::read_to_string(&dest).unwrap();
    assert!(body.contains("orphanuid"), "uid used when no title row");
    assert!(
        body.contains("#fff"),
        "bare highlight still listed with its colour"
    );
}

#[test]
fn export_annotations_empty_db_md_says_empty() {
    let tmp = TempDir::new("exp-md-empty");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    let dest = tmp.join("empty.md");
    let n = backup::export_annotations_conn(&conn, None, dest.to_str().unwrap(), "md").expect("ok");
    assert_eq!(n, 0);
    assert!(std::fs::read_to_string(&dest).unwrap().contains("Empty"));
}

#[test]
fn export_annotations_unknown_format_errors() {
    let tmp = TempDir::new("exp-badfmt");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    seed_annotations(&conn);
    let dest = tmp.join("x.pdf");
    let err = backup::export_annotations_conn(&conn, None, dest.to_str().unwrap(), "pdf")
        .expect_err("unsupported format");
    assert!(err.to_string().contains("format"), "message: {err}");
    assert!(!dest.exists(), "nothing written");
}

#[test]
fn import_annotations_roundtrip_after_wipe() {
    let tmp = TempDir::new("imp-rt");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    seed_annotations(&conn);

    let dest = tmp.join("annotations.json");
    let exported = backup::export_annotations_conn(&conn, None, dest.to_str().unwrap(), "json")
        .expect("export");
    assert_eq!(exported, 4);

    // Wipe every annotation row, then import the export back.
    conn.execute_batch("DELETE FROM highlights; DELETE FROM notes; DELETE FROM bookmarks;")
        .expect("wipe");
    assert_eq!(counts(&conn), (0, 0, 0));

    let imported = backup::import_annotations_conn(&conn, dest.to_str().unwrap()).expect("import");
    assert_eq!(imported, 4, "all four rows written back");
    assert_eq!(counts(&conn), (2, 1, 1));

    // Re-export and compare payloads (ids may differ, content must not).
    let dest2 = tmp.join("again.json");
    backup::export_annotations_conn(&conn, None, dest2.to_str().unwrap(), "json")
        .expect("export 2");
    let strip_ids = |p: &Path| -> Vec<serde_json::Value> {
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        ["highlights", "notes", "bookmarks"]
            .iter()
            .flat_map(|k| {
                v[k].as_array().unwrap().iter().map(|item| {
                    let mut o = item.as_object().unwrap().clone();
                    o.remove("id");
                    o.remove("exportedAt");
                    serde_json::Value::Object(o)
                })
            })
            .collect()
    };
    let mut a = strip_ids(&dest);
    let mut b = strip_ids(&dest2);
    a.sort_by_key(|v| v.to_string());
    b.sort_by_key(|v| v.to_string());
    assert_eq!(a, b, "round-tripped rows are identical");
}

#[test]
fn import_annotations_roundtrips_b4_crud_rows() {
    // Cross-path roundtrip (INTEGRATION.md §A, B8→B4): rows written by db::annotations'
    // helpers must survive backup's own SELECT/INSERT SQL — export → wipe → import →
    // list through B4 again, field-for-field (ids may differ after re-insert).
    let tmp = TempDir::new("imp-b4-crud");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    conn.execute(
        "INSERT INTO books(uid, path, title, added_at) VALUES ('book1','/b/1.epub','Франкенштейн',100)",
        [],
    )
    .expect("book row");

    let hl_plain = ann::add_highlight(
        &conn,
        "book1",
        1,
        "epubcfi(/4/2/2)",
        "epubcfi(/4/2/2:8)",
        "#ffe08a",
        "выделено",
    )
    .expect("highlight");
    let hl_with_note = ann::add_highlight(
        &conn,
        "book1",
        2,
        "epubcfi(/4/4/2)",
        "epubcfi(/4/4/2:5)",
        "#a8e6a3",
        "",
    )
    .expect("highlight 2");
    let note = ann::add_note(
        &conn,
        "book1",
        2,
        "epubcfi(/4/4/2)",
        "epubcfi(/4/4/2:5)",
        "выделено",
        "моя заметка",
    )
    .expect("note");
    let bm =
        ann::add_bookmark(&conn, "book1", 5, "epubcfi(/4/6/2)", Some("финал")).expect("bookmark");

    // hasNote is derived from the note row, before the roundtrip.
    let mut orig_hls = ann::list_highlights(&conn, "book1", None).unwrap();
    assert!(
        !orig_hls
            .iter()
            .find(|h| h.id == hl_plain.id)
            .unwrap()
            .has_note
    );
    assert!(
        orig_hls
            .iter()
            .find(|h| h.id == hl_with_note.id)
            .unwrap()
            .has_note
    );

    let dest = tmp.join("annotations.json");
    let exported =
        backup::export_annotations_conn(&conn, Some("book1"), dest.to_str().unwrap(), "json")
            .expect("export");
    assert_eq!(exported, 4);

    conn.execute_batch("DELETE FROM highlights; DELETE FROM notes; DELETE FROM bookmarks;")
        .expect("wipe");
    assert_eq!(counts(&conn), (0, 0, 0));

    let imported = backup::import_annotations_conn(&conn, dest.to_str().unwrap()).expect("import");
    assert_eq!(imported, 4, "all four B4-written rows imported");

    // Highlights: same content through B4's list, hasNote re-derived from the reimported note.
    let strip_hl = |h: &Highlight| {
        (
            h.book_uid.clone(),
            h.chapter_idx,
            h.cfi_start.clone(),
            h.cfi_end.clone(),
            h.color.clone(),
            h.text.clone(),
            h.created_at,
            h.has_note,
        )
    };
    let mut new_hls = ann::list_highlights(&conn, "book1", None).unwrap();
    orig_hls.sort_by_key(strip_hl);
    new_hls.sort_by_key(strip_hl);
    assert_eq!(
        new_hls.iter().map(strip_hl).collect::<Vec<_>>(),
        orig_hls.iter().map(strip_hl).collect::<Vec<_>>(),
        "text/color/created_at/hasNote preserved through the backup SQL"
    );

    // Note and bookmark: every stored field, ids aside.
    let new_note = ann::list_notes(&conn, Some("book1")).unwrap().remove(0);
    assert_eq!(new_note.book_uid, note.book_uid);
    assert_eq!(new_note.chapter_idx, note.chapter_idx);
    assert_eq!(new_note.cfi_start, note.cfi_start);
    assert_eq!(new_note.cfi_end, note.cfi_end);
    assert_eq!(new_note.selected_text, note.selected_text);
    assert_eq!(new_note.note_text, note.note_text);
    assert_eq!(new_note.created_at, note.created_at);
    assert_eq!(new_note.updated_at, note.updated_at);

    let new_bm = ann::list_bookmarks(&conn, Some("book1")).unwrap().remove(0);
    assert_eq!(new_bm.book_uid, bm.book_uid);
    assert_eq!(new_bm.chapter_idx, bm.chapter_idx);
    assert_eq!(new_bm.cfi, bm.cfi);
    assert_eq!(new_bm.label, bm.label);
    assert_eq!(new_bm.created_at, bm.created_at);
}

#[test]
fn import_annotations_skips_duplicates() {
    let tmp = TempDir::new("imp-dup");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    seed_annotations(&conn);

    let dest = tmp.join("annotations.json");
    backup::export_annotations_conn(&conn, None, dest.to_str().unwrap(), "json").expect("export");

    // Import onto a db that already has the same rows → nothing new.
    let n = backup::import_annotations_conn(&conn, dest.to_str().unwrap()).expect("import");
    assert_eq!(n, 0, "all rows are duplicates");
    assert_eq!(counts(&conn), (2, 1, 1), "no rows added");

    // And a second import is still a no-op.
    let n2 = backup::import_annotations_conn(&conn, dest.to_str().unwrap()).expect("import again");
    assert_eq!(n2, 0);
    assert_eq!(counts(&conn), (2, 1, 1));
}

#[test]
fn import_annotations_note_newer_wins_older_loses() {
    let tmp = TempDir::new("imp-note");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    conn.execute(
        "INSERT INTO notes(book_uid, chapter_idx, cfi_start, cfi_end, selected_text, note_text,
                           created_at, updated_at)
         VALUES ('b', 0, 's', 'e', 'old text', 'old note', 100, 500)",
        [],
    )
    .unwrap();

    // Incoming row with a NEWER updated_at must overwrite.
    let newer = tmp.join("newer.json");
    std::fs::write(
        &newer,
        r#"{"version":1,"exportedAt":1,"highlights":[],"bookmarks":[],"notes":[
            {"id":99,"bookUid":"b","chapterIdx":0,"cfiStart":"s","cfiEnd":"e",
             "selectedText":"old text","noteText":"new note","createdAt":100,"updatedAt":900}]}"#,
    )
    .unwrap();
    let n = backup::import_annotations_conn(&conn, newer.to_str().unwrap()).expect("import");
    assert_eq!(n, 1, "newer note applied");
    let note_text: String = conn
        .query_row("SELECT note_text FROM notes WHERE book_uid='b'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(note_text, "new note");
    let updated: i64 = conn
        .query_row("SELECT updated_at FROM notes WHERE book_uid='b'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(updated, 900);

    // Incoming row with an OLDER updated_at must be ignored.
    let older = tmp.join("older.json");
    std::fs::write(
        &older,
        r#"{"version":1,"exportedAt":1,"highlights":[],"bookmarks":[],"notes":[
            {"id":98,"bookUid":"b","chapterIdx":0,"cfiStart":"s","cfiEnd":"e",
             "selectedText":"old text","noteText":"stale","createdAt":100,"updatedAt":200}]}"#,
    )
    .unwrap();
    let n2 = backup::import_annotations_conn(&conn, older.to_str().unwrap()).expect("import");
    assert_eq!(n2, 0, "older note skipped");
    let note_text: String = conn
        .query_row("SELECT note_text FROM notes WHERE book_uid='b'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(note_text, "new note", "stale import must not clobber");
}

#[test]
fn import_annotations_equal_updated_at_keeps_existing() {
    let tmp = TempDir::new("imp-eq");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    conn.execute(
        "INSERT INTO notes(book_uid, chapter_idx, cfi_start, cfi_end, selected_text, note_text,
                           created_at, updated_at) VALUES ('b',0,'s','e','t','mine',1,500)",
        [],
    )
    .unwrap();
    let src = tmp.join("eq.json");
    std::fs::write(
        &src,
        r#"{"version":1,"exportedAt":1,"highlights":[],"bookmarks":[],"notes":[
            {"id":1,"bookUid":"b","chapterIdx":0,"cfiStart":"s","cfiEnd":"e",
             "selectedText":"t","noteText":"theirs","createdAt":1,"updatedAt":500}]}"#,
    )
    .unwrap();
    assert_eq!(
        backup::import_annotations_conn(&conn, src.to_str().unwrap()).expect("import"),
        0,
        "strictly-newer rule: equal timestamps lose"
    );
    let note_text: String = conn
        .query_row("SELECT note_text FROM notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(note_text, "mine");
}

#[test]
fn import_annotations_bookmark_dedupes_by_uid_and_cfi() {
    let tmp = TempDir::new("imp-bm");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    let src = tmp.join("bm.json");
    // Same (book_uid, cfi) twice → second is a duplicate.
    std::fs::write(
        &src,
        r#"{"version":1,"exportedAt":1,"highlights":[],"notes":[],"bookmarks":[
            {"id":1,"bookUid":"b","chapterIdx":0,"cfi":"same","label":"a","createdAt":1},
            {"id":2,"bookUid":"b","chapterIdx":1,"cfi":"same","label":"b","createdAt":2},
            {"id":3,"bookUid":"b","chapterIdx":2,"cfi":"other","label":null,"createdAt":3}]}"#,
    )
    .unwrap();
    let n = backup::import_annotations_conn(&conn, src.to_str().unwrap()).expect("import");
    assert_eq!(n, 2, "two distinct (uid, cfi) pairs");
    let total: i64 = conn
        .query_row("SELECT COUNT(*) FROM bookmarks", [], |r| r.get(0))
        .unwrap();
    assert_eq!(total, 2);
    let labels: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT COALESCE(label,'<null>') FROM bookmarks ORDER BY cfi")
            .unwrap();
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        rows
    };
    assert_eq!(labels, vec!["<null>".to_string(), "a".to_string()]);
}

#[test]
fn import_annotations_highlight_dedupes_on_full_natural_key() {
    let tmp = TempDir::new("imp-hl");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    let src = tmp.join("hl.json");
    std::fs::write(
        &src,
        r##"{"version":1,"exportedAt":1,"notes":[],"bookmarks":[],"highlights":[
            {"id":1,"bookUid":"b","chapterIdx":0,"cfiStart":"s1","cfiEnd":"e1","color":"#aaa","createdAt":1,"hasNote":false},
            {"id":2,"bookUid":"b","chapterIdx":0,"cfiStart":"s1","cfiEnd":"e1","color":"#bbb","createdAt":2,"hasNote":false},
            {"id":3,"bookUid":"b","chapterIdx":0,"cfiStart":"s2","cfiEnd":"e2","color":"#ccc","createdAt":3,"hasNote":false}]}"##,
    )
    .unwrap();
    let n = backup::import_annotations_conn(&conn, src.to_str().unwrap()).expect("import");
    assert_eq!(n, 2, "second row shares the natural key → skipped");
    let colors: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT color FROM highlights ORDER BY cfi_start")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(
        colors,
        vec!["#aaa".to_string(), "#ccc".to_string()],
        "first wins"
    );
}

#[test]
fn import_annotations_rejects_corrupt_json() {
    let tmp = TempDir::new("imp-corrupt");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    let src = tmp.join("bad.json");
    std::fs::write(&src, "{ this is not json").unwrap();
    let err = backup::import_annotations_conn(&conn, src.to_str().unwrap()).expect_err("must fail");
    assert!(err.to_string().contains("corrupted"), "message: {err}");
    assert_eq!(counts(&conn), (0, 0, 0), "nothing written");
}

#[test]
fn import_annotations_rejects_markdown_file() {
    let tmp = TempDir::new("imp-md");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    let src = tmp.join("notes.md");
    std::fs::write(&src, "# Highlights and notes\n\n## Book\n").unwrap();
    assert!(
        backup::import_annotations_conn(&conn, src.to_str().unwrap()).is_err(),
        "json only"
    );
}

#[test]
fn import_is_atomic_on_bad_row() {
    let tmp = TempDir::new("imp-atomic");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    let src = tmp.join("mixed.json");
    // A good bookmark followed by a row violating NOT NULL → the whole import rolls back.
    std::fs::write(
        &src,
        r#"{"version":1,"exportedAt":1,"highlights":[],"notes":[],"bookmarks":[
            {"id":1,"bookUid":"b","chapterIdx":0,"cfi":"ok","label":null,"createdAt":1},
            {"id":2,"bookUid":null,"chapterIdx":0,"cfi":"bad","label":null,"createdAt":2}]}"#,
    )
    .unwrap();
    assert!(backup::import_annotations_conn(&conn, src.to_str().unwrap()).is_err());
    assert_eq!(counts(&conn), (0, 0, 0), "no partial import");
}

#[test]
fn import_tolerates_missing_sections() {
    let tmp = TempDir::new("imp-thin");
    let paths = test_paths(&tmp);
    let conn = open_db(&paths);
    let src = tmp.join("thin.json");
    std::fs::write(
        &src,
        r#"{"version":1,"exportedAt":1,"bookmarks":[
            {"id":1,"bookUid":"b","chapterIdx":3,"cfi":"c","label":"x","createdAt":9}]}"#,
    )
    .unwrap();
    let n = backup::import_annotations_conn(&conn, src.to_str().unwrap()).expect("import");
    assert_eq!(n, 1);
    assert_eq!(counts(&conn), (0, 0, 1));
}

#[test]
fn export_import_between_two_databases() {
    // The realistic restore path: export from one db, import into a *different* one.
    let tmp = TempDir::new("cross-db");
    let src_paths = test_paths(&tmp);
    let src_conn = open_db(&src_paths);
    seed_annotations(&src_conn);

    let dest = tmp.join("transfer.json");
    backup::export_annotations_conn(&src_conn, None, dest.to_str().unwrap(), "json")
        .expect("export");

    let dst_dir = TempDir::new("cross-db-target");
    let dst_paths = test_paths(&dst_dir);
    let dst_conn = open_db(&dst_paths);
    assert_eq!(counts(&dst_conn), (0, 0, 0));

    let n = backup::import_annotations_conn(&dst_conn, dest.to_str().unwrap()).expect("import");
    assert_eq!(n, 4);
    assert_eq!(counts(&dst_conn), (2, 1, 1));
    let note: String = dst_conn
        .query_row("SELECT note_text FROM notes", [], |r| r.get(0))
        .unwrap();
    assert_eq!(note, "важный момент");
}
