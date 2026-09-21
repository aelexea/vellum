//! B7 integration tests (§8): provider response parsers vs saved fixture JSON,
//! registry/config resolution, language table + offline detect heuristic, and graceful
//! degradation when offline (`http://127.0.0.1:1` as baseUrl).
//!
//! Lives in `tests/` (not `#[cfg(test)] mod tests` inside `src/net/`) so it links against
//! `vellum_lib` as a normal rlib: it runs even while another WP's in-flight `cfg(test)`
//! module breaks the single lib-test binary. The in-module unit tests in `src/net/**`
//! cover the same seams more exhaustively (chunking, bd senses, URL encoding).
//!
//! No live network: every request in this file is aimed at `127.0.0.1:1`, which refuses
//! instantly, so the suite is deterministic and fast on an IP-blocked build host.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use parking_lot::RwLock;
use rusqlite::Connection;

use vellum_lib::db::AppPaths;
use vellum_lib::dto::{ProviderConfig, TranslatorKind};
use vellum_lib::net::dict::dictionaryapi;
use vellum_lib::net::translate::{google, libre, lingva};
use vellum_lib::net::{self, dict, languages, translate};
use vellum_lib::settings::{Settings, TranslateSettings};
use vellum_lib::AppState;

/// Dead port: connection refused, fails in microseconds.
const DEAD: &str = "http://127.0.0.1:1";

fn fixtures_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn fixture(name: &str) -> String {
    let path = fixtures_dir().join(name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("fixture {}: {e}", path.display()))
}

fn paths() -> AppPaths {
    let tmp = std::env::temp_dir();
    AppPaths {
        data_dir: tmp.clone(),
        config_dir: tmp.clone(),
        cache_dir: tmp.clone(),
        covers_dir: tmp.clone(),
        backups_dir: tmp.clone(),
        db_path: tmp.join("vellum-b7-it.db"),
    }
}

/// AppState wired entirely at `127.0.0.1:1`, so nothing here reaches the internet.
///
/// libre is the default translate provider (its base URL is configurable, unlike google's
/// hardcoded real endpoints, and the `detect` trait method takes no `ProviderConfig`);
/// google/lingva are disabled so the fallback chain can't escape to a live host.
fn offline_state() -> AppState {
    let mut settings = Settings::default();
    settings.translate.default_provider_id = "libre".to_owned();
    settings.translate.default_target_lang = "ru".to_owned();
    settings.translate.providers.insert(
        "libre".to_owned(),
        ProviderConfig {
            enabled: true,
            base_url: Some(DEAD.to_owned()),
            api_key: None,
        },
    );
    for id in ["google", "lingva"] {
        settings.translate.providers.insert(
            id.to_owned(),
            ProviderConfig {
                enabled: false,
                base_url: Some(DEAD.to_owned()),
                api_key: None,
            },
        );
    }
    settings.translate.providers.insert(
        "dictionaryapi".to_owned(),
        ProviderConfig {
            enabled: true,
            base_url: Some(format!("{DEAD}/api/v2/entries/en")),
            api_key: None,
        },
    );
    state_with(settings)
}

fn state_with(settings: Settings) -> AppState {
    AppState {
        db: Mutex::new(Connection::open_in_memory().expect("in-memory db")),
        zips: DashMap::new(),
        // 1 s timeout: connection-refused is instant, but never let a test hang
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(1))
            .build()
            .expect("client"),
        settings: RwLock::new(settings),
        paths: paths(),
        fonts: OnceLock::new(),
    }
}

fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tauri::async_runtime::block_on(f)
}

// ---------------------------------------------------------------------------
// §8 B7: provider response parsers vs saved fixture JSON
// ---------------------------------------------------------------------------

#[test]
fn google_parse_single_rich_fixture() {
    let r = google::parse_single(&fixture("b7_google_single.json")).expect("parse");
    // segments concatenated: "привет" + "здравствуйте"
    assert_eq!(r.translated_text, "приветздравствуйте");
    assert_eq!(r.detected_source_lang, "en");
    assert_eq!(r.provider_id, "google");
}

