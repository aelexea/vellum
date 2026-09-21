//! Font discovery via fontconfig (§4.7) — owned by B8.
//!
//! `fc-list : family file style slant spacing` is run once and the parsed result is cached
//! in `AppState::fonts` (a `OnceLock`). The pure parser [`parse_fc_list`] is split out so it
//! can be unit-tested against a captured fixture without fontconfig installed (§8).
//!
//! Observed fc-list line shape on this machine (see `tests/fixtures/b8_fclist.txt`):
//!
//! ```text
//! /usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf: DejaVu Sans Mono:style=Bold:slant=0:spacing=100
//! /usr/share/fonts/noto-cjk/NotoSansCJK-Light.ttc: Noto Sans CJK JP,Noto Sans CJK JP Light:style=Light,Regular:slant=0
//! ```
//!
//! Fields are `:`-separated; the **file** is field 0 and the **family** is field 1 (bare, no
//! `family=` prefix), while the remaining properties carry `key=value` prefixes. fontconfig
//! **omits** properties sitting at their default value — `spacing` is absent for proportional
//! fonts and `style` may be absent for the default face — so the parser must not rely on
//! positional indices for style/slant/spacing. Both `family` and `style` can contain commas
//! (localized/secondary names, e.g. `Light,Regular`); we take the first comma-segment of the
//! family.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::dto::FontFamily;
use crate::state::AppState;

/// Hard cap on families returned (§4.7: keep the settings select snappy).
const MAX_FONTS: usize = 500;

/// Wall-clock budget for the `fc-list` subprocess before we kill it.
const FC_LIST_TIMEOUT: Duration = Duration::from_secs(5);

/// Run `fc-list` once, parse into deduped families, cache in `state.fonts` (§4.7).
///
/// If fontconfig is unavailable, times out, or yields nothing usable, a small generic
/// fallback list is returned instead so the typography UI is never empty.
pub fn list_fonts(state: &AppState) -> Vec<FontFamily> {
    if let Some(cached) = state.fonts.get() {
        return cached.clone();
    }
    let fonts = run_fc_list()
        .map(|out| parse_fc_list(&out))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(fallback_fonts);

    // Another thread may have populated the cache first; either result is equivalent.
    let stored = state.fonts.get_or_init(|| fonts);
    stored.clone()
}

/// Minimal CSS-generic families used when `fc-list` is missing or empty (§4.7 fallback).
/// All flagged as having bold + italic so the UI's weight/style controls stay enabled.
pub fn fallback_fonts() -> Vec<FontFamily> {
    ["serif", "sans-serif", "monospace", "system-ui"]
        .into_iter()
        .map(|name| FontFamily {
            name: name.to_owned(),
            has_bold: true,
            has_italic: true,
            mono: name == "monospace",
        })
        .collect()
}

/// Spawn `fc-list` with a 5 s guard. Returns `None` if the binary is missing, the process
/// fails/times out, or stdout cannot be read — callers fall back to [`fallback_fonts`].
fn run_fc_list() -> Option<String> {
    let mut child = Command::new("fc-list")
        .args([":", "family", "file", "style", "slant", "spacing"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Drain stdout on a helper thread so a full pipe buffer can't deadlock `try_wait`.
    let stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buf = String::new();
        let mut reader = std::io::BufReader::new(stdout);
        let _ = reader.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });

    let deadline = Instant::now() + FC_LIST_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    eprintln!("[vellum] fonts: fc-list timed out, using fallback list");
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => {
                eprintln!("[vellum] fonts: fc-list wait failed: {e}");
                return None;
            }
        }
    }

    rx.recv_timeout(Duration::from_secs(1)).ok()
}

