//! B1 integration tests: hand-built EPUB fixture zips (constructed programmatically with the
//! zip writer — no committed binaries) exercising real-world robustness cases:
//! minimal EPUB2 (NCX, no properties), minimal EPUB3 (nav.xhtml + cover-image),
//! broken OPF (missing dc:creator), zip entries with spaces/unicode/percent-encoded names,
//! nav entries pointing mid-chapter, deep `../` hrefs.

use std::io::Write;
use std::path::PathBuf;

use zip::write::SimpleFileOptions;
use zip::ZipWriter;

use vellum_lib::epub::{self, BookArchive, NavKind};

// ---------------------------------------------------------------------------
// Fixture zip construction helpers
// ---------------------------------------------------------------------------

struct Fixture {
    entries: Vec<(String, Vec<u8>)>,
}

impl Fixture {
    fn new() -> Self {
        Fixture {
            entries: Vec::new(),
        }
    }

    fn add(mut self, path: &str, content: &str) -> Self {
        self.entries
            .push((path.to_string(), content.as_bytes().to_vec()));
        self
    }

    fn add_bytes(mut self, path: &str, content: &[u8]) -> Self {
        self.entries.push((path.to_string(), content.to_vec()));
        self
    }

    /// Write the fixture into the process-unique temp path and return it.
    fn write_to_temp(self, name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("vellum-b1-fixtures-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = ZipWriter::new(file);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        // mimetype first, as the spec demands.
        zip.start_file("mimetype", opts).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        for (p, c) in &self.entries {
            zip.start_file(p, opts).unwrap();
            zip.write_all(c).unwrap();
        }
        let f = zip.finish().unwrap();
        drop(f);
        path
    }
}

fn cleanup(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_dir(path.parent().unwrap());
}

const CONTAINER: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"#;

const CH1: &str = r#"<html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title></head>
<body><h1>Chapter One</h1><p>First chapter body text.</p><div id="mid">Middle of chapter.</div>
<p>Tail of chapter one.</p></body></html>"#;
const CH2: &str = r#"<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head>
<body><h1>Chapter Two</h1><p>Second chapter body.</p></body></html>"#;

// ---------------------------------------------------------------------------
// Minimal EPUB2: NCX toc, no properties attributes, meta name=cover
// ---------------------------------------------------------------------------

fn epub2_fixture() -> Fixture {
    let opf = r#"<?xml version="1.0" encoding="UTF-8"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"
         xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
  <metadata>
    <dc:identifier id="uid">urn:uuid:fixture-epub2</dc:identifier>
    <dc:title>Minimal EPUB2</dc:title>
    <dc:language>en</dc:language>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item href="cover.jpg" id="cover-img" media-type="image/jpeg"/>
    <item href="ch1.xhtml" id="c1" media-type="application/xhtml+xml"/>
    <item href="ch2.xhtml" id="c2" media-type="application/xhtml+xml"/>
    <item href="toc.ncx" id="ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="c1"/>
    <itemref idref="c2" linear="no"/>
  </spine>
</package>"#;
    let ncx = r#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>Chapter One</text></navLabel>
      <content src="ch1.xhtml"/>
      <navPoint id="np2" playOrder="2">
        <navLabel><text>Mid-chapter point</text></navLabel>
        <content src="ch1.xhtml#mid"/>
      </navPoint>
    </navPoint>
    <navPoint id="np3" playOrder="3">
      <navLabel><text>Ghost (not in spine)</text></navLabel>
      <content src="nowhere.xhtml"/>
    </navPoint>
  </navMap>
</ncx>"#;
    Fixture::new()
        .add("META-INF/container.xml", CONTAINER)
        .add("OEBPS/content.opf", opf)
        .add("OEBPS/ch1.xhtml", CH1)
        .add("OEBPS/ch2.xhtml", CH2)
        .add("OEBPS/toc.ncx", ncx)
        .add_bytes("OEBPS/cover.jpg", &[0xFF, 0xD8, 0xFF, 0x00])
}

#[test]
fn minimal_epub2_full_parse() {
    let path = epub2_fixture().write_to_temp("epub2.epub");
    let b = epub::open_book(path.to_str().unwrap()).unwrap();

    assert_eq!(b.metadata.title, "Minimal EPUB2");
    assert!(
        b.metadata.authors.is_empty(),
        "no dc:creator -> empty authors"
    );
    assert_eq!(b.metadata.language.as_deref(), Some("en"));
    assert_eq!(
        b.metadata.identifier.as_deref(),
        Some("urn:uuid:fixture-epub2")
    );
    assert_eq!(b.container_dir, "OEBPS");
    assert_eq!(b.spine.len(), 2);
    assert_eq!(b.spine[0].href, "OEBPS/ch1.xhtml");
    assert!(b.spine[0].linear);
    assert!(!b.spine[1].linear);
    assert_eq!(b.uid.len(), 40);

    // cover via meta name=cover
    let cover = epub::find_cover_href(&b).unwrap();
    assert_eq!(cover, "OEBPS/cover.jpg");
    assert_eq!(b.metadata.cover_href.as_deref(), Some("OEBPS/cover.jpg"));

    // NCX toc: 3 entries, levels 1/2/1, parents None/Some(0)/None
    assert_eq!(b.toc.len(), 3);
    assert_eq!(b.toc[0].title, "Chapter One");
    assert_eq!(b.toc[0].level, 1);
    assert_eq!(b.toc[0].parent_idx, None);
    assert_eq!(b.toc[0].chapter_idx, 0);
    assert_eq!(b.toc[0].cfi, None, "no fragment -> no cfi");
    // mid-chapter entry: chapter_idx resolved, cfi keeps the fragment for the anchor jump
    assert_eq!(b.toc[1].title, "Mid-chapter point");
    assert_eq!(b.toc[1].level, 2);
    assert_eq!(b.toc[1].parent_idx, Some(0));
    assert_eq!(b.toc[1].chapter_idx, 0, "fragment stripped -> chapter 0");
    assert_eq!(b.toc[1].cfi.as_deref(), Some("#mid"));
    // entry outside spine -> -1
    assert_eq!(b.toc[2].chapter_idx, -1);
    assert_eq!(
        b.toc[2].cfi, None,
        "unresolved entry has no navigable target"
    );

    // chapter text extraction roundtrip through the public API
    let ch1_bytes = epub::zip_entry_bytes(&b.path, &b.spine[0].href).unwrap();
    let text = epub::extract_text(&ch1_bytes);
    assert!(text.contains("Chapter One"));
    assert!(text.contains("First chapter body text."));
    assert!(!text.contains("One\n"), "head <title> text excluded");

    // uid stable
    let b2 = epub::open_book(path.to_str().unwrap()).unwrap();
    assert_eq!(b.uid, b2.uid);

    cleanup(&path);
}

// ---------------------------------------------------------------------------
// Minimal EPUB3: nav.xhtml, cover-image property, deep ../ hrefs
// ---------------------------------------------------------------------------

fn epub3_fixture() -> Fixture {
    let opf = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/"
         version="3.0" unique-identifier="uid">
  <metadata>
    <dc:identifier id="uid">urn:uuid:fixture-epub3</dc:identifier>
    <dc:title>Minimal EPUB3</dc:title>
    <dc:creator>Author Alpha</dc:creator>
    <dc:creator>Author Beta</dc:creator>
    <dc:language>ru</dc:language>
    <meta property="dcterms:modified">2024-05-05T12:00:00Z</meta>
  </metadata>
  <manifest>
    <item href="images/cover.png" id="ci" media-type="image/png" properties="cover-image"/>
    <item href="nav.xhtml" id="nav" media-type="application/xhtml+xml" properties="nav"/>
    <item href="text/ch1.xhtml" id="c1" media-type="application/xhtml+xml"/>
    <item href="text/ch2.xhtml" id="c2" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>"#;
    // nav lives in OPS dir; ch2 href uses ../text/ (deep-ish); one entry points mid-chapter.
    let nav = r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Nav Doc</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      <li><a href="text/ch1.xhtml">Первая глава</a>
        <ol>
          <li><a href="text/ch1.xhtml#mid">Середина</a></li>
          <li><span>Без ссылки</span></li>
        </ol>
      </li>
      <li><a href="../OEBPS/text/ch2.xhtml">Deep dotdot chapter</a></li>
    </ol>
  </nav>
  <nav epub:type="page-list" hidden="hidden">
    <ol><li><a href="text/ch1.xhtml">1</a></li></ol>
  </nav>
</body>
</html>"#;
    // Nav sits at OEBPS/nav.xhtml so ../OEBPS/text/ch2.xhtml resolves to OEBPS/text/ch2.xhtml.
    Fixture::new()
        .add("META-INF/container.xml", CONTAINER)
        .add("OEBPS/content.opf", opf)
        .add("OEBPS/nav.xhtml", nav)
        .add("OEBPS/text/ch1.xhtml", CH1)
        .add("OEBPS/text/ch2.xhtml", CH2)
        .add_bytes("OEBPS/images/cover.png", &[0x89, b'P', b'N', b'G', 0x00])
}

#[test]
fn minimal_epub3_full_parse() {
    let path = epub3_fixture().write_to_temp("epub3.epub");
    let b = epub::open_book(path.to_str().unwrap()).unwrap();

    assert_eq!(b.metadata.title, "Minimal EPUB3");
    assert_eq!(b.metadata.authors, vec!["Author Alpha", "Author Beta"]);
    assert_eq!(b.metadata.language.as_deref(), Some("ru"));

    // EPUB3 cover-image property wins
    assert_eq!(
        epub::find_cover_href(&b).as_deref(),
        Some("OEBPS/images/cover.png")
    );
    assert_eq!(b.cover_id.as_deref(), Some("ci"));

    // nav.xhtml preferred over any NCX; page-list nav ignored; 4 toc entries
    assert_eq!(b.toc.len(), 4);
    assert_eq!(b.toc[0].title, "Первая глава");
    assert_eq!(b.toc[0].chapter_idx, 0);
    assert_eq!(b.toc[1].title, "Середина");
    assert_eq!(b.toc[1].level, 2);
    assert_eq!(b.toc[1].parent_idx, Some(0));
    assert_eq!(b.toc[1].chapter_idx, 0, "mid-chapter -> chapter kept");
    assert_eq!(
        b.toc[1].cfi.as_deref(),
        Some("#mid"),
        "fragment kept for the jump"
    );
    assert_eq!(b.toc[2].title, "Без ссылки");
    assert_eq!(b.toc[2].chapter_idx, -1, "span entry -> -1");
    // '../' resolution: OEBPS/../OEBPS/text/ch2.xhtml == OEBPS/text/ch2.xhtml == spine[1]
    assert_eq!(b.toc[3].title, "Deep dotdot chapter");
    assert_eq!(b.toc[3].chapter_idx, 1, "../ href resolved against spine");

    cleanup(&path);
}

#[test]
fn epub3_nav_and_ncx_both_present_prefers_nav() {
    // Build an EPUB3 fixture that ALSO has an NCX (common in the wild).
    let mut f = epub3_fixture();
    let ncx = r#"<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>NCX entry</text></navLabel>
      <content src="text/ch1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>"#;
    f = f.add("OEBPS/toc.ncx", ncx);
    let path = f.write_to_temp("epub3-with-ncx.epub");
    let b = epub::open_book(path.to_str().unwrap()).unwrap();
    // nav.xhtml wins: 4 entries, none titled "NCX entry"
    assert_eq!(b.toc.len(), 4);
    assert!(!b.toc.iter().any(|e| e.title == "NCX entry"));
    cleanup(&path);
}

#[test]
fn find_nav_href_picks_nav_then_ncx() {
    let nav_item = epub::ManifestItem {
        id: "nav".into(),
        href: "OPS/nav.xhtml".into(),
        media_type: "application/xhtml+xml".into(),
        properties: vec!["nav".into()],
    };
    let ncx_item = epub::ManifestItem {
        id: "ncx".into(),
        href: "OPS/toc.ncx".into(),
        media_type: "application/x-dtbncx+xml".into(),
        properties: vec![],
    };
    let (href, kind) = epub::find_nav_href(&[ncx_item.clone(), nav_item], &[]).unwrap();
    assert_eq!((href.as_str(), kind), ("OPS/nav.xhtml", NavKind::Nav));
    let (href, kind) = epub::find_nav_href(std::slice::from_ref(&ncx_item), &[]).unwrap();
    assert_eq!((href.as_str(), kind), ("OPS/toc.ncx", NavKind::Ncx));
    assert!(epub::find_nav_href(&[], &[]).is_none());
}

// ---------------------------------------------------------------------------
// Weird file names: spaces, unicode, percent-encoded entries
// ---------------------------------------------------------------------------

#[test]
fn spaces_unicode_percent_entries() {
    // Manifest hrefs are percent-encoded (the common packer output), zip entry names are the
    // decoded unicode form. Storage form = decoded; zip lookup must try exact then encoded.
    let opf = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="http://www.idpf.org/2007/opf"
         version="3.0" unique-identifier="uid">
  <metadata>
    <dc:identifier id="uid">urn:uuid:weird-names</dc:identifier>
    <dc:title>Weird Names</dc:title>
    <dc:creator>Тест Тестов</dc:creator>
    <dc:language>ru</dc:language>
  </metadata>
  <manifest>
    <item href="text/%D0%93%D0%BB%D0%B0%D0%B2%D0%B0%201.xhtml" id="c1" media-type="application/xhtml+xml"/>
    <item href="text/sp%20ace%2Bplus.xhtml" id="c2" media-type="application/xhtml+xml"/>
    <item href="%D0%BE%D0%B1%D0%BB%D0%BE%D0%B6%D0%BA%D0%B0%20cover.jpg" id="cov" media-type="image/jpeg" properties="cover-image"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>"#;
    let f = Fixture::new()
        .add("META-INF/container.xml", CONTAINER)
        .add("OEBPS/content.opf", opf)
        .add("OEBPS/text/Глава 1.xhtml", CH1)
        .add("OEBPS/text/sp ace+plus.xhtml", CH2)
        .add_bytes("OEBPS/обложка cover.jpg", &[0xFF, 0xD8, 0xFF, 0x00]);
    let path = f.write_to_temp("weird-names.epub");
    let b = epub::open_book(path.to_str().unwrap()).unwrap();

    // Storage form: percent-decoded with spaces/unicode
    assert_eq!(b.spine[0].href, "OEBPS/text/Глава 1.xhtml");
    assert_eq!(b.spine[1].href, "OEBPS/text/sp ace+plus.xhtml");
    assert_eq!(b.metadata.authors, vec!["Тест Тестов".to_string()]);

    // cover detection through the unicode name
    let cover = epub::find_cover_href(&b).unwrap();
    assert_eq!(cover, "OEBPS/обложка cover.jpg");

    // zip_entry_bytes finds decoded names exactly AND percent-encoded inputs via fallback
    let bytes = epub::zip_entry_bytes(&b.path, &b.spine[0].href).unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("Chapter One"));
    let bytes_enc = epub::zip_entry_bytes(
        &b.path,
        "OEBPS/text/%D0%93%D0%BB%D0%B0%D0%B2%D0%B0%201.xhtml",
    )
    .unwrap();
    assert_eq!(bytes, bytes_enc);
    let cover_bytes = epub::zip_entry_bytes(&b.path, &cover).unwrap();
    assert_eq!(&cover_bytes[..2], &[0xFF, 0xD8]);

