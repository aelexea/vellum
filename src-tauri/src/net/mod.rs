//! Translation + dictionary network layer (§11.4) — owned by B7.
//!
//! Contract: `lookup`/`translate`/`dict_lookup` must never panic; `lookup` and
//! `dict_lookup` return `Ok` with null sub-results when a provider errors (so B6
//! degrades gracefully per §4.6). `translate` is the one function that may return `Err`
//! (all providers failed) — `lookup` folds that into `translation: None`.

pub mod dict;
pub mod languages;
pub mod translate;

use std::future::Future;
use std::pin::Pin;

use crate::dto::{
    DictEntry, Lang, LookupContext, LookupResult, ProviderConfig, TranslateResult, TranslatorInfo,
};
use crate::state::AppState;

/// Boxed future alias shared by the provider traits (see DEVIATION note in
/// `translate/mod.rs`: `async fn` in trait is not dyn-compatible on stable).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Real browser UA — Google endpoints 403 the default client UA (§11.4 addendum).
pub const BROWSER_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// Shared reqwest client (§4.2: 15 s timeout, gzip, UA).
pub fn client(state: &AppState) -> &reqwest::Client {
    &state.http
}

// ---------------------------------------------------------------------------
// Shared URL helpers (hand-rolled percent-encoding, no new deps)
// ---------------------------------------------------------------------------

/// RFC 3986 unreserved set: ALPHA / DIGIT / `-` / `.` / `_` / `~`.
fn is_unreserved(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~')
}

const HEX_UPPER: &[u8; 16] = b"0123456789ABCDEF";

/// Percent-encode a string for use in a query value or a path segment
/// (unreserved bytes pass through; everything else → `%XX`, UTF-8 byte-wise).
/// Hex digits are uppercase per RFC 3986 §2.1 (canonical form).
pub fn pct_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if is_unreserved(b) {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX_UPPER[(b >> 4) as usize] as char);
            out.push(HEX_UPPER[(b & 0xF) as usize] as char);
        }
    }
    out
}

// The same encoding serves query values and path segments: `/` is not in the unreserved
// set, so pct_encode already keeps a path segment (lingva puts the text in one) from
// breaking routing.

