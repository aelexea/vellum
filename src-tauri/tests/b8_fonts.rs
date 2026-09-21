//! B8 §8 — fc-list parsing against a **real** captured fixture.
//!
//! Fixture: `tests/fixtures/b8_fclist.txt`, captured on the dev machine with
//! `fc-list : family file style slant spacing` (889 lines). The parser is exercised purely
//! from the string, so these tests pass without fontconfig installed.

use vellum_lib::db::AppPaths;
use vellum_lib::fonts::{fallback_fonts, parse_fc_list};
use vellum_lib::settings::Settings;

fn fixture() -> String {
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/b8_fclist.txt");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read fixture {}: {e}", path.display()))
}

#[test]
fn parses_real_fixture_with_plenty_of_families() {
    let fonts = parse_fc_list(&fixture());
    assert!(
        fonts.len() > 5,
        "expected many families from the real fixture, got {}",
        fonts.len()
    );
    // The fixture has 889 face lines; families dedupe well below the 500 cap here, but the
    // cap must never be exceeded regardless of the machine.
    assert!(fonts.len() <= 500, "cap violated: {}", fonts.len());
}

#[test]
fn dejavu_sans_present_with_bold_and_italic() {
    let fonts = parse_fc_list(&fixture());
    let dejavu = fonts
        .iter()
        .find(|f| f.name == "DejaVu Sans")
        .expect("DejaVu Sans must be in the fixture");
    assert!(dejavu.has_bold, "fixture has DejaVuSans-Bold.ttf");
    assert!(dejavu.has_italic, "fixture has DejaVuSans-Oblique.ttf");
    assert!(!dejavu.mono, "DejaVu Sans is proportional");
}

#[test]
fn mono_family_flagged_mono() {
    let fonts = parse_fc_list(&fixture());
    let mono = fonts
        .iter()
        .find(|f| f.name == "DejaVu Sans Mono")
        .expect("DejaVu Sans Mono must be in the fixture");
    assert!(mono.mono, "spacing=100 → mono");
    assert!(mono.has_bold, "fixture has DejaVuSansMono-Bold.ttf");
    assert!(mono.has_italic, "fixture has DejaVuSansMono-Oblique.ttf");
}

#[test]
fn noto_sans_mono_is_flagged_even_though_fc_list_omits_spacing() {
    // Real-world regression guard: on this machine every `Noto Sans Mono` face line has no
    // `spacing=` property at all (verified against the fixture), so a spacing-only rule would
    // report it as proportional and the UI's monospace group would lose it.
    let fonts = parse_fc_list(&fixture());
    let noto = fonts.iter().find(|f| f.name == "Noto Sans Mono");
    assert!(noto.is_some(), "Noto Sans Mono must be in the fixture");
    assert!(noto.unwrap().mono, "name-based mono fallback must catch it");

    let raw = fixture();
    let noto_lines: Vec<&str> = raw
        .lines()
        .filter(|l| l.contains(": Noto Sans Mono,") || l.contains(": Noto Sans Mono:"))
        .collect();
    assert!(!noto_lines.is_empty(), "fixture really has Noto Sans Mono");
    assert!(
        noto_lines.iter().all(|l| !l.contains("spacing=")),
        "fixture premise changed — Noto Sans Mono now reports spacing: {noto_lines:?}"
    );
}

#[test]
fn proportional_fonts_are_not_flagged_mono() {
    let fonts = parse_fc_list(&fixture());
    let non_mono = fonts.iter().filter(|f| !f.mono).count();
    assert!(
        non_mono > 5,
        "most families should be proportional, got {non_mono} of {}",
        fonts.len()
    );
}

#[test]
fn every_family_appears_once() {
    let fonts = parse_fc_list(&fixture());
    let mut names: Vec<&str> = fonts.iter().map(|f| f.name.as_str()).collect();
    let total = names.len();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), total, "families must be deduped");
}

#[test]
fn output_is_sorted_by_name() {
    let fonts = parse_fc_list(&fixture());
    let lower: Vec<String> = fonts.iter().map(|f| f.name.to_lowercase()).collect();
    let mut sorted = lower.clone();
    sorted.sort();
    assert_eq!(lower, sorted, "plain alphabetical order");
}

