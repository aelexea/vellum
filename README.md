# Vellum

A fast, minimal EPUB reader for Linux (Arch) with selection translation and a
vocabulary-learning system. Tauri 2 + Rust + WebKitGTK — a native window, not
Electron: cold start around one second, lag-free reading of large books, and
in-book search in milliseconds (the FTS5 index is built in the background on
first open).

## Features

- **EPUB 2/3**: table of contents (NCX and nav.xhtml), covers, illustrations,
  metadata; chapters are sanitized and served through a custom `vellum://`
  protocol — scripts from books never execute.
- **Reading**: paginated mode (CSS columns) and vertical scroll; a pool of three
  iframes with prefetch of neighboring chapters — page turns in a single frame;
  the reading position is remembered per book (CFI + page + percentage).
- **Full text customization**: font (all system fonts via fontconfig), size,
  weight, line height, letter spacing, alignment, paragraph indent, hyphenation,
  page/text width, margins, text/background/link colors.
- **Themes**: Light, Dark, Sepia, OLED (pure black) + a custom-theme editor;
  app UI colors and book page colors are configured separately.
- **Translation**: select a word/phrase → "Translate" (Ctrl+Shift+T) → a
  floating panel over the book. Providers: Google (mirror chain), Lingva,
  LibreTranslate (your own server/key); automatic source-language detection,
  target-language selection.
- **Dictionary**: Ctrl+Shift+D — translation, IPA transcription, part of speech,
  definitions and examples (dictionaryapi.dev, English).
- **Vocabulary learning**: "Add to vocabulary" saves the word, translation,
  definition, context sentence from the book, book and chapter; the app suggests
  adding a word after N repeated lookups; statuses new → learning → known;
  spaced repetition (SM-2) with a flashcard screen and Again/Hard/Good/Easy
  grades.
- **In-book search** (Ctrl+F): the FTS5 index is built in the background;
  results come with snippets and highlighting, and a click jumps to the spot
  with a flash. *War and Peace* indexes in ~165 ms, a query takes ~12 ms.
- **Highlights and notes**: 6 colors, notes on highlights, bookmarks (Ctrl+D),
  a panel with the full list and jump-to-location.
- **Minimal UI**: panels hide while reading and appear on mouse movement or
  Ctrl+H; every action is duplicated by a hotkey (rebindable in settings).
- **Library**: covers, progress, tags, search/sorting, file import and folder
  scanning, drag-and-drop; covers are cached as thumbnails ≤512 px.
- **Statistics**: reading time per day, pages, day streak, a 30 min/day goal.
- **Data**: everything local (SQLite WAL, `~/.local/share/com.vellum.reader`);
  export/import of vocabulary (JSON/CSV/Anki), notes and settings; automatic DB
  backup every 7 days (last 5 kept).

## Keyboard shortcuts (defaults)

| Action | Keys | Action | Keys |
|---|---|---|---|
| Page forward/back | ← → / PgUp PgDn / Space | Search | Ctrl+F |
| Chapter forward/back | Ctrl+← Ctrl+→ | Table of contents | Ctrl+T |
| Font larger/smaller | Ctrl+= / Ctrl+- | Notes & highlights | Ctrl+Shift+A |
| Cycle theme | Ctrl+J | Bookmark | Ctrl+D |
| Pages/scroll mode | Ctrl+Shift+M | Translate selection | Ctrl+Shift+T |
| Hide chrome | Ctrl+H | Dictionary | Ctrl+Shift+D |
| Fullscreen | F11 | Add to vocabulary | Ctrl+Shift+V |
| Settings | Ctrl+, | Word review | Ctrl+Shift+R |
| Back to library | Ctrl+L | Quit | Ctrl+Q |

All combinations are rebindable: Settings → Shortcuts.

## Building (Arch Linux)

Dependencies:

```sh
sudo pacman -S --needed webkit2gtk-4.1 librsvg openssl base-devel curl wget file \
  nodejs npm rust   # rust can also come from rustup
```

Build and run:

```sh
npm ci
npm run tauri:dev      # development mode
npm run tauri:build    # release (AppImage/deb in src-tauri/target/release/bundle/)
```

Install from source (AUR-style): `tools/pkbuild/PKGBUILD` + `vellum.desktop`
(the binary installs to `/usr/bin/vellum` and registers the
`application/epub+zip` mimetype).

Quality gate: `tools/check.sh` (fmt → clippy -D warnings → cargo test →
tsc+vite → vitest → release build); GUI smoke test with screenshots:
`tools/smoke.sh`.

## Architecture

```
src-tauri/src/
  epub/        container/OPF/NCX/nav parsing, lol_html chapter sanitizer, serve
  protocol.rs  vellum:// (chapters, assets, covers) — registered on the Builder
  db/          SQLite WAL: library, positions, annotations, stats, vocab
  search/      FTS5 index (built in background) + HTML-escaped snippets
  net/         translators (google/lingva/libre) and dictionary (dictionaryapi)
  settings.rs  JSON settings with defaults, atomic writes
src/
  features/reader/engine/  CSS-column pagination, epubcfi, selection, find
  features/…               library, reader, search, annotations, vocab, stats,
                           settings, translate popups
  stores/                  zustand: ui, settings, library, reader, vocab
```

The detailed module contract lives in `ARCHITECTURE.md`; integration seams in
`INTEGRATION.md`.

## Known limitations

- Chapters in non-standard encodings (windows-1251 etc.) render with
  replacement characters — EPUBs are almost always UTF-8.
- `dictionaryapi.dev` is English-only; for other languages translation works
  without definitions.
- Drag-and-drop uses native Tauri events; in rare environments without
  `__TAURI_INTERNALS__` only button-based import works.
- Cross-device sync is not implemented (data is local; export/import and
  backups cover manual transfer).
- Day boundaries (`db::today_str()`) are computed in UTC: backup file names and
  daily stats can shift by one day around local midnight.
- The book list on the stats screen shows overall library progress, not the
  reading time of an individual book.
- The head word in the dictionary popup is 20px (chosen over the contract's
  24px).
- `Select` enables search with more than 8 options and filters by value as well
  as by label (for languages the labels are now English while the values are
  ISO codes).
- `ToastHost` is pinned to the bottom (bottom-20, reverse column order) so
  toasts don't cover the SuggestChip's Add button.
- A book whose file has disappeared from disk is shown dimmed in the library
  with a "File unavailable" badge; this flag is refreshed only by an explicit
  "Rescan" (rescan_library) or when the book is opened — not automatically at
  app startup.

## License

MIT — see [LICENSE](LICENSE).
