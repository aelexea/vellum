//! Static language table (§11.4) — owned by B7.
//!
//! `table()` returns the full provider-supported list (ISO 639-1 code + English display
//! name), sorted by `name_ru` for the UI pickers. `detect_heuristic` is the offline
//! unicode-block sniff used by `net::detect_lang` when no provider detection is available
//! (§11.4 "Provider endpoint reality": never needs the network).

use crate::dto::Lang;

/// ISO 639-1 code → English display name (§6.9 language picker). Sorted by nameRu.
/// (The dto field keeps its legacy `name_ru` name; it now carries English names.)
pub fn table() -> Vec<Lang> {
    const TABLE: &[(&str, &str)] = &[
        ("auto", "Auto"),
        ("en", "English"),
        ("ru", "Russian"),
        ("de", "German"),
        ("fr", "French"),
        ("es", "Spanish"),
        ("it", "Italian"),
        ("pt", "Portuguese"),
        ("pl", "Polish"),
        ("cs", "Czech"),
        ("uk", "Ukrainian"),
        ("be", "Belarusian"),
        ("bg", "Bulgarian"),
        ("sr", "Serbian"),
        ("hr", "Croatian"),
        ("sl", "Slovenian"),
        ("sk", "Slovak"),
        ("hu", "Hungarian"),
        ("ro", "Romanian"),
        ("el", "Greek"),
        ("tr", "Turkish"),
        ("ar", "Arabic"),
        ("he", "Hebrew"),
        ("fa", "Persian"),
        ("hi", "Hindi"),
        ("bn", "Bengali"),
        ("ur", "Urdu"),
        ("ta", "Tamil"),
        ("te", "Telugu"),
        ("mr", "Marathi"),
        ("gu", "Gujarati"),
        ("pa", "Punjabi"),
        ("kn", "Kannada"),
        ("ml", "Malayalam"),
        ("si", "Sinhala"),
        ("th", "Thai"),
        ("lo", "Lao"),
        ("km", "Khmer"),
        ("my", "Burmese"),
        ("ka", "Georgian"),
        ("hy", "Armenian"),
        ("az", "Azerbaijani"),
        ("kk", "Kazakh"),
        ("ky", "Kyrgyz"),
        ("uz", "Uzbek"),
        ("tg", "Tajik"),
        ("mn", "Mongolian"),
        ("zh", "Chinese"),
        ("ja", "Japanese"),
        ("ko", "Korean"),
        ("vi", "Vietnamese"),
        ("id", "Indonesian"),
        ("ms", "Malay"),
        ("tl", "Tagalog"),
        ("sw", "Swahili"),
        ("af", "Afrikaans"),
        ("eu", "Basque"),
        ("ca", "Catalan"),
        ("gl", "Galician"),
        ("is", "Icelandic"),
        ("ga", "Irish"),
        ("cy", "Welsh"),
        ("mt", "Maltese"),
        ("sq", "Albanian"),
        ("mk", "Macedonian"),
        ("bs", "Bosnian"),
        ("lt", "Lithuanian"),
        ("lv", "Latvian"),
        ("et", "Estonian"),
        ("fi", "Finnish"),
        ("sv", "Swedish"),
        ("no", "Norwegian"),
        ("da", "Danish"),
        ("nl", "Dutch"),
        ("la", "Latin"),
    ];
    let mut v: Vec<Lang> = TABLE
        .iter()
        .map(|(code, name)| Lang {
            code: (*code).to_owned(),
            name_ru: (*name).to_owned(),
        })
        .collect();
    // sorted by display name for the UI ("Auto" lands between Armenian and Azerbaijani)
    v.sort_by(|a, b| a.name_ru.cmp(&b.name_ru).then(a.code.cmp(&b.code)));
    v
}

/// Offline language sniff (§11.4 addendum): unicode blocks → ISO 639-1 code.
/// Ambiguous Latin script maps to "en". Never fails, never touches the network.
pub fn detect_heuristic(text: &str) -> String {
    detect_code(text).to_owned()
}

