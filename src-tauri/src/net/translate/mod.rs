//! `TranslateProvider` trait + registry (§11.4) — owned by B7.
//!
//! DEVIATION note: §11.4 writes `async fn` methods in the trait AND `Vec<Box<dyn …>>` in
//! the registry. On stable Rust `async fn` in a trait is **not dyn-compatible**, so the
//! scaffold uses `Pin<Box<dyn Future + Send>>` return types (the standard no-new-dep
//! pattern). Semantics are identical; B7 keeps this shape.

pub mod google;
pub mod libre;
pub mod lingva;

use crate::dto::{ProviderConfig, TranslateResult};
use crate::settings::TranslateSettings;

/// Re-exported so `translate::BoxFuture` keeps working for B7; canonical alias is
/// `crate::net::BoxFuture`.
pub use crate::net::BoxFuture;

pub trait TranslateProvider: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    /// Whether the provider needs a base URL / API key before use.
    fn needs_config(&self) -> bool;

    fn translate<'a>(
        &'a self,
        c: &'a reqwest::Client,
        cfg: &'a ProviderConfig,
        text: &'a str,
        from: &'a str,
        to: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<TranslateResult>>;

    /// ISO 639-1 detection; providers without detection support return Err.
    fn detect<'a>(
        &'a self,
        c: &'a reqwest::Client,
        text: &'a str,
    ) -> BoxFuture<'a, anyhow::Result<String>>;
}

/// All built-in translate providers: google, lingva, libre (§11.4).
pub fn registry() -> Vec<Box<dyn TranslateProvider>> {
    vec![
        Box::new(google::Google),
        Box::new(lingva::Lingva),
        Box::new(libre::Libre),
    ]
}

/// Look a provider up by id.
pub fn by_id(id: &str) -> Option<Box<dyn TranslateProvider>> {
    registry().into_iter().find(|p| p.id() == id)
}

/// Effective config for a provider id: stored config, else a per-provider default.
/// `enabled` defaults to true for providers that work out of the box (google, lingva)
/// so a fresh install (empty providers map) still translates (§6.6 defaults).
pub fn effective_config(ts: &TranslateSettings, id: &str) -> ProviderConfig {
    if let Some(cfg) = ts.providers.get(id) {
        return cfg.clone();
    }
    match id {
        "google" => ProviderConfig {
            enabled: true,
            base_url: None,
            api_key: None,
        },
        "lingva" => ProviderConfig {
            enabled: true,
            base_url: None,
            api_key: None,
        },
        // libre needs a user-supplied base URL; disabled until configured
        _ => ProviderConfig {
            enabled: false,
            base_url: None,
            api_key: None,
        },
    }
}

/// A provider counts as "configured" for [`crate::net::list_translators`] when it either
/// needs no config, or its required base URL is present (key is optional per instance).
pub fn is_configured(p: &dyn TranslateProvider, cfg: Option<&ProviderConfig>) -> bool {
    if !p.needs_config() {
        return true;
    }
    cfg.and_then(|c| c.base_url.as_ref())
        .is_some_and(|u| !u.trim().is_empty())
}

