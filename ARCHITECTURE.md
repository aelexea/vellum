# Vellum — Architecture & Agent Contract (v1.3 — §11 additions override earlier text on conflict; v1.2 added VocabWord.ease; v1.3 added Highlight.text + highlights.text column)

Fast, minimal, native-feeling EPUB reader for Arch Linux. Reading + translation + vocabulary
learning in one app. This document is the **single source of truth** for all work-package (WP)
agents. If your implementation must deviate from this contract, implement the closest working
solution and report the deviation in your final summary.

UI language: **English** (copy table §6.9). No emoji in UI. Animations: subtle only
(120–220 ms, opacity/transform, `cubic-bezier(0.2, 0, 0, 1)`).

## 1. Product priorities

1. Speed: cold start < 1.5 s; open indexed book < 500 ms; page turn one paint frame; search
   query < 100 ms on an indexed 4 MB EPUB; library scroll 60 fps @ 500 books; RAM < 400 MB.
2. Minimal reading-first UI: chrome auto-hides; panels are overlays; zero visual noise.
3. Everything local-first: SQLite + files in XDG dirs; network only for translate/dict lookups.

## 2. Stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 (`tauri`, `tauri-build` v2), system WebKitGTK 2.52 |
| Backend | Rust 1.98 (edition 2021), `tokio` (via tauri async runtime) |
| DB | SQLite via `rusqlite` (feature `bundled`), WAL mode, FTS5 |
| EPUB | `zip` + `quick-xml` (OPF/NCX) + `lol_html` (streaming HTML rewrite) |
| HTTP | `reqwest` (rustls-tls, json, gzip) |
| Frontend | React 19 + TypeScript 5 + Vite 7 + Tailwind CSS v4 (`@tailwindcss/vite`) + Zustand 5 |
| Routing | custom state router in `uiStore` (no react-router) |
| Tests | `cargo test` (backend), `vitest` + jsdom + @testing-library/react (frontend) |
| Tauri plugins | `dialog` (folder/save pickers), `opener` (external links), `single-instance` |

Crates/npm versions are resolved at scaffold time via `cargo add` / `npm i pkg@latest`;
do not pin to versions listed nowhere else. **No new dependencies** beyond those the scaffold
installs, unless a WP reports the need explicitly.

Rust DTO serde convention: every struct `#[serde(rename_all = "camelCase")]`. Tauri 2 maps
JS camelCase invoke args to Rust snake_case params automatically.

Error convention: all commands return `Result<T, AppError>`; `AppError(String)` (see §4.2).
Frontend surfaces errors via `uiStore.toast(msg, 'error')`.

## 3. Repository layout & file ownership

Tag in brackets = owning WP. `(scaffold)` files are created once by scaffolding and are
**frozen** for WP agents — never edit them; report needed changes as deviations.

```
vellum/
├── ARCHITECTURE.md            (contract — this file)
├── package.json               (scaffold-FE)
├── vite.config.ts             (scaffold-FE)
├── vitest.config.ts           (scaffold-FE)
├── tsconfig.json              (scaffold-FE)
├── index.html                 (scaffold-FE)
├── README.md                  (scaffold-FE, stub; finalized at integration)
├── tools/
│   ├── smoke.sh               (integration) build+run+screenshot+kill
│   └── pkbuild/PKGBUILD       (integration)
├── testbooks/                 pg11 pg13 pg84 pg2600 .epub (fixtures; read-only)
├── src-tauri/
│   ├── Cargo.toml             (scaffold-BE)
│   ├── build.rs               (scaffold-BE)
│   ├── tauri.conf.json        (scaffold-BE)
│   ├── capabilities/default.json (scaffold-BE)
│   ├── icons/                 (scaffold-BE)
│   └── src/
│       ├── lib.rs             (scaffold-BE — frozen: mod tree + invoke_handler list)
│       ├── error.rs           (scaffold-BE — frozen)
│       ├── dto.rs             (scaffold-BE — frozen: all serde DTOs per §4.1)
│       ├── state.rs           (scaffold-BE — frozen: AppState)
│       ├── commands/
│       │   ├── mod.rs         (scaffold-BE — frozen)
│       │   ├── library.rs     [B3]
│       │   ├── reader.rs      [B3]
│       │   ├── annotations.rs [B4]
│       │   ├── stats.rs       [B4]
│       │   ├── search.rs      [B5]
│       │   ├── vocab.rs       [B6]
│       │   ├── translate.rs   [B7]
│       │   └── settings.rs    [B8]
│       ├── settings.rs        [B8]  (load/save/defaults/AppSettings struct)
│       ├── backup.rs          [B8]  (export/import/VACUUM INTO/auto-backup)
│       ├── fonts.rs           [B8]  (fc-list parse + cache)
│       ├── protocol.rs        [B2]  (vellum:// handler)
│       ├── epub/
│       │   ├── mod.rs         [B1]  (pub API: open_book, BookArchive, manifest/spine/toc)
│       │   ├── container.rs   [B1]  (META-INF/container.xml)
│       │   ├── opf.rs         [B1]  (OPF: metadata, manifest, spine, cover detect)
│       │   ├── ncx.rs         [B1]  (NCX + EPUB3 nav.xhtml → TocEntry list)
│       │   ├── rewrite.rs     [B2]  (lol_html: strip scripts, absolutize assets)
│       │   └── serve.rs       [B2]  (chapter/asset/cover fetch from zip, mime, cache)
│       ├── db/
│       │   ├── mod.rs         [B3]  (schema DDL §4.4, migrations, open+WAL)
│       │   ├── library.rs     [B3]  (books, tags, scan dirs, import, covers)
│       │   ├── progress.rs    [B3]  (positions, last_opened, toc cache)
│       │   ├── annotations.rs [B4]  (highlights, notes, bookmarks)
│       │   ├── stats.rs       [B4]  (sessions, aggregates)
│       │   └── vocab.rs       [B6]  (lookups, vocab, srs, review_log)
│       ├── search/
│       │   ├── mod.rs         [B5]
│       │   ├── index.rs       [B5]  (background FTS5 build + events)
│       │   └── query.rs       [B5]  (MATCH + snippet)
│       └── net/
│           ├── mod.rs         [B7]  (shared reqwest client, retry/timeout)
│           ├── languages.rs   [B7]  (static lang table)
│           ├── translate/
│           │   ├── mod.rs     [B7]  (trait TranslateProvider + registry)
│           │   ├── google.rs  [B7]  (translate.googleapis.com gtx)
│           │   ├── lingva.rs  [B7]  (configurable instance)
│           │   └── libre.rs   [B7]  (LibreTranslate url+key)
│           └── dict/
│               ├── mod.rs     [B7]  (trait DictProvider + registry)
│               └── dictionaryapi.rs [B7] (api.dictionaryapi.dev, en)
└── src/
    ├── main.tsx               (scaffold-FE — frozen)
    ├── App.tsx                (scaffold-FE — frozen: view router + overlay mount points)
    ├── lib/
    │   ├── types.ts           (scaffold-FE — frozen: all TS types §4.1 mirror)
    │   ├── tauri.ts           (scaffold-FE — frozen: typed invoke wrappers §5.1)
    │   └── utils.ts           (scaffold-FE — frozen: cn(), debounce, clamp, fmtTime…)
    ├── stores/
    │   ├── uiStore.ts         (scaffold-FE — frozen: view router, panels, toasts, shortcuts map)
    │   ├── settingsStore.ts   (scaffold-FE — frozen)
    │   ├── libraryStore.ts    (scaffold-FE — frozen)
    │   ├── readerStore.ts     (scaffold-FE — frozen)
    │   └── vocabStore.ts      (scaffold-FE — frozen)
    ├── styles/
    │   ├── tokens.css         (scaffold-FE — frozen: --v-* tokens, animation tokens)
    │   ├── themes.css         [F3]    (built-in theme var sets)
    │   └── base.css           (scaffold-FE — frozen: tailwind import, resets, scrollbar)
    ├── components/
    │   ├── Modal.tsx Popover.tsx Slider.tsx Toast.tsx Spinner.tsx
    │   ├── ContextMenu.tsx Tooltip.tsx Segmented.tsx Switch.tsx Select.tsx
    │   └── (scaffold-FE base impls; [F6] may polish internals, API frozen)
    └── features/
        ├── library/  LibraryView.tsx BookCard.tsx ImportBar.tsx TagsBar.tsx   [F1]
        ├── reader/
        │   ├── ReaderView.tsx ChapterFrame.tsx ChromeBars.tsx TocPanel.tsx
        │   ├── SelectionToolbar.tsx QuickSettings.tsx Shortcuts.ts            [F2]
        │   └── engine/
        │       ├── cfi.ts        [F0]
        │       ├── pagination.ts [F0]
        │       ├── scrollmode.ts [F0]
        │       ├── selection.ts  [F0]
        │       ├── highlight.ts  [F0]
        │       ├── findtext.ts   [F0]
        │       └── controller.ts [F0]  (ChapterController facade §6.3)
        ├── search/       SearchPanel.tsx                                      [F5]
        ├── annotations/  AnnotationsPanel.tsx                                 [F5]
        ├── vocab/        VocabView.tsx ReviewSession.tsx WordEditor.tsx       [F4]
        ├── stats/        StatsView.tsx                                        [F4]
        ├── settings/     SettingsView.tsx TypographyPanel.tsx ThemeEditor.tsx
        │                 TranslatorsPanel.tsx ShortcutsPanel.tsx BackupPanel.tsx [F3]
        └── translate/    TranslatePopup.tsx DictPopup.tsx SuggestChip.tsx     [F6]
```