/// `&'static str` core of [`detect_heuristic`] (table-testable).
pub(crate) fn detect_code(text: &str) -> &'static str {
    let mut kana = 0u32;
    let mut hangul = 0u32;
    let mut han = 0u32;
    let mut greek = 0u32;
    let mut hebrew = 0u32;
    let mut arabic = 0u32;
    let mut persian_extra = false; // پ چ ژ گ
    let mut urdu_extra = false; // ٹ ڈ ڑ ں ے
    let mut cyrillic = 0u32;
    let mut cyr_uk = false; // ї є ґ
    let mut cyr_i = false; // і (uk + be, not ru)
    let mut cyr_be = false; // ў
    let mut devanagari = 0u32;
    let mut thai = 0u32;
    let mut georgian = 0u32;
    let mut armenian = 0u32;
    // latin is not counted: ambiguous Latin script falls through to "en" (§11.4)

    for c in text.chars() {
        let u = c as u32;
        match u {
            0x3040..=0x30FF => kana += 1, // hiragana + katakana
            0x1100..=0x11FF | 0x3130..=0x318F | 0xAC00..=0xD7AF => hangul += 1,
            0x3400..=0x4DBF | 0x4E00..=0x9FFF => han += 1,
            0x0370..=0x03FF => greek += 1,
            0x0590..=0x05FF => hebrew += 1,
            0x0600..=0x06FF => {
                arabic += 1;
                match u {
                    0x067E | 0x0686 | 0x0698 | 0x06AF => persian_extra = true,
                    0x0679 | 0x0688 | 0x0691 | 0x06BA | 0x06D2 => urdu_extra = true,
                    _ => {}
                }
            }
            0x0400..=0x04FF => {
                cyrillic += 1;
                match u {
                    0x0457 | 0x0454 | 0x0491 => cyr_uk = true, // ї є ґ
                    0x0456 => cyr_i = true,                    // і
                    0x045E => cyr_be = true,                   // ў
                    _ => {}
                }
            }
            0x0900..=0x097F => devanagari += 1,
            0x0E00..=0x0E7F => thai += 1,
            0x10A0..=0x10FF => georgian += 1,
            0x0530..=0x058F => armenian += 1,
            _ => {} // latin/other: default bucket → "en"
        }
    }

    // priority: most distinctive scripts first; ambiguous Latin → en
    if kana > 0 {
        "ja"
    } else if hangul > 0 {
        "ko"
    } else if han > 0 {
        "zh"
    } else if thai > 0 {
        "th"
    } else if devanagari > 0 {
        "hi"
    } else if georgian > 0 {
        "ka"
    } else if armenian > 0 {
        "hy"
    } else if hebrew > 0 {
        "he"
    } else if greek > 0 {
        "el"
    } else if cyrillic > 0 {
        // ў occurs only in Belarusian; ї/є/ґ only in Ukrainian; і is in uk+be (not ru),
        // so once ў is ruled out it points at Ukrainian.
        if cyr_be {
            "be"
        } else if cyr_uk || cyr_i {
            "uk"
        } else {
            "ru"
        }
    } else if arabic > 0 {
        if persian_extra {
            "fa"
        } else if urdu_extra {
            "ur"
        } else {
            "ar"
        }
    } else {
        "en"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_is_non_empty_and_unique() {
        let t = table();
        assert!(!t.is_empty());
        let mut codes: Vec<_> = t.iter().map(|l| l.code.clone()).collect();
        let n = codes.len();
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), n, "duplicate language codes");
        assert!(t.iter().any(|l| l.code == "ru"));
    }

    #[test]
    fn table_covers_contract_set() {
        let t = table();
        assert!(t.len() >= 60, "expected ~60+ languages, got {}", t.len());
        for code in [
            "auto", "en", "ru", "de", "fr", "es", "uk", "be", "zh", "ja", "ko", "ar", "he", "hi",
            "fi", "nl", "la", "af", "mt", "cy",
        ] {
            assert!(t.iter().any(|l| l.code == code), "missing {code}");
        }
        // English display names
        let by_code = |c: &str| t.iter().find(|l| l.code == c).map(|l| l.name_ru.clone());
        assert_eq!(by_code("en").as_deref(), Some("English"));
        assert_eq!(by_code("af").as_deref(), Some("Afrikaans"));
        assert_eq!(by_code("auto").as_deref(), Some("Auto"));
    }

    #[test]
    fn table_sorted_by_name_ru() {
        let t = table();
        for w in t.windows(2) {
            assert!(
                w[0].name_ru <= w[1].name_ru,
                "{} > {}",
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
            ("你好，世界", "zh"),
            ("こんにちは世界", "ja"),
            ("안녕하세요", "ko"),
            ("Καλημέρα κόσμε", "el"),
            ("مرحبا بالعالم", "ar"),
            ("שלום עולם", "he"),
            ("नमस्ते दुनिया", "hi"),
            ("Hello Привет mixed", "ru"),
            ("12345 -- ?!", "en"),
            ("", "en"),
        ];
        for (text, want) in cases {
            assert_eq!(detect_code(text), want, "text={text:?}");
        }
    }

    #[test]
    fn detect_belarusian_via_short_u() {
        // ў + і are Belarusian-specific (ў does not occur in uk or ru)
        assert_eq!(detect_code("Гэта ўнікальны тэкст"), "be");
    }
}
