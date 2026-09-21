# Vellum — Integration checklist

Cross-WP seams collected from agent reports. Each must be verified during integration, after
every WP lands. Checked off as verified.

## A. Cross-module bindings (backend)

- [ ] **B3 → B5 auto-index.** `commands/reader.rs::open_book` calls
      `search::index::maybe_reindex(&app, uid)`; B5 must export exactly
      `pub fn maybe_reindex(app: &tauri::AppHandle, book_uid: &str)`. B3 wrapped it in
      `catch_unwind` temporarily — **remove the catch_unwind once B5 lands** (B3 DEVIATION).
- [ ] **B6 → B7 lookup.** `commands/vocab.rs::lookup_word` calls `net::lookup(&state, word, ctx)`.
      Verify B7's landed signature matches §11.4 and that B6 fills
      `lookupCount/suggestAdd/alreadyInVocab` (B7 leaves them false/0).
- [ ] **B7 → B2 helper.** B7 defined its own `net::pct_encode` instead of importing
      `epub::rewrite::pct_encode_path` (verified: no unresolved symbol, B8 checked).
      Optional cleanup: dedupe the two encoders. Not blocking.
- [ ] **B8 → B4 SQL duplication.** `backup.rs` has its own annotation SELECT/INSERT SQL
      (written while `db/annotations.rs` was a stub) with `has_note` via correlated EXISTS.
      B8: "should later be folded onto B4's helpers to avoid two SQL paths." Verify both
      paths agree on column order (text between color and created_at) and that
      export→wipe→import roundtrips against B4's real CRUD.
- [ ] **lib.rs rescan-lite.** Lines 64-66 document `db::library::mark_missing` as
      intentionally not spawned (stub would panic off-thread). Once B3 lands, decide:
      spawn it in setup (off-thread) or leave rescan to the explicit `rescan_library`
      command + library load. Current behavior: missing flags refresh only on explicit
      rescan. Acceptable; document in README if left.

## B. v1.2 / v1.3 contract changes — propagation audit

`VocabWord.ease` (v1.2) and `Highlight.text` (v1.3) were added to frozen DTOs mid-flight.
Every producer/consumer must be consistent:

- [ ] dto.rs: both fields present (`#[serde(default)]` on Highlight.text).
- [ ] §4.4 DDL in B3's `db/mod.rs::migrate`: `highlights.text TEXT NOT NULL DEFAULT ''`;
      `vocab.ease REAL NOT NULL DEFAULT 2.5`.
- [ ] B4 `db/annotations.rs`: add_highlight takes + INSERTs `text`; all Highlight mappers
      SELECT it. add_highlight command signature has the 6th `text` arg.
- [ ] B3 `commands/reader.rs`: local read-only Highlight SELECT includes `text`
      (E0063 reported by B8 — messaged B3).
- [ ] B6 `db/vocab.rs`: all VocabWord mappers SELECT + populate `ease`; record_review
      returns the UPDATED ease.
- [ ] B8 `backup.rs`: already re-aligned by B8 (HL_SELECT includes h.text; import INSERT
      writes it; md export quotes real text with CFI fallback for pre-v1.3 rows).
- [ ] types.ts / lib/tauri.ts / readerStore: done by orchestrator
      (`addHighlight(cfiStart, cfiEnd, color, text)`).
- [ ] F2 `SelectionToolbar.tsx:139`: pass `selection.text` as 4th arg (messaged F2).
- [ ] Test fixtures: setup.ts done; F4's two test files done; F5's AnnotationsPanel.test.tsx
      done (HL_A text:'' to exercise the Note-fallback path, HL_B/HL_OTHER have real text).
- [ ] Any remaining `Highlight`/`VocabWord` literal in tests → grep for `hasNote:` and
      `lastReviewedAt:` and confirm `text:`/`ease:` present.

## C. Frontend integration seams

- [ ] **F5 → F2 `vellum:find`.** Panels dispatch
      `window.dispatchEvent(new CustomEvent('vellum:find', {detail:{chapterIdx, text?, cfi?}}))`
      via `src/features/search/jump.ts` (`FIND_EVENT`). ChapterFrame must subscribe and,
      once the target chapter is loaded+laid out, do the in-chapter part: prefer
      `detail.cfi` → controller.goto + flash; else `detail.text` → controller.find(text,0)
      → goto + flash. Ignore events whose chapterIdx ≠ current (stale). (Messaged F2.)