Ground rules for every WP agent:
- Touch **only files you own**. Never edit frozen/scaffold or other WPs' files.
- Rust: keep `cargo check` green (target dir lock serializes concurrent checks — be patient;
  never delete `target/`). Frontend: keep `npm run build` and your `vitest` files green.
- Do not launch any GUI (`tauri dev`), do not run `tauri build` — integration phase does that.
- Do not `git commit` — the orchestrator commits.
- Unit tests required per §8 for your WP; fixtures: `testbooks/*.epub` are real Gutenberg books
  (pg11 = Alice, pg13 = Hunting of the Snark (poetry), pg84 = Frankenstein, pg2600 = War and
  Peace (English Garnett translation, huge; Russian fixture is testbooks/ru_fixture.epub)).
  Never mutate testbooks.
- Performance discipline: no work on the UI thread that can be a task; no re-parsing per page
  turn; memoize; virtualize long lists (plain CSS containment + windowing by hand, no lib).
- UI text: English, from §6.9. Numbers with `font-variant-numeric: tabular-nums`.

## 4. Backend

### 4.1 DTOs (TS is normative; Rust `dto.rs` mirrors with camelCase serde)

```ts
export interface BookMeta {
  uid: string; title: string; authors: string[]; path: string;
  coverUrl: string | null;        // "vellum://covers/{uid}" or null
  progress: number;               // 0..1
  positionChapterIdx: number | null;
  totalChapters: number;
  addedAt: number;                // unix ms
  lastOpenedAt: number | null;
  tags: string[];
  sizeBytes: number;
  missing: boolean;               // file no longer on disk
}
export interface TocEntry { title: string; chapterIdx: number; cfi: string | null; level: number; parentIdx: number | null; }
export interface ChapterMeta { idx: number; href: string; title: string | null; charCount: number | null; }
export interface BookDetail extends BookMeta { toc: TocEntry[]; chapters: ChapterMeta[]; }
export interface ReadingPosition {
  cfi: string | null; chapterIdx: number;
  pctWithinChapter: number;       // 0..1
  pageIndex: number | null;       // paginated mode
  pageCount: number | null;
  mode: 'paginated' | 'scroll';
  globalPct: number;              // whole-book progress 0..1
  savedAt: number;
}
export interface OpenBook { book: BookDetail; position: ReadingPosition | null;
  highlights: Highlight[]; notes: Note[]; bookmarks: Bookmark[]; indexStatus: IndexStatus; }
export interface Highlight { id: number; bookUid: string; chapterIdx: number;
  cfiStart: string; cfiEnd: string; color: string; text: string;   // v1.3: highlighted text (F5 FCR)
  createdAt: number; hasNote: boolean; }
export interface Note { id: number; bookUid: string; chapterIdx: number;
  cfiStart: string; cfiEnd: string; selectedText: string; noteText: string;
  createdAt: number; updatedAt: number; }
export interface Bookmark { id: number; bookUid: string; chapterIdx: number;
  cfi: string; label: string | null; createdAt: number; }
export interface IndexStatus { state: 'none' | 'indexing' | 'ready' | 'error';
  chaptersDone: number; chaptersTotal: number; }
export interface SearchHit { chapterIdx: number; chapterTitle: string;
  snippet: string;                // HTML, matches wrapped in <mark>
  score: number; }
export interface LookupContext { bookUid: string; chapterIdx: number; sentence: string; cfi: string; }
export interface DictMeaning { pos: string | null; definitions: { definition: string; example: string | null; synonyms: string[] }[]; }
export interface DictEntry { word: string; transcription: string | null; meanings: DictMeaning[]; }
export interface LookupResult { word: string; translation: TranslateResult | null;
  dictionary: DictEntry | null; lookupCount: number; suggestAdd: boolean; alreadyInVocab: boolean; }
export interface TranslateResult { translatedText: string; detectedSourceLang: string;
  targetLang: string; providerId: string; }
export interface TranslatorInfo { id: string; name: string; kind: 'translate' | 'dict' | 'both';
  needsConfig: boolean; configured: boolean; }
export interface VocabWord { id: number; word: string; translation: string | null;
  definition: string | null; transcription: string | null; pos: string | null;
  examples: string[]; bookUid: string | null; bookTitle: string | null;
  chapterIdx: number | null; context: string | null; contextCfi: string | null;
  addedAt: number; status: 'new' | 'learning' | 'known';
  reviewCount: number; intervalDays: number | null; dueAt: number | null; lastReviewedAt: number | null;
  ease: number; }   // v1.2: SM-2 ease surfaced for accurate interval previews (F4 FCR)
export interface VocabStats { total: number; byStatus: Record<'new' | 'learning' | 'known', number>;
  dueToday: number; reviewsToday: number; addedThisWeek: number; }
export interface ReadingStats { rangeSeconds: number;
  byDay: { date: string; seconds: number }[];   // ISO yyyy-mm-dd, oldest first
  pagesTurned: number; booksTouched: number; streakDays: number; }
export interface BookStats { totalSeconds: number; pagesTurned: number;
  firstOpenedAt: number | null; lastOpenedAt: number | null; progress: number; }
export interface Tag { id: number; name: string; count: number; }
export interface ImportReport { imported: BookMeta[];
  skipped: { path: string; reason: string }[]; failed: { path: string; reason: string }[]; }
export interface LibraryFilter { query: string | null; tag: string | null;
  sort: 'lastOpened' | 'title' | 'author' | 'progress' | 'added' | 'percent';
  sortDesc: boolean; missing: 'hide' | 'only' | 'all'; }
export interface FontFamily { name: string; hasBold: boolean; hasItalic: boolean; mono: boolean; }
export interface Theme { id: string; name: string; builtin: boolean;
  ui: { bg: string; bgAlt: string; bgRaise: string; fg: string; fgMuted: string;
        accent: string; accentFg: string; border: string; };
  page: { bg: string; fg: string; link: string; selectionBg: string; }; }
export interface ProviderConfig { enabled: boolean; baseUrl: string | null; apiKey: string | null; }
export interface Settings {
  ui: { themeId: string; customThemes: Theme[]; animations: boolean; autoHideChrome: boolean; };
  page: { fontFamily: string; fontSizePx: number; fontWeight: number; lineHeight: number;
    letterSpacingEm: number; textAlign: 'left' | 'justify'; paragraphIndentEm: number;
    paragraphSpacingEm: number; hyphenate: boolean; pageWidthPct: number;   // 40..100
    scrollMaxWidthPx: number; marginsPx: { top: number; right: number; bottom: number; left: number }; };
  reading: { mode: 'paginated' | 'scroll'; pageTurn: 'slide' | 'fade' | 'none'; prefetch: boolean;
    wheelTurnsPage: boolean; clickZones: boolean; };
  translate: { defaultProviderId: string; defaultTargetLang: string; popupOnSelect: boolean;
    providers: Record<string, ProviderConfig>; };
  dictionary: { defaultProviderId: string; };
  vocab: { suggestAfterLookups: number; dailyReviewLimit: number; };
  library: { watchedDirs: string[]; view: 'grid' | 'list'; sort: LibraryFilter['sort']; sortDesc: boolean; };
  shortcuts: Record<string, string>;   // action id → combo, §6.8
}
```

### 4.2 error.rs / state.rs (frozen, scaffold)

```rust
pub struct AppError(pub String);           // serde-serializes as its string
impl From<anyhow::Error>/io/zip/rusqlite/reqwest/utf8 for AppError
pub type CmdResult<T> = Result<T, AppError>;

pub struct AppState {
    pub db: std::sync::Mutex<rusqlite::Connection>,      // WAL, busy_timeout 5 s
    pub zips: dashmap::DashMap<String, std::sync::Mutex<zip::ZipArchive<BufReader<File>>>>,
    pub http: reqwest::Client,                            // 15 s timeout, gzip, UA set
    pub settings: parking_lot::RwLock<Settings>,          // or std RwLock
    pub paths: AppPaths,                                  // data_dir, config_dir, cache_dir, covers_dir, backups_dir
    pub fonts: std::sync::OnceLock<Vec<FontFamily>>,
}
// AppState::init(app: &tauri::AppHandle) -> anyhow::Result<Self>
// helper: pub fn state(app: &tauri::AppHandle) -> State<AppState> via app.state()
```

`dashmap` and `parking_lot` are scaffold deps (allowed). If scaffold omits them, use
`std::sync::{Mutex, RwLock}` + `HashMap` guarded by one mutex for zips — B2 reports which.

### 4.3 vellum:// protocol [B2]

Registered in `lib.rs setup` via `app.register_asynchronous_uri_scheme_protocol("vellum", …)`
(scaffold wires the call; B2 implements `protocol::register`). Routes (authority = first host
segment; WebKit lowercases authority → **uids must be lowercase hex**, they are sha1):

| URI | Response |
|---|---|
| `vellum://book/{uid}/chapter/{idx}` | rewritten chapter XHTML (utf-8), `Content-Type: application/xhtml+xml` |
| `vellum://book/{uid}/asset/{pct-encoded-path}` | raw bytes from zip, mime by extension |
| `vellum://book/{uid}/cover` | cover bytes (or 404) |
| `vellum://covers/{uid}` | cached cover file from `covers_dir` (or 404 → frontend shows fallback) |
| anything else | 404 |

