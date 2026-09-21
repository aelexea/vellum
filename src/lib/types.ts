/**
 * DTO types — mirror of ARCHITECTURE.md §4.1 (TS is normative).
 * FROZEN (scaffold-FE). Backend `dto.rs` mirrors these with camelCase serde.
 *
 * Additions beyond §4.1, per contract:
 *  - Settings.page colour overrides (§5.9 / §11.5)
 *  - VocabPatch (§4.8), Lang (§4.8 list_languages), VocabWordStatus, StatsRange,
 *    ReviewResult (§4.6), backend event payloads (§4.8).
 */

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

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

export interface TocEntry {
  title: string; chapterIdx: number; cfi: string | null; level: number; parentIdx: number | null;
}

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

export interface OpenBook {
  book: BookDetail; position: ReadingPosition | null;
  highlights: Highlight[]; notes: Note[]; bookmarks: Bookmark[]; indexStatus: IndexStatus;
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export interface Highlight {
  id: number; bookUid: string; chapterIdx: number;
  cfiStart: string; cfiEnd: string; color: string; createdAt: number; hasNote: boolean;
  /** The highlighted text (v1.3, F5 FCR) — quoted in the annotations list. */
  text: string;
}

export interface Note {
  id: number; bookUid: string; chapterIdx: number;
  cfiStart: string; cfiEnd: string; selectedText: string; noteText: string;
  createdAt: number; updatedAt: number;
}

export interface Bookmark {
  id: number; bookUid: string; chapterIdx: number;
  cfi: string; label: string | null; createdAt: number;
}

// ---------------------------------------------------------------------------
// Search / indexing
// ---------------------------------------------------------------------------

export interface IndexStatus {
  state: 'none' | 'indexing' | 'ready' | 'error';
  chaptersDone: number; chaptersTotal: number;
}

export interface SearchHit {
  chapterIdx: number; chapterTitle: string;
  snippet: string;                // HTML, matches wrapped in <mark>
  score: number;
}

// ---------------------------------------------------------------------------
// Translate / dictionary
// ---------------------------------------------------------------------------

export interface LookupContext { bookUid: string; chapterIdx: number; sentence: string; cfi: string; }

export interface DictMeaning {
  pos: string | null;
  definitions: { definition: string; example: string | null; synonyms: string[] }[];
}

export interface DictEntry { word: string; transcription: string | null; meanings: DictMeaning[]; }

export interface LookupResult {
  word: string; translation: TranslateResult | null;
  dictionary: DictEntry | null; lookupCount: number; suggestAdd: boolean; alreadyInVocab: boolean;
}

export interface TranslateResult {
  translatedText: string; detectedSourceLang: string;
  targetLang: string; providerId: string;
}

export interface TranslatorInfo {
  id: string; name: string; kind: 'translate' | 'dict' | 'both';
  needsConfig: boolean; configured: boolean;
}

export interface Lang { code: string; nameRu: string; }

// ---------------------------------------------------------------------------
// Vocabulary / SRS
// ---------------------------------------------------------------------------

export type VocabWordStatus = 'new' | 'learning' | 'known';

export interface VocabWord {
  id: number; word: string; translation: string | null;
  definition: string | null; transcription: string | null; pos: string | null;
  examples: string[]; bookUid: string | null; bookTitle: string | null;
  chapterIdx: number | null; context: string | null; contextCfi: string | null;
  addedAt: number; status: VocabWordStatus;
  reviewCount: number; intervalDays: number | null; dueAt: number | null; lastReviewedAt: number | null;
  /** SM-2 ease factor, SRS-managed; used for grade-interval previews. */
  ease: number;
}

/** §4.8 — all optional, only present fields are updated. */
export interface VocabPatch {
  translation?: string | null;
  definition?: string | null;
  transcription?: string | null;
  pos?: string | null;
  examples?: string[];
  status?: VocabWordStatus;
  context?: string | null;
  dueAt?: number | null;
}

export interface VocabStats {
  total: number; byStatus: Record<VocabWordStatus, number>;
  dueToday: number; reviewsToday: number; addedThisWeek: number;
}

/** §4.6 record_review result. */
export type ReviewResult = 'again' | 'hard' | 'good' | 'easy';

/** add_vocab_word input (all fields optional except word). */
export interface VocabWordInput {
  word: string;
  translation?: string | null;
  definition?: string | null;
  transcription?: string | null;
  pos?: string | null;
  examples?: string[];
  bookUid?: string | null;
  chapterIdx?: number | null;
  context?: string | null;
  contextCfi?: string | null;
  status?: VocabWordStatus;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface ReadingStats {
  rangeSeconds: number;
  byDay: { date: string; seconds: number }[];   // ISO yyyy-mm-dd, oldest first
  pagesTurned: number; booksTouched: number; streakDays: number;
}

export interface BookStats {
  totalSeconds: number; pagesTurned: number;
  firstOpenedAt: number | null; lastOpenedAt: number | null; progress: number;
}

/** get_stats(range) — §4.8. */
export type StatsRange = 'day' | 'week' | 'month' | 'all';

// ---------------------------------------------------------------------------
// Library filter / import / fonts
// ---------------------------------------------------------------------------

export interface Tag { id: number; name: string; count: number; }

export interface ImportReport {
  imported: BookMeta[];
  skipped: { path: string; reason: string }[];
  failed: { path: string; reason: string }[];
}

export interface LibraryFilter {
  query: string | null; tag: string | null;
  sort: 'lastOpened' | 'title' | 'author' | 'progress' | 'added' | 'percent';
  sortDesc: boolean; missing: 'hide' | 'only' | 'all';
}

export interface FontFamily { name: string; hasBold: boolean; hasItalic: boolean; mono: boolean; }

// ---------------------------------------------------------------------------
// Theme / settings
// ---------------------------------------------------------------------------

export interface Theme {
  id: string; name: string; builtin: boolean;
  ui: {
    bg: string; bgAlt: string; bgRaise: string; fg: string; fgMuted: string;
    accent: string; accentFg: string; border: string;
  };
  page: { bg: string; fg: string; link: string; selectionBg: string; };
}

export interface ProviderConfig { enabled: boolean; baseUrl: string | null; apiKey: string | null; }

export interface Settings {
  ui: { themeId: string; customThemes: Theme[]; animations: boolean; autoHideChrome: boolean; };
  page: {
    fontFamily: string; fontSizePx: number; fontWeight: number; lineHeight: number;
    letterSpacingEm: number; textAlign: 'left' | 'justify'; paragraphIndentEm: number;
    paragraphSpacingEm: number; hyphenate: boolean; pageWidthPct: number;   // 40..100
    scrollMaxWidthPx: number; marginsPx: { top: number; right: number; bottom: number; left: number };
    // §5.9 / §11.5 — page colour overrides; theme supplies the value when null.
    textColorOverride?: string | null;
    backgroundColorOverride?: string | null;
    linkColorOverride?: string | null;
  };
  reading: {
    mode: 'paginated' | 'scroll'; pageTurn: 'slide' | 'fade' | 'none'; prefetch: boolean;
    wheelTurnsPage: boolean; clickZones: boolean;
  };
  translate: {
    defaultProviderId: string; defaultTargetLang: string; popupOnSelect: boolean;
    providers: Record<string, ProviderConfig>;
  };
  dictionary: { defaultProviderId: string; };
  vocab: { suggestAfterLookups: number; dailyReviewLimit: number; };
  library: { watchedDirs: string[]; view: 'grid' | 'list'; sort: LibraryFilter['sort']; sortDesc: boolean; };
  shortcuts: Record<string, string>;   // action id → combo, §6.8
}

/** Recursive partial for settingsStore.patch. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ---------------------------------------------------------------------------
// Backend events (§4.8)
// ---------------------------------------------------------------------------

export interface IndexProgressEvent { bookUid: string; done: number; total: number; }
export interface IndexDoneEvent { bookUid: string; }
export interface IndexErrorEvent { bookUid: string; message: string; }
export interface ImportProgressEvent { done: number; total: number; current: string; }

export type BackendEventMap = {
  'index-progress': IndexProgressEvent;
  'index-done': IndexDoneEvent;
  'index-error': IndexErrorEvent;
  'import-progress': ImportProgressEvent;
};

export type BackendEventName = keyof BackendEventMap;
