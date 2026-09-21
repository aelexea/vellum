//! META-INF/container.xml parsing (§3) — owned by B1.

use quick_xml::events::Event;
use quick_xml::{Reader, XmlVersion};

const OPF_MEDIA_TYPE: &str = "application/oebps-package+xml";

/// Locate the OPF rootfile path (zip-relative) from `META-INF/container.xml` bytes.
/// Returns the full path of the first `application/oebps-package+xml` rootfile.
///
/// Multiple rootfiles: the first rootfile with `media-type="application/oebps-package+xml"`
/// wins; when none carries that media-type (rare/malformed) the first rootfile wins.
pub fn opf_path(container_xml: &[u8]) -> anyhow::Result<String> {
    let mut reader = Reader::from_reader(container_xml);
    let mut fallback: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() != "rootfile" {
                    continue;
                }
                let mut full_path: Option<String> = None;
                let mut is_opf = false;
                let mut attrs = e.attributes();
                attrs.with_checks(false);
                for a in attrs.flatten() {
                    let Ok(v) = a.normalized_value(XmlVersion::Implicit1_0) else {
                        continue;
                    };
                    match a.key.local_name().as_ref() {
                        "full-path" => {
                            let v = v.trim();
                            if !v.is_empty() {
                                full_path = Some(v.to_string());
                            }
                        }
                        "media-type" => {
                            is_opf = v.trim() == OPF_MEDIA_TYPE;
                        }
                        _ => {}
                    }
                }
                if let Some(path) = full_path {
                    if is_opf {
                        return Ok(normalize_opf_path(&path));
                    }
                    if fallback.is_none() {
                        fallback = Some(normalize_opf_path(&path));
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => {
                return Err(anyhow::anyhow!("container.xml parse error: {e}"));
            }
            _ => {}
        }
    }

    fallback.ok_or_else(|| anyhow::anyhow!("container.xml: no rootfile found"))
}

/// Strip a leading `/` and collapse duplicate slashes; the container full-path is a
/// zip-relative URI, never absolute.
fn normalize_opf_path(path: &str) -> String {
    let p = path.trim().trim_start_matches('/');
    collapse_slashes(p)
}

/// Collapse runs of `/` into one (keeps a trailing empty segment intact).
pub(crate) fn collapse_slashes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_slash = false;
    for ch in s.chars() {
        if ch == '/' {
            if !prev_slash {
                out.push('/');
            }
            prev_slash = true;
        } else {
            out.push(ch);
            prev_slash = false;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_container() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;
        assert_eq!(opf_path(xml).unwrap(), "OEBPS/content.opf");
    }

    #[test]
    fn multiple_rootfiles_prefer_opf_media_type() {
        let xml = br#"<container><rootfiles>
  <rootfile full-path="weird/content.opf" media-type="application/xhtml+xml"/>
  <rootfile full-path="OPS/package.opf" media-type="application/oebps-package+xml"/>
  <rootfile full-path="second/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles></container>"#;
        assert_eq!(opf_path(xml).unwrap(), "OPS/package.opf");
    }

    #[test]
    fn missing_media_type_falls_back_to_first() {
        let xml = br#"<container><rootfiles>
  <rootfile full-path="/root/content.opf"/>
  <rootfile full-path="second/content.opf"/>
</rootfiles></container>"#;
        assert_eq!(opf_path(xml).unwrap(), "root/content.opf");
    }

    #[test]
    fn double_slash_collapsed_percent_kept_as_written() {
        // Storage form stays exactly as written in the container (percent-encoded names are
        // resolved at zip-lookup time); only slashes collapse and a leading '/' is dropped.
        let xml = br#"<container><rootfiles>
  <rootfile full-path="My%20Book//OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles></container>"#;
        assert_eq!(opf_path(xml).unwrap(), "My%20Book/OEBPS/content.opf");
    }

    #[test]
    fn entities_in_full_path_unescaped() {
        let xml = br#"<container><rootfiles>
  <rootfile full-path="A&amp;B/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles></container>"#;
        assert_eq!(opf_path(xml).unwrap(), "A&B/content.opf");
    }

    #[test]
    fn no_rootfile_is_error_not_panic() {
        assert!(opf_path(b"<container><rootfiles></rootfiles></container>").is_err());
        assert!(opf_path(b"not xml at all <<<").is_err());
        assert!(opf_path(b"").is_err());
    }
}