All responses: header `Access-Control-Allow-Origin: *` (fonts + fetch from app origin),
`Cache-Control: no-cache` for chapters, `max-age=86400` for assets/covers.

Chapter serving pipeline (`epub::serve` + `epub::rewrite`):
1. Read spine item bytes from zip (keep ZipArchive cached in `state.zips`).
2. lol_html rewrite: **remove** `<script>`, `on*=` attributes, `<meta http-equiv="refresh">`;
   rewrite `href`/`src`/`xlink:href`/`srcset` of a/img/link/video/audio/source/image/use/iframe
   resolving relative to the chapter's zip dir → `vellum://book/{uid}/asset/{enc}`; internal
   `a[href]` to spine items → keep as `#vellum-link:{idx}:{fragment}` marker (frontend handles);
   external `http(s)` links → `data-vellum-external="1"`; inject
   `<base href="vellum://book/{uid}/">` fallback; ensure `<meta charset="utf-8">`;
   append theme hook: add `class="vellum-doc"` to `<html>`.
3. Book CSS files are served via asset route untouched (rewrite relative `url()` inside CSS with
   lol_html element-rewriter? No — use a small regex pass over `url(...)` in text/css only).

Frontend fetches chapter HTML with `fetch()` and injects into iframe via `srcdoc`
(same-origin with app → engine gets direct `contentDocument` access; **no postMessage**).

### 4.4 DB schema (db/mod.rs [B3]; exact DDL, `user_version = 1`)

```sql
PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS books(
  uid TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
  authors TEXT NOT NULL DEFAULT '[]',          -- json array
  cover_path TEXT, added_at INTEGER NOT NULL, last_opened_at INTEGER,
  progress REAL NOT NULL DEFAULT 0, position TEXT,   -- json ReadingPosition
  total_chapters INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER NOT NULL DEFAULT 0,
  indexed INTEGER NOT NULL DEFAULT 0,          -- 0 none, 1 indexing, 2 ready, -1 error
  missing INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tags(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS book_tags(book_uid TEXT NOT NULL, tag_id INTEGER NOT NULL,
  PRIMARY KEY(book_uid, tag_id));
CREATE TABLE IF NOT EXISTS toc(book_uid TEXT NOT NULL, idx INTEGER NOT NULL,
  title TEXT NOT NULL, chapter_idx INTEGER NOT NULL, cfi TEXT, level INTEGER NOT NULL DEFAULT 1,
  parent_idx INTEGER, PRIMARY KEY(book_uid, idx));
CREATE TABLE IF NOT EXISTS chapters(book_uid TEXT NOT NULL, idx INTEGER NOT NULL,
  href TEXT NOT NULL, title TEXT, char_count INTEGER, PRIMARY KEY(book_uid, idx));
CREATE VIRTUAL TABLE IF NOT EXISTS book_search USING fts5(
  book_uid UNINDEXED, chapter_idx UNINDEXED, chapter_title, body,
  tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS highlights(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL, cfi_start TEXT NOT NULL, cfi_end TEXT NOT NULL,
  color TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);  -- v1.3: text col
CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL, cfi_start TEXT NOT NULL, cfi_end TEXT NOT NULL,
  selected_text TEXT NOT NULL DEFAULT '', note_text TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bookmarks(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  chapter_idx INTEGER NOT NULL, cfi TEXT NOT NULL, label TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS lookups(word_norm TEXT PRIMARY KEY, word TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1, last_seen_at INTEGER NOT NULL,
  last_book TEXT, last_chapter INTEGER, last_context TEXT, last_cfi TEXT);
CREATE TABLE IF NOT EXISTS vocab(id INTEGER PRIMARY KEY, word TEXT NOT NULL,
  word_norm TEXT NOT NULL UNIQUE, translation TEXT, definition TEXT, transcription TEXT,
  pos TEXT, examples TEXT NOT NULL DEFAULT '[]',      -- json array
  book_uid TEXT, chapter_idx INTEGER, context TEXT, context_cfi TEXT,
  added_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new'
    CHECK(status IN ('new','learning','known')),
  review_count INTEGER NOT NULL DEFAULT 0, ease REAL NOT NULL DEFAULT 2.5,
  interval_days REAL, due_at INTEGER, last_reviewed_at INTEGER);
CREATE TABLE IF NOT EXISTS review_log(id INTEGER PRIMARY KEY, vocab_id INTEGER NOT NULL,
  at INTEGER NOT NULL, result TEXT NOT NULL, interval_after REAL);
CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, book_uid TEXT NOT NULL,
  day TEXT NOT NULL,               -- yyyy-mm-dd local
  seconds INTEGER NOT NULL DEFAULT 0, pages_turned INTEGER NOT NULL DEFAULT 0,
  UNIQUE(book_uid, day));
CREATE INDEX IF NOT EXISTS idx_vocab_due ON vocab(due_at);
CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
CREATE INDEX IF NOT EXISTS idx_hl_book ON highlights(book_uid, chapter_idx);
CREATE INDEX IF NOT EXISTS idx_notes_book ON notes(book_uid, chapter_idx);
```

`word_norm` = lowercase, trim, strip surrounding punctuation/diacritics-free for matching
(keep original `word` for display).

### 4.5 Search indexing [B5]

- `reindex_book(uid, force)`: if `indexed=2 && !force` → no-op. Sets `indexed=1`, spawns
  `tauri::async_runtime::spawn_blocking` task: opens its **own** rusqlite connection (WAL
  allows it), iterates spine, extracts plain text per chapter (lol_html text-only sink),
  `INSERT INTO book_search(book_search) VALUES('delete-all')`-style per-book purge first
  (`DELETE FROM book_search WHERE book_uid=?1`), inserts rows, updates `chapters.char_count`,
  emits `index-progress {bookUid, done, total}` every ~10 chapters, then `index-done {bookUid}`
  and `indexed=2` (or `index-error`, `indexed=-1`). Idempotent; one task per book (guard map).
- Auto-index: `open_book` triggers `reindex_book(uid,false)` if `indexed==0`.
- `search_in_book(uid, query, limit=100)`: FTS5 `MATCH` with query sanitization (escape `"`,
  wrap tokens: `tok*` prefix matching, join with `AND` for multiword; phrase mode when query
  starts+ends with `"`). `SELECT chapter_idx, chapter_title, snippet(book_search, 3, '<mark>',
  '</mark>', '…', 16) , bm25(book_search) ORDER BY rank LIMIT ?`. Return `SearchHit[]`.
  Empty query → `[]`.

### 4.6 Vocabulary + SRS [B6]

- `lookup_word(word, context?)`: normalize → upsert `lookups` (+1 count, save context fields);
  if word in vocab → `alreadyInVocab=true, suggestAdd=false`; else
  `suggestAdd = lookups.count >= settings.vocab.suggestAfterLookups`. Then run dict+translate
  (B7 functions, in-process): dictionary only when word is single-token latin/cyrillic ≤ 40
  chars; translation via default provider auto→`settings.translate.defaultTargetLang`.
  Network failures degrade gracefully: fields null, never Err unless **all** fail.
- SM-2 lite (`record_review(id, result)`), result ∈ again|hard|good|easy:
  - again: `interval = 10 min` (due_at = now+600s, same-day requeue), ease -= 0.2
  - hard: interval × 1.2 (first review: 1 day), ease -= 0.15
  - good: first → 1 day; else interval × ease
  - easy: first → 3 days; else interval × ease × 1.3, ease += 0.15
  - clamp ease to [1.3, 3.0]; `review_count += 1`; `due_at = now + interval`;
    status: interval < 21 d → 'learning', ≥ 21 d → 'known' (unless user-set 'known').
- `get_review_queue(limit=settings.vocab.dailyReviewLimit*2)`: `due_at <= now OR due_at IS NULL
  AND status='new'` ORDER BY due_at ASC NULLS FIRST, LIMIT.
- Export: json (full VocabWord[]), csv (`word;translation;definition;status;due_at;book;context`,
  `;`-separated, UTF-8 BOM), anki (tab-sep `word<TAB>translation — definition<br>context`).
  Import: json + csv (best-effort, skip broken rows, count returned).

### 4.7 Settings [B8]

`~/.config/com.vellum.reader/settings.json`. `Settings::load_or_default()` (serde defaults for
every field — partial/old files never fail), `save(patch)` = deep-merge JSON patch into current,
persist atomically (tmp+rename), return full Settings. Defaults in §6.8/§6.6.
`list_fonts()`: run `fc-list : family file style slant spacing` once (cache in `state.fonts`),
parse to `FontFamily[]` (dedupe families, `mono` if spacing=mono/100, hasBold/hasItalic from
style strings), sorted: serif reading families first? No — plain alphabetical, UI groups.
`backup_db(path)`: `VACUUM INTO ?path`. Auto-backup on startup: if newest file in
`backups_dir` older than 7 days → `VACUUM INTO backups_dir/vellum-<yyyymmdd>.db`, keep last 5.
`export_settings/import_settings`, `export_annotations(uid|null, path, format json|md)`,
`import_annotations(path)` (json only, upsert by natural keys).

### 4.8 Command catalog (names are frozen; `lib.rs` lists all)

All async unless marked. Args camelCase from JS; returns per DTOs above.

