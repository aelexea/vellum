//! Frozen DTOs (§4.1, mirrored 1:1 from the TS normative types) plus command-argument
//! structs (§4.8) and the smoke-test config (integration).
//!
//! Conventions (§2): every struct is `#[serde(rename_all = "camelCase")]`; numeric ids and
//! unix-ms timestamps are `i64`; fractions are `f64`. `Settings` lives in `crate::settings`
//! (§11.5) and is re-exported here so `dto::Settings` resolves for all consumers.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub use crate::settings::Settings;

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookMeta {
    pub uid: String,
    pub title: String,
    pub authors: Vec<String>,
    pub path: String,
    /// `vellum://covers/{uid}` or null.
    pub cover_url: Option<String>,
    /// 0..1
    pub progress: f64,
    pub position_chapter_idx: Option<i64>,
    pub total_chapters: i64,
    /// unix ms
    pub added_at: i64,
    pub last_opened_at: Option<i64>,
    pub tags: Vec<String>,
    pub size_bytes: i64,
    /// file no longer on disk
    pub missing: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TocEntry {
    pub title: String,
    /// spine position of the target href, or -1 when unresolved (UI hides those).
    pub chapter_idx: i64,
    pub cfi: Option<String>,
    pub level: i64,
    /// index into the flat toc vec (0-based) or null.
    pub parent_idx: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChapterMeta {
    pub idx: i64,
    pub href: String,
    pub title: Option<String>,
    pub char_count: Option<i64>,
}

/// `BookDetail extends BookMeta` in TS — flattened here so the JSON shape matches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookDetail {
    #[serde(flatten)]
    pub meta: BookMeta,
    pub toc: Vec<TocEntry>,
    pub chapters: Vec<ChapterMeta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub count: i64,
}

/// Sort key for library listings (`LibraryFilter['sort']`, also `Settings.library.sort`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum LibrarySort {
    #[default]
    LastOpened,
    Title,
    Author,
    Progress,
    Added,
    Percent,
}

/// Which missing-file books to include in a listing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum MissingFilter {
    Hide,
    Only,
    #[default]
    All,
}

/// `list_books` argument struct (§4.8). Deserialized from camelCase JS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LibraryFilter {
    pub query: Option<String>,
    pub tag: Option<String>,
    pub sort: LibrarySort,
    pub sort_desc: bool,
    pub missing: MissingFilter,
}