    cleanup(&path);
}

#[test]
fn entries_stored_percent_encoded_are_found() {
    // The reverse case: packer stored the *encoded* name as the actual zip entry name.
    let opf = r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="http://www.idpf.org/2007/opf"
         version="3.0" unique-identifier="uid">
  <metadata>
    <dc:identifier id="uid">urn:uuid:encoded-entries</dc:identifier>
    <dc:title>Encoded Entries</dc:title><dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item href="text/ch%201.xhtml" id="c1" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>"#;
    let f = Fixture::new()
        .add("META-INF/container.xml", CONTAINER)
        .add("OEBPS/content.opf", opf)
        // Zip name literally contains %20 (no real space).
        .add("OEBPS/text/ch%201.xhtml", CH1);
    let path = f.write_to_temp("encoded-entries.epub");
    let b = epub::open_book(path.to_str().unwrap()).unwrap();
    assert_eq!(b.spine[0].href, "OEBPS/text/ch 1.xhtml");
    // Exact lookup fails (stored name is encoded) -> percent-encoded fallback must find it.
    let bytes = epub::zip_entry_bytes(&b.path, &b.spine[0].href).unwrap();
    assert!(String::from_utf8_lossy(&bytes).contains("Chapter One"));
    cleanup(&path);
}

// ---------------------------------------------------------------------------
// Broken OPF: missing dc:creator, empty title, no nav at all
// ---------------------------------------------------------------------------