```
library: import_books(paths: string[]) -> ImportReport                 [B3]
         scan_directory(dir: string) -> ImportReport                    [B3]
         rescan_library() -> ImportReport                               [B3]
         list_books(filter: LibraryFilter) -> BookMeta[]                [B3]
         list_tags() -> Tag[]                                           [B3]
         set_book_tags(uid: string, tags: string[]) -> ()               [B3]
         delete_book(uid: string, deleteFile: boolean) -> ()            [B3]
         get_book(uid: string) -> BookDetail                            [B3]
reader:  open_book(uid: string) -> OpenBook                             [B3]
         save_position(uid: string, position: ReadingPosition) -> ()    [B3]
         record_reading_tick(uid: string, seconds: number,
             pagesTurned: number) -> ()                                 [B4]
annotations: list_highlights(uid: string, chapterIdx: number|null) -> Highlight[]   [B4]
         add_highlight(bookUid, chapterIdx, cfiStart, cfiEnd, color, text) -> Highlight [B4]
         update_highlight(id: number, color: string) -> ()              [B4]
         delete_highlight(id: number) -> ()                             [B4]
         list_notes(uid: string|null) -> Note[]                         [B4]
         add_note(bookUid, chapterIdx, cfiStart, cfiEnd, selectedText,
             noteText) -> Note                                          [B4]
         update_note(id: number, noteText: string) -> ()                [B4]
         delete_note(id: number) -> ()                                  [B4]
         list_bookmarks(uid: string|null) -> Bookmark[]                 [B4]
         add_bookmark(bookUid, chapterIdx, cfi, label: string|null) -> Bookmark      [B4]
         delete_bookmark(id: number) -> ()                              [B4]
search:  get_index_status(uid: string) -> IndexStatus                   [B5]
         reindex_book(uid: string, force: boolean) -> ()                [B5]
         search_in_book(uid: string, query: string,
             limit: number|null) -> SearchHit[]                         [B5]
vocab:   lookup_word(word: string,
             context: LookupContext|null) -> LookupResult               [B6]
         list_vocab(status: string|null, bookUid: string|null,
             query: string|null, dueOnly: boolean) -> VocabWord[]       [B6]
         add_vocab_word(word, translation, definition, transcription,
             pos, examples: string[], bookUid, chapterIdx, context,
             contextCfi, status) -> VocabWord   (all nullable opt args) [B6]
         update_vocab_word(id: number, patch: VocabPatch) -> VocabWord  [B6]
         delete_vocab_word(id: number) -> ()                            [B6]
         get_review_queue(limit: number|null) -> VocabWord[]            [B6]
         record_review(id: number, result: string) -> VocabWord         [B6]
         vocab_stats() -> VocabStats                                    [B6]
         export_vocab(path: string, format: string) -> number           [B6]
         import_vocab(path: string) -> number                           [B6]
translate: translate_text(text, from: string, to: string,
             providerId: string|null) -> TranslateResult                [B7]
         detect_language(text: string) -> string                        [B7]
         list_translators() -> TranslatorInfo[]                         [B7]
         save_provider_config(providerId: string,
             cfg: ProviderConfig) -> ()                                 [B7]
         test_provider(providerId: string) -> boolean                   [B7]
         list_languages() -> {code: string, nameRu: string}[]           [B7]
settings: get_settings() -> Settings                                    [B8]
         save_settings(patch: object) -> Settings                       [B8]
         list_fonts() -> FontFamily[]                                   [B8]
         export_settings(path) -> (); import_settings(path) -> Settings [B8]
         backup_db(path: string) -> ()                                  [B8]
         export_annotations(uid: string|null, path,
             format: string) -> number                                  [B8]
         import_annotations(path: string) -> number                     [B8]
stats:   get_stats(range: string) -> ReadingStats  // day|week|month|all [B4]
         get_book_stats(uid: string) -> BookStats                       [B4]
```

`VocabPatch`: `{ translation?, definition?, transcription?, pos?, examples?, status?,
context?, dueAt? }` — all optional, only present fields updated.

Backend events (`app.emit`): `index-progress {bookUid,done,total}`, `index-done {bookUid}`,
`index-error {bookUid,message}`, `import-progress {done,total,current}`.

Book import algorithm [B3]: for each .epub path (skip non-zip/encrypted with reason):
uid = sha1 hex of (dc:identifier if non-empty else file size + first 64 KiB); if uid exists →
update path/size, skip=already; parse metadata (title, authors, language), spine count;
extract cover (OPF `properties="cover-image"` → meta name=cover → first image of
`cover.*` filename → first jpeg/png in manifest) → write `covers_dir/{uid}.{ext}`;
insert book row + toc + chapters; emit import-progress. Covers dir:
`~/.cache/com.vellum.reader/covers/`.

### 4.9 lib.rs wiring (frozen, scaffold)

`mod` tree per §3; `setup`: init AppState (db migrate, settings load, auto-backup spawn,
rescan-lite spawn: mark missing books), `protocol::register(app)`, manage state.
`invoke_handler(tauri::generate_handler![…all commands §4.8…])`. Plugins: single-instance
(focus main window), dialog, opener. Window created from tauri.conf.json.

## 5. Frontend

### 5.1 lib/tauri.ts (frozen, scaffold)

One typed function per command: `export const importBooks = (paths: string[]) =>
invoke<ImportReport>('import_books', { paths })` etc. (exact names §4.8, camelCase args).
Plus `onEvent<T>(name, cb)` wrapping `listen` with auto-unsubscribe return.

### 5.2 Stores (frozen, scaffold — Zustand)

- `uiStore`: `view: 'library'|'reader'|'vocab'|'stats'|'settings'`; `overlay: null |
  'toc' | 'search' | 'annotations' | 'quickSettings' | 'review' | 'translate' | 'dict'`;
  `toasts`; `openBook(uid)` → sets readerStore + view='reader'; `toast(msg, kind)`;
  `confirm(opts) -> Promise<boolean>`; theme application: `applyTheme()` computes CSS vars
  from settingsStore theme → `document.documentElement.style.setProperty('--v-…')`.
- `settingsStore`: `settings`, `loaded`, `load()`, `patch(p: DeepPartial<Settings>)`
  (optimistic + debounced 400 ms `save_settings`), `fonts`, `loadFonts()`, computed
  `theme: Theme` (builtin table §6.6 or custom by id), `shortcuts`.
- `libraryStore`: `books`, `tags`, `filter`, `importing`, `load()`, `importPaths()`,
  `scanDir()`, `setTags`, `remove`, listens `import-progress`.
- `readerStore`: `book: OpenBook|null`, `chapterIdx`, `pageIndex`, `pageCount`, `mode`,
  `selection: {text, cfiStart, cfiEnd, rect, sentence, word}|null`, `open(uid)`,
  `gotoChapter(i)`, `gotoCfi(cfi)`, `nextPage/prevPage`, `savePos()` (debounced 1.5 s +
  on chapter change/close), highlights/notes/bookmarks CRUD passthroughs, `lookup(word,ctx)`
  → vocabStore + opens overlay, heartbeat tick (30 s interval while view==='reader' &&
  document.visibilityState==='visible', accrues seconds+pages deltas → record_reading_tick).
- `vocabStore`: `words`, `queue`, `stats`, `load(filter)`, `add(input)`, `review(result)`,
  `suggest: {word, translation, context…}|null` (set from DictPopup/lookup when suggestAdd).

### 5.3 Reader engine [F0] — `src/features/reader/engine/`

Pure TS (no React), operates on `iframe.contentDocument` (srcdoc → same-origin).
Vitest+jsdom unit-tested against fixture DOMs (no iframes needed in tests).