#[test]
fn google_parse_single_rejects_blocked_html_fixture() {
    // the real "Sorry…" page Google serves to a blocked IP must not parse
    assert!(google::parse_single(&fixture("b7_google_sorry.html")).is_err());
}

#[test]
fn google_parse_flat_auto_pair_fixture() {
    // real capture 2026-09: sl=auto → [["translated","detected"]]
    let r = google::parse_flat(&fixture("b7_google_flat_auto.json")).expect("parse");
    assert_eq!(r.translated_text, "привет");
    assert_eq!(r.detected_source_lang, "en");
}

#[test]
fn google_parse_flat_explicit_string_fixture() {
    // real capture 2026-09: explicit sl → ["translated"]
    let r = google::parse_flat(&fixture("b7_google_flat_explicit.json")).expect("parse");
    assert_eq!(r.translated_text, "Hallo");
    assert_eq!(r.detected_source_lang, "");
}

#[test]
fn google_parse_flat_object_fixture() {
    let r = google::parse_flat(&fixture("b7_google_flat_object.json")).expect("parse");
    assert_eq!(r.translated_text, "Привет, как дела? Меня зовут Джон.");
    assert_eq!(r.detected_source_lang, "en");
}

#[test]
fn lingva_parse_ok_and_error_fixtures() {
    let r = lingva::parse(&fixture("b7_lingva_ok.json")).expect("parse");
    assert_eq!(r.translated_text, "привет");
    assert_eq!(r.detected_source_lang, "en");
    assert_eq!(r.provider_id, "lingva");

    let e = lingva::parse(&fixture("b7_lingva_error.json")).expect_err("error → Err");
    assert!(e.contains("Invalid target language"), "{e}");
}

#[test]
fn libre_parse_ok_and_missing_key_fixtures() {
    let r = libre::parse(&fixture("b7_libre_ok.json")).expect("parse");
    assert_eq!(r.translated_text, "Привет, мир");
    assert_eq!(r.detected_source_lang, "en");
    assert_eq!(r.provider_id, "libre");

    let e = libre::parse(&fixture("b7_libre_missing_key.json")).expect_err("error → Err");
    assert!(e.contains("authenticate"), "{e}");
}

#[test]
fn dictionaryapi_parse_serendipity_fixture() {
    let e = dictionaryapi::parse_entries(&fixture("b7_dictapi_serendipity.json")).expect("parse");
    assert_eq!(e.word, "serendipity");
    // transcription: first non-empty phonetics[].text (second entry is blank)
    assert_eq!(e.transcription.as_deref(), Some("/ˌsɛ.ɹən.ˈdɪ.pɪ.ti/"));
    assert_eq!(e.meanings.len(), 2, "one DictMeaning per API meaning entry");
    assert_eq!(e.meanings[0].pos.as_deref(), Some("noun"));
    assert_eq!(e.meanings[0].definitions.len(), 2);
    assert_eq!(
        e.meanings[0].definitions[0].example.as_deref(),
        Some("The discovery of penicillin was a classic example of serendipity.")
    );
    assert_eq!(
        e.meanings[0].definitions[1].example, None,
        "empty example → None"
    );
    assert_eq!(
        e.meanings[0].definitions[0].synonyms,
        vec!["chance", "luck", "fortune"],
        "synonyms capped at 3"
    );
}

#[test]
fn dictionaryapi_parse_notfound_fixture_is_none() {
    // the 404 body served with 200 → None, never a fake entry
    assert!(dictionaryapi::parse_entries(&fixture("b7_dictapi_notfound.json")).is_none());
}

// ---------------------------------------------------------------------------
// §8 B7: multi-paragraph split/join at the parser (planning) level
// ---------------------------------------------------------------------------

#[test]
fn google_plan_multi_paragraph_split_join() {
    let text = "Первый абзац.\nВторой абзац.\nТретий.";
    let (units, sep) = google::plan_requests(text);
    assert_eq!(units.len(), 3, "one request per paragraph (≤3 paragraphs)");
    assert_eq!(sep, "\n");
    assert_eq!(
        units.join(sep),
        text,
        "join reconstructs the source exactly"
    );
}

