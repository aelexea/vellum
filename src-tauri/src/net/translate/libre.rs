//! LibreTranslate — self-hosted instance, base URL + optional API key (§11.4) — owned
//! by B7.
//!
//! `POST {baseUrl}/translate` json `{q, source, target, api_key?}` →
//! `{"translatedText":"…","detectedLanguage":"en"}` (some builds answer
//! `detectedLanguage` as `{"code":"en","confidence":…}` — both parsed).
//! `source: "auto"` is supported by LibreTranslate itself, so `from = "auto"` is passed
//! through verbatim. Needs config: a base URL is required; the key is optional per
//! instance. Errors (`{"error":…}`, missing key 403) map to `Err`.

use crate::dto::{ProviderConfig, TranslateResult};
use crate::net::translate::{BoxFuture, TranslateProvider};

pub struct Libre;

impl Libre {
    /// `{base}/translate` — `Err` when the instance URL is not configured.
    pub fn translate_url(cfg: &ProviderConfig) -> anyhow::Result<String> {
        let base = cfg
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("libre: baseUrl is not configured"))?;
        Ok(format!("{}/translate", base.trim_end_matches('/')))
    }

    /// Request body per the LibreTranslate API; `api_key` omitted when not configured
    /// (many self-hosted instances run keyless).
    pub fn request_body(
        text: &str,
        from: &str,
        to: &str,
        api_key: Option<&str>,
    ) -> serde_json::Value {
        let mut body = serde_json::json!({
            "q": text,
            "source": from, // "auto" passes through — LibreTranslate supports it
            "target": to,
            "format": "text",
        });
        if let Some(key) = api_key.map(str::trim).filter(|k| !k.is_empty()) {
            body["api_key"] = serde_json::Value::String(key.to_owned());
        }
        body
    }
}

impl TranslateProvider for Libre {
    fn id(&self) -> &str {
        "libre"
    }
    fn name(&self) -> &str {
        "LibreTranslate"
    }
    fn needs_config(&self) -> bool {
        // requires a self-hosted instance URL (and usually a key)
        true
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
            let url = Libre::translate_url(cfg)?;
            let body = Libre::request_body(text, from, to, cfg.api_key.as_deref());
            let resp = c.post(&url).json(&body).send().await?;
            let status = resp.status();
            let text_resp = resp.text().await?;
            // 4xx/5xx: surface the server message when it is JSON {"error":…}
            if !status.is_success() {
                if let Ok(msg) = parse_error(&text_resp) {
                    anyhow::bail!("libre: HTTP {status}: {msg}");
                }
                anyhow::bail!("libre: HTTP {status}");
            }
            let mut r = parse(&text_resp).map_err(|e| anyhow::anyhow!("libre: {e}"))?;
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
        // detect needs the configured base URL, which the trait signature does not
        // carry — net::detect_lang falls back to the local heuristic instead.
        Box::pin(async { anyhow::bail!("unsupported") })
    }
}

/// Parse `{"translatedText":"…","detectedLanguage":"en"|"…object…"}`.
/// Tolerated variants (real-world instances differ):
/// - `detectedLanguage` as string, as `{"code":"en",…}`, or absent;
/// - `{"error":"…"}` → Err with the message (missing key, quota, bad lang).
pub fn parse(body: &str) -> Result<TranslateResult, String> {
    let trimmed = body.trim();
    if trimmed.starts_with('<') || trimmed.is_empty() {
        return Err("HTML/empty response".to_owned());
    }
    let v: serde_json::Value = serde_json::from_str(trimmed).map_err(|e| format!("json: {e}"))?;

    if let Some(err) = parse_error_value(&v) {
        return Err(err);
    }

    let translated = v
        .get("translatedText")
        .and_then(|t| t.as_str())
        .ok_or("no translatedText field")?
        .to_owned();

    let detected = v
        .get("detectedLanguage")
        .map(|d| match d {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Object(_) => d
                .get("code")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_owned(),
            _ => String::new(),
        })
        .unwrap_or_default();

    Ok(TranslateResult {
        translated_text: translated,
        detected_source_lang: detected,
        target_lang: String::new(), // filled by caller
        provider_id: "libre".to_owned(),
    })
}

/// Extract an `error` message from a response body string (JSON or raw text).
pub(crate) fn parse_error(body: &str) -> Result<String, ()> {
    let v: serde_json::Value = serde_json::from_str(body.trim()).map_err(|_| ())?;
    parse_error_value(&v).ok_or(())
}

fn parse_error_value(v: &serde_json::Value) -> Option<String> {
    v.get("error").map(|e| match e {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
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

    fn cfg(base: Option<&str>, key: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            enabled: true,
            base_url: base.map(str::to_owned),
            api_key: key.map(str::to_owned),
        }
    }

    #[test]
    fn translate_url_rules() {
        assert_eq!(
            Libre::translate_url(&cfg(Some("https://lt.example/"), None)).unwrap(),
            "https://lt.example/translate"
        );
        assert!(Libre::translate_url(&cfg(None, None)).is_err());
        assert!(Libre::translate_url(&cfg(Some("   "), None)).is_err());
    }

    #[test]
    fn request_body_shapes() {
        let b = Libre::request_body("hello", "auto", "ru", None);
        assert_eq!(b["q"], "hello");
        assert_eq!(b["source"], "auto");
        assert_eq!(b["target"], "ru");
        assert!(b.get("api_key").is_none(), "key omitted when unset");

        let b = Libre::request_body("hi", "en", "ru", Some(" secret "));
        assert_eq!(b["api_key"], "secret", "key trimmed");

        let b = Libre::request_body("hi", "en", "ru", Some("  "));
        assert!(b.get("api_key").is_none(), "blank key omitted");
    }

    #[test]
    fn parse_ok_fixture() {
        let body = fixture("b7_libre_ok.json");
        let r = parse(&body).expect("parse");
        assert_eq!(r.translated_text, "Привет, мир");
        assert_eq!(r.detected_source_lang, "en");
        assert_eq!(r.provider_id, "libre");
    }

    #[test]
    fn parse_missing_key_fixture_is_err() {
        let body = fixture("b7_libre_missing_key.json");
        let e = parse(&body).expect_err("error shape must be Err");
        assert!(e.contains("authenticate"), "{e}");
    }

    #[test]
    fn parse_detected_language_object_variant() {
        let body =
            r#"{"translatedText":"Привет","detectedLanguage":{"code":"en","confidence":98.5}}"#;
        let r = parse(body).expect("parse");
        assert_eq!(r.translated_text, "Привет");
        assert_eq!(r.detected_source_lang, "en");
    }

    #[test]
    fn parse_without_detected_language() {
        let r = parse(r#"{"translatedText":"Привет"}"#).expect("parse");
        assert_eq!(r.detected_source_lang, "");
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse("<html>405</html>").is_err());
        assert!(parse("").is_err());
        assert!(parse("{}").is_err(), "missing translatedText → Err");
        assert!(parse("null").is_err());
    }
}