```ts
// cfi.ts
encodeRange(range: Range, chapterRoot: HTMLElement): string;      // "epubcfi(/4/2/6/1:12)"
decodeCfi(cfi: string, chapterRoot: HTMLElement): Range | null;
cfiFromElement(el: Element, chapterRoot: HTMLElement): string;
compareCfi(a: string, b: string): number;
// CFI subset: path of child-index steps from chapterRoot (/2 = 2nd element child, 1-based,
// text nodes get odd indices interleaved: standard epubcfi child enumeration where element
// children are 2,4,6… and text nodes 1,3,5…), terminal ":charOffset". Ignore id/assertion
// indirections except [epub-id] skip. Escapes per spec minimal.

// pagination.ts
interface LayoutOpts { pageWidthPx: number; gapPx: number; heightPx: number;
  typography: Record<string,string>; /* css var name → value */ }
applyLayout(doc: Document, opts: LayoutOpts): void;   // wraps doc.body children into
  // #vellum-wrap (columns: column-width=pageWidthPx, column-gap=gapPx, height=heightPx,
  // overflow hidden, will-change transform) and #vellum-inner? (structure: html/body fixed
  // h=heightPx overflow hidden; wrap width = pages*pageWidth after measure)
measurePages(doc: Document, opts: LayoutOpts): number;  // ceil(scrollWidth/(page+gap))
setPage(doc: Document, pageIndex: number, animate: 'slide'|'fade'|'none'): void;
  // transform translateX(-i*(pageWidth+gap)); caller handles transition class
cfiAtPage(doc: Document, pageIndex: number): string | null;  // first text node in column
pageForCfi(doc: Document, cfi: string): number | null;      // via Range rect / column math
pageForPoint / elementPage(el): number;

// scrollmode.ts
applyScroll(doc: Document, maxWidthPx: number, typography): void; // no columns; body
  // max-width centered; returns void; caller sets iframe.style.height =
  // contentDoc.documentElement.scrollHeight px (+ ResizeObserver hook)
scrollToCfi(doc, cfi, behavior:'smooth'|'auto'): boolean;
pctFromScroll(el: HTMLElement): number; scrollToPct(el, pct): void;

// selection.ts
onSelectionChange(doc: Document, cb: (sel: SelectionInfo|null) => void): () => void;
  // SelectionInfo {text, cfiStart, cfiEnd, rect (viewport px of iframe), sentence, word}
  // debounce mouseup+selectionchange 80 ms; sentence = enclosing [.!?…\n] bounded span
  // ≤ 240 chars; word = selection when single token else undefined
suppressSelectionFlash(doc): void; // css ::selection color from theme var

// highlight.ts
renderHighlights(doc: Document, chapterRoot: HTMLElement, items:
  {id:number,cfiStart:string,cfiEnd:string,color:string,hasNote:boolean}[]): void;
  // idempotent: removes existing .vellum-hl marks, wraps ranges via decodeCfi
  // (use Range.surroundContents-safe algorithm: split across element boundaries),
  // mark.dataset.hlId; note marker: small ▎ via ::after when hasNote
onMarkClick(doc, cb: (id:number, ev:MouseEvent)=>void): () => void;

// findtext.ts
findText(doc: Document, text: string, occurrence = 0):
  {cfi: string, rect: DOMRect} | null;   // normalized-whitespace TreeWalker search
flashRange(doc, range: Range, ms = 1200): void; // temporary .vellum-flash mark

// controller.ts — facade used by ChapterFrame.tsx [F2]
class ChapterController {
  constructor(iframe: HTMLIFrameElement);           // caller sets srcdoc first
  ready(): Promise<void>;                            // resolves on iframe load + doc ready
  chapterRoot(): HTMLElement;                        // doc.body
  layout(opts: {mode:'paginated'|'scroll'} & LayoutOpts & {maxWidthPx:number}): void;
  goto(pageOrCfiOrPct): void; pages(): number; currentPage(): number;
  setHighlights(items): void; onSelect(cb): void; onLinkClick(cb): void;
  onImageClick(cb): void; find(text, occ): …; dispose(): void;
  // link clicks: capture-phase click listener on doc: a[data-vellum-external] →
  // opener plugin; a[href^='#vellum-link:'] → cb({chapterIdx, fragment}); #frag → in-page
}
```

Chapter HTML post-processing on frontend before srcdoc: strip nothing (backend already
sanitized); wrap: inject `<style>` with typography/theme vars + base reader CSS
(`readerBaseCss` const exported from engine: img/svg max-width 100% height auto; p margins
from vars; text-align/indent/hyphens from vars; `mark.vellum-hl` styles; `.vellum-flash`
keyframes; `::selection` bg var; `a { color: var(--v-page-link) }`).

### 5.4 Reader UX [F2]

- `ChapterFrame`: **iframe pool of 3** (prev/current/next) absolutely stacked; current
  visible; on chapter change: swap roles, load new chapter HTML (fetch cache: `Map<uid:idx,
  string>` LRU 10) into freed iframe, layout with engine. Prefetch next/prev when
  `settings.reading.prefetch`. Page turn within chapter = transform on wrap (engine) +
  container slide/fade per `settings.reading.pageTurn` (140 ms). Turn triggers
  `readerStore.savePos()` debounce + pages delta for heartbeat.
- Click zones (optional setting): left 25% prev, right 25% next page; middle click toggles
  chrome. Wheel: turns pages in paginated mode (setting), native scroll in scroll mode.
- Chrome auto-hide (`settings.ui.autoHideChrome`): top+bottom bars; visible on mouse move /
  touch / hover near edges / any panel open / key press; hide after 2.5 s idle; transition
  opacity+translateY 180 ms. In fullscreen same behavior. F11 toggles fullscreen
  (tauri window API).
- Top bar: back (library), `title • chapter`, spacer, buttons: Bookmark (toggle, filled when
  exists at current cfi), Contents, Search, Notes, Dictionary(=vocab view), Stats?
  (no — keep: Bookmark, TOC, search, annotations, quick-settings (Aa), theme cycle, mode
  toggle, fullscreen). Icons: inline SVG set (lucide-style paths hand-written into
  `components/icons.tsx` [F2 owns icons.tsx]).
- Bottom bar: prev-chapter, range slider (whole-book progress, chapter ticks), next-chapter,
  `page X / Y · Z %`.
- TOC panel: left drawer 320 px, tree by level, current highlighted, click → gotoCfi/chapter.
- QuickSettings: right drawer: font size ±, font family select, line height, margins,
  theme picker (4 circles), mode toggle, "All settings" link → settings view.
- Selection toolbar [F2 renders, F6 owns popup visuals]: floating above selection rect
  (clamped to viewport): Translate · Dictionary · Highlight ▾ (6 colors + remove) · Note ·
  Add to vocabulary · Copy. Note opens Modal with textarea (saves Note).
- Position save/restore: on open → `open_book` position → gotoChapter + engine.goto(cfi or
  pageIndex). On chapter/page change → compute cfi via engine (`cfiAtPage`) → savePos.
  globalPct = (chapterIdx + pctWithinChapter) / totalChapters.

### 5.5 Library [F1]

Grid (cover 3:4, radius 8, soft shadow, hover: translateY(-2px) 160ms) / list view.
Header: "Vellum" wordmark, search input (filter by title/author, instant), sort select,
view toggle, buttons: "Add books" (dialog multi-select .epub), "Scan folder"
(dialog folder). Tag bar: chips (all + each tag with count), click filters. Card: cover
(img vellum://covers/{uid}, fallback: generated gradient with initials), title (2-line
clamp), author, progress bar 2 px accent, `lastOpened` relative ("yesterday", "3 days ago"),
context menu (right-click / ⋯): Open, Tags…, Add book's words to vocabulary?, Stats, Delete
(confirm; option delete file). Import progress: thin top progress bar + toast on finish
(`Books added: N`). Missing books: dimmed + badge "File unavailable", filtered by setting.
Empty state: centered illustration (simple SVG book) + two CTA buttons.
Perf: lazy `loading="lazy"` covers, `content-visibility: auto` cards, windowing not needed
below 2000 cards.

### 5.6 Search [F5], Annotations [F5]

SearchPanel (left drawer, same slot as TOC with tabs "Contents | Search | Notes"):
input (autofocus, debounce 150 ms) → `search_in_book`; result list: chapter title (muted,
xs), snippet HTML (dangerouslySetInnerHTML — backend-produced <mark> only, text escaped by
snippet(); style mark with accent underline), click → close panel → `readerStore.gotoChapter`
then `findText(matchText from snippet, occurrence=nth)` + flash. Indexing state: spinner row
"Indexing… 34/120" from events; none/error → button "Build index". Query tips:
empty → recent? no; zero results → "Nothing found".
AnnotationsPanel: segmented "Highlights | Notes | Bookmarks", grouped by chapter; item:
colored bar + quoted text (clamp 3) + note preview; click → jump+flash; hover actions:
edit note (modal), recolor (popover 6 dots), delete. Counts in tabs.

### 5.7 Translate/Dict popups [F6]