/// Parse a captured `fc-list` output string — pure function, unit-tested against a fixture
/// (§8). Dedupes families, OR-ing their bold/italic/mono flags across all faces; sorts by
/// name; caps at [`MAX_FONTS`].
pub fn parse_fc_list(output: &str) -> Vec<FontFamily> {
    // family name → (has_bold, has_italic, mono)
    let mut acc: HashMap<String, (bool, bool, bool)> = HashMap::new();

    for line in output.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() < 2 {
            continue;
        }

        // Family: field 1 normally (bare), but tolerate a `family=` prefix if fc-list ever
        // emits one. Everything else is identified by its `key=` prefix, so a colon inside a
        // file path (none on this machine) or an omitted property won't misalign the parse.
        let mut family_raw: Option<&str> = None;
        let mut style = String::new();
        let mut spacing = String::new();

        for part in &parts[1..] {
            if let Some(v) = part.strip_prefix("style=") {
                style.push_str(v);
            } else if let Some(v) = part.strip_prefix("spacing=") {
                spacing = v.to_string();
            } else if let Some(v) = part.strip_prefix("family=") {
                if family_raw.is_none() {
                    family_raw = Some(v);
                }
            } else if part.starts_with("slant=") || part.starts_with("file=") {
                // ignore
            } else if family_raw.is_none() {
                // bare family field (the usual case)
                family_raw = Some(part);
            }
        }

        let Some(family_raw) = family_raw else {
            continue;
        };
        // "Name,Other Name" (localized) → first comma-segment.
        let family = family_raw.split(',').next().unwrap_or("").trim();
        if family.is_empty() {
            continue;
        }

        let bold = style_contains(&style, "bold");
        let italic = style_contains(&style, "italic") || style_contains(&style, "oblique");
        // §4.7: mono when spacing is mono/100. Empirically that is not enough: on the
        // captured fixture `Noto Sans Mono` and `Noto Sans Mono CJK *` report no `spacing`
        // property at all, while `DejaVu Sans Mono`, `Liberation Mono`, the Meslo* and
        // Adwaita families report `spacing=100` on every face. So also honor a standalone
        // "Mono" token in the style or the family name — matched as a whole word, otherwise
        // a display face such as "Monoton" would be mislabelled monospaced.
        let mono = spacing == "mono"
            || spacing == "100"
            || has_word(&style, "mono")
            || has_word(family, "mono");

        let entry = acc
            .entry(family.to_owned())
            .or_insert((false, false, false));
        entry.0 |= bold;
        entry.1 |= italic;
        entry.2 |= mono;
    }

    let mut out: Vec<FontFamily> = acc
        .into_iter()
        .map(|(name, (has_bold, has_italic, mono))| FontFamily {
            name,
            has_bold,
            has_italic,
            mono,
        })
        .collect();

    // Plain alphabetical (case-insensitive, name as tiebreak for stability); UI groups.
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });
    out.truncate(MAX_FONTS);
    out
}

/// Case-insensitive substring test over a (possibly comma-joined) fc-list style value.
fn style_contains(style: &str, needle: &str) -> bool {
    style.to_lowercase().contains(needle)
}