#[test]
fn broken_opf_missing_creator_and_nav() {
    let opf = r#"<?xml version="1.0"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata>
    <dc:title>Broken Book</dc:title>
  </metadata>
  <manifest>
    <item href="ch1.xhtml" id="c1" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/></spine>
</package>"#;
    let f = Fixture::new()
        .add("META-INF/container.xml", CONTAINER)
        .add("OEBPS/content.opf", opf)
        .add("OEBPS/ch1.xhtml", CH1);
    let path = f.write_to_temp("broken.epub");
    let b = epub::open_book(path.to_str().unwrap()).unwrap();

    assert_eq!(b.metadata.title, "Broken Book");
    assert!(b.metadata.authors.is_empty());
    assert_eq!(b.metadata.language, None);
    assert_eq!(b.metadata.identifier, None);
    assert!(b.toc.is_empty(), "no nav/ncx -> empty toc, still Ok");
    assert_eq!(b.spine.len(), 1);
    // uid falls back to size+first-64KiB and stays stable
    assert_eq!(b.uid.len(), 40);
    let b2 = epub::open_book(path.to_str().unwrap()).unwrap();
    assert_eq!(b.uid, b2.uid);
    assert!(epub::find_cover_href(&b).is_none(), "no images -> no cover");
    cleanup(&path);
}