#[test]
fn no_empty_or_comma_containing_names() {
    for f in parse_fc_list(&fixture()) {
        assert!(!f.name.trim().is_empty(), "empty family name");
        assert!(
            !f.name.contains(','),
            "localized second name leaked through: {:?}",
            f.name
        );
    }
}

#[test]
fn cjk_localized_family_takes_first_name_only() {
    // The fixture contains `Noto Sans CJK JP,Noto Sans CJK JP Light`.
    let fonts = parse_fc_list(&fixture());
    if let Some(cjk) = fonts.iter().find(|f| f.name == "Noto Sans CJK JP") {
        assert_eq!(cjk.name, "Noto Sans CJK JP");
        assert!(
            !fonts.iter().any(|f| f.name == "Noto Sans CJK JP Light"),
            "secondary comma-name must not become its own family"
        );
    }
}

#[test]
fn fallback_list_is_used_when_fc_list_is_missing() {
    // The fallback path is exercised directly (fc-list IS installed on this machine, so
    // `list_fonts` would return real data); the shape is what the UI depends on.
    let v = fallback_fonts();
    let names: Vec<&str> = v.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, vec!["serif", "sans-serif", "monospace", "system-ui"]);
    assert!(v.iter().all(|f| f.has_bold && f.has_italic));
    assert!(v.iter().any(|f| f.mono));
    assert_eq!(v.iter().filter(|f| f.mono).count(), 1);
}

#[test]
fn parse_of_empty_output_yields_nothing() {
    assert!(parse_fc_list("").is_empty());
}

// ---------------------------------------------------------------------------
// live path: §11.5 entry point + OnceLock caching
// ---------------------------------------------------------------------------

/// Build a real `AppState` without a Tauri app (all fields are public). The db points at a
/// throwaway file because nothing here touches it.
fn test_state() -> vellum_lib::state::AppState {
    let root = std::env::temp_dir().join(format!(
        "vellum-b8-fonts-state-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    let data_dir = root.join("data");
    std::fs::create_dir_all(&data_dir).expect("mkdir");
    let db_path = data_dir.join("vellum.db");

    vellum_lib::state::AppState {
        db: std::sync::Mutex::new(rusqlite::Connection::open(&db_path).expect("open db")),
        zips: Default::default(),
        http: reqwest::Client::new(),
        settings: parking_lot::RwLock::new(Settings::default()),
        paths: AppPaths {
            data_dir: data_dir.clone(),
            config_dir: root.join("config"),
            cache_dir: root.join("cache"),
            covers_dir: root.join("cache/covers"),
            backups_dir: data_dir.join("backups"),
            db_path,
        },
        fonts: std::sync::OnceLock::new(),
    }
}

#[test]
fn list_fonts_populates_cache_and_returns_usable_families() {
    use vellum_lib::settings::list_fonts;

    let state = test_state();
    assert!(state.fonts.get().is_none(), "cache starts empty");

    let fonts = list_fonts(&state);
    assert!(!fonts.is_empty(), "never returns an empty list");
    // Either the real fc-list output (this machine: hundreds) or the 4-entry fallback.
    assert!(
        fonts.len() >= 4,
        "expected real fonts or the generic fallback, got {}",
        fonts.len()
    );
    assert!(
        state.fonts.get().is_some(),
        "result must be cached in state.fonts"
    );
    assert_eq!(
        state.fonts.get().unwrap(),
        &fonts,
        "cached value is the answer"
    );

    // Second call is served from the cache and is identical.
    assert_eq!(list_fonts(&state), fonts);

    // Every entry is usable by the UI select.
    for f in &fonts {
        assert!(!f.name.trim().is_empty());
    }
}

#[test]
fn list_fonts_survives_a_prepopulated_cache() {
    // If another thread filled the cache first, the stored value wins and no subprocess runs.
    let state = test_state();
    let seeded = vec![vellum_lib::dto::FontFamily {
        name: "Seeded Family".into(),
        has_bold: true,
        has_italic: false,
        mono: false,
    }];
    state.fonts.set(seeded.clone()).expect("seed cache");
    assert_eq!(vellum_lib::settings::list_fonts(&state), seeded);
}
