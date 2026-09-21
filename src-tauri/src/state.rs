//! Frozen app state (§4.2). Managed by Tauri via `app.manage(state)`; commands take
//! `State<'_, AppState>`.
//!
//! Rules for WPs (§11.3): `db` lock is short-lived only; long jobs open their **own**
//! rusqlite connection to the same path (WAL). Never hold the main lock across `.await`.

use std::fs::File;
use std::io::BufReader;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use dashmap::DashMap;
use parking_lot::RwLock;
use tauri::{AppHandle, Manager};

use crate::db::{self, AppPaths};
use crate::dto::FontFamily;
use crate::settings::{self, Settings};

/// Cached open zip archives keyed by book uid (§4.3 pipeline; B2 `serve.rs` consumes).
pub type ZipCache = DashMap<String, Mutex<zip::ZipArchive<BufReader<File>>>>;

pub struct AppState {
    /// SQLite, WAL, busy_timeout 5 s.
    pub db: Mutex<rusqlite::Connection>,
    /// Open EPUB zip archives by uid.
    pub zips: ZipCache,
    /// Shared HTTP client: 15 s timeout, gzip, UA "Vellum/0.1".
    pub http: reqwest::Client,
    /// Live settings; persisted via `settings::save`.
    pub settings: RwLock<Settings>,
    /// XDG-derived directories + db path.
    pub paths: AppPaths,
    /// fc-list cache, filled once by `settings::list_fonts` (B8).
    pub fonts: OnceLock<Vec<FontFamily>>,
}

impl AppState {
    /// Build the state during `setup` (§4.9): paths → db open+migrate → settings load →
    /// http client.
    pub fn init(app: &AppHandle) -> anyhow::Result<Self> {
        let paths = db::init_paths(app);
        let conn = db::open(&paths)?;
        db::migrate(&conn)?;
        let loaded = settings::load(&paths);

        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .gzip(true)
            .user_agent("Vellum/0.1")
            .build()?;

        Ok(Self {
            db: Mutex::new(conn),
            zips: DashMap::new(),
            http,
            settings: RwLock::new(loaded),
            paths,
            fonts: OnceLock::new(),
        })
    }
}

/// Helper (§4.2): `state(app)` → managed `State<AppState>`.
pub fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a real (empty) zip in a temp file so the `ZipCache` map API can be exercised
    /// without touching `testbooks/`.
    fn empty_zip() -> Mutex<zip::ZipArchive<BufReader<File>>> {
        let path = std::env::temp_dir().join(format!(
            "vellum-state-test-{}-{:?}.zip",
            std::process::id(),
            std::thread::current().id()
        ));
        let file = File::create(&path).expect("create tmpfile");
        let zw = zip::ZipWriter::new(file);
        zw.finish().expect("finish empty zip");
        let file = File::open(&path).expect("reopen tmpfile");
        let _ = std::fs::remove_file(&path);
        Mutex::new(zip::ZipArchive::new(BufReader::new(file)).expect("open empty zip"))
    }

    #[test]
    fn zip_cache_insert_lookup_remove() {
        let zips: ZipCache = DashMap::new();
        assert!(zips.get("nope").is_none());
        zips.insert("uid".into(), empty_zip());
        {
            let entry = zips.get("uid").expect("present");
            let guard = entry.value().lock().expect("not poisoned");
            assert_eq!(guard.len(), 0);
        }
        assert!(zips.remove("uid").is_some());
        assert!(zips.get("uid").is_none());
    }
}