#[test]
fn google_plan_many_paragraphs_capped_at_three_requests() {
    let text = (0..20)
        .map(|i| format!("paragraph {i}"))
        .collect::<Vec<_>>()
        .join("\n");
    let (units, sep) = google::plan_requests(&text);
    assert_eq!(units.len(), 3);
    assert_eq!(units.join(sep), text, "nothing dropped or reordered");
}

#[test]
fn google_plan_long_text_chunks_at_sentence_boundaries() {
    let text = "This is a fairly long test sentence for chunking. ".repeat(48);
    assert!(text.chars().count() > 1800);
    let (units, sep) = google::plan_requests(&text);
    assert!(units.len() > 1);
    assert!(units.len() <= 8, "chunk cap");
    assert_eq!(sep, "", "chunks are mid-paragraph splits");
    for u in &units {
        assert!(u.chars().count() <= 1500, "chunk over 1500 chars");
    }
    assert_eq!(units.join(sep), text);
}

#[test]
fn google_plan_short_text_single_unit() {
    let (units, sep) = google::plan_requests("hello");
    assert_eq!(units, vec!["hello".to_owned()]);
    assert_eq!(sep, "");
}

// ---------------------------------------------------------------------------
// §8 B7: registry / config resolution (disabled → fallback)
// ---------------------------------------------------------------------------

fn ts(default: &str, providers: HashMap<String, ProviderConfig>) -> TranslateSettings {
    TranslateSettings {
        default_provider_id: default.to_owned(),
        default_target_lang: "ru".to_owned(),
        popup_on_select: false,
        providers,
    }
}

fn pcfg(enabled: bool, base_url: Option<&str>) -> ProviderConfig {
    ProviderConfig {
        enabled,
        base_url: base_url.map(str::to_owned),
        api_key: None,
    }
}

#[test]
fn translate_registry_shape() {
    let r = translate::registry();
    let ids: Vec<&str> = r.iter().map(|p| p.id()).collect();
    assert_eq!(ids, vec!["google", "lingva", "libre"]);
    assert!(translate::by_id("google").is_some());
    assert!(translate::by_id("nope").is_none());
    assert!(!r[0].needs_config() && !r[1].needs_config());
    assert!(r[2].needs_config(), "libre needs a base URL");
}

#[test]
fn dict_registry_shape() {
    let r = dict::registry();
    assert_eq!(r.len(), 1);
    assert_eq!(r[0].id(), "dictionaryapi");
    assert_eq!(r[0].languages(), &["en"]);
    assert!(!r[0].needs_config());
    assert!(dict::by_id("dictionaryapi").is_some());
    assert!(dict::by_id("google").is_none());
}

#[test]
fn resolve_default_settings_google_then_lingva() {
    let chain = translate::resolve(&ts("google", HashMap::new()), None);
    let ids: Vec<&str> = chain.iter().map(|(p, _)| p.id()).collect();
    // fresh install: google + lingva usable, libre skipped (needs config)
    assert_eq!(ids, vec!["google", "lingva"]);
}

#[test]
fn resolve_explicit_provider_wins() {
    let chain = translate::resolve(&ts("google", HashMap::new()), Some("lingva"));
    assert_eq!(chain[0].0.id(), "lingva");
}

#[test]
fn resolve_disabled_fallback_is_skipped() {
    let mut providers = HashMap::new();
    providers.insert("lingva".to_owned(), pcfg(false, None));
    let chain = translate::resolve(&ts("google", providers), None);
    let ids: Vec<&str> = chain.iter().map(|(p, _)| p.id()).collect();
    assert_eq!(ids, vec!["google"], "disabled lingva must be skipped");
}

#[test]
fn resolve_disabled_default_still_tried_once() {
    // user intent wins: a disabled default is still attempted, but not twice
    let mut providers = HashMap::new();
    providers.insert("google".to_owned(), pcfg(false, None));
    let chain = translate::resolve(&ts("google", providers), None);
    let ids: Vec<&str> = chain.iter().map(|(p, _)| p.id()).collect();
    assert_eq!(ids[0], "google");
    assert_eq!(ids.iter().filter(|i| **i == "google").count(), 1);
    assert!(ids.contains(&"lingva"), "enabled lingva still a fallback");
}

