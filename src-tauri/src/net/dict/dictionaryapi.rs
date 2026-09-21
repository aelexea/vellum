//! api.dictionaryapi.dev (English only) (§11.4 addendum) — owned by B7.
//!
//! `GET {BASE_URL}/{pct word}` → `[{word, phonetic, phonetics:[{text,audio}],
//! meanings:[{partOfSpeech, definitions:[{definition, example, synonyms[]}]}]}]`.
//! Mapping to `DictEntry`: transcription = first non-empty `phonetics[].text`, else the
//! top-level `phonetic`; one `DictMeaning` per API meaning entry (duplicated pos values
//! stay separate — the UI groups by chip); definitions capped at 5 per meaning,
//! examples only when non-empty, synonyms capped at 3.
//! Non-200 (incl. 404 "No Definitions Found" and rate limits) or any parse failure →
//! `Ok(None)` — dictionary absence must never fail a lookup (§4.6).

use serde_json::Value;

use crate::dto::{DictDefinition, DictEntry, DictMeaning, ProviderConfig};
use crate::net::dict::DictProvider;
use crate::net::{pct_encode, BoxFuture};

pub struct DictionaryApi;

pub const BASE_URL: &str = "https://api.dictionaryapi.dev/api/v2/entries/en";

/// Max definitions kept per meaning entry (WP spec).
const MAX_DEFINITIONS: usize = 5;
/// Max synonyms kept per definition (WP spec).
const MAX_SYNONYMS: usize = 3;

/// `GET {BASE_URL}/{word}` — 404 means "no entry", which maps to `Ok(None)`.
pub fn entry_url(word: &str) -> String {
    entry_url_with(BASE_URL, word)
}

/// Same, against a configured mirror (`cfg.base_url`). Used so a self-hosted or
/// test endpoint can stand in for the public API.
pub fn entry_url_with(base: &str, word: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), pct_encode(word.trim()))
}

/// Resolve the effective base URL: `cfg.base_url` when set, else the public API.
pub fn effective_base(cfg: &ProviderConfig) -> &str {
    cfg.base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(BASE_URL)
}

impl DictProvider for DictionaryApi {
    fn id(&self) -> &str {
        "dictionaryapi"
    }
    fn name(&self) -> &str {
        "DictionaryAPI"
    }
    fn needs_config(&self) -> bool {
        false
    }
    fn languages(&self) -> &[&'static str] {
        &["en"]
    }

    fn lookup<'a>(
        &'a self,
        c: &'a reqwest::Client,
        cfg: &'a ProviderConfig,
        word: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<Option<DictEntry>>> {
        Box::pin(async move {
            let url = entry_url_with(effective_base(cfg), word);
            let resp = c.get(&url).send().await?;
            let status = resp.status();
            let body = resp.text().await?;
            // 404 = no entry; 429/5xx = rate limit / outage — all degrade to None
            if !status.is_success() {
                return Ok(None);
            }
            Ok(parse_entries(&body))
        })
    }
}

