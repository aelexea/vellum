//! Settings (§4.1 `Settings`, §6.6 defaults, §11.5 signatures) — owned by B8.
//!
//! Scaffold provides: the full struct tree with `#[serde(default)]` everywhere (partial or
//! old JSON files never fail to load), a hand-written `Default` per §6.6, and **stub**
//! function bodies (load → Default, save → Ok, merge_patch → clone, list_fonts → []).
//! B8 implements real file IO, deep-merge and fc-list parsing.
//!
//! The struct tree itself is treated as frozen (dto.rs re-exports `Settings`).

use serde::{Deserialize, Serialize};

use crate::db::AppPaths;
use crate::dto::{FontFamily, LibrarySort, ProviderConfig, ReadMode, Theme};
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Leaf enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Left,
    #[default]
    Justify,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum PageTurn {
    #[default]
    Slide,
    Fade,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LibraryView {
    #[default]
    Grid,
    List,
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiSettings {
    pub theme_id: String,
    pub custom_themes: Vec<Theme>,
    pub animations: bool,
    pub auto_hide_chrome: bool,
}

impl Default for UiSettings {
    fn default() -> Self {
        Self {
            // §6.6: 'light' default (first run may honor prefers-color-scheme on FE).
            theme_id: "light".into(),
            custom_themes: vec![],
            animations: true,
            auto_hide_chrome: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MarginsPx {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

impl Default for MarginsPx {
    fn default() -> Self {
        // §6.6: {top:28, right:40, bottom:28, left:40}
        Self {
            top: 28.0,
            right: 40.0,
            bottom: 28.0,
            left: 40.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PageSettings {
    pub font_family: String,
    pub font_size_px: f64,
    pub font_weight: u32,
    pub line_height: f64,
    pub letter_spacing_em: f64,
    pub text_align: TextAlign,
    pub paragraph_indent_em: f64,
    pub paragraph_spacing_em: f64,
    pub hyphenate: bool,
    /// 40..100
    pub page_width_pct: f64,
    pub scroll_max_width_px: f64,
    pub margins_px: MarginsPx,
    /// §11.5 overrides — null means "from theme".
    pub text_color_override: Option<String>,
    pub background_color_override: Option<String>,
    pub link_color_override: Option<String>,
}

impl Default for PageSettings {
    fn default() -> Self {
        // §6.6
        Self {
            font_family: "serif".into(),
            font_size_px: 19.0,
            font_weight: 400,
            line_height: 1.65,
            letter_spacing_em: 0.0,
            text_align: TextAlign::Justify,
            paragraph_indent_em: 1.2,
            paragraph_spacing_em: 0.6,
            hyphenate: true,
            page_width_pct: 100.0,
            scroll_max_width_px: 720.0,
            margins_px: MarginsPx::default(),
            text_color_override: None,
            background_color_override: None,
            link_color_override: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ReadingSettings {
    pub mode: ReadMode,
    pub page_turn: PageTurn,
    pub prefetch: bool,
    pub wheel_turns_page: bool,
    pub click_zones: bool,
}

impl Default for ReadingSettings {
    fn default() -> Self {
        // §6.6
        Self {
            mode: ReadMode::Paginated,
            page_turn: PageTurn::Slide,
            prefetch: true,
            wheel_turns_page: true,
            click_zones: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TranslateSettings {
    pub default_provider_id: String,
    pub default_target_lang: String,
    pub popup_on_select: bool,
    pub providers: std::collections::HashMap<String, ProviderConfig>,
}

impl Default for TranslateSettings {
    fn default() -> Self {
        // §6.6
        Self {
            default_provider_id: "google".into(),
            default_target_lang: "ru".into(),
            popup_on_select: false,
            providers: std::collections::HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DictionarySettings {
    pub default_provider_id: String,
}

impl Default for DictionarySettings {
    fn default() -> Self {
        Self {
            default_provider_id: "dictionaryapi".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VocabSettings {
    pub suggest_after_lookups: u32,
    pub daily_review_limit: u32,
}

impl Default for VocabSettings {
    fn default() -> Self {
        // §6.6
        Self {
            suggest_after_lookups: 3,
            daily_review_limit: 50,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibrarySettings {
    pub watched_dirs: Vec<String>,
    pub view: LibraryView,
    pub sort: LibrarySort,
    pub sort_desc: bool,
}

impl Default for LibrarySettings {
    fn default() -> Self {
        // §6.6: view 'grid', sort 'lastOpened' desc, watchedDirs []
        Self {
            watched_dirs: vec![],
            view: LibraryView::Grid,
            sort: LibrarySort::LastOpened,
            sort_desc: true,
        }
    }
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub ui: UiSettings,
    pub page: PageSettings,
    pub reading: ReadingSettings,
    pub translate: TranslateSettings,
    pub dictionary: DictionarySettings,
    pub vocab: VocabSettings,
    pub library: LibrarySettings,
    /// action id → combo (§5.10).
    pub shortcuts: std::collections::HashMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ui: UiSettings::default(),
            page: PageSettings::default(),
            reading: ReadingSettings::default(),
            translate: TranslateSettings::default(),
            dictionary: DictionarySettings::default(),
            vocab: VocabSettings::default(),
            library: LibrarySettings::default(),
            shortcuts: default_shortcuts(),
        }
    }
}

/// §5.10 default shortcut map.
fn default_shortcuts() -> std::collections::HashMap<String, String> {
    use std::collections::HashMap;
    HashMap::from(
        [
            ("nextPage", "Right"),
            ("prevPage", "Left"),
            ("nextPageAlt", "PageDown"),
            ("prevPageAlt", "PageUp"),
            ("spaceNext", "Space"),
            ("nextChapter", "Ctrl+Right"),
            ("prevChapter", "Ctrl+Left"),
            ("toggleSearch", "Ctrl+F"),
            ("toggleToc", "Ctrl+T"),
            ("toggleAnnotations", "Ctrl+Shift+A"),
            ("fontInc", "Ctrl+="),
            ("fontDec", "Ctrl+-"),
            ("cycleTheme", "Ctrl+J"),
            ("toggleMode", "Ctrl+Shift+M"),
            ("toggleUi", "Ctrl+H"),
            ("fullscreen", "F11"),
            ("bookmark", "Ctrl+D"),
            ("translate", "Ctrl+Shift+T"),
            ("dictionary", "Ctrl+Shift+D"),
            ("addVocab", "Ctrl+Shift+V"),
            ("openSettings", "Ctrl+,"),
            ("backToLibrary", "Ctrl+L"),
            ("startReview", "Ctrl+Shift+R"),
            ("quit", "Ctrl+Q"),
        ]
        .map(|(k, v)| (k.to_owned(), v.to_owned())),
    )
}

// ---------------------------------------------------------------------------
// Functions (§11.5)
// ---------------------------------------------------------------------------

/// File name inside `config_dir` (§4.7).
pub const FILE_NAME: &str = "settings.json";

/// `{config_dir}/settings.json`.
pub fn path(paths: &AppPaths) -> std::path::PathBuf {
    paths.config_dir.join(FILE_NAME)
}

/// JSON object paths whose keys are **data**, not schema: a key absent from the defaults
/// is legitimate there (a new shortcut binding, a new provider id) and must be merged in
/// rather than counted as unknown.
const DYNAMIC_MAP_PATHS: &[&[&str]] = &[&["shortcuts"], &["translate", "providers"]];

/// Read `config_dir/settings.json`, deep-merge over the §6.6 defaults; never fails.
///
/// * file missing → `Settings::default()`
/// * partial JSON → absent fields keep their defaults (merge, not replace)
/// * corrupt JSON (unparsable, not an object, or a field of the wrong type) → the file is
///   renamed to `settings.json.bak-{now_ms}` so the user does not lose it, the reason goes
///   to stderr, and the defaults are returned.
pub fn load(paths: &AppPaths) -> Settings {
    let file = path(paths);
    let raw = match std::fs::read(&file) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Settings::default(),
        Err(e) => {
            eprintln!("[vellum] settings: cannot read {}: {e}", file.display());
            return Settings::default();
        }
    };

    let value: serde_json::Value = match serde_json::from_slice(&raw) {
        Ok(value) => value,
        Err(e) => return quarantine(&file, &format!("invalid JSON: {e}")),
    };
    if !value.is_object() {
        return quarantine(&file, "top-level JSON value is not an object");
    }
    match settings_from_value(value) {
        Ok(merged) => merged,
        // Valid JSON, but a field has a type the struct rejects (e.g. `"fontSizePx": "big"`).
        Err(e) => quarantine(&file, &format!("unusable values: {e}")),
    }
}

/// Park a broken settings file next to itself as `settings.json.bak-{now_ms}`, log to
/// stderr and hand back the defaults (§4.7: loading never fails).
fn quarantine(file: &std::path::Path, reason: &str) -> Settings {
    let backup = file.with_file_name(format!("{}.bak-{}", FILE_NAME, crate::db::now_ms()));
    match std::fs::rename(file, &backup) {
        Ok(()) => eprintln!(
            "[vellum] settings: {reason}; moved {} → {}",
            file.display(),
            backup.display()
        ),
        Err(e) => eprintln!(
            "[vellum] settings: {reason}; could not move {} aside: {e}",
            file.display()
        ),
    }
    Settings::default()
}

/// Atomic persist: write `settings.json.tmp` → fsync → rename over the real file (§4.7).
/// A crash mid-write therefore leaves either the old or the new file, never a torn one.
pub fn save(paths: &AppPaths, s: &Settings) -> anyhow::Result<()> {
    use std::io::Write;

    std::fs::create_dir_all(&paths.config_dir)?;
    let final_path = path(paths);
    let tmp = final_path.with_file_name(format!("{FILE_NAME}.tmp"));

    let json = serde_json::to_string_pretty(s)?;
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(json.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, &final_path)?;
    // Best effort: make the rename itself durable. Not fatal when the platform refuses.
    if let Ok(dir) = std::fs::File::open(&paths.config_dir) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// Deep-merge a JSON patch into `current` (§4.7 `save_settings`).
///
/// Objects merge recursively, arrays and scalars **replace**, an explicit `null` sets the
/// field to null (which is how the §11.5 `Option<String>` colour overrides are cleared),
/// and keys that are not part of the schema are ignored — their count goes to stderr.
/// Use [`merge_patch_counted`] to get that count programmatically.
pub fn merge_patch(current: &Settings, patch: serde_json::Value) -> anyhow::Result<Settings> {
    let (merged, unknown) = merge_patch_counted(current, patch)?;
    if unknown > 0 {
        eprintln!("[vellum] settings: ignored {unknown} unknown key(s) in patch");
    }
    Ok(merged)
}

/// [`merge_patch`] plus the number of ignored unknown keys.
pub fn merge_patch_counted(
    current: &Settings,
    patch: serde_json::Value,
) -> anyhow::Result<(Settings, usize)> {
    let mut base = serde_json::to_value(current)?;
    if !patch.is_object() {
        // Nothing to merge (the frontend always sends an object); keep settings as they are.
        if !patch.is_null() {
            eprintln!("[vellum] settings: patch is not an object, ignoring");
        }
        return Ok((current.clone(), 0));
    }
    let mut unknown = 0usize;
    deep_merge(&mut base, &patch, &[], &mut unknown);
    Ok((settings_from_value(base)?, unknown))
}

/// Merge a JSON object over the §6.6 defaults and type-check the result.
pub fn settings_from_value(value: serde_json::Value) -> anyhow::Result<Settings> {
    let mut base = serde_json::to_value(Settings::default())?;
    let mut unknown = 0usize;
    if value.is_object() {
        deep_merge(&mut base, &value, &[], &mut unknown);
        if unknown > 0 {
            eprintln!("[vellum] settings: ignored {unknown} unknown key(s) in file");
        }
    }
    Ok(serde_json::from_value(base)?)
}

/// Recursive object merge: both sides objects → descend, otherwise `patch` wins.
/// Keys unknown to the schema are counted and skipped, except inside [`DYNAMIC_MAP_PATHS`].
fn deep_merge(
    base: &mut serde_json::Value,
    patch: &serde_json::Value,
    path: &[&str],
    unknown: &mut usize,
) {
    let (Some(base_obj), Some(patch_obj)) = (base.as_object_mut(), patch.as_object()) else {
        *base = patch.clone();
        return;
    };
    let dynamic = DYNAMIC_MAP_PATHS.contains(&path);

    for (key, value) in patch_obj {
        if !dynamic && !base_obj.contains_key(key) {
            *unknown += 1;
            continue;
        }
        match base_obj.get_mut(key) {
            Some(slot) if slot.is_object() && value.is_object() => {
                let child: Vec<&str> = path.iter().copied().chain([key.as_str()]).collect();
                deep_merge(slot, value, &child, unknown);
            }
            Some(slot) => *slot = value.clone(),
            // A new key of a dynamic map (shortcut binding / provider id).
            None => {
                base_obj.insert(key.clone(), value.clone());
            }
        }
    }
}

/// fc-list parse, cached in `state.fonts` (§4.7). Thin wrapper over [`crate::fonts`].
pub fn list_fonts(state: &AppState) -> Vec<FontFamily> {
    crate::fonts::list_fonts(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_contract_6_6() {
        let s = Settings::default();
        assert_eq!(s.ui.theme_id, "light");
        assert_eq!(s.page.font_size_px, 19.0);
        assert_eq!(s.page.line_height, 1.65);
        assert_eq!(s.page.font_family, "serif");
        assert_eq!(s.page.text_align, TextAlign::Justify);
        assert!(s.page.hyphenate);
        assert_eq!(s.page.margins_px.top, 28.0);
        assert_eq!(s.reading.mode, ReadMode::Paginated);
        assert!(!s.reading.click_zones);
        assert_eq!(s.translate.default_provider_id, "google");
        assert_eq!(s.translate.default_target_lang, "ru");
        assert_eq!(s.dictionary.default_provider_id, "dictionaryapi");
        assert_eq!(s.vocab.suggest_after_lookups, 3);
        assert_eq!(s.vocab.daily_review_limit, 50);
        assert_eq!(s.library.view, LibraryView::Grid);
        assert!(s.library.sort_desc);
        assert_eq!(
            s.shortcuts.get("fullscreen").map(String::as_str),
            Some("F11")
        );
        assert_eq!(
            s.shortcuts.get("translate").map(String::as_str),
            Some("Ctrl+Shift+T")
        );
        assert_eq!(s.shortcuts.len(), 24);
    }

    #[test]
    fn serializes_camel_case() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        let page = &v["page"];
        assert!(page.get("fontSizePx").is_some());
        assert!(page.get("marginsPx").is_some());
        assert!(page.get("textColorOverride").is_some());
        assert_eq!(v["ui"]["themeId"], "light");
        assert_eq!(v["reading"]["pageTurn"], "slide");
        assert_eq!(v["translate"]["defaultProviderId"], "google");
        assert_eq!(v["library"]["sort"], "lastOpened");
        assert_eq!(v["vocab"]["suggestAfterLookups"], 3);
    }

    #[test]
    fn partial_json_fills_defaults() {
        // old/partial file: only a few keys present
        let partial = r##"{
            "ui": {"themeId": "dark"},
            "page": {"fontSizePx": 22, "textColorOverride": "#112233"},
            "shortcuts": {"fullscreen": "F12"}
        }"##;
        let s: Settings = serde_json::from_str(partial).unwrap();
        assert_eq!(s.ui.theme_id, "dark");
        assert!(s.ui.animations, "missing field → default");
        assert_eq!(s.page.font_size_px, 22.0);
        assert_eq!(s.page.line_height, 1.65);
        assert_eq!(s.page.text_color_override.as_deref(), Some("#112233"));
        assert_eq!(s.page.background_color_override, None);
        // note: with container-level `default`, a present `shortcuts` map replaces the
        // whole default map (documented; B8's merge_patch handles per-key merging).
        assert_eq!(
            s.shortcuts.get("fullscreen").map(String::as_str),
            Some("F12")
        );
        assert_eq!(s.reading.mode, ReadMode::Paginated);
    }

    #[test]
    fn empty_json_is_defaults() {
        let s: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(s, Settings::default());
    }

    #[test]
    fn roundtrip_full() {
        let s = Settings::default();
        let json = serde_json::to_string(&s).unwrap();
        let back: Settings = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    // -----------------------------------------------------------------------
    // B8 §8: load (partial + corrupt), merge_patch (deep), save (atomic)
    // -----------------------------------------------------------------------

    fn temp_paths(tag: &str) -> AppPaths {
        let root = std::env::temp_dir().join(format!(
            "vellum-b8-settings-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let config_dir = root.join("config");
        std::fs::create_dir_all(&config_dir).expect("create config dir");
        AppPaths {
            data_dir: root.join("data"),
            config_dir,
            cache_dir: root.join("cache"),
            covers_dir: root.join("cache/covers"),
            backups_dir: root.join("data/backups"),
            db_path: root.join("data/vellum.db"),
        }
    }

    fn write_settings_file(paths: &AppPaths, body: &str) {
        std::fs::write(path(paths), body).expect("write settings.json");
    }

    #[test]
    fn load_missing_file_gives_defaults_and_no_file_created() {
        let paths = temp_paths("missing");
        let s = load(&paths);
        assert_eq!(s, Settings::default());
        assert!(!path(&paths).exists(), "load must not create the file");
    }

    #[test]
    fn load_partial_file_fills_rest_with_defaults() {
        let paths = temp_paths("partial");
        write_settings_file(
            &paths,
            r#"{"ui":{"themeId":"dark"},"page":{"fontSizePx":22},"vocab":{"dailyReviewLimit":77}}"#,
        );
        let s = load(&paths);

        // the three patched fields
        assert_eq!(s.ui.theme_id, "dark");
        assert_eq!(s.page.font_size_px, 22.0);
        assert_eq!(s.vocab.daily_review_limit, 77);
        // everything else is still §6.6
        assert!(s.ui.animations);
        assert!(s.ui.auto_hide_chrome);
        assert_eq!(s.page.line_height, 1.65);
        assert_eq!(s.page.margins_px.left, 40.0);
        assert_eq!(s.reading.mode, ReadMode::Paginated);
        assert_eq!(s.translate.default_target_lang, "ru");
        assert_eq!(s.shortcuts.len(), 24, "shortcut map untouched");
        assert_eq!(s.shortcuts.get("quit").map(String::as_str), Some("Ctrl+Q"));
    }

    #[test]
    fn load_partial_nested_object_keeps_siblings() {
        let paths = temp_paths("nested");
        // only marginsPx.top given → right/bottom/left must stay default
        write_settings_file(&paths, r#"{"page":{"marginsPx":{"top":10}}}"#);
        let s = load(&paths);
        assert_eq!(s.page.margins_px.top, 10.0);
        assert_eq!(s.page.margins_px.right, 40.0);
        assert_eq!(s.page.margins_px.bottom, 28.0);
        assert_eq!(s.page.margins_px.left, 40.0);
    }

    #[test]
    fn load_corrupt_json_falls_back_to_defaults_and_creates_bak() {
        let paths = temp_paths("corrupt");
        write_settings_file(&paths, "{\"ui\": { this is not json ,,}");
        let s = load(&paths);

        assert_eq!(s, Settings::default(), "corrupt file → defaults, never Err");
        assert!(!path(&paths).exists(), "corrupt file was moved aside");

        let baks: Vec<_> = std::fs::read_dir(&paths.config_dir)
            .expect("read config dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("settings.json.bak-"))
            .collect();
        assert_eq!(baks.len(), 1, "exactly one .bak file, got {baks:?}");
        let saved = std::fs::read_to_string(paths.config_dir.join(&baks[0])).unwrap();
        assert!(
            saved.contains("this is not json"),
            "original bytes preserved"
        );
    }

    #[test]
    fn load_non_object_json_is_treated_as_corrupt() {
        let paths = temp_paths("array");
        write_settings_file(&paths, "[1,2,3]");
        assert_eq!(load(&paths), Settings::default());
        assert!(!path(&paths).exists());
    }

    #[test]
    fn load_wrong_typed_field_is_treated_as_corrupt() {
        let paths = temp_paths("badtype");
        write_settings_file(&paths, r#"{"page":{"fontSizePx":"huge"}}"#);
        assert_eq!(load(&paths), Settings::default());
        assert!(!path(&paths).exists());
    }

    #[test]
    fn load_ignores_unknown_keys_from_older_or_newer_versions() {
        let paths = temp_paths("unknown");
        write_settings_file(
            &paths,
            r#"{"ui":{"themeId":"sepia","futureFlag":true},"totallyNew":{"a":1},"page":{"nope":2}}"#,
        );
        let s = load(&paths);
        assert_eq!(s.ui.theme_id, "sepia");
        assert_eq!(s, {
            let mut expected = Settings::default();
            expected.ui.theme_id = "sepia".into();
            expected
        });
    }

    #[test]
    fn save_creates_file_and_roundtrips_every_field() {
        let paths = temp_paths("save");
        let mut s = Settings::default();
        s.ui.theme_id = "oled".into();
        s.page.font_size_px = 23.5;
        s.page.margins_px.bottom = 7.0;
        s.page.text_color_override = Some("#123456".into());
        s.translate.providers.insert(
            "libre".into(),
            ProviderConfig {
                enabled: true,
                base_url: Some("https://libre.example/translate".into()),
                api_key: None,
            },
        );
        s.shortcuts.insert("quit".into(), "Ctrl+Alt+Q".into());

        save(&paths, &s).expect("save ok");

        let on_disk = std::fs::read_to_string(path(&paths)).expect("file exists");
        let back: Settings = serde_json::from_str(&on_disk).expect("parses");
        assert_eq!(back, s, "full content roundtrips");
        assert!(
            on_disk.contains("\"themeId\": \"oled\""),
            "camelCase on disk"
        );
    }

    #[test]
    fn save_is_atomic_leaves_no_tmp_and_overwrites() {
        let paths = temp_paths("atomic");
        let tmp = path(&paths).with_file_name("settings.json.tmp");

        save(&paths, &Settings::default()).expect("first save");
        assert!(path(&paths).exists());
        assert!(!tmp.exists(), "tmp file cleaned up by rename");

        // second save overwrites the first
        let mut s2 = Settings::default();
        s2.ui.theme_id = "dark".into();
        save(&paths, &s2).expect("second save");
        assert_eq!(load(&paths).ui.theme_id, "dark");
        assert!(!tmp.exists());

        let entries: Vec<_> = std::fs::read_dir(&paths.config_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            entries,
            vec!["settings.json".to_string()],
            "got {entries:?}"
        );
    }

    #[test]
    fn save_creates_config_dir_when_absent() {
        let mut paths = temp_paths("nodir");
        let _ = std::fs::remove_dir_all(&paths.config_dir);
        paths.config_dir = paths.config_dir.join("nested/deeper");
        save(&paths, &Settings::default()).expect("save creates dirs");
        assert!(path(&paths).exists());
    }

    #[test]
    fn load_then_save_preserves_settings() {
        let paths = temp_paths("loadsave");
        write_settings_file(&paths, r#"{"page":{"fontSizePx":30,"lineHeight":2.0}}"#);
        let s = load(&paths);
        save(&paths, &s).expect("save");
        let again = load(&paths);
        assert_eq!(again, s);
        assert_eq!(again.page.font_size_px, 30.0);
    }

    #[test]
    fn merge_patch_deep_nested_partial() {
        let current = Settings::default();
        let patch = serde_json::json!({
            "ui": {"themeId": "sepia"},
            "page": {"marginsPx": {"top": 4}},
            "reading": {"clickZones": true}
        });
        let (merged, unknown) = merge_patch_counted(&current, patch).unwrap();

        assert_eq!(merged.ui.theme_id, "sepia");
        assert!(merged.ui.animations, "sibling of patched key keeps default");
        assert_eq!(merged.page.margins_px.top, 4.0);
        assert_eq!(merged.page.margins_px.right, 40.0, "untouched margin side");
        assert_eq!(merged.page.margins_px.left, 40.0);
        assert_eq!(merged.page.font_size_px, 19.0);
        assert!(merged.reading.click_zones);
        assert!(merged.reading.wheel_turns_page);
        assert_eq!(unknown, 0);
    }

    #[test]
    fn merge_patch_arrays_replace_not_concat() {
        let mut current = Settings::default();
        current.library.watched_dirs = vec!["/books/a".into(), "/books/b".into()];
        let patch = serde_json::json!({"library": {"watchedDirs": ["/only/one"]}});
        let merged = merge_patch(&current, patch).unwrap();
        assert_eq!(merged.library.watched_dirs, vec!["/only/one".to_string()]);

        // empty array clears, it does not restore the old one
        let cleared =
            merge_patch(&merged, serde_json::json!({"library": {"watchedDirs": []}})).unwrap();
        assert!(cleared.library.watched_dirs.is_empty());
    }

    #[test]
    fn merge_patch_null_clears_option_override() {
        let mut current = Settings::default();
        current.page.text_color_override = Some("#ff0000".into());
        current.page.link_color_override = Some("#00ff00".into());

        let patch = serde_json::json!({"page": {"textColorOverride": null}});
        let merged = merge_patch(&current, patch).unwrap();
        assert_eq!(merged.page.text_color_override, None, "null sets to null");
        assert_eq!(
            merged.page.link_color_override.as_deref(),
            Some("#00ff00"),
            "other override untouched"
        );

        // and a value can be set again afterwards
        let back = merge_patch(
            &merged,
            serde_json::json!({"page": {"textColorOverride": "#0000ff"}}),
        )
        .unwrap();
        assert_eq!(back.page.text_color_override.as_deref(), Some("#0000ff"));
    }

    #[test]
    fn merge_patch_unknown_keys_ignored_and_counted() {
        let current = Settings::default();
        let patch = serde_json::json!({
            "ui": {"themeId": "dark", "nope": 1},
            "bogus": {"a": 1},
            "page": {"fontSizePx": 21, "madeUp": true}
        });
        let (merged, unknown) = merge_patch_counted(&current, patch).unwrap();
        assert_eq!(merged.ui.theme_id, "dark");
        assert_eq!(merged.page.font_size_px, 21.0);
        assert_eq!(unknown, 3, "nope + bogus + madeUp");
        // the valid parts of an object that also had junk still applied
        assert!(merged.ui.animations);
    }

    #[test]
    fn merge_patch_shortcut_map_merges_per_key() {
        let current = Settings::default();
        let patch =
            serde_json::json!({"shortcuts": {"fullscreen": "F12", "customAction": "Ctrl+K"}});
        let merged = merge_patch(&current, patch).unwrap();
        assert_eq!(
            merged.shortcuts.get("fullscreen").map(String::as_str),
            Some("F12")
        );
        assert_eq!(
            merged.shortcuts.get("customAction").map(String::as_str),
            Some("Ctrl+K")
        );
        assert_eq!(merged.shortcuts.len(), 25, "24 defaults + 1 new binding");
        assert_eq!(
            merged.shortcuts.get("quit").map(String::as_str),
            Some("Ctrl+Q")
        );
    }

    #[test]
    fn merge_patch_provider_map_merges_per_key() {
        let current = Settings::default();
        let patch = serde_json::json!({
            "translate": {
                "defaultTargetLang": "en",
                "providers": {"libre": {"enabled": true, "baseUrl": "https://x", "apiKey": "k"}}
            }
        });
        let merged = merge_patch(&current, patch).unwrap();
        assert_eq!(merged.translate.default_target_lang, "en");
        let libre = merged
            .translate
            .providers
            .get("libre")
            .expect("provider present");
        assert!(libre.enabled);
        assert_eq!(libre.base_url.as_deref(), Some("https://x"));
        assert_eq!(libre.api_key.as_deref(), Some("k"));
    }

    #[test]
    fn merge_patch_empty_object_is_identity() {
        let current = Settings::default();
        let merged = merge_patch(&current, serde_json::json!({})).unwrap();
        assert_eq!(merged, current);
        assert_eq!(
            merge_patch(&current, serde_json::Value::Null).unwrap(),
            current
        );
    }

    #[test]
    fn merge_patch_type_mismatch_is_an_error() {
        // §11.5 gives merge_patch a Result: an invalid patch surfaces to the caller
        // (→ AppError → toast) instead of silently resetting a whole section.
        // `load` is the tolerant path (corrupt file → defaults + .bak).
        let current = Settings::default();
        assert!(merge_patch(&current, serde_json::json!({"page": 5})).is_err());
        assert!(merge_patch(&current, serde_json::json!({"page": {"fontSizePx": "big"}})).is_err());
        assert!(merge_patch(
            &current,
            serde_json::json!({"vocab": {"dailyReviewLimit": -1}})
        )
        .is_err());
        // and a valid patch right after still works
        assert_eq!(
            merge_patch(&current, serde_json::json!({"page": {"fontSizePx": 17}}))
                .unwrap()
                .page
                .font_size_px,
            17.0
        );
    }

    #[test]
    fn merge_patch_persisted_then_reloaded() {
        let paths = temp_paths("patchpersist");
        let current = load(&paths);
        let merged = merge_patch(
            &current,
            serde_json::json!({"ui":{"themeId":"oled"},"vocab":{"suggestAfterLookups":9}}),
        )
        .unwrap();
        save(&paths, &merged).expect("save");
        assert_eq!(load(&paths), merged);
    }

    #[test]
    fn merge_patch_result_is_valid_settings_json() {
        let merged = merge_patch(
            &Settings::default(),
            serde_json::json!({"page": {"fontSizePx": 15.5, "fontWeight": 700}}),
        )
        .unwrap();
        let v = serde_json::to_value(&merged).unwrap();
        assert_eq!(v["page"]["fontSizePx"], 15.5);
        assert_eq!(v["page"]["fontWeight"], 700);
    }
}