#[test]
fn resolve_all_disabled_default_still_used() {
    let mut providers = HashMap::new();
    providers.insert("google".to_owned(), pcfg(false, None));
    providers.insert("lingva".to_owned(), pcfg(false, None));
    let chain = translate::resolve(&ts("google", providers), None);
    assert!(!chain.is_empty(), "chain must never be empty");
    assert_eq!(chain[0].0.id(), "google");
}

#[test]
fn resolve_configured_libre_joins_chain_with_its_base_url() {
    let mut providers = HashMap::new();
    providers.insert("libre".to_owned(), pcfg(true, Some("https://lt.example/")));
    let chain = translate::resolve(&ts("google", providers), None);
    let (p, cfg) = chain
        .iter()
        .find(|(p, _)| p.id() == "libre")
        .expect("libre");
    assert_eq!(p.id(), "libre");
    assert_eq!(cfg.base_url.as_deref(), Some("https://lt.example/"));
    assert_eq!(
        libre::Libre::translate_url(cfg).unwrap(),
        "https://lt.example/translate"
    );
}

#[test]
fn resolve_unknown_default_falls_back_to_registry_order() {
    let chain = translate::resolve(&ts("nope", HashMap::new()), None);
    assert_eq!(chain[0].0.id(), "google");
}

#[test]
fn dict_resolve_default_and_unknown() {
    let s = Settings::default();
    let chain = dict::resolve(&s);
    assert_eq!(chain.len(), 1);
    assert_eq!(chain[0].0.id(), "dictionaryapi");
    assert!(chain[0].1.enabled, "absent config → enabled");

    let mut s2 = Settings::default();
    s2.dictionary.default_provider_id = "nope".into();
    assert_eq!(dict::resolve(&s2)[0].0.id(), "dictionaryapi");
}

#[test]
fn is_configured_rules() {
    let g = google::Google;
    let l = libre::Libre;
    assert!(translate::is_configured(&g, None), "google needs no config");
    assert!(!translate::is_configured(&l, None), "libre needs base url");
    assert!(!translate::is_configured(&l, Some(&pcfg(true, None))));
    assert!(translate::is_configured(
        &l,
        Some(&pcfg(true, Some("https://x")))
    ));
    assert!(!translate::is_configured(
        &l,
        Some(&pcfg(true, Some("   ")))
    ));

    let d = dictionaryapi::DictionaryApi;
    assert!(dict::is_configured(&d, None));
}

// ---------------------------------------------------------------------------
// §8 B7: language table + offline detect heuristic
// ---------------------------------------------------------------------------

#[test]
fn languages_table_covers_contract_set() {
    let t = net::languages();
    assert!(t.len() >= 60, "expected ~60+, got {}", t.len());

    let mut codes: Vec<&str> = t.iter().map(|l| l.code.as_str()).collect();
    let n = codes.len();
    codes.sort_unstable();
    codes.dedup();
    assert_eq!(codes.len(), n, "duplicate language codes");

    for code in [
        "auto", "en", "ru", "de", "fr", "es", "it", "pt", "pl", "cs", "uk", "be", "bg", "sr", "hr",
        "sl", "sk", "hu", "ro", "el", "tr", "ar", "he", "fa", "hi", "bn", "ur", "ta", "te", "mr",
        "gu", "pa", "kn", "ml", "si", "th", "lo", "km", "my", "ka", "hy", "az", "kk", "ky", "uz",
        "tg", "mn", "zh", "ja", "ko", "vi", "id", "ms", "tl", "sw", "af", "eu", "ca", "gl", "is",
        "ga", "cy", "mt", "sq", "mk", "bs", "lt", "lv", "et", "fi", "sv", "no", "da", "nl",
    ] {
        assert!(t.iter().any(|l| l.code == code), "missing {code}");
    }

    let name = |c: &str| {
        t.iter()
            .find(|l| l.code == c)
            .map(|l| l.name_ru.clone())
            .unwrap()
    };
    assert_eq!(name("en"), "English");
    assert_eq!(name("ru"), "Russian");
    assert_eq!(name("af"), "Afrikaans");
    assert_eq!(name("auto"), "Auto");
    assert_eq!(name("no"), "Norwegian");
}