- [ ] **F5 ↔ F2 shared drawer header.** App renders SearchPanel/AnnotationsPanel standalone
      and TocPanel separately. F5's two panels each render the 3-tab header
      "Contents | Search | Notes" (active = 2px accent underline ::after, switching via
      `uiStore.setOverlay`). F2's TocPanel must render the SAME header so the three drawers
      don't visually jump. (Messaged F2.)
- [ ] **B2 → F0/F2 `vellum-link://`.** Internal chapter links are rewritten to
      `href="vellum-link://{pct-encoded zip path}#{fragment}"` (scheme deliberately
      unroutable → 404 if not intercepted). Controller must intercept clicks on
      `href` starting `vellum-link://` and map decoded zipPath → spine idx via
      `book.chapters[].href`, giving `{zipPath, fragment}`. External http(s)/mailto/tel get
      `data-vellum-external="1"` → opener plugin. Fragment-only `#foo` untouched → in-page
      smooth scroll. (In F2's brief; verify F0's controller.ts implements the scheme.)
- [ ] **F3 → F2 re-layout.** F3 did NOT add a reader re-layout effect on settings change;
      ChapterFrame must re-layout on `settings.page` / `reading.mode` changes and restore
      the current page/cfi. (Messaged F2.)
- [ ] **F3 → F2 App.tsx shortcut TODOs.** Four actions still unwired in the frozen App.tsx
      keydown switch: openSettings, backToLibrary, startReview, quit. F2 owns the dispatch
      path. (Messaged F2.)
- [ ] **animations kill-switch double-write.** F3's effect writes
      `documentElement.dataset.animations = "on"|"false"`; frozen `uiStore.applyTheme`
      writes `"off"`. themes.css handles BOTH — do not "fix" either side.
- [ ] **F4 ReviewSession interval previews** now use real `ease` from the DTO (v1.2) instead
      of assuming 2.5 — verify the preview matches B6's `sm2_next` output for the same word.
- [ ] **F1 "Stats" menu item** only does `setView('stats')` (no per-book scoping — no
      store field exists). Acceptable interim; note in README or wire later.
- [ ] **F3 BackupPanel/F4 vocab import** import `open` from `@tauri-apps/plugin-dialog`
      directly (lib/tauri.ts has no generic `openFile`). Optional: add `openFile(filters)`
      to lib/tauri.ts and refactor both. Not blocking.
- [ ] **F3 "Open data folder"** uses `appDataDir()` with an XDG string fallback (no
      command exposes AppPaths). Optional: add `get_app_paths`. Not blocking.
- [ ] **F1 DnD** uses `getCurrentWebview().onDragDropEvent` (dynamic import gated on
      `window.__TAURI_INTERNALS__`) because Tauri 2 intercepts drops natively and DOM
      `dataTransfer.files[].path` is empty in WebKitGTK. Verify real drops work in the
      smoke test; the pathless-drop toast branch is a genuine platform limitation.
- [ ] **F2 Shortcuts.ts export names** must stay `DEFAULT_SHORTCUTS`, `SHORTCUT_LABELS`,
      `comboFromEvent`, `serializeCombo`, `findConflict` (F3's ShortcutsPanel imports them
      read-only). NOTE: `SHORTCUT_LABELS_RU` was renamed to `SHORTCUT_LABELS` during the
      English translation — update F3's ShortcutsPanel import accordingly. F1 also flagged:
      Shortcuts.ts dynamically imports readerStore/uiStore → 2 Vite warnings + chunk noise;
      converting to static imports is a cheap cleanup.
- [ ] **F0 → F2 flashCfi.** F2 asked F0 for `controller.flashCfi(cfi, ms?)` (annotations-panel
      jumps supply exact CFIs; today goto({cfi}) with no flash). Messaged F0 — verify it
      landed and that F2's ChapterFrame calls it for cfi-targeted pendingFind.
- [ ] **F0 readerBaseCss flash color.** `mark.vellum-flash` hardcoded `#c2662d` fallback →
      should be `var(--v-accent, …)`. F2 injects `--v-accent`/`--v-ease`/`--v-hyphens` into
      srcdoc; verify the var contract both sides (F0's readerBaseCss reads vs F2's
      buildSrcdoc emits) after F0 finishes.
