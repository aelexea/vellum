/**
 * Fixture DOMs for the engine tests (§8 F0).
 *
 * Built from HTML strings so the exact node structure — including which whitespace text nodes
 * exist — is visible and reproducible. CFI expectations depend on that structure, because
 * §3.1.1 preserves insignificant whitespace as indexable character-data chunks.
 */

/**
 * A compact chapter with nested inline elements, multiple text chunks per element, and a
 * multi-sentence Russian paragraph. Markup is written without inter-tag whitespace so the
 * chunk indices stay readable; {@link prettyChapter} covers the indented case.
 *
 * body
 * ├─ h1          "Chapter One"                       → /2   (chunk /1 = "Chapter One")
 * ├─ p#p1                                            → /4
 * │  ├─ text     "Hello "                            → /1
 * │  ├─ b        "world"                             → /2   (its own chunk /1)
 * │  └─ text     " again"                            → /3
 * ├─ div#nested                                      → /6
 * │  ├─ text     "alpha"                             → /1
 * │  ├─ span                                         → /2
 * │  │  ├─ text  "beta "                             → /1
 * │  │  ├─ em    "gamma"                             → /2   (chunk /1 = "gamma")
 * │  │  └─ text  " delta"                            → /3
 * │  └─ text     "omega"                             → /3
 * ├─ p#p2                                            → /8
 * │  └─ text     Russian multi-sentence paragraph    → /1
 * └─ p#p3                                            → /10
 *    └─ text     "Last line"                         → /1
 */
export const COMPACT_CHAPTER =
  '<h1>Chapter One</h1>' +
  '<p id="p1">Hello <b>world</b> again</p>' +
  '<div id="nested">alpha<span>beta <em>gamma</em> delta</span>omega</div>' +
  '<p id="p2">Он пошёл домой. «Правда?» — спросила она… Да! Потом всё стихло.</p>' +
  '<p id="p3">Last line</p>';

export const RU_PARAGRAPH = 'Он пошёл домой. «Правда?» — спросила она… Да! Потом всё стихло.';

/** The same chapter pretty-printed: indentation creates whitespace-only chunks that must be
 * indexed (odd steps) rather than skipped — the classic epubcfi interop hazard. */
export const PRETTY_CHAPTER = `<h1>Title</h1>
<p id="q1">One <b>two</b> three</p>
<p id="q2">Tail</p>`;

/** Install one of the fixtures into `doc.body` and return the body element. */
export function mountChapter(doc: Document, html: string = COMPACT_CHAPTER): HTMLElement {
  doc.body.innerHTML = html;
  return doc.body;
}

/** A long chapter (many paragraphs) for perf-sensitive tests. */
export function longChapter(paragraphs: number, wordsPerParagraph = 60): string {
  const word = (n: number): string => `слово${n}`;
  let html = '<h1>Long</h1>';
  for (let p = 0; p < paragraphs; p += 1) {
    let text = '';
    for (let w = 0; w < wordsPerParagraph; w += 1) text += `${word(w)} `;
    html += `<p id="lp${p}">${text.trim()}</p>`;
  }
  return html;
}

/** A chapter shaped like a real Gutenberg file: nested lists, figures, blockquotes. */
export const RICH_CHAPTER =
  '<h1 id="ch1">Глава 1</h1>' +
  '<p id="r1">Первый абзац с <em>курсивом</em> и <strong>жирным</strong> текстом.</p>' +
  '<blockquote id="bq1"><p>Цитата внутри блока.</p></blockquote>' +
  '<ul id="ul1"><li>Пункт один</li><li>Пункт <b>два</b></li></ul>' +
  '<figure id="fig1"><img src="vellum://book/x/asset/a.png" alt="Рисунок" />' +
  '<figcaption>Подпись</figcaption></figure>' +
  '<p id="r2">Последний абзац.</p>';

/** The link fixtures the controller must route (B2's rewrite output, §4.3 + its deviation). */
export const LINK_CHAPTER =
  '<p id="l1">See <a id="ext" href="https://example.com/page" data-vellum-external="1">outside</a>.</p>' +
  '<p id="l2">Go to <a id="zip" href="vellum-link://OPS/text/ch2.xhtml#sec1">chapter two</a>.</p>' +
  '<p id="l3">Legacy <a id="legacy" href="#vellum-link:3:frag9">marker</a>.</p>' +
  '<p id="l4">Anchor <a id="frag" href="#r2">in page</a>.</p>' +
  '<p id="l5">Mail <a id="mail" href="mailto:a@b.c">us</a>.</p>' +
  '<p id="l6">Unmarked <a id="http" href="http://plain.example/">http</a>.</p>' +
  '<p id="l7"><img id="img1" src="vellum://book/x/asset/a.png" alt="Рисунок" /></p>' +
  '<h2 id="r2">Target heading</h2>';
