//! Lingva Translate — configurable public/self-hosted instance (§11.4) — owned by B7.
//!
//! `GET {base}/api/v1/{from}/{to}/{pct-encoded text}` →
//! `{"translation":"…","info":{"detectedSource":"en"}}`. Errors answer
//! `{"error":"…"}` — mapped to `Err` so the net fallback chain moves on.
//! Public instances are flaky (probed 2026-09: lingva.ml echoed input untranslated),
//! hence `needs_config = false` but always reachable through a user base URL.
//!
//! Lingva has no detect-only endpoint; `detect` returns `Err` and
//! [`crate::net::detect_lang`] falls back to the local unicode heuristic.

use crate::dto::{ProviderConfig, TranslateResult};
use crate::net::pct_encode;
use crate::net::translate::{BoxFuture, TranslateProvider};

pub struct Lingva;

/// Fallback public instance used when `cfg.base_url` is null.
pub const DEFAULT_BASE_URL: &str = "https://lingva.ml";

impl Lingva {
    /// `GET {base}/api/v1/{from}/{to}/{query}` — base from cfg or the default instance.
    pub fn api_url(cfg: &ProviderConfig) -> String {
        cfg.base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_owned())
            .trim_end_matches('/')
            .to_owned()
    }

    /// Full request URL for a translation (path-encoded text so `/` cannot break routing).
    pub fn translate_url(cfg: &ProviderConfig, from: &str, to: &str, text: &str) -> String {
        format!(
            "{}/api/v1/{}/{}/{}",
            Self::api_url(cfg),
            pct_encode(from),
            pct_encode(to),
            pct_encode(text)
        )
    }
}

impl TranslateProvider for Lingva {
    fn id(&self) -> &str {
        "lingva"
    }
    fn name(&self) -> &str {
        "Lingva"
    }
    fn needs_config(&self) -> bool {
        // works against the public instance, but self-hosted URLs are supported
        false
    }

    fn translate<'a>(
        &'a self,
        c: &'a reqwest::Client,
        cfg: &'a ProviderConfig,
        text: &'a str,
        from: &'a str,
        to: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<TranslateResult>> {
        Box::pin(async move {
            let url = Lingva::translate_url(cfg, from, to, text);
            let resp = c.get(&url).send().await?;
            let status = resp.status();
            let body = resp.text().await?;
            anyhow::ensure!(status.is_success(), "lingva: HTTP {status}");
            let mut r = parse(&body).map_err(|e| anyhow::anyhow!("lingva: {e}"))?;
            if r.translated_text.is_empty() {
                r.translated_text = text.to_owned();
            }
            r.target_lang = to.to_owned();
            Ok(r)
        })
    }

    fn detect<'a>(
        &'a self,
        _c: &'a reqwest::Client,
        _text: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<String>> {
        // no detect-only endpoint; net::detect_lang falls back to the local heuristic
        Box::pin(async { anyhow::bail!("unsupported") })
    }
}

/// Parse the lingva JSON response. `{"error":…}` → `Err`.
/// Shape: `{"translation":"…","info":{"detectedSource":"en"}}`.
pub fn parse(body: &str) -> Result<TranslateResult, String> {
    let trimmed = body.trim();
    if trimmed.starts_with('<') || trimmed.is_empty() {
        return Err("HTML/empty response".to_owned());
    }
    let v: serde_json::Value = serde_json::from_str(trimmed).map_err(|e| format!("json: {e}"))?;

    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        return Err(err.to_owned());
    }

    let translation = v
        .get("translation")
        .and_then(|t| t.as_str())
        .ok_or("no translation field")?;

    let detected = v
        .get("info")
        .and_then(|i| i.get("detectedSource"))
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .to_owned();

    Ok(TranslateResult {
        translated_text: translation.to_owned(),
        detected_source_lang: detected,
        target_lang: String::new(), // filled by caller
        provider_id: "lingva".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIX: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/");

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{FIX}{name}"))
            .unwrap_or_else(|e| panic!("fixture {name}: {e}"))
    }

    #[test]
    fn api_url_prefers_configured_base() {
        let cfg = ProviderConfig {
            enabled: true,
            base_url: Some("https://my.lingva.example/".into()),
            api_key: None,
        };
        assert_eq!(Lingva::api_url(&cfg), "https://my.lingva.example");
        assert_eq!(
            Lingva::api_url(&ProviderConfig::default()),
            DEFAULT_BASE_URL
        );
    }

    #[test]
    fn translate_url_encodes_path_segments() {
        let cfg = ProviderConfig::default();
        let url = Lingva::translate_url(&cfg, "en", "ru", "good morning");
        assert_eq!(url, "https://lingva.ml/api/v1/en/ru/good%20morning");
        // slashes in the text must not create sub-paths
        let url = Lingva::translate_url(&cfg, "en", "ru", "and/or");
        assert!(url.ends_with("/api/v1/en/ru/and%2For"), "{url}");
    }

    #[test]
    fn parse_ok_fixture() {
        let body = fixture("b7_lingva_ok.json");
        let r = parse(&body).expect("parse");
        assert_eq!(r.translated_text, "привет");
        assert_eq!(r.detected_source_lang, "en");
        assert_eq!(r.provider_id, "lingva");
    }

    #[test]
    fn parse_error_fixture_is_err() {
        let body = fixture("b7_lingva_error.json");
        let e = parse(&body).expect_err("error shape must be Err");
        assert!(e.contains("Invalid target language"), "{e}");
    }

    #[test]
    fn parse_missing_detected_source_ok() {
        let r = parse(r#"{"translation":"привет"}"#).expect("parse");
        assert_eq!(r.translated_text, "привет");
        assert_eq!(r.detected_source_lang, "");
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse("<html>nope</html>").is_err());
        assert!(parse("").is_err());
        assert!(parse("{}").is_err(), "missing translation field → Err");
        assert!(parse("[]").is_err());
    }
}
