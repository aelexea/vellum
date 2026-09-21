//! `DictProvider` trait + registry (§11.4) — owned by B7.
//!
//! Same dyn-compatibility shape as `TranslateProvider`: boxed futures instead of
//! `async fn` in trait (see the DEVIATION note in `translate/mod.rs`).

pub mod dictionaryapi;

use crate::dto::{DictEntry, ProviderConfig};
use crate::net::BoxFuture;
use crate::settings::Settings;

pub trait DictProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn needs_config(&self) -> bool;
    /// Language codes this provider supports (dictionaryapi: `["en"]`).
    fn languages(&self) -> &[&'static str];

    fn lookup<'a>(
        &'a self,
        c: &'a reqwest::Client,
        cfg: &'a crate::dto::ProviderConfig,
        word: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<Option<DictEntry>>>;
}

/// All built-in dictionary providers (§11.4).
pub fn registry() -> Vec<Box<dyn DictProvider>> {
    vec![Box::new(dictionaryapi::DictionaryApi)]
}

pub fn by_id(id: &str) -> Option<Box<dyn DictProvider>> {
    registry().into_iter().find(|p| p.id() == id)
}

/// Effective config for a dict provider id. Provider configs all live in
/// `settings.translate.providers` (the only `Record<string, ProviderConfig>` in the
/// Settings tree — `settings.dictionary` holds just `defaultProviderId`); dictionaryapi
/// needs no config, so absent → enabled.
pub fn effective_config(settings: &Settings, id: &str) -> ProviderConfig {
    settings
        .translate
        .providers
        .get(id)
        .cloned()
        .unwrap_or(ProviderConfig {
            enabled: true,
            base_url: None,
            api_key: None,
        })
}

/// A dict provider counts as "configured" when it needs no config or its base URL is set.
pub fn is_configured(p: &dyn DictProvider, cfg: Option<&ProviderConfig>) -> bool {
    if !p.needs_config() {
        return true;
    }
    cfg.and_then(|c| c.base_url.as_ref())
        .is_some_and(|u| !u.trim().is_empty())
}

/// Ordered dict provider chain (§4.6): the `settings.dictionary.defaultProviderId`
/// provider first (user intent wins even when disabled — same rule as translate), then
/// the other *enabled* providers in registry order. Never empty for known ids.
pub fn resolve(settings: &Settings) -> Vec<(Box<dyn DictProvider>, ProviderConfig)> {
    let wanted = settings.dictionary.default_provider_id.as_str();
    let mut chain: Vec<(Box<dyn DictProvider>, ProviderConfig)> = Vec::new();
    let mut rest: Vec<Box<dyn DictProvider>> = Vec::new();
    let mut found = false;

    for p in registry() {
        if !found && p.id() == wanted {
            let cfg = effective_config(settings, p.id());
            chain.push((p, cfg));
            found = true;
        } else {
            rest.push(p);
        }
    }
    for p in rest {
        let cfg = effective_config(settings, p.id());
        if cfg.enabled {
            chain.push((p, cfg));
        }
    }
    if chain.is_empty() {
        // unknown default id → plain registry order
        for p in registry() {
            let cfg = effective_config(settings, p.id());
            chain.push((p, cfg));
        }
    }
    chain
}

/// A word is dictionary-eligible when it is a single latin/cyrillic token ≤ 40 chars (§4.6).
/// Hyphens are allowed inside a compound word (not leading/trailing, not doubled).
pub fn is_eligible_word(word: &str) -> bool {
    let w = word.trim();
    if w.is_empty() || w.chars().count() > 40 {
        return false;
    }
    let alpha = |c: char| {
        matches!(c,
            'a'..='z' | 'A'..='Z'
            | '\u{00C0}'..='\u{024F}'   // latin extended (accented)
            | '\u{0400}'..='\u{04FF}'   // cyrillic
        )
    };
    // single token: every char is alpha or an internal hyphen
    if !w.chars().all(|c| alpha(c) || c == '-') {
        return false;
    }
    let letters = w.chars().filter(|c| *c != '-').count();
    letters > 0 && !w.starts_with('-') && !w.ends_with('-') && !w.contains("--")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_has_dictionaryapi() {
        let r = registry();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id(), "dictionaryapi");
        assert!(by_id("dictionaryapi").is_some());
        assert!(by_id("google").is_none());
    }

    #[test]
    fn eligibility_rules() {
        assert!(is_eligible_word("monster"));
        assert!(is_eligible_word("Monster"));
        assert!(is_eligible_word("слово"));
        assert!(is_eligible_word("well-known"));
        assert!(!is_eligible_word("two words"));
        assert!(!is_eligible_word(""));
        assert!(!is_eligible_word("   "));
        assert!(!is_eligible_word(&"a".repeat(41)));
        assert!(!is_eligible_word("word123"));
    }

    #[test]
    fn resolve_default_settings_has_dictionaryapi() {
        let s = Settings::default();
        let chain = resolve(&s);
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].0.id(), "dictionaryapi");
        assert!(chain[0].1.enabled, "absent config → enabled by default");
    }

    #[test]
    fn resolve_unknown_default_still_yields_registry() {
        let mut s = Settings::default();
        s.dictionary.default_provider_id = "nope".into();
        let chain = resolve(&s);
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].0.id(), "dictionaryapi");
    }

    #[test]
    fn is_configured_rules() {
        let p = dictionaryapi::DictionaryApi;
        assert!(is_configured(&p, None), "needs no config → configured");
    }
}