#[test]
fn languages_table_sorted_by_name_ru() {
    let t = languages::table();
    for w in t.windows(2) {
        assert!(
            w[0].name_ru <= w[1].name_ru,
            "not sorted: {} > {}",
            w[0].name_ru,
            w[1].name_ru
        );
    }
}

#[test]
fn detect_heuristic_table() {
    let cases = [
        ("Hello, world!", "en"),
        ("Привет, мир!", "ru"),
        ("Привіт, як справи?", "uk"),
        ("Гэта ўнікальны тэкст", "be"),
        ("你好，世界", "zh"),
        ("こんにちは世界", "ja"),
        ("안녕하세요", "ko"),
        ("Καλημέρα κόσμε", "el"),
        ("مرحبا بالعالم", "ar"),
        ("שלום עולם", "he"),
        ("नमस्ते दुनिया", "hi"),
        ("สวัสดีชาวโลก", "th"),
        ("12345 -- ?!", "en"),
        ("", "en"),
    ];
    for (text, want) in cases {
        assert_eq!(
            languages::detect_heuristic(text),
            want,
            "detect({text:?}) != {want}"
        );
    }
}

// ---------------------------------------------------------------------------
// §8 B7: graceful failure when offline (http://127.0.0.1:1)
// ---------------------------------------------------------------------------

#[test]
fn lookup_offline_returns_ok_with_nulls_under_two_seconds() {
    let state = offline_state();
    let started = Instant::now();
    let r = block_on(net::lookup(&state, "monster", None));
    let elapsed = started.elapsed();

    let r = r.expect("lookup must degrade to Ok, never Err");
    assert_eq!(r.word, "monster");
    assert!(r.translation.is_none(), "translate failed → null");
    assert!(r.dictionary.is_none(), "dict failed → null");
    // B6 fills these; they must land as neutral defaults
    assert_eq!(r.lookup_count, 0);
    assert!(!r.suggest_add);
    assert!(!r.already_in_vocab);
    assert!(elapsed < Duration::from_secs(2), "took {elapsed:?}");
}

#[test]
fn lookup_offline_normalizes_word_and_still_degrades() {
    let state = offline_state();
    let r = block_on(net::lookup(&state, "  \"monster,\"  ", None)).expect("Ok");
    assert_eq!(r.word, "monster", "wrapping punctuation stripped");
    assert!(r.translation.is_none() && r.dictionary.is_none());
}

#[test]
fn lookup_empty_word_is_err() {
    let state = offline_state();
    assert!(block_on(net::lookup(&state, "   ", None)).is_err());
}

#[test]
fn dict_lookup_offline_is_none_not_err() {
    let state = offline_state();
    assert!(matches!(
        block_on(net::dict_lookup(&state, "monster")),
        Ok(None)
    ));
}

#[test]
fn dict_lookup_cyrillic_skips_english_only_provider() {
    // dictionaryapi is en-only → no request, None
    let state = offline_state();
    assert!(matches!(
        block_on(net::dict_lookup(&state, "слово")),
        Ok(None)
    ));
}

#[test]
fn dict_lookup_ineligible_words_are_none() {
    let state = offline_state();
    for w in [
        "two words",
        "",
        "word123",
        "-lead",
        "trail-",
        "a--b",
        &"a".repeat(41),
    ] {
        assert!(
            matches!(block_on(net::dict_lookup(&state, w)), Ok(None)),
            "word={w:?}"
        );
    }
}

#[test]
fn translate_offline_is_err_never_panic() {
    let state = offline_state();
    let e = block_on(net::translate(&state, "hello", "en", "ru", None))
        .expect_err("all providers down → Err");
    assert!(
        format!("{e:#}").contains("all translate providers failed"),
        "{e:#}"
    );
}

#[test]
fn translate_explicit_provider_bypasses_fallback_chain() {
    // §4.8: an explicit providerId is a direct call — the error must be libre's own,
    // not the chain wrapper, so the UI can report that specific provider.
    let state = offline_state();
    let e = block_on(net::translate(&state, "hello", "en", "ru", Some("libre")))
        .expect_err("dead port → Err");
    let msg = format!("{e:#}");
    assert!(!msg.contains("all translate providers failed"), "{msg}");
}