/// Parse the entries array into one `DictEntry` (first entry only — homographs beyond
/// `[0]` are rare and the UI shows a single card). Returns `None` on any unexpected
/// shape (e.g. the 404 `{"title":"No Definitions Found",…}` object served with 200).
pub fn parse_entries(body: &str) -> Option<DictEntry> {
    let v: Value = serde_json::from_str(body.trim()).ok()?;
    let entries = v.as_array()?;
    let first = entries.first()?;

    let word = first.get("word").and_then(Value::as_str)?.to_owned();

    // transcription: first non-empty phonetics[].text, else top-level phonetic
    let transcription = first
        .get("phonetics")
        .and_then(Value::as_array)
        .and_then(|ps| {
            ps.iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .find(|t| !t.trim().is_empty())
        })
        .or_else(|| {
            first
                .get("phonetic")
                .and_then(Value::as_str)
                .filter(|t| !t.trim().is_empty())
        })
        .map(str::to_owned);

    let meanings: Vec<DictMeaning> = first
        .get("meanings")
        .and_then(Value::as_array)
        .map(|ms| {
            ms.iter()
                .filter_map(|m| {
                    let pos = m
                        .get("partOfSpeech")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned);
                    let definitions: Vec<DictDefinition> = m
                        .get("definitions")
                        .and_then(Value::as_array)?
                        .iter()
                        .take(MAX_DEFINITIONS)
                        .filter_map(|d| {
                            let definition =
                                d.get("definition").and_then(Value::as_str)?.to_owned();
                            if definition.trim().is_empty() {
                                return None;
                            }
                            let example = d
                                .get("example")
                                .and_then(Value::as_str)
                                .filter(|e| !e.trim().is_empty())
                                .map(str::to_owned);
                            let synonyms: Vec<String> = d
                                .get("synonyms")
                                .and_then(Value::as_array)
                                .map(|s| {
                                    s.iter()
                                        .filter_map(Value::as_str)
                                        .filter(|s| !s.trim().is_empty())
                                        .take(MAX_SYNONYMS)
                                        .map(str::to_owned)
                                        .collect()
                                })
                                .unwrap_or_default();
                            Some(DictDefinition {
                                definition,
                                example,
                                synonyms,
                            })
                        })
                        .collect();
                    if definitions.is_empty() {
                        return None;
                    }
                    Some(DictMeaning { pos, definitions })
                })
                .collect()
        })
        .unwrap_or_default();

    if meanings.is_empty() {
        return None;
    }

    Some(DictEntry {
        word,
        transcription,
        meanings,
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
    fn entry_url_format() {
        assert_eq!(
            entry_url("monster"),
            "https://api.dictionaryapi.dev/api/v2/entries/en/monster"
        );
        assert_eq!(entry_url("  word  "), entry_url("word"));
        // path-unsafe characters are encoded
        assert!(entry_url("a/b").contains("a%2Fb"));
    }

    #[test]
    fn effective_base_honors_config() {
        // no config → public API
        assert_eq!(effective_base(&ProviderConfig::default()), BASE_URL);
        // blank base → public API
        let blank = ProviderConfig {
            enabled: true,
            base_url: Some("   ".into()),
            api_key: None,
        };
        assert_eq!(effective_base(&blank), BASE_URL);
        // configured mirror wins, trailing slash trimmed
        let mirror = ProviderConfig {
            enabled: true,
            base_url: Some("http://127.0.0.1:1/api/v2/entries/en/".into()),
            api_key: None,
        };
        assert_eq!(
            entry_url_with(effective_base(&mirror), "monster"),
            "http://127.0.0.1:1/api/v2/entries/en/monster"
        );
    }

    #[test]
    fn parse_serendipity_fixture() {
        let body = fixture("b7_dictapi_serendipity.json");
        let e = parse_entries(&body).expect("parse");
        assert_eq!(e.word, "serendipity");
        assert_eq!(e.transcription.as_deref(), Some("/ˌsɛ.ɹən.ˈdɪ.pɪ.ti/"));
        // two meaning entries, both noun (kept separate)
        assert_eq!(e.meanings.len(), 2);
        assert_eq!(e.meanings[0].pos.as_deref(), Some("noun"));
        assert_eq!(e.meanings[0].definitions.len(), 2);
        assert_eq!(
            e.meanings[0].definitions[0].example.as_deref(),
            Some("The discovery of penicillin was a classic example of serendipity.")
        );
        // empty example → None
        assert_eq!(e.meanings[0].definitions[1].example, None);
        // synonyms capped at 3
        assert_eq!(
            e.meanings[0].definitions[0].synonyms,
            vec!["chance", "luck", "fortune"]
        );
        assert_eq!(e.meanings[1].definitions.len(), 1);
    }

    #[test]
    fn parse_notfound_fixture_is_none() {
        let body = fixture("b7_dictapi_notfound.json");
        assert!(parse_entries(&body).is_none(), "404 body must map to None");
    }

    #[test]
    fn parse_transcription_falls_back_to_phonetic_field() {
        // phonetics[].text empty → top-level phonetic used
        let body = r#"[{"word":"test","phonetic":"/tɛst/","phonetics":[{"text":"","audio":""}],"meanings":[{"partOfSpeech":"noun","definitions":[{"definition":"a procedure"}]}]}]"#;
        let e = parse_entries(body).expect("parse");
        assert_eq!(e.transcription.as_deref(), Some("/tɛst/"));
    }

    #[test]
    fn parse_no_phonetics_at_all() {
        let body = r#"[{"word":"test","meanings":[{"partOfSpeech":"noun","definitions":[{"definition":"a procedure"}]}]}]"#;
        let e = parse_entries(body).expect("parse");
        assert_eq!(e.transcription, None);
        assert_eq!(e.meanings[0].definitions[0].synonyms, Vec::<String>::new());
    }

    #[test]
    fn parse_definitions_capped_at_five() {
        let defs: Vec<Value> = (0..9)
            .map(|i| serde_json::json!({"definition": format!("def {i}")}))
            .collect();
        let body = Value::Array(vec![serde_json::json!({
            "word": "x",
            "meanings": [{"partOfSpeech": "noun", "definitions": defs}],
        })]);
        let e = parse_entries(&body.to_string()).expect("parse");
        assert_eq!(e.meanings[0].definitions.len(), MAX_DEFINITIONS);
    }

    #[test]
    fn parse_skips_meanings_without_definitions() {
        let body = r#"[{"word":"x","meanings":[{"partOfSpeech":"noun","definitions":[]},{"partOfSpeech":"verb","definitions":[{"definition":"to x"}]}]}]"#;
        let e = parse_entries(body).expect("parse");
        assert_eq!(e.meanings.len(), 1);
        assert_eq!(e.meanings[0].pos.as_deref(), Some("verb"));
    }

    #[test]
    fn parse_missing_pos_is_none() {
        let body = r#"[{"word":"x","meanings":[{"definitions":[{"definition":"d"}]}]}]"#;
        let e = parse_entries(body).expect("parse");
        assert_eq!(e.meanings[0].pos, None);
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse_entries("").is_none());
        assert!(parse_entries("<html>522</html>").is_none());
        assert!(parse_entries("[]").is_none());
        assert!(parse_entries("{}").is_none());
        assert!(
            parse_entries(r#"[{"meanings":[]}]"#).is_none(),
            "no word/meanings → None"
        );
    }
}