- [ ] **DrawerTabs hoist.** F5's SearchPanel/AnnotationsPanel and F2's TocPanel each contain
      a private copy of the 3-tab drawer header (`vel-sp-tabs`/`vel-sp-tab` markup). Hoist to
      `src/components/DrawerTabs.tsx` at integration so the three drawers can't drift.
- [ ] **CSS cascade trap (Segmented/Select/Slider internals).** base.css's UNLAYERED
      `button`/`input` resets beat Tailwind's `@layer utilities` rules, so color/padding/font
      utilities on interactive elements inside frozen components silently lose. F5/F2 worked
      around it with class selectors in their own files; F6's polished Segmented/Select/Slider
      internals still use utilities in spots (visible in QuickSettings mode segmented +
      sliders). Integration fix: restyle those internals with class selectors (props API
      unchanged). Alternatively add `@layer` wrapping to base.css resets — riskier, verify
      against all views.
- [ ] **First real WebKitGTK run — page math.** jsdom can't test CSS-column layout. Verify on
      first GUI run: engine `measurePages` agrees with F2's `pages>1 ? page/(pages-1) : 0`
      pct mapping; `setPage` transform step = pageWidth + gapPx with F2's GAP_PX=48;
      position save/restore lands on the same page; scroll-mode iframe height sizing +
      ResizeObserver behave; chapter prefetch doesn't leak memory over ~20 chapters.

## D. Review-workflow findings (apply after synthesis lands)

Already applied by orchestrator:
- [x] **BLOCKER: protocol registration.** `register_asynchronous_uri_scheme_protocol` exists
      ONLY on `Builder<R>`, not AppHandle/App/Manager; and Tauri creates config windows
      BEFORE the user setup hook, with schemes bound at webview creation. Applied: chained
      `.register_asynchronous_uri_scheme_protocol("vellum", protocol::uri_scheme_protocol())`
      on the Builder in lib.rs before `.setup()`; removed the misleading
      `protocol::register(&handle)` call (B2 independently filed the same FCR).
      **Without this every vellum:// request 404s** — chapters, assets, covers.
- [x] **MAJOR: FTS5 snippet() does not escape.** Verified against sqlite 3.53.4: snippet()
      returns stored text verbatim plus the mark strings. With `csp:null` and the search
      panel in the app origin (not the sandboxed iframe), book-supplied markup would get the
      Tauri IPC bridge. B5 already implemented `escape_snippet` (splits on `<mark>`/`</mark>`,
      HTML-escapes everything else) — **verify it's exercised by a test with `<script>` in
      the chapter body**.
- [x] **BLOCKER: self-closing non-void XHTML tags.** srcdoc is always HTML-parsed; `<a id="x"/>`
      swallows the rest of the chapter via formatting-element reconstruction (measured on
      pg84: 27 `<p>` / 13023 chars). **B2 FIXED + VERIFIED (84 tests):** the prescribed
      `el.append("", ContentType::Html)` is a NO-OP in lol_html 3.0.1 (unmodified tokens emit
      raw source bytes; append content lands at the IMPLIED end tag; set_inner_content is
      destructive). Landed fix: `close_self_closing_non_void()` rebuilds the start tag as an
      explicit `<tag …></tag>` pair via `start_tag().replace()`, guarded by
      `is_self_closing() && can_have_content()` (void + foreign-content `<path/>` correctly
      untouched). SECURITY NOTE: normalization MUST run AFTER `sanitize_element` — with
      close-first, the pre-sanitize attribute values get frozen into the replacement literal
      and `on*` handlers escape sanitization (B2 measured this; regression test
      `sanitization_survives_self_closing_normalization` guards the order). Real-book check:
      pg84's 30 self-closing tags across 29 chapters → 0 survivors. Idempotent on 2nd pass.
- [x] **E0428 duplicate `record_reading_tick`.** lib.rs now registers
      `commands::stats::record_reading_tick` (#[tauri::command] re-added there by
      orchestrator); B3 messaged to DELETE the annotated stub in commands/reader.rs (~line
      205). **Verify at integration: only ONE definition remains** (grep -c across crate).
- [ ] **B2 fmt incident (benign, verify):** B2 ran a bare `cargo fmt` once which reformatted
      B1's epub/opf.rs and B3's tests/b3_import.rs (whitespace-only, untracked files). Both
      agents were mid-flight; confirm their final states are still rustfmt-clean (the gate
      runs `cargo fmt --check` anyway).