#[test]
fn empty_toc_titles_fall_back_to_chapter_n() {
    let opf = r#"<?xml version="1.0"?>
<package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns="http://www.idpf.org/2007/opf" version="2.0">
  <metadata><dc:title>T</dc:title><dc:identifier id="i">x</dc:identifier></metadata>
  <manifest>
    <item href="ch1.xhtml" id="c1" media-type="application/xhtml+xml"/>
    <item href="toc.ncx" id="ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx"><itemref idref="c1"/></spine>
</package>"#;
    let ncx = r#"<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/">
  <navMap>
    <navPoint id="a" playOrder="1"><navLabel><text>  </text></navLabel><content src="ch1.xhtml"/></navPoint>
    <navPoint id="b" playOrder="2"><navLabel><text></text></navLabel><content src="ch1.xhtml"/></navPoint>
  </navMap>
</ncx>"#;
    let f = Fixture::new()
        .add("META-INF/container.xml", CONTAINER)
        .add("OEBPS/content.opf", opf)
        .add("OEBPS/ch1.xhtml", CH1)
        .add("OEBPS/toc.ncx", ncx);
    let path = f.write_to_temp("empty-titles.epub");
    let b = epub::open_book(path.to_str().unwrap()).unwrap();
    assert_eq!(b.toc.len(), 2);
    assert_eq!(b.toc[0].title, "Chapter 1");
    assert_eq!(b.toc[1].title, "Chapter 2");
    cleanup(&path);
}