#[test]
fn translate_unknown_provider_is_err() {
    let state = offline_state();
    let e = block_on(net::translate(&state, "hello", "en", "ru", Some("nope")))
        .expect_err("unknown id → Err");
    assert!(
        format!("{e:#}").contains("unknown translate provider"),
        "{e:#}"
    );
}

#[test]
fn detect_lang_offline_falls_back_to_heuristic() {
    // libre's detect is "unsupported" → local heuristic must still answer
    let state = offline_state();
    assert_eq!(
        block_on(net::detect_lang(&state, "Привет, мир!")).unwrap(),
        "ru"
    );
    assert_eq!(
        block_on(net::detect_lang(&state, "Hello there")).unwrap(),
        "en"
    );
    assert_eq!(block_on(net::detect_lang(&state, "")).unwrap(), "en");
}

// ---------------------------------------------------------------------------
// list_translators / apply_provider_config
// ---------------------------------------------------------------------------

#[test]
fn list_translators_reports_kind_and_configured_state() {
    let state = state_with(Settings::default());
    let infos = net::list_translators(&state);

    let ids: Vec<&str> = infos.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(ids, vec!["google", "lingva", "libre", "dictionaryapi"]);

    let find = |id: &str| infos.iter().find(|i| i.id == id).unwrap();
    assert_eq!(find("google").kind, TranslatorKind::Translate);
    assert_eq!(find("dictionaryapi").kind, TranslatorKind::Dict);

    assert!(find("google").configured, "needs no config → configured");
    assert!(find("lingva").configured, "works against public instance");
    assert!(find("dictionaryapi").configured);

    let libre = find("libre");
    assert!(libre.needs_config);
    assert!(!libre.configured, "no base URL → not configured");
    assert_eq!(libre.name, "LibreTranslate");
}

#[test]
fn list_translators_reflects_saved_config() {
    let mut settings = Settings::default();
    net::apply_provider_config(
        &mut settings,
        "libre",
        ProviderConfig {
            enabled: true,
            base_url: Some("https://lt.example".into()),
            api_key: Some("k".into()),
        },
    );
    let infos = net::list_translators(&state_with(settings));
    let libre = infos.iter().find(|i| i.id == "libre").unwrap();
    assert!(libre.configured, "base URL set → configured");
}

#[test]
fn apply_provider_config_patches_shared_providers_map() {
    let mut s = Settings::default();
    assert!(!s.translate.providers.contains_key("libre"));

    net::apply_provider_config(&mut s, "libre", pcfg(true, Some("https://lt.example")));
    assert_eq!(
        s.translate.providers["libre"].base_url.as_deref(),
        Some("https://lt.example")
    );

    // dict providers live in the same map (§4.1 has only one providers record)
    net::apply_provider_config(&mut s, "dictionaryapi", pcfg(false, None));
    assert!(s.translate.providers.contains_key("dictionaryapi"));

    // re-patch overwrites, no duplicate keys
    net::apply_provider_config(&mut s, "libre", pcfg(false, None));
    assert!(!s.translate.providers["libre"].enabled);
    assert_eq!(s.translate.providers.len(), 2);
}

// ---------------------------------------------------------------------------
// URL/encoding helpers (no new deps — hand-rolled percent-encoding)
// ---------------------------------------------------------------------------

#[test]
fn pct_encode_is_rfc3986_uppercase() {
    assert_eq!(net::pct_encode("hello"), "hello");
    assert_eq!(net::pct_encode("a-b_c.d~e"), "a-b_c.d~e");
    assert_eq!(net::pct_encode("good morning"), "good%20morning");
    assert_eq!(
        net::pct_encode("привет"),
        "%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82"
    );
    assert_eq!(net::pct_encode("a/b?c=d&e"), "a%2Fb%3Fc%3Dd%26e");
    assert_eq!(net::pct_encode("100%"), "100%25");
    assert_eq!(net::pct_encode(""), "");
}