- [x] **MAJOR: cover RAM at scale.** pg84 cover = 1824x2726 ≈ 19 MB decoded RGBA; WebKitGTK
      2.52's Cairo backend does not subsample-decode, so a CSS-downscaled `<img>` still holds
      the full bitmap. At 500 books that breaks the §1 RAM<400MB / 60fps targets. Sent to B3:
      downscale to max edge ~512px JPEG q82 at import (`image` crate authorized), fall back to
      verbatim bytes if decode fails. **Verify B3 applied it + report cover timing.**
- [x] **MINOR: Settings.page overrides naming.** §5.9 said `bgColorOverride`, §11.5 said
      `backgroundColorOverride`. Resolved: `backgroundColorOverride` (what scaffold implemented
      in dto.rs/types.ts/settings.rs). Verify no `bgColorOverride` survives anywhere.
- [ ] Remaining synthesized patches from the review workflow (pending — it was still in the
      Verify phase at 08:02). Apply each, then re-verify the affected WP's tests.

## E. Integration gate (tools/check.sh) — must be fully green

Pre-gate fixes in flight (messaging done):
- [ ] **B1: entity decoding.** extract_text/TOC titles must decode HTML entities (&mdash;,
      &ldquo;, numeric refs) — 4 B1 unit tests were failing on this at B5's finish; affects
      search match quality + TOC display. B1 resumed with instructions.
- [ ] **B1+B7 clippy lints** (gate is -D warnings crate-wide): epub/ncx.rs:186 (&mut Vec →
      &mut [_]), epub/mod.rs:642 (field-assignment-outside-initializer),
      net/translate/libre.rs:151 (bind_instead_of_map). B1 messaged; B7 finished — fix
      libre.rs myself at integration if B7 is gone.
- [ ] **pg2600 is the ENGLISH Garnett translation** (contract §3 said "ru" — wrong). Any
      test/doc assuming Russian text in it is wrong. For Cyrillic FTS verification at
      integration, download a Russian epub (Gutenberg ru or Librivox-derived) or build a
      small Cyrillic fixture; `porter unicode61` tokenizer stems English only — verify
      Russian prefix search still works via the "tok"* quoting (unicode61 tokenizes
      Cyrillic fine; porter only affects English morphology).

- [ ] `cargo fmt --check`
- [ ] `cargo clippy --all-targets -- -D warnings`
- [ ] `cargo test` (whole crate; un-ignore B1/B2/B5's `#[ignore] // needs B1` tests now that
      B1 landed — B2 has 2, B5 may have real-book ones)
- [ ] `npm run build` (tsc strict + vite)
- [ ] `npx vitest run` (whole suite)
- [ ] `npx tauri build --no-bundle` (release binary)
- [ ] `tools/smoke.sh release` — 10 views launch without dying, screenshots captured
- [ ] Manual screenshot review: library / reader / TOC / search / quick-settings / sepia /
      vocab / stats / settings — check for visual junk, overlapping panels, wrong colors,
      missing icons, unstyled controls.
- [ ] Real-book functional pass on pg2600 (War and Peace, English Garnett translation,
      1.8 MB): open, page turns, chapter nav, search (English queries), highlight, note,
      bookmark, word lookup. Cyrillic search is verified against `testbooks/ru_fixture.epub`
      (test `ru_fixture_index_and_search_inflected_forms`), not pg2600.
- [ ] Cold-start timing, RAM at idle + with a big book open, index time for pg2600.
- [ ] Packaging: `tools/pkbuild/PKGBUILD` builds (or at least `makepkg --nobuild` sanity),
      .desktop + icons installed, `application/epub+zip` mimetype association.

## F. Known accepted deviations (document in README, no action)

- Non-UTF-8 EPUB chapters show U+FFFD (no `encoding_rs` dep). Rare; revisit on user reports.
- `db::today_str()` is UTC-based with a cached `local_offset_minutes()` helper available;
  backup filenames can be one day off near local midnight (B8 FCR #3). Low impact.
- F4's per-book stats list shows library progress rather than per-book reading time
  (avoids N `get_book_stats` calls).
- DictPopup head word is 20px (WP brief) vs §5.7's 24px — cosmetic, pick one at integration.
- `Select` auto-enables search above 8 options; filters by value as well as label
  (needed because language labels are Russian while values are ISO codes).
- ToastHost sits at `bottom-20` + `flex-col-reverse` so toasts don't cover SuggestChip's
  "Add" button.