TranslatePopup (overlay anchored near selection rect, max-w 420, card): source text
(clamp 6 lines, italic muted), detected lang chip → target lang Select (searchable, from
list_languages, recent first), provider mini-select, result block (skeleton 3 dots while
loading), actions: Copy, "Add to vocabulary" (single word → prefilled add_vocab_word with
translation+context, toast "Word added"). Auto-runs on open with selection text.
Hotkey re-open with current selection. Esc closes. Error state: "Translation unavailable" + retry.
DictPopup: word (24 px) + transcription (IPA, muted) + "Add to vocabulary" button; meanings grouped
by pos (chip) → definitions list, examples italic; if no dictionary result for non-English →
show translation only + hint. Both popups: appear animation scale .97→1 + opacity 160 ms,
click-outside/Esc close, `settings.translate.popupOnSelect` → selecting text auto-opens?
Default **off** (toolbar button/hotkey instead; setting label "Show translation immediately on
selection").
SuggestChip: when `vocabStore.suggest` set (from lookup with suggestAdd) show bottom-center
pill: "The word “X” appeared N times. Add to vocabulary?" [Add] [×] (dismiss clears;
same word not re-suggested this session).

### 5.8 Vocab + Review [F4], Stats [F4]

VocabView: header: search, status segmented ("All | New | Learning | Known" with counts),
book filter select, sort (added/due/alpha), button "Review" (badge dueToday) →
ReviewSession. Table/list rows: word (bold) + transcription, translation (clamp1), context
(clamp1 italic muted, click → jump to book cfi via uiStore.openBook + gotoCfi), status pill
(click cycles new→learning→known), due ("today", "tomorrow", "Oct 12"), row menu: edit
(WordEditor modal: all fields), delete. Empty state CTA.
ReviewSession (full-screen modal): card: word (32 px) centered, "Show translation" (space /
click flips, 200 ms rotateX? no — simple crossfade): back shows translation+definition+
context+example; grade buttons: "Again" (red-ish) "Hard" "Good" "Easy" with interval
hints (compute preview from current ease). Progress bar top, count "12 / 34". Esc exits
(summary toast: "Words reviewed: N"). Keyboard: 1-4 grade, space flip.
StatsView: today ring (seconds vs 30 min goal), week bar chart (7 divs heights, no chart
lib), tiles: total time ("Reading time"), pages turned, books started, streak (streakDays),
vocabulary: total words/learning/known (from vocab_stats), per-book top-5 list
(time+progress). Range segmented Today/Week/Month/All.

### 5.9 Settings [F3]

SettingsView (full view): left nav ("Appearance | Text | Reading | Translation | Dictionary |
Library | Shortcuts | Data"), right pane.
- Appearance: theme cards (4 built-in previews: mini page mock with colors), "Create theme"
  → ThemeEditor: name + color inputs (native `<input type=color>` + hex field) for ui/page
  groups, live preview card, save → customThemes; custom theme delete/edit. Animations
  switch; auto-hide chrome switch.
- Text: font family (searchable select from list_fonts, preview "Handgloves 0123"), size
  slider 12–32 px, weight select (300–900 available), line-height 1.0–2.4, letter-spacing
  -0.05..0.3 em, align segmented (left/justify), paragraph indent 0..3 em, paragraph spacing
  0..2 em, hyphenation switch, page width 40–100 %, scroll max width 480–1200 px, margins
  4 sliders 0–96 px; **live preview**: mini book pane (static English sample paragraph,
  ~120 words, from contract fixture string) re-renders instantly on every change. Text/bg
  color overrides: "Page colors" expandable: text color, bg color, link color (default:
  from theme; override stored in customThemes? No — page.textColor/backgroundColor overrides
  live in settings.page as optional `textColorOverride/bgColorOverride/linkColorOverride:
  string|null` — add to Settings.page; theme provides defaults when null).
- Reading: mode, page turn anim, prefetch, wheel, click zones.
- Translation: default provider select (from list_translators), target lang select, popupOnSelect
  switch; per-provider cards: enable switch, base URL input (lingva/libre), API key (libre),
  "Test connection" (test_provider → toast ok/fail).
- Dictionary: suggestAfterLookups slider 1–10, dailyReviewLimit 10–200, dict provider select.
- Library: watched dirs list (add via dialog / remove), "Rescan" button, default
  view/sort.
- Shortcuts: rows action (English label) + combo capture input (keydown → serialize
  `Ctrl+Shift+T` style; Esc clears; conflicts flagged red + toast).
- Data: "Export vocabulary" (json/csv/anki via save dialog), "Import vocabulary",
  "Export notes and highlights" (json/md), "Import", "Export settings", "Import settings",
  "Back up database" (save dialog → backup_db), auto-backup info line, "Open data folder"
  (opener). All async with spinner on buttons + toasts.

### 5.10 Shortcuts [F2 Shortcuts.ts]

Global keydown (capture) mounted in App; ignored when target is input/textarea/select/
contentEditable (except Esc and Ctrl-combos). Combos from `settings.shortcuts` (rebindable).

Default map (action id → combo):
```
nextPage Right | prevPage Left | nextPageAlt PageDown | prevPageAlt PageUp | spaceNext Space
nextChapter Ctrl+Right | prevChapter Ctrl+Left
toggleSearch Ctrl+F | toggleToc Ctrl+T | toggleAnnotations Ctrl+Shift+A
fontInc Ctrl+= | fontDec Ctrl+-
cycleTheme Ctrl+J | toggleMode Ctrl+Shift+M | toggleUi Ctrl+H | fullscreen F11
bookmark Ctrl+D | translate Ctrl+Shift+T | dictionary Ctrl+Shift+D | addVocab Ctrl+Shift+V
openSettings Ctrl+, | backToLibrary Ctrl+L | startReview Ctrl+Shift+R | quit Ctrl+Q
```
(Selection-scoped: translate/dictionary/addVocab require active selection, else no-op toast
"Select some text".) Modifier parsing: split '+', case-insensitive, support Ctrl/Shift/Alt/Meta.

### 5.11 Themes & tokens [F3 themes.css; tokens frozen]

CSS vars on `:root` (UI) — applied by `uiStore.applyTheme()` from Theme object:
`--v-bg, --v-bg-alt, --v-bg-raise, --v-fg, --v-fg-muted, --v-accent, --v-accent-fg,
--v-border, --v-shadow` (+ alpha derived). Page vars passed to engine layout →
`--v-page-bg, --v-page-fg, --v-page-link, --v-page-selection`.
Tokens (frozen): `--dur-fast:120ms; --dur-med:180ms; --dur-slow:240ms;
--ease: cubic-bezier(0.2,0,0,1); --radius: 10px; --radius-sm: 6px;` spacing scale via
tailwind. UI font stack: `system-ui, 'Segoe UI', Roboto, 'Noto Sans', sans-serif`.
Highlight palette (frozen): `#ffe08a #a8e6a3 #9ecbf5 #f5a9c0 #cdb4f6 #f7c78e` (mark bg with
`color-mix(in srgb, X 55%, transparent)` overlay + dark-theme boost via page var).

Built-in themes (frozen values):

| id | ui.bg | ui.bgAlt | ui.bgRaise | ui.fg | ui.fgMuted | ui.accent | ui.border | page.bg | page.fg | page.link | page.selectionBg |
|---|---|---|---|---|---|---|---|---|---|---|---|
| light | #f6f5f3 | #ffffff | #ffffff | #1f1c19 | #7a736b | #c2662d | #e4e0da | #fcfbf9 | #26221d | #9a5b2d | rgba(194,102,45,.22) |
| dark | #17171a | #1f1f23 | #26262b | #e4e3e1 | #9b9aa0 | #e0913f | #2e2e34 | #1a1a1e | #d8d6d2 | #e0a458 | rgba(224,145,63,.28) |
| sepia | #ece1cd | #f4ead8 | #f7f0e2 | #43351f | #8b7856 | #9a6b3f | #ddcfb4 | #f4ead8 | #3e2f1c | #8a5a2b | rgba(154,107,63,.25) |
| oled | #000000 | #0a0a0a | #121212 | #e6e6e6 | #8f8f8f | #e0913f | #232323 | #000000 | #d9d9d9 | #e0b060 | rgba(224,145,63,.30) |

accentFg: light/sepia `#fff`, dark/oled `#1a1206`.

### 5.12 App.tsx shell (frozen)

Mounts: `view==='library'` → LibraryView; `'reader'` → ReaderView; etc. Overlays rendered
above view: TocPanel/SearchPanel/AnnotationsPanel (left drawer, mutually exclusive via
`uiStore.overlay`), QuickSettings (right drawer), TranslatePopup/DictPopup (anchored),
ReviewSession (modal), SuggestChip, Toasts, Confirm dialog. On boot: `settingsStore.load()`
→ `applyTheme()` → `libraryStore.load()`; global shortcuts mounted; window min size enforced
by conf. Reader mounts only when a book is open; leaving reader saves position + flushes
heartbeat.

## 6. Defaults & copy

### 6.6 Settings defaults

themeId 'dark' (devs) — no: **'light'** default, honor `prefers-color-scheme: dark` on first
run only. fontSizePx 19, lineHeight 1.65, letterSpacingEm 0, fontWeight 400, fontFamily
'system-ui' fallback chain resolved to first available serif? Default `'Serif'` generic →
engine maps: `fontFamily: 'Georgia, serif'`? Keep: default fontFamily = `'serif'` (CSS
generic; UI shows "System (serif)"), textAlign 'justify', hyphenate true,
paragraphIndentEm 1.2, paragraphSpacingEm 0.6, pageWidthPct 100, scrollMaxWidthPx 720,
margins {top:28,right:40,bottom:28,left:40}, mode 'paginated', pageTurn 'slide', prefetch
true, wheelTurnsPage true, clickZones false, animations true, autoHideChrome true,
defaultProviderId 'google', defaultTargetLang 'ru', popupOnSelect false, dict
defaultProviderId 'dictionaryapi', suggestAfterLookups 3, dailyReviewLimit 50, library view
'grid' sort 'lastOpened' desc, watchedDirs [].

### 6.8 Shortcut action labels

"Next page", "Previous page", "Next chapter", "Previous chapter",
"Search", "Contents", "Notes and highlights", "Larger font", "Smaller font",
"Change theme", "Scroll/page mode", "Hide interface", "Fullscreen",
"Bookmark", "Translate selection", "Dictionary", "Add word to vocabulary", "Settings",
"Back to library", "Start review", "Quit".

### 6.9 UI copy (exact strings; extend in same tone)

Library · Add books · Scan folder · Rescan · Search books… · All tags ·
Sort: Recently opened / Title / Author / Progress / Date added · Open ·
Tags… · Stats · Delete book · "Delete book “{title}”?" + checkbox "Delete file from
disk" · File unavailable · Empty state: "Add your first book" + "Choose EPUB files or a folder of
books" · Books added: {n} · Contents · Search book · Notes · Highlights ·
Bookmarks · Indexing… {done}/{total} · Build index · Nothing found · chapter ·
page {x} / {y} · {pct} % · Translate · Dictionary · Highlight · Note · Add to vocabulary · Copy ·
Copied · Translation unavailable · Retry · Target language · Detected language: {lang} ·
Transcription · Part of speech · Definitions · Examples · Add to vocabulary · The word “{w}”
appeared {n} times. Add to vocabulary? · Study vocabulary · Review · New ·
Learning · Known · Show translation · Again · Hard · Good · Easy · Words reviewed: {n} ·
Due: today / tomorrow / in {n}d / overdue · Reading stats · Today · Week ·
Month · All · Reading time · Pages turned · Books · Streak: {n}d · Settings ·
Appearance · Text · Reading · Translation · Dictionary (study) · Library · Shortcuts ·
Data · Light · Dark · Sepia · OLED · Create theme · Theme name · Text color ·
Background color · Link color · Font · Size · Weight · Line spacing · Letter
spacing · Alignment · Left / Justify · Paragraph indent · Paragraph
spacing · Hyphenation · Page width · Text width (scroll) · Margins · Reading mode ·
Pages / Scroll · Page-turn animation · Slide / Fade / No animation ·
Preload chapters · Mouse wheel turns pages · Click zones · Translation provider · Target language ·
Show translation immediately on selection · Test connection · Works / Doesn't work ·
Suggest word after N lookups · Daily review limit · Export vocabulary · Import
vocabulary · Export notes · Import notes · Export settings · Import settings ·
Back up database · Open data folder · Done · Error: {msg} · Close · Cancel ·
Delete · Save · Apply · Back.

## 7. Data flows (normative)

1. **Import**: UI dialog → `import_books/scan_directory` → B3 parses via `epub::open_book`
   (B1) → rows+cover → report → libraryStore reload.
2. **Open**: `openBook(uid)` → `open_book` (returns OpenBook, triggers auto-index B5) →
   readerStore sets state → ReaderView mounts pool → fetch `vellum://book/{uid}/chapter/{i}`
   → controller.layout → restore position (cfi→page or pct) → chrome shows.
3. **Page turn**: input → engine.setPage (transform) → readerStore.pageIndex → debounced
   savePos (cfiAtPage) + heartbeat page delta. At chapter end → gotoChapter(next).
4. **Selection→translate**: engine.onSelect → readerStore.selection → SelectionToolbar →
   "Translate" → uiStore.overlay='translate' → TranslatePopup → `translate_text` →
   result. "Dictionary" → `lookup_word(word, ctx)` → DictPopup + suggest chip logic.
   "Add to vocabulary" → `add_vocab_word` prefilled from last lookup/selection.
5. **Search**: panel input → `search_in_book` → hits → click → gotoChapter + engine.findText
   + flash.
6. **Review**: VocabView → `get_review_queue` → cards → `record_review` → next; queue empty
   → summary.
7. **Heartbeat**: readerStore interval 30 s → `record_reading_tick` → sessions upsert;
   StatsView `get_stats`.
8. **Settings**: any change → settingsStore.patch (optimistic) → debounced save → if visual:
   applyTheme / re-layout open reader (engine.layout with new vars — cheap, keeps page).

## 8. Testing requirements (per WP)

- B1: parse all 4 testbooks: spine/toc counts > 0, metadata non-empty, cover found for pg84
  and pg2600, uid stable across runs; malformed zip → Err not panic.
- B2: rewrite fixture HTML: scripts removed, relative img/link/anchor absolutized correctly
  (incl. `../` paths, url-encoded names), CSS url() rewritten; protocol route table tests via
  direct function calls (serve_chapter returns bytes; missing asset → 404 type).
- B3: import testbooks into temp-dir DB; list/filter/sort; tags roundtrip; progress
  save/restore; rescan marks missing; delete.
- B4: CRUD roundtrips all 3 annotation types; tick aggregation across days; stats math
  (streak!).
- B5: index pg84 fully; search "monster" hits; "frank" prefix hits; phrase; snippet contains
  <mark>; reindex idempotent; concurrent reader progress writes while indexing don't fail
  (WAL test).
- B6: SM-2 intervals for again/hard/good/easy sequences (table-driven); lookup counter +
  suggest threshold; export/import roundtrip json+csv; queue ordering.
- B7: provider response parsers vs saved fixture JSON (tests/fixtures/*.json — create from
  real API shape, documented in file); registry/config; graceful failure when offline
  (use `http://127.0.0.1:1` as baseUrl in test).
- B8: settings partial-file load (missing fields → defaults), patch merge, atomic save;
  fc-list parse from fixture output string; backup VACUUM INTO produces openable db.
- F0: cfi encode/decode roundtrip on nested fixture DOM (incl. text offsets, multiple text
  nodes per element); pagination column math (jsdom can't layout — test pure functions with
  injected metrics); selection sentence extraction; findText whitespace-normalized match;
  highlight wrap across element boundaries (jsdom Range supported subset).
- F1–F6: smoke render tests (mount with mocked stores/lib), key interactions: card click
  opens book; toolbar buttons call right actions; review grade flips card; settings patch
  debounce fires once. Mock `lib/tauri.ts` via `vi.mock`.
- Integration (orchestrator, not WP): `cargo test` all green; `npm run build`; `vitest run`
  green; `tools/smoke.sh` — release build, launch on Wayland (niri), grim screenshot of
  library + reader, kill; DB/cache dirs created; manual checklist pass.

## 9. Work packages summary

| WP | Scope | Key files |
|---|---|---|
| scaffold-BE | manifests, frozen files, all stubs compile | §3 (scaffold-BE) |
| scaffold-FE | manifests, frozen files, stub components, stores full impl | §3 (scaffold-FE) |
| B1 | epub parse | epub/{mod,container,opf,ncx}.rs |
| B2 | protocol+rewrite+serve | protocol.rs, epub/{rewrite,serve}.rs |
| B3 | db core+library+progress | db/{mod,library,progress}.rs, commands/{library,reader}.rs |
| B4 | annotations+stats | db/{annotations,stats}.rs, commands/{annotations,stats}.rs |
| B5 | search | search/*, commands/search.rs |
| B6 | vocab+srs+export | db/vocab.rs, commands/vocab.rs |
| B7 | net translate+dict+langs | net/**, commands/translate.rs |
| B8 | settings+fonts+backup | settings.rs, backup.rs, fonts.rs, commands/settings.rs |
| F0 | reader engine | features/reader/engine/* |
| F1 | library UI | features/library/* |
| F2 | reader UI shell | features/reader/* (except engine), components/icons.tsx |
| F3 | settings UI + themes | features/settings/*, styles/themes.css |
| F4 | vocab+stats UI | features/vocab/*, features/stats/* |
| F5 | search+annotations UI | features/search/*, features/annotations/* |
| F6 | popups+components polish | features/translate/*, components/* internals |

## 10. Deviations protocol

Contract gaps: choose the simplest solution consistent with the spirit (speed, minimal UI),
implement, and list in your final report under `DEVIATIONS:` with file+reason. Frozen-file
changes needed: do NOT edit; report under `FROZEN-CHANGE-REQUEST:`.

## 11. Frozen internal cross-module APIs

Scaffold-BE creates **compiling stubs** (`todo!("WP-x")` bodies or minimal placeholders) for
every signature below in the owning file; each WP replaces the body. Dependent WPs compile
against these without waiting. `#![allow(dead_code)]` is set crate-wide by scaffold to keep
partial builds green. All types in `dto.rs` unless noted.

### 11.1 epub parsing (epub/mod.rs [B1]) — used by B2, B3, B5

```rust
pub struct BookArchive {                 // cheap handle; not Send across threads unless noted
    pub uid: String, pub path: String, pub container_dir: String,   // dir of OPF inside zip
    pub metadata: BookMetadata, pub manifest: Vec<ManifestItem>,
    pub spine: Vec<SpineItem>, pub toc: Vec<TocEntry>, pub cover_id: Option<String>,
}
pub struct BookMetadata { pub title: String, pub authors: Vec<String>,
    pub language: Option<String>, pub identifier: Option<String>, pub cover_href: Option<String> }
pub struct ManifestItem { pub id: String, pub href: String, pub media_type: String,
    pub properties: Vec<String> }              // "cover-image","nav",…
pub struct SpineItem { pub idref: String, pub href: String, pub linear: bool }
    // href already normalized to zip-root-relative, percent-decoded storage form

pub fn open_book(path: &str) -> anyhow::Result<BookArchive>;   // parse container+opf+ncx/nav
pub fn compute_uid(meta: &BookMetadata, path: &std::path::Path) -> anyhow::Result<String>;
    // sha1 hex (lowercase) of identifier if present else size+first 64KiB bytes
pub fn manifest_by_id<'a>(b: &'a BookArchive, id: &str) -> Option<&'a ManifestItem>;
pub fn find_cover_href(b: &BookArchive) -> Option<String>;      // cover-image→meta cover→cover.*→first img
pub fn zip_entry_bytes(path: &str, entry: &str) -> anyhow::Result<Vec<u8>>; // low-level read (B1)
pub fn extract_text(html: &[u8]) -> String;                     // B1: lol_html text-only, for B5 index
pub fn nav_or_ncx_toc(bytes: &[u8], kind: NavKind) -> anyhow::Result<Vec<TocEntry>>; // B1
pub enum NavKind { Ncx, Nav }
```
TocEntry.chapter_idx resolved by B1 to the spine position of the target href (or -1 if none;
UI hides those). TocEntry.parent_idx = index into the flat vec (0-based) or null.

### 11.2 rewrite/serve (epub/rewrite.rs, epub/serve.rs [B2]) — used by protocol.rs [B2]

```rust
// rewrite.rs
pub struct RewriteCtx<'a> { pub uid: &'a str, pub chapter_zip_dir: &'a str }
pub fn rewrite_chapter(html: &[u8], ctx: &RewriteCtx) -> Vec<u8>;   // sanitize+absolutize
pub fn rewrite_css(css: &str, css_zip_dir: &str, uid: &str) -> String; // url() absolutize

// serve.rs
pub enum Served { Ok { body: Vec<u8>, mime: String, cache_secs: u32 }, NotFound }
pub fn serve_chapter(uid: &str, path: &str, chapter_idx: usize, zips: &ZipCache) -> Served;
pub fn serve_asset(uid: &str, path: &str, zip_path: &str, entry: &str, zips: &ZipCache) -> Served;
pub fn serve_cover(uid: &str, zip_path: &str, zips: &ZipCache) -> Served;
pub fn mime_for(path: &str) -> &'static str;   // xhtml,css,js→text/plain(off),png,jpeg,gif,svg,woff,woff2,ttf,otf,mp3,…
pub type ZipCache = dashmap::DashMap<String, std::sync::Mutex<zip::ZipArchive<std::io::BufReader<std::fs::File>>>>;
pub fn get_zip(zips: &ZipCache, uid: &str, path: &str) -> anyhow::Result<()>; // open+insert if absent
```
`protocol.rs [B2] pub fn register(app: &tauri::AppHandle)` parses the URI, resolves
uid→book path via a `books` lookup closure the protocol holds (scaffold passes a channel to
query AppState db for path by uid), dispatches to serve_*, sets CORS+cache headers, replies.

### 11.3 db helpers (db/mod.rs [B3]) — used by all command WPs

```rust
pub fn open(app_paths: &AppPaths) -> anyhow::Result<rusqlite::Connection>; // sets pragmas
pub fn migrate(c: &rusqlite::Connection) -> anyhow::Result<()>;           // §4.4 DDL, user_version
pub fn now_ms() -> i64;                                    // std::time unix ms (no chrono)
pub fn today_str() -> String;                              // yyyy-mm-dd local via now_ms + tz offset
pub struct AppPaths { pub data_dir: PathBuf, pub config_dir: PathBuf, pub cache_dir: PathBuf,
    pub covers_dir: PathBuf, pub backups_dir: PathBuf, pub db_path: PathBuf }
pub fn init_paths(app: &tauri::AppHandle) -> AppPaths;     // XDG via app.path()
// row mappers (B3): pub fn row_to_book(row)->BookMeta; pub fn row_to_toc; row_to_chapter
```
All command WPs get the connection via `state.db.lock().unwrap()` — **short-lived locks
only**; long jobs (B5 index) open a **second** connection to the same path (WAL). Never hold
the main lock across `.await`.

### 11.4 vocab↔net (net [B7] functions called in-process by B6)

```rust
// net/mod.rs
pub fn client(state: &AppState) -> &reqwest::Client;         // &state.http
pub async fn lookup(state: &AppState, word: &str, ctx: Option<&LookupContext>) -> anyhow::Result<LookupResult>;
    // B7 orchestrates: dict (if eligible) + translate(auto→targetLang); B6 wraps with
    // lookups upsert + suggest logic. lookup_word command (B6) calls this.
pub async fn translate(state: &AppState, text: &str, from: &str, to: &str, provider: Option<&str>)
    -> anyhow::Result<TranslateResult>;
pub async fn dict_lookup(state: &AppState, word: &str) -> anyhow::Result<Option<DictEntry>>;
pub async fn detect_lang(state: &AppState, text: &str) -> anyhow::Result<String>; // ISO 639-1
pub fn list_translators(state: &AppState) -> Vec<TranslatorInfo>;
pub fn languages() -> Vec<Lang>;   // static; Lang { code, name_ru }
// translate/mod.rs
pub trait TranslateProvider: Send + Sync { fn id(&self)->&str; fn name(&self)->&str;
  fn needs_config(&self)->bool;
  async fn translate(&self, c:&reqwest::Client, cfg:&ProviderConfig, text:&str, from:&str, to:&str)
    -> anyhow::Result<TranslateResult>;
  async fn detect(&self, c:&reqwest::Client, text:&str)->anyhow::Result<String>; }
pub fn registry()->Vec<Box<dyn TranslateProvider>>;   // google, lingva, libre
// dict/mod.rs analogous: DictProvider trait { async fn lookup(...)->anyhow::Result<Option<DictEntry>> }
```
B7 must make `lookup`/`translate`/`dict_lookup` never panic and return `Ok` with null
sub-results when a provider errors (so B6 degrades gracefully); `Err` only on total failure.

**Provider endpoint reality (probed 2026-09-21 from build host — implement as fallback chains,
the FIRST working one wins; some endpoints are IP-blocked on certain networks so never rely
on one):**
- `google` provider: try in order — (1) `https://translate.googleapis.com/translate_a/single?client=gtx&sl={from}&tl={to}&dt=t&dt=bd&q={text}` (rich: `bd` gives dictionary senses), parse nested arrays; (2) if (1) returns HTML/`Sorry…`/non-JSON, fall back to `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl={from}&tl={to}&q={text}` which returns a flat `["translated"]` (or `{"src":..}` shape) — parse both. `sl=auto` supported. Set a real browser UA (`Mozilla/5.0 …Chrome/126…`) on every translate request or Google 403s.
- `lingva` provider: `{baseUrl}/api/v1/{from}/{to}/{urlencoded text}` → `{"translation":..,"info":{"detectedSource":..}}`. Public instances are flaky; default baseUrl `https://lingva.ml`, user-configurable.
- `libre` provider: POST `{baseUrl}/translate` json `{q,source,target,api_key}` → `{"translatedText":..,"detectedLanguage":..}`. Needs config (baseUrl+key).
- `dictionaryapi` (dict): `https://api.dictionaryapi.dev/api/v2/entries/en/{word}` → `[{word,phonetic,phonetics:[{text}],meanings:[{partOfSpeech,definitions:[{definition,example,synonyms}]}]}]`. Map to DictEntry (transcription from first `phonetics[].text`). English-only; for non-English words return None (dict_lookup → None, translate still works). May rate-limit → treat non-200 as None.
- detect_language: derive from google response `src`/detectedSource when available; else a cheap local heuristic (unicode-block sniff: Cyrillic→ru, Latin→en, CJK→zh/ja, Greek→el, Arabic→ar) so it never needs the network.

All network tests use saved fixtures (§8 B7), NOT live calls, so a blocked build-host IP does
not fail CI; but the live fallback chain must be implemented for the user's real machine.

### 11.5 settings (settings.rs [B8]) — used by B5, B6, B7, protocol indirectly

```rust
pub struct Settings { /* §4.1 Settings, serde, all #[serde(default)] via Default impl */ }
impl Default for Settings { /* §6.6 values */ }
pub fn load(paths: &AppPaths) -> Settings;               // read file, merge over default, never Err
pub fn save(paths: &AppPaths, s: &Settings) -> anyhow::Result<()>;  // atomic tmp+rename
pub fn merge_patch(current: &Settings, patch: serde_json::Value) -> anyhow::Result<Settings>;
    // deep merge; used by save_settings command
pub fn list_fonts(state: &AppState) -> Vec<FontFamily>;  // fc-list, cached in state.fonts
```
B8 also adds to `Settings.page` optional overrides: `textColorOverride: Option<String>`,
`backgroundColorOverride: Option<String>`, `linkColorOverride: Option<String>` (camelCase).
Frontend `settingsStore` exposes them; F3 wires color inputs; engine uses override ?? theme.

### 11.6 frontend frozen exports (scaffold-FE)

`lib/tauri.ts` — one exported async fn per §4.8 command, exact name = camelCase of command
(`importBooks`, `scanDirectory`, `listBooks`, `openBook`, `savePosition`, `lookupWord`,
`translateText`, `getSettings`, `saveSettings`, `listFonts`, `getReviewQueue`, `recordReview`,
`searchInBook`, …) + `onEvent<T>(name, cb): Promise<() => void>`. Types from `lib/types.ts`.
`lib/utils.ts` — `cn(...classes): string`, `debounce<A extends any[]>(fn, ms): ((...A)=>void)&{cancel()}`,
`clamp(n,min,max)`, `fmtDuration(seconds): string` ("2h 15m"), `fmtRelative(ts): string`
("just now"/"yesterday"/"N days ago"), `fmtDate(ts): string` ("Oct 12"), `esc(s): string`
(HTML-escape), `slug(s): string`.
`stores/*` per §5.2 with **full working implementations** (scaffold writes them completely,
frozen). `components/*` base impls (Modal/Popover/Slider/Toast/Spinner/ContextMenu/Tooltip/
Segmented/Switch/Select) with stable props (scaffold defines; F6 may restyle internals only).
`components/icons.tsx` [F2] — `<Icon name="book|search|bookmark|toc|notes|settings|sun|moon|
type|columns|scroll|maximize|close|chevronLeft|chevronRight|plus|check|trash|edit|play|
arrowLeft|layers|languages" size={18}/>` inline SVG, currentColor.
`styles/readerBaseCss.ts` [F0] — exported const string (the injected reader CSS, §5.3).
Feature components mount via `App.tsx` (frozen) — scaffold renders stubs ("WIP") so the app
boots; each F-WP replaces its stub.

### 11.7 Build/CI commands (integration phase runs these; WPs keep them green locally)

```
cd src-tauri && cargo fmt && cargo clippy -- -D warnings && cargo test
cd .. && npm run build && npx vitest run
tools/smoke.sh   # release build + launch + grim screenshots + assertions + kill
```
scaffold ensures `cargo check` and `npm run build` pass with all stubs BEFORE any WP starts.