impl Default for LibraryFilter {
    fn default() -> Self {
        Self {
            query: None,
            tag: None,
            sort: LibrarySort::LastOpened,
            // §6.6: library default sort is 'lastOpened' desc.
            sort_desc: true,
            missing: MissingFilter::All,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportIssue {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub imported: Vec<BookMeta>,
    pub skipped: Vec<ImportIssue>,
    pub failed: Vec<ImportIssue>,
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReadMode {
    #[default]
    Paginated,
    Scroll,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPosition {
    pub cfi: Option<String>,
    pub chapter_idx: i64,
    /// 0..1
    pub pct_within_chapter: f64,
    /// paginated mode only
    pub page_index: Option<i64>,
    pub page_count: Option<i64>,
    pub mode: ReadMode,
    /// whole-book progress 0..1
    pub global_pct: f64,
    pub saved_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenBook {
    pub book: BookDetail,
    pub position: Option<ReadingPosition>,
    pub highlights: Vec<Highlight>,
    pub notes: Vec<Note>,
    pub bookmarks: Vec<Bookmark>,
    pub index_status: IndexStatus,
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: i64,
    pub book_uid: String,
    pub chapter_idx: i64,
    pub cfi_start: String,
    pub cfi_end: String,
    pub color: String,
    /// The highlighted text itself (F5 FCR) — so the annotations list can quote it
    /// without re-deriving from CFIs. Defaults to "" for rows created before v1.3.
    #[serde(default)]
    pub text: String,
    pub created_at: i64,
    pub has_note: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: i64,
    pub book_uid: String,
    pub chapter_idx: i64,
    pub cfi_start: String,
    pub cfi_end: String,
    pub selected_text: String,
    pub note_text: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: i64,
    pub book_uid: String,
    pub chapter_idx: i64,
    pub cfi: String,
    pub label: Option<String>,
    pub created_at: i64,
}

// ---------------------------------------------------------------------------
// Search / indexing
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum IndexState {
    #[default]
    None,
    Indexing,
    Ready,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub state: IndexState,
    pub chapters_done: i64,
    pub chapters_total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub chapter_idx: i64,
    pub chapter_title: String,
    /// HTML, matches wrapped in `<mark>`.
    pub snippet: String,
    pub score: f64,
}

// ---------------------------------------------------------------------------
// Translate / dictionary
// ---------------------------------------------------------------------------

/// `lookup_word` context argument (§4.8).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LookupContext {
    pub book_uid: String,
    pub chapter_idx: i64,
    pub sentence: String,
    pub cfi: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DictDefinition {
    pub definition: String,
    pub example: Option<String>,
    pub synonyms: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DictMeaning {
    pub pos: Option<String>,
    pub definitions: Vec<DictDefinition>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DictEntry {
    pub word: String,
    pub transcription: Option<String>,
    pub meanings: Vec<DictMeaning>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranslateResult {
    pub translated_text: String,
    pub detected_source_lang: String,
    pub target_lang: String,
    pub provider_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LookupResult {
    pub word: String,
    pub translation: Option<TranslateResult>,
    pub dictionary: Option<DictEntry>,
    pub lookup_count: i64,
    pub suggest_add: bool,
    pub already_in_vocab: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TranslatorKind {
    #[default]
    Translate,
    Dict,
    Both,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TranslatorInfo {
    pub id: String,
    pub name: String,
    pub kind: TranslatorKind,
    pub needs_config: bool,
    pub configured: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub enabled: bool,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
}

/// One row of the static language table (`list_languages` → `{code, nameRu}[]`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Lang {
    pub code: String,
    pub name_ru: String,
}

// ---------------------------------------------------------------------------
// Vocab / SRS
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum VocabStatus {
    #[default]
    New,
    Learning,
    Known,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VocabWord {
    pub id: i64,
    pub word: String,
    pub translation: Option<String>,
    pub definition: Option<String>,
    pub transcription: Option<String>,
    pub pos: Option<String>,
    pub examples: Vec<String>,
    pub book_uid: Option<String>,
    pub book_title: Option<String>,
    pub chapter_idx: Option<i64>,
    pub context: Option<String>,
    pub context_cfi: Option<String>,
    pub added_at: i64,
    pub status: VocabStatus,
    pub review_count: i64,
    pub interval_days: Option<f64>,
    /// SM-2 ease factor (SRS-managed, not user-editable) — surfaced so the UI can
    /// render accurate grade-interval previews.
    pub ease: f64,
    pub due_at: Option<i64>,
    pub last_reviewed_at: Option<i64>,
}

/// `update_vocab_word` patch (§4.8): only present fields are updated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VocabPatch {
    pub translation: Option<String>,
    pub definition: Option<String>,
    pub transcription: Option<String>,
    pub pos: Option<String>,
    pub examples: Option<Vec<String>>,
    pub status: Option<VocabStatus>,
    pub context: Option<String>,
    pub due_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VocabStatusCounts {
    pub new: i64,
    pub learning: i64,
    pub known: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VocabStats {
    pub total: i64,
    /// TS: `Record<'new'|'learning'|'known', number>` — fixed keys, so a struct.
    pub by_status: VocabStatusCounts,
    pub due_today: i64,
    pub reviews_today: i64,
    pub added_this_week: i64,
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DaySeconds {
    /// ISO yyyy-mm-dd, oldest first.
    pub date: String,
    pub seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStats {
    pub range_seconds: i64,
    pub by_day: Vec<DaySeconds>,
    pub pages_turned: i64,
    pub books_touched: i64,
    pub streak_days: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BookStats {
    pub total_seconds: i64,
    pub pages_turned: i64,
    pub first_opened_at: Option<i64>,
    pub last_opened_at: Option<i64>,
    pub progress: f64,
}

// ---------------------------------------------------------------------------
// Themes / fonts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThemeUi {
    pub bg: String,
    pub bg_alt: String,
    pub bg_raise: String,
    pub fg: String,
    pub fg_muted: String,
    pub accent: String,
    pub accent_fg: String,
    pub border: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ThemePage {
    pub bg: String,
    pub fg: String,
    pub link: String,
    pub selection_bg: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    pub id: String,
    pub name: String,
    pub builtin: bool,
    pub ui: ThemeUi,
    pub page: ThemePage,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub name: String,
    pub has_bold: bool,
    pub has_italic: bool,
    pub mono: bool,
}

// ---------------------------------------------------------------------------
// Smoke test config (integration; consumed by the frontend at boot)
// ---------------------------------------------------------------------------

/// Populated from `VELLUM_SMOKE_*` env vars by `commands::get_smoke_config`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SmokeConfig {
    pub book: Option<String>,
    pub view: Option<String>,
    pub overlay: Option<String>,
    pub theme: Option<String>,
}

/// Settings.translate.providers is keyed by provider id.
pub type ProviderMap = HashMap<String, ProviderConfig>;

/// Settings.shortcuts: action id → combo (§5.10/§6.8).
pub type ShortcutMap = HashMap<String, String>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn book_meta_camel_case_roundtrip() {
        let b = BookMeta {
            uid: "0a1b2c".into(),
            title: "Алиса".into(),
            authors: vec!["Lewis Carroll".into()],
            path: "/books/pg11.epub".into(),
            cover_url: Some("vellum://covers/0a1b2c".into()),
            progress: 0.25,
            position_chapter_idx: Some(3),
            total_chapters: 12,
            added_at: 1_700_000_000_000,
            last_opened_at: None,
            tags: vec!["классика".into()],
            size_bytes: 123456,
            missing: false,
        };
        let json = serde_json::to_string(&b).unwrap();
        // camelCase keys on the wire
        assert!(json.contains("\"coverUrl\""), "{json}");
        assert!(json.contains("\"positionChapterIdx\""), "{json}");
        assert!(json.contains("\"lastOpenedAt\":null"), "{json}");
        assert!(json.contains("\"sizeBytes\":123456"), "{json}");
        let back: BookMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(back, b);
    }

    #[test]
    fn book_detail_flattens_meta() {
        let d = BookDetail {
            meta: BookMeta {
                uid: "u".into(),
                title: "t".into(),
                ..Default::default()
            },
            toc: vec![TocEntry {
                title: "Глава 1".into(),
                chapter_idx: 0,
                ..Default::default()
            }],
            chapters: vec![],
        };
        let v: serde_json::Value = serde_json::to_value(&d).unwrap();
        let o = v.as_object().unwrap();
        // flattened: title sits next to toc/chapters at the top level
        assert_eq!(o.get("title").and_then(|x| x.as_str()), Some("t"));
        assert!(o.get("toc").is_some());
        assert!(o.get("meta").is_none());
    }

    #[test]
    fn library_filter_partial_json_uses_defaults() {
        let f: LibraryFilter = serde_json::from_str(r#"{"sortDesc":false}"#).unwrap();
        assert_eq!(f.sort, LibrarySort::LastOpened);
        assert!(!f.sort_desc);
        assert_eq!(f.missing, MissingFilter::All);
        assert!(f.query.is_none());

        let f2: LibraryFilter =
            serde_json::from_str(r#"{"query":"ali","sort":"percent","missing":"only"}"#).unwrap();
        assert_eq!(f2.query.as_deref(), Some("ali"));
        assert_eq!(f2.sort, LibrarySort::Percent);
        assert_eq!(f2.missing, MissingFilter::Only);
    }

    #[test]
    fn enum_wire_values_match_ts_unions() {
        assert_eq!(
            serde_json::to_string(&ReadMode::Paginated).unwrap(),
            "\"paginated\""
        );
        assert_eq!(
            serde_json::to_string(&LibrarySort::LastOpened).unwrap(),
            "\"lastOpened\""
        );
        assert_eq!(
            serde_json::to_string(&VocabStatus::Learning).unwrap(),
            "\"learning\""
        );
        assert_eq!(
            serde_json::to_string(&IndexState::None).unwrap(),
            "\"none\""
        );
        assert_eq!(
            serde_json::to_string(&TranslatorKind::Both).unwrap(),
            "\"both\""
        );
    }

    #[test]
    fn vocab_patch_and_lookup_context_deserialize() {
        let p: VocabPatch =
            serde_json::from_str(r#"{"translation":"слово","status":"known","dueAt":42}"#).unwrap();
        assert_eq!(p.translation.as_deref(), Some("слово"));
        assert_eq!(p.status, Some(VocabStatus::Known));
        assert_eq!(p.due_at, Some(42));
        assert!(p.definition.is_none());

        let c: LookupContext = serde_json::from_str(
            r#"{"bookUid":"u","chapterIdx":2,"sentence":"S","cfi":"epubcfi(/4/2)"}"#,
        )
        .unwrap();
        assert_eq!(c.book_uid, "u");
        assert_eq!(c.chapter_idx, 2);
    }

    #[test]
    fn smoke_config_camel_case() {
        let s = SmokeConfig {
            book: Some("uid".into()),
            view: Some("reader".into()),
            overlay: None,
            theme: Some("dark".into()),
        };
        let json = serde_json::to_string(&s).unwrap();
        assert!(json.contains("\"book\"") && json.contains("\"theme\""));
        let back: SmokeConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }
}