/// Build the ordered provider chain for a translation request (§11.4 + WP spec):
/// - explicit `provider_id` (or settings default when None) goes first — user intent wins,
///   even if that provider is disabled or unconfigured (we still try it);
/// - then every other *enabled and usable* provider in registry order as fallback;
/// - providers that need config but lack it are skipped in the fallback chain
///   (they cannot work), but never removed from the first slot.
///
/// Returns (provider, effective config) pairs. Never empty (registry is non-empty and the
/// default id is always resolved against it; unknown default → registry order).
pub fn resolve(
    ts: &TranslateSettings,
    provider_id: Option<&str>,
) -> Vec<(Box<dyn TranslateProvider>, ProviderConfig)> {
    let all = registry();
    let wanted = provider_id
        .filter(|s| !s.is_empty())
        .unwrap_or(&ts.default_provider_id);

    let mut chain: Vec<(Box<dyn TranslateProvider>, ProviderConfig)> = Vec::new();

    // 1. the explicitly wanted provider first (if it exists in the registry)
    let mut rest: Vec<Box<dyn TranslateProvider>> = Vec::new();
    let mut found = false;
    for p in all {
        if !found && p.id() == wanted {
            let cfg = effective_config(ts, p.id());
            chain.push((p, cfg));
            found = true;
        } else {
            rest.push(p);
        }
    }
    // unknown id → nothing prepended; rest holds the full registry

    // 2. fallbacks: enabled + usable (config present when required), registry order
    for p in rest {
        let cfg = effective_config(ts, p.id());
        if !cfg.enabled {
            continue;
        }
        if p.needs_config() && !is_configured(p.as_ref(), Some(&cfg)) {
            continue;
        }
        chain.push((p, cfg));
    }

    // 3. defensive: chain must never be empty (first provider is always kept above, so
    //    this only triggers for a truly unknown id with all fallbacks filtered out)
    if chain.is_empty() {
        for p in registry() {
            let cfg = effective_config(ts, p.id());
            chain.push((p, cfg));
        }
    }
    chain
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn ts_with(default: &str, providers: HashMap<String, ProviderConfig>) -> TranslateSettings {
        TranslateSettings {
            default_provider_id: default.to_owned(),
            default_target_lang: "ru".to_owned(),
            popup_on_select: false,
            providers,
        }
    }

    fn cfg(enabled: bool, base_url: Option<&str>) -> ProviderConfig {
        ProviderConfig {
            enabled,
            base_url: base_url.map(str::to_owned),
            api_key: None,
        }
    }

    #[test]
    fn registry_ids_are_unique_and_known() {
        let r = registry();
        let ids: Vec<_> = r.iter().map(|p| p.id().to_owned()).collect();
        assert_eq!(ids.len(), 3);
        let mut sorted = ids.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), 3);
        assert!(ids.contains(&"google".to_owned()));
        assert!(by_id("google").is_some());
        assert!(by_id("nope").is_none());
    }

    #[test]
    fn provider_metadata() {
        let g = google::Google;
        assert_eq!(g.id(), "google");
        assert!(!g.needs_config());
        let l = libre::Libre;
        assert_eq!(l.id(), "libre");
        assert!(l.needs_config());
    }

    #[test]
    fn resolve_default_settings_starts_with_google() {
        let ts = ts_with("google", HashMap::new());
        let chain = resolve(&ts, None);
        assert_eq!(chain[0].0.id(), "google");
        // fresh install: lingva usable by default, libre skipped (needs config)
        let ids: Vec<_> = chain.iter().map(|(p, _)| p.id()).collect();
        assert_eq!(ids, vec!["google", "lingva"]);
    }

    #[test]
    fn resolve_explicit_id_wins_over_default() {
        let ts = ts_with("google", HashMap::new());
        let chain = resolve(&ts, Some("lingva"));
        assert_eq!(chain[0].0.id(), "lingva");
    }

    #[test]
    fn resolve_disabled_default_is_still_tried_but_excluded_from_fallbacks() {
        let mut providers = HashMap::new();
        providers.insert("google".to_owned(), cfg(false, None));
        let ts = ts_with("google", providers);
        let chain = resolve(&ts, None);
        // user intent wins: disabled default still first…
        assert_eq!(chain[0].0.id(), "google");
        // …but it must not appear twice, and lingva follows as fallback
        let ids: Vec<_> = chain.iter().map(|(p, _)| p.id()).collect();
        assert_eq!(ids.iter().filter(|i| **i == "google").count(), 1);
        assert!(ids.contains(&"lingva"));
    }

    #[test]
    fn resolve_disabled_fallback_is_skipped() {
        let mut providers = HashMap::new();
        providers.insert("lingva".to_owned(), cfg(false, None));
        let ts = ts_with("google", providers);
        let chain = resolve(&ts, None);
        let ids: Vec<_> = chain.iter().map(|(p, _)| p.id()).collect();
        assert_eq!(ids, vec!["google"], "disabled lingva must be skipped");
    }

    #[test]
    fn resolve_configured_libre_joins_chain() {
        let mut providers = HashMap::new();
        providers.insert("libre".to_owned(), cfg(true, Some("https://lt.example")));
        let ts = ts_with("google", providers);
        let chain = resolve(&ts, None);
        let ids: Vec<_> = chain.iter().map(|(p, _)| p.id()).collect();
        assert!(ids.contains(&"libre"));
        let libre = chain.iter().find(|(p, _)| p.id() == "libre").unwrap();
        assert_eq!(libre.1.base_url.as_deref(), Some("https://lt.example"));
    }

    #[test]
    fn resolve_unknown_id_falls_back_to_registry_order() {
        let ts = ts_with("nope", HashMap::new());
        let chain = resolve(&ts, None);
        let ids: Vec<_> = chain.iter().map(|(p, _)| p.id()).collect();
        assert_eq!(ids[0], "google");
        assert!(!ids.is_empty());
    }

    #[test]
    fn all_disabled_default_still_used() {
        let mut providers = HashMap::new();
        providers.insert("google".to_owned(), cfg(false, None));
        providers.insert("lingva".to_owned(), cfg(false, None));
        let ts = ts_with("google", providers);
        let chain = resolve(&ts, None);
        assert!(!chain.is_empty(), "chain must never be empty");
        assert_eq!(chain[0].0.id(), "google");
    }

    #[test]
    fn is_configured_rules() {
        let g = google::Google;
        let l = libre::Libre;
        assert!(is_configured(&g, None), "google needs no config");
        assert!(!is_configured(&l, None), "libre needs base url");
        assert!(!is_configured(&l, Some(&cfg(true, None))));
        assert!(is_configured(&l, Some(&cfg(true, Some("https://x")))));
        assert!(!is_configured(&l, Some(&cfg(true, Some("   ")))));
    }
}