// ---------------------------------------------------------------------------
// Malformed archives: Err, never panic
// ---------------------------------------------------------------------------

#[test]
fn malformed_archives_err_not_panic() {
    let dir = std::env::temp_dir().join(format!("vellum-b1-bad-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();

    // Truncated zip of a valid fixture.
    let good = epub2_fixture().write_to_temp("good-for-trunc.epub");
    let full = std::fs::read(&good).unwrap();
    for cut in [10usize, full.len() / 2, full.len() - 5] {
        let p = dir.join(format!("trunc-{cut}.epub"));
        std::fs::write(&p, &full[..cut.min(full.len())]).unwrap();
        let _ = epub::open_book(p.to_str().unwrap()); // must not panic
    }
    cleanup(&good);

    // Random bytes / empty file.
    let p = dir.join("random.epub");
    std::fs::write(&p, [7u8; 4096]).unwrap();
    assert!(epub::open_book(p.to_str().unwrap()).is_err());
    let p = dir.join("empty.epub");
    std::fs::write(&p, []).unwrap();
    assert!(epub::open_book(p.to_str().unwrap()).is_err());

    // Valid zip, garbage OPF.
    let f = Fixture::new()
        .add("META-INF/container.xml", CONTAINER)
        .add("OEBPS/content.opf", "\u{0}\u{1}garbage<<<");
    let p = f.write_to_temp("garbage-opf.epub");
    let r = epub::open_book(p.to_str().unwrap());
    assert!(r.is_err() || r.is_ok(), "must not panic"); // tolerant parse: either is fine
    cleanup(&p);

    // Valid zip, container points at a missing OPF.
    let f = Fixture::new().add("META-INF/container.xml", CONTAINER);
    let p = f.write_to_temp("missing-opf.epub");
    assert!(epub::open_book(p.to_str().unwrap()).is_err());
    cleanup(&p);

    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------------------
// nav_or_ncx_toc direct API (bytes in, flat toc out)
// ---------------------------------------------------------------------------

#[test]
fn nav_or_ncx_toc_direct() {
    let ncx = br#"<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
  <navPoint id="a" playOrder="1"><navLabel><text>One</text></navLabel><content src="a.xhtml"/>
    <navPoint id="b" playOrder="2"><navLabel><text>One.A</text></navLabel><content src="a.xhtml#x"/></navPoint>
    <navPoint id="c" playOrder="3"><navLabel><text>One.B</text></navLabel><content src="b.xhtml"/></navPoint>
  </navPoint>
  <navPoint id="d" playOrder="4"><navLabel><text>Two</text></navLabel><content src="b.xhtml"/></navPoint>
</navMap></ncx>"#;
    let toc = epub::nav_or_ncx_toc(ncx, NavKind::Ncx).unwrap();
    assert_eq!(toc.len(), 4);
    // document order preserved; standalone call leaves chapter_idx = -1, cfi cleared
    let titles: Vec<&str> = toc.iter().map(|e| e.title.as_str()).collect();
    assert_eq!(titles, vec!["One", "One.A", "One.B", "Two"]);
    assert!(toc.iter().all(|e| e.chapter_idx == -1 && e.cfi.is_none()));

    // Caller-side resolution needs the href transport, so parse with `parse_ncx` directly
    // (nav_or_ncx_toc already consumed+cleared it above by design).
    let mut toc = vellum_lib::epub::ncx::parse_ncx(ncx).unwrap();
    let spine = vec!["a.xhtml".to_string(), "b.xhtml".to_string()];
    vellum_lib::epub::ncx::resolve_chapter_indices(&mut toc, &spine);
    let idx: Vec<i64> = toc.iter().map(|e| e.chapter_idx).collect();
    assert_eq!(idx, vec![0, 0, 1, 1]);
    let levels: Vec<i64> = toc.iter().map(|e| e.level).collect();
    assert_eq!(levels, vec![1, 2, 2, 1]);
    let parents: Vec<Option<i64>> = toc.iter().map(|e| e.parent_idx).collect();
    assert_eq!(parents, vec![None, Some(0), Some(0), None]);
}

#[test]
fn ncx_deep_nesting_levels() {
    // 4 levels deep; verify level == nesting depth and parent chains.
    let ncx = br#"<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap>
  <navPoint id="1"><navLabel><text>L1</text></navLabel><content src="a.xhtml">
    <navPoint id="2"><navLabel><text>L2</text></navLabel><content src="a.xhtml">
      <navPoint id="3"><navLabel><text>L3</text></navLabel><content src="a.xhtml">
        <navPoint id="4"><navLabel><text>L4</text></navLabel><content src="a.xhtml"/>
      </navPoint>
    </navPoint>
  </navPoint>
</navMap></ncx>"#;
    let toc = epub::nav_or_ncx_toc(ncx, NavKind::Ncx).unwrap();
    let levels: Vec<i64> = toc.iter().map(|e| e.level).collect();
    assert_eq!(levels, vec![1, 2, 3, 4]);
    let parents: Vec<Option<i64>> = toc.iter().map(|e| e.parent_idx).collect();
    assert_eq!(parents, vec![None, Some(0), Some(1), Some(2)]);
}

// ---------------------------------------------------------------------------
// BookArchive threading contract (§ B1 scope item 5)
// ---------------------------------------------------------------------------

#[test]
fn book_archive_survives_thread_hop() {
    let path = epub2_fixture().write_to_temp("threaded.epub");
    let b = epub::open_book(path.to_str().unwrap()).unwrap();
    let handle = std::thread::spawn(move || {
        // Moved into another thread: Send + 'static in practice.
        assert_eq!(b.metadata.title, "Minimal EPUB2");
        assert!(!b.toc.is_empty());
        let bytes = epub::zip_entry_bytes(&b.path, &b.spine[0].href).unwrap();
        epub::extract_text(&bytes).len()
    });
    assert!(handle.join().unwrap() > 50);
    cleanup(&path);
}

// ---------------------------------------------------------------------------
// extract_text end-to-end on real book chapter (B5 contract)
// ---------------------------------------------------------------------------

#[test]
fn extract_text_on_real_testbook_chapter() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../testbooks/pg84.epub");
    let b: BookArchive = epub::open_book(path.to_str().unwrap()).unwrap();
    // A mid-book chapter (not the tiny cover page).
    let item = &b.spine[b.spine.len() / 2];
    let bytes = epub::zip_entry_bytes(&b.path, &item.href).unwrap();
    let text = epub::extract_text(&bytes);
    assert!(text.len() > 500, "chapter text too short: {}", text.len());
    assert!(text.contains("\n\n"), "paragraph breaks expected");
    assert!(!text.contains("<"), "no markup leaks");
    assert!(!text.contains("&amp;"), "entities resolved");
}