/// Build `?k=v&k2=v2` with values percent-encoded.
pub fn query_string(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", pct_encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// First string at `v[key]`, if any (JSON helper).
pub(crate) fn json_str<'a>(v: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}

// ---------------------------------------------------------------------------
// Word normalization (§4.6 / §11.4 lookup)
// ---------------------------------------------------------------------------

/// Normalize a looked-up word: trim, strip wrapping punctuation (repeatedly, so
/// `"«слово»,"` → `слово`). Display form for `LookupResult.word`.
pub fn normalize_word(word: &str) -> String {
    let mut w = word.trim();
    loop {
        let before = w;
        w = w.trim_matches(|c: char| !c.is_alphanumeric());
        if w.len() == before.len() {
            break;
        }
    }
    w.to_string()
}

// ---------------------------------------------------------------------------
// Public API (§11.4 — signatures frozen; B6 calls lookup/translate/dict_lookup)
// ---------------------------------------------------------------------------

/// Orchestrate dict (when eligible) + translate(auto → targetLang) for one word (§4.6).
///
/// Degrades gracefully: provider failures land as `null` sub-fields, never `Err` and
/// never a panic, so B6 can always render *something* (§4.6 "fields null, never Err
/// unless all fail"; §11.4 "Ok with null sub-results when a provider errors"). The only
/// hard `Err` is an empty/whitespace word — there is nothing to look up. When both
/// sub-lookups fail the result is still `Ok` with `translation: None, dictionary: None`
/// (the B7 degradation test asserts exactly this against a connection-refused base URL).
/// `lookup_count`/`suggest_add`/`already_in_vocab` are filled by B6 (it owns the lookups
/// table); they land as 0/false/false here.
pub async fn lookup(
    state: &AppState,
    word: &str,
    _ctx: Option<&LookupContext>,
) -> anyhow::Result<LookupResult> {
    let normalized = normalize_word(word);
    if normalized.is_empty() {
        anyhow::bail!("empty lookup word");
    }

    let target_lang = state.settings.read().translate.default_target_lang.clone();

    // Sequential sub-lookups (each degrades to None on failure, never panics).
    // Sequential is fine: the shared client has a 15 s timeout and connection-refused
    // fails instantly; the B7 degradation test asserts a < 2 s round trip.
    // dict_lookup gates on is_eligible_word internally (non-eligible → Ok(None)).
    let dictionary = dict_lookup(state, &normalized).await.unwrap_or(None);
    let translation = translate(state, &normalized, "auto", &target_lang, None)
        .await
        .ok();

    Ok(LookupResult {
        word: normalized,
        translation,
        dictionary,
        lookup_count: 0,
        suggest_add: false,
        already_in_vocab: false,
    })
}

/// Translate `text` from `from` to `to` via `provider` (None → settings default).
///
/// - explicit `provider` → **direct call** to exactly that provider, no settings
///   defaulting and no fallback (§4.8 `translate_text`: the user picked it, so the UI
///   must see that provider's own success/failure — e.g. "Test connection");
/// - `None` → settings default first, then every other *enabled and usable* provider in
///   registry order (graceful degradation for the reader/lookup flow, §4.6).
pub async fn translate(
    state: &AppState,
    text: &str,
    from: &str,
    to: &str,
    provider: Option<&str>,
) -> anyhow::Result<TranslateResult> {
    let settings = state.settings.read().clone();
    let c = client(state);

    if let Some(id) = provider.filter(|s| !s.is_empty()) {
        let p = translate::by_id(id)
            .ok_or_else(|| anyhow::anyhow!("unknown translate provider: {id}"))?;
        let cfg = translate::effective_config(&settings.translate, id);
        // user intent wins: called even when the stored config has enabled=false
        return p.translate(c, &cfg, text, from, to).await;
    }

    let chain = translate::resolve(&settings.translate, None);
    let mut errors: Vec<String> = Vec::new();

    for (p, cfg) in chain {
        match p.translate(c, &cfg, text, from, to).await {
            Ok(r) => return Ok(r),
            Err(e) => errors.push(format!("{}: {e:#}", p.id())),
        }
    }
    anyhow::bail!("all translate providers failed: {}", errors.join("; "))
}

/// Dictionary lookup; `None` when no provider is eligible or all failed (§4.6).
/// Never returns `Err` — provider failures degrade to `None`.
pub async fn dict_lookup(state: &AppState, word: &str) -> anyhow::Result<Option<DictEntry>> {
    let normalized = normalize_word(word);
    if !dict::is_eligible_word(&normalized.to_lowercase()) {
        return Ok(None);
    }

    let settings = state.settings.read().clone();
    let chain = dict::resolve(&settings);
    let c = client(state);

    let word_lang = languages::detect_code(&normalized);
    for (p, cfg) in chain {
        // dictionaryapi is English-only (§11.4): skip providers that cannot answer for
        // this word's script instead of burning a request (§4.6 non-English → None).
        if !p.languages().contains(&word_lang) {
            continue;
        }
        match p.lookup(c, &cfg, &normalized).await {
            Ok(r) => return Ok(r),
            Err(_) => continue, // degrade: try next provider
        }
    }
    Ok(None)
}

/// ISO 639-1 code detection. Provider detection first (google `sl=auto` probe),
/// local unicode-block heuristic as the always-available fallback (§11.4).
pub async fn detect_lang(state: &AppState, text: &str) -> anyhow::Result<String> {
    if text.trim().is_empty() {
        return Ok(languages::detect_heuristic(text));
    }
    let settings = state.settings.read().clone();
    let chain = translate::resolve(&settings.translate, None);
    let c = client(state);

    // first resolved provider gets one detect attempt; unsupported/failed → heuristic
    if let Some((p, _cfg)) = chain.first() {
        if let Ok(lang) = p.detect(c, text).await {
            if !lang.is_empty() && lang != "auto" {
                return Ok(lang);
            }
        }
    }
    Ok(languages::detect_heuristic(text))
}

/// Registry of translate + dict providers with their configured/enabled state (§4.8).
pub fn list_translators(state: &AppState) -> Vec<TranslatorInfo> {
    use crate::dto::TranslatorKind;
    let settings = state.settings.read();
    let mut out = Vec::new();

    for p in translate::registry() {
        let cfg = settings.translate.providers.get(p.id());
        out.push(TranslatorInfo {
            id: p.id().to_owned(),
            name: p.name().to_owned(),
            kind: TranslatorKind::Translate,
            needs_config: p.needs_config(),
            configured: translate::is_configured(p.as_ref(), cfg),
        });
    }
    for p in dict::registry() {
        let cfg = settings.translate.providers.get(p.id());
        out.push(TranslatorInfo {
            id: p.id().to_owned(),
            name: p.name().to_owned(),
            kind: TranslatorKind::Dict,
            needs_config: p.needs_config(),
            // no config needed → always usable; else needs base URL
            configured: !p.needs_config()
                || cfg
                    .and_then(|c| c.base_url.as_ref())
                    .is_some_and(|u| !u.trim().is_empty()),
        });
    }
    out
}

/// Static language table (§11.4).
pub fn languages() -> Vec<Lang> {
    languages::table()
}

/// Patch one provider's config in place (`save_provider_config` §4.8).
///
/// All provider configs — translate *and* dict — live in `settings.translate.providers`,
/// the only `Record<string, ProviderConfig>` in the Settings tree (`settings.dictionary`
/// holds just `defaultProviderId`). Pure helper so the patch semantics are unit-testable
/// outside a tauri command.
pub fn apply_provider_config(
    settings: &mut crate::settings::Settings,
    provider_id: &str,
    cfg: ProviderConfig,
) {
    settings
        .translate
        .providers
        .insert(provider_id.to_owned(), cfg);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pct_encode_basics() {
        assert_eq!(pct_encode("hello"), "hello");
        assert_eq!(pct_encode("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(pct_encode("good morning"), "good%20morning");
        assert_eq!(pct_encode("привет"), "%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82");
        assert_eq!(pct_encode("a/b?c=d&e"), "a%2Fb%3Fc%3Dd%26e");
        assert_eq!(pct_encode("100%"), "100%25");
        // path-segment safe: '/' and '?' are encoded too
        assert_eq!(pct_encode("and/or"), "and%2For");
        assert_eq!(pct_encode(""), "");
    }

    #[test]
    fn query_string_encodes_values_only() {
        let q = query_string(&[("sl", "auto"), ("q", "hello world"), ("x", "a&b=c")]);
        assert_eq!(q, "sl=auto&q=hello%20world&x=a%26b%3Dc");
    }

    #[test]
    fn normalize_word_strips_wrapping_punctuation() {
        assert_eq!(normalize_word("  word  "), "word");
        assert_eq!(normalize_word("\"monster,\""), "monster");
        assert_eq!(normalize_word("«слово»."), "слово");
        assert_eq!(normalize_word("...hello!!!"), "hello");
        assert_eq!(normalize_word("well-known"), "well-known");
        assert_eq!(normalize_word("(x)"), "x");
        assert_eq!(normalize_word("   "), "");
    }

    #[test]
    fn json_str_helper() {
        let v: serde_json::Value = serde_json::json!({"a": "x", "b": 1, "c": null});
        assert_eq!(json_str(&v, "a"), Some("x"));
        assert_eq!(json_str(&v, "b"), None);
        assert_eq!(json_str(&v, "c"), None);
        assert_eq!(json_str(&v, "missing"), None);
    }

    // -- offline degradation (§8 B7: "graceful failure when offline") ---------

    /// AppState wired entirely to `http://127.0.0.1:1` (connection refused — fails
    /// instantly), so no test touches the live network.
    ///
    /// Setup notes (why libre is the default here): google's endpoints are hardcoded to
    /// the real Google hosts per the §11.4 addendum, and the `detect` trait method takes
    /// no `ProviderConfig` — so a google-first chain could reach the internet. Defaulting
    /// to `libre` (base URL = dead port; its `detect` is `unsupported` → no network) and
    /// disabling google/lingva keeps the whole resolve→HTTP→refuse→degrade path offline
    /// while still exercising it for real.
    fn offline_state() -> AppState {
        use crate::db::AppPaths;
        use crate::dto::ProviderConfig;
        use crate::settings::Settings;
        use dashmap::DashMap;
        use parking_lot::RwLock;
        use std::sync::{Mutex, OnceLock};

        const DEAD: &str = "http://127.0.0.1:1";

        let mut settings = Settings::default();
        // libre is the default translate provider, pointed at the dead port
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
        // google + lingva disabled so the fallback chain never reaches a real host
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
        // dictionaryapi: dead base URL (it honors ProviderConfig.base_url)
        settings.translate.providers.insert(
            "dictionaryapi".to_owned(),
            ProviderConfig {
                enabled: true,
                base_url: Some(format!("{DEAD}/api/v2/entries/en")),
                api_key: None,
            },
        );

        AppState {
            db: Mutex::new(rusqlite::Connection::open_in_memory().unwrap()),
            zips: DashMap::new(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(1))
                .build()
                .unwrap(),
            settings: RwLock::new(settings),
            paths: AppPaths {
                data_dir: std::env::temp_dir(),
                config_dir: std::env::temp_dir(),
                cache_dir: std::env::temp_dir(),
                covers_dir: std::env::temp_dir(),
                backups_dir: std::env::temp_dir(),
                db_path: std::env::temp_dir().join("vellum-b7-test.db"),
            },
            fonts: OnceLock::new(),
        }
    }

    #[test]
    fn lookup_offline_returns_ok_with_nulls_fast() {
        // §8 B7: connection-refused baseUrl → Ok with null fields, no panic, < 2 s
        let state = offline_state();
        let started = std::time::Instant::now();
        let r = tauri::async_runtime::block_on(lookup(&state, "monster", None));
        let elapsed = started.elapsed();

        let r = r.expect("lookup must degrade to Ok, not Err");
        assert_eq!(r.word, "monster");
        assert!(r.translation.is_none(), "translate failed → null");
        assert!(r.dictionary.is_none(), "dict failed → null");
        assert_eq!(r.lookup_count, 0);
        assert!(!r.suggest_add);
        assert!(!r.already_in_vocab);
        assert!(
            elapsed < std::time::Duration::from_secs(2),
            "took {elapsed:?}"
        );
    }

    #[test]
    fn dict_lookup_offline_is_none_not_err() {
        let state = offline_state();
        let r = tauri::async_runtime::block_on(dict_lookup(&state, "monster"));
        assert!(matches!(r, Ok(None)), "expected Ok(None), got {r:?}");
    }

    #[test]
    fn dict_lookup_cyrillic_skips_english_provider() {
        // dictionaryapi is en-only: a cyrillic word must yield None without a request
        let state = offline_state();
        let r = tauri::async_runtime::block_on(dict_lookup(&state, "слово"));
        assert!(matches!(r, Ok(None)));
    }

    #[test]
    fn dict_lookup_ineligible_word_is_none() {
        let state = offline_state();
        for w in ["two words", "", "word123", &"a".repeat(41)] {
            let r = tauri::async_runtime::block_on(dict_lookup(&state, w));
            assert!(matches!(r, Ok(None)), "word={w:?} → {r:?}");
        }
    }

    #[test]
    fn translate_offline_is_err() {
        // every provider unreachable → Err (combined message), never a panic
        let state = offline_state();
        let r = tauri::async_runtime::block_on(translate(&state, "hello", "en", "ru", None));
        let e = r.expect_err("all providers down → Err");
        assert!(
            e.to_string().contains("all translate providers failed"),
            "{e:#}"
        );
    }

    #[test]
    fn translate_explicit_provider_bypasses_chain() {
        // §4.8: an explicit providerId is a direct call — the failure must be libre's own,
        // not the "all translate providers failed" chain wrapper.
        let state = offline_state();
        let r =
            tauri::async_runtime::block_on(translate(&state, "hello", "en", "ru", Some("libre")));
        let e = r.expect_err("libre points at a dead port → Err");
        let msg = format!("{e:#}");
        assert!(!msg.contains("all translate providers failed"), "{msg}");
    }

    #[test]
    fn translate_unknown_provider_is_err() {
        let state = offline_state();
        let r =
            tauri::async_runtime::block_on(translate(&state, "hello", "en", "ru", Some("nope")));
        let e = r.expect_err("unknown id → Err");
        assert!(
            format!("{e:#}").contains("unknown translate provider"),
            "{e:#}"
        );
    }

    #[test]
    fn lookup_empty_word_is_err() {
        let state = offline_state();
        assert!(tauri::async_runtime::block_on(lookup(&state, "   ", None)).is_err());
    }

    #[test]
    fn detect_lang_offline_falls_back_to_heuristic() {
        // google detect would fail (dead port) → local heuristic must still answer
        let state = offline_state();
        let r = tauri::async_runtime::block_on(detect_lang(&state, "Привет, мир!"));
        assert_eq!(r.unwrap(), "ru");
    }

    #[test]
    fn list_translators_reports_configured_state() {
        use crate::db::AppPaths;
        use crate::settings::Settings;
        use dashmap::DashMap;
        use parking_lot::RwLock;
        use std::sync::{Mutex, OnceLock};

        // default settings (no providers configured) — exercises the needs_config gate
        let state = AppState {
            db: Mutex::new(rusqlite::Connection::open_in_memory().unwrap()),
            zips: DashMap::new(),
            http: reqwest::Client::builder().build().unwrap(),
            settings: RwLock::new(Settings::default()),
            paths: AppPaths {
                data_dir: std::env::temp_dir(),
                config_dir: std::env::temp_dir(),
                cache_dir: std::env::temp_dir(),
                covers_dir: std::env::temp_dir(),
                backups_dir: std::env::temp_dir(),
                db_path: std::env::temp_dir().join("vellum-b7-test.db"),
            },
            fonts: OnceLock::new(),
        };
        let infos = list_translators(&state);
        let ids: Vec<_> = infos.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"google") && ids.contains(&"lingva") && ids.contains(&"libre"));
        assert!(ids.contains(&"dictionaryapi"));

        let libre = infos.iter().find(|i| i.id == "libre").unwrap();
        assert!(libre.needs_config);
        assert!(!libre.configured, "libre has no base URL → not configured");

        let google = infos.iter().find(|i| i.id == "google").unwrap();
        assert!(google.configured, "google needs no config → configured");

        let dict = infos.iter().find(|i| i.id == "dictionaryapi").unwrap();
        assert!(
            dict.configured,
            "dictionaryapi needs no config → configured"
        );
        assert!(matches!(dict.kind, crate::dto::TranslatorKind::Dict));
    }

    #[test]
    fn languages_exposed_via_net() {
        let langs = languages();
        assert!(langs.len() >= 60);
        assert!(langs
            .iter()
            .any(|l| l.code == "ru" && l.name_ru == "Russian"));
    }

    #[test]
    fn apply_provider_config_patches_translate_providers_map() {
        use crate::settings::Settings;
        let mut s = Settings::default();
        assert!(!s.translate.providers.contains_key("libre"));

        apply_provider_config(
            &mut s,
            "libre",
            ProviderConfig {
                enabled: true,
                base_url: Some("https://lt.example".into()),
                api_key: Some("k".into()),
            },
        );
        let got = s.translate.providers.get("libre").expect("inserted");
        assert!(got.enabled);
        assert_eq!(got.base_url.as_deref(), Some("https://lt.example"));
        assert_eq!(got.api_key.as_deref(), Some("k"));

        // dict providers share the same map (§4.1: only one providers record)
        apply_provider_config(
            &mut s,
            "dictionaryapi",
            ProviderConfig {
                enabled: false,
                base_url: None,
                api_key: None,
            },
        );
        assert!(s.translate.providers.contains_key("dictionaryapi"));

        // re-patching overwrites
        apply_provider_config(
            &mut s,
            "libre",
            ProviderConfig {
                enabled: false,
                base_url: None,
                api_key: None,
            },
        );
        assert!(!s.translate.providers.get("libre").unwrap().enabled);
        assert_eq!(s.translate.providers.len(), 2);
    }
}