/// Does `s` contain `word` as a standalone token? Tokens are runs of alphanumerics, so
/// "Mono" matches "DejaVu Sans Mono" but not "Monoton" or "Monospace-ish".
fn has_word(s: &str, word: &str) -> bool {
    s.split(|c: char| !c.is_alphanumeric())
        .any(|tok| tok.eq_ignore_ascii_case(word))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_synthetic_minimal_line() {
        let out = "/fonts/Foo.ttf: Foo Sans:style=Regular:slant=0";
        let v = parse_fc_list(out);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "Foo Sans");
        assert!(!v[0].has_bold);
        assert!(!v[0].has_italic);
        assert!(!v[0].mono);
    }

    #[test]
    fn parse_groups_faces_and_sets_bold_italic() {
        let out = "\
/f/DejaVuSans.ttf: DejaVu Sans:style=Book:slant=0
/f/DejaVuSans-Bold.ttf: DejaVu Sans:style=Bold:slant=0
/f/DejaVuSans-Oblique.ttf: DejaVu Sans:style=Oblique:slant=110
/f/DejaVuSans-BoldOblique.ttf: DejaVu Sans:style=Bold Oblique:slant=110";
        let v = parse_fc_list(out);
        assert_eq!(v.len(), 1, "family deduped across 4 faces");
        let f = &v[0];
        assert_eq!(f.name, "DejaVu Sans");
        assert!(f.has_bold);
        assert!(f.has_italic, "Oblique counts as italic");
        assert!(!f.mono);
    }

    #[test]
    fn parse_mono_via_spacing_100() {
        let out = "/f/DejaVuSansMono.ttf: DejaVu Sans Mono:style=Book:slant=0:spacing=100";
        let v = parse_fc_list(out);
        assert_eq!(v.len(), 1);
        assert!(v[0].mono, "spacing=100 → mono");
    }

    #[test]
    fn parse_mono_via_spacing_word() {
        let out = "/f/X.ttf: Some Mono:style=Regular:spacing=mono";
        assert!(parse_fc_list(out)[0].mono);
    }

    #[test]
    fn parse_mono_via_family_name_when_spacing_absent() {
        // Real case from the fixture: `Noto Sans Mono` reports no spacing property at all.
        let out = "/f/Y.ttf: Noto Sans Mono:style=Bold:slant=0";
        assert!(parse_fc_list(out)[0].mono);
    }

    #[test]
    fn parse_mono_via_style_word_when_spacing_absent() {
        let out = "/f/Z.ttf: Hack:style=Bold Mono:slant=0";
        assert!(parse_fc_list(out)[0].mono);
    }

    #[test]
    fn parse_mono_requires_whole_word_not_substring() {
        // "Monoton"/"Monospace-ish" must not trip the mono flag on a substring match.
        let out = "\
/f/a.ttf: Monoton:style=Regular:slant=0
/f/b.ttf: Monaco:style=Regular:slant=0";
        let v = parse_fc_list(out);
        assert_eq!(v.len(), 2);
        assert!(
            v.iter().all(|f| !f.mono),
            "substring must not mean mono: {v:?}"
        );
    }

    #[test]
    fn parse_localized_family_takes_first_segment() {
        let out = "/f/NotoSansCJK-Light.ttc: Noto Sans CJK JP,Noto Sans CJK JP Light:style=Light,Regular:slant=0";
        let v = parse_fc_list(out);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "Noto Sans CJK JP", "first comma-segment only");
    }

    #[test]
    fn parse_ignores_blank_and_malformed_lines() {
        let out = "\n\n   \n/no-colon-here\n/f/A.ttf: Alpha:style=Bold\n";
        let v = parse_fc_list(out);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name, "Alpha");
        assert!(v[0].has_bold);
    }

    #[test]
    fn parse_empty_returns_empty() {
        assert!(parse_fc_list("").is_empty());
        assert!(parse_fc_list("\n\n").is_empty());
    }

    #[test]
    fn parse_sorts_alphabetically_case_insensitive() {
        let out = "\
/f/a.ttf: zebra:style=Regular
/f/b.ttf: Apple:style=Regular
/f/c.ttf: banana:style=Regular";
        let v = parse_fc_list(out);
        let names: Vec<_> = v.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["Apple", "banana", "zebra"]);
    }

    #[test]
    fn parse_caps_at_500() {
        let mut out = String::new();
        for i in 0..600 {
            out.push_str(&format!("/f/{i}.ttf: Fam{i:04}:style=Regular\n"));
        }
        assert_eq!(parse_fc_list(&out).len(), MAX_FONTS);
    }

    #[test]
    fn fallback_list_shape() {
        let v = fallback_fonts();
        let names: Vec<_> = v.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["serif", "sans-serif", "monospace", "system-ui"]);
        assert!(v.iter().all(|f| f.has_bold && f.has_italic));
        assert!(v.iter().find(|f| f.name == "monospace").unwrap().mono);
        assert!(!v.iter().find(|f| f.name == "serif").unwrap().mono);
    }
}