#[test]
fn query_string_encodes_values() {
    assert_eq!(
        net::query_string(&[("sl", "auto"), ("q", "hello world"), ("x", "a&b=c")]),
        "sl=auto&q=hello%20world&x=a%26b%3Dc"
    );
}

#[test]
fn normalize_word_strips_wrapping_punctuation() {
    assert_eq!(net::normalize_word("  word  "), "word");
    assert_eq!(net::normalize_word("\"monster,\""), "monster");
    assert_eq!(net::normalize_word("«слово»."), "слово");
    assert_eq!(net::normalize_word("...hello!!!"), "hello");
    assert_eq!(net::normalize_word("well-known"), "well-known");
    assert_eq!(net::normalize_word("   "), "");
}

#[test]
fn google_urls_match_endpoint_reality() {
    let u = google::single_url("good morning", "auto", "ru");
    assert!(u.starts_with(google::ENDPOINT));
    assert!(u.contains("client=gtx"));
    assert!(u.contains("sl=auto") && u.contains("tl=ru"));
    assert!(u.contains("dt=t") && u.contains("dt=bd"));
    assert!(u.contains("q=good%20morning"));

    let f = google::fallback_url("привет", "ru", "en");
    assert!(f.starts_with(google::FALLBACK_ENDPOINT));
    assert!(f.contains("client=dict-chrome-ex"));
    assert!(f.contains("q=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82"));
}

#[test]
fn lingva_url_uses_configured_base_and_encodes_path() {
    assert_eq!(
        lingva::Lingva::api_url(&ProviderConfig::default()),
        lingva::DEFAULT_BASE_URL
    );
    let cfg = pcfg(true, Some("https://my.lingva.example/"));
    assert_eq!(lingva::Lingva::api_url(&cfg), "https://my.lingva.example");
    let url = lingva::Lingva::translate_url(&cfg, "en", "ru", "and/or");
    assert_eq!(
        url, "https://my.lingva.example/api/v1/en/ru/and%2For",
        "'/' must not create a sub-path"
    );
}

#[test]
fn libre_request_body_includes_key_only_when_set() {
    let b = libre::Libre::request_body("hello", "auto", "ru", None);
    assert_eq!(b["q"], "hello");
    assert_eq!(b["source"], "auto", "LibreTranslate supports source=auto");
    assert_eq!(b["target"], "ru");
    assert!(b.get("api_key").is_none());

    assert_eq!(
        libre::Libre::request_body("hi", "en", "ru", Some(" secret "))["api_key"],
        "secret",
        "key trimmed"
    );
    assert!(libre::Libre::request_body("hi", "en", "ru", Some("  "))
        .get("api_key")
        .is_none());
    assert!(libre::Libre::translate_url(&pcfg(true, None)).is_err());
}

#[test]
fn dictionaryapi_url_and_base_resolution() {
    assert_eq!(
        dictionaryapi::entry_url("monster"),
        "https://api.dictionaryapi.dev/api/v2/entries/en/monster"
    );
    assert_eq!(
        dictionaryapi::effective_base(&ProviderConfig::default()),
        dictionaryapi::BASE_URL
    );
    assert_eq!(
        dictionaryapi::effective_base(&pcfg(true, Some("   "))),
        dictionaryapi::BASE_URL
    );
    let mirror = pcfg(true, Some("http://127.0.0.1:1/api/v2/entries/en/"));
    assert_eq!(
        dictionaryapi::entry_url_with(dictionaryapi::effective_base(&mirror), "monster"),
        "http://127.0.0.1:1/api/v2/entries/en/monster"
    );
}

#[test]
fn dict_eligibility_rules() {
    assert!(dict::is_eligible_word("monster"));
    assert!(dict::is_eligible_word("Monster"));
    assert!(dict::is_eligible_word("слово"));
    assert!(dict::is_eligible_word("well-known"));
    assert!(dict::is_eligible_word("café"));
    assert!(!dict::is_eligible_word("two words"));
    assert!(!dict::is_eligible_word(""));
    assert!(!dict::is_eligible_word("   "));
    assert!(!dict::is_eligible_word(&"a".repeat(41)));
    assert!(!dict::is_eligible_word("word123"));
}
