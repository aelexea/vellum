/**
 * Vitest setup — mocks the Tauri surface so stores/components run under jsdom.
 * Registered via vitest.config.ts `setupFiles`.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/stores/settingsStore';
import { DEFAULT_SHORTCUTS } from '@/features/reader/Shortcuts';
import type {
  BookMeta, FontFamily, ImportReport, IndexStatus, Lang, LookupResult,
  ReadingStats, Settings, Tag, TranslatorInfo, VocabStats, VocabWord,
} from '@/lib/types';

// --------------------------------------------------------------------------
// jsdom gaps
// --------------------------------------------------------------------------

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// --------------------------------------------------------------------------
// Fixture data returned by the mocked commands
// --------------------------------------------------------------------------

export const mockBook: BookMeta = {
  uid: 'aaaa1111', title: 'Тестовая книга', authors: ['Автор Тестов'], path: '/tmp/test.epub',
  coverUrl: null, progress: 0.25, positionChapterIdx: 1, totalChapters: 4,
  addedAt: 1_700_000_000_000, lastOpenedAt: 1_700_000_900_000, tags: [], sizeBytes: 1024,
  missing: false,
};

const emptyImportReport: ImportReport = { imported: [], skipped: [], failed: [] };
const emptyIndexStatus: IndexStatus = { state: 'none', chaptersDone: 0, chaptersTotal: 0 };
const emptyVocabStats: VocabStats = {
  total: 0, byStatus: { new: 0, learning: 0, known: 0 },
  dueToday: 0, reviewsToday: 0, addedThisWeek: 0,
};
const emptyReadingStats: ReadingStats = {
  rangeSeconds: 0, byDay: [], pagesTurned: 0, booksTouched: 0, streakDays: 0,
};
// Mirrors the backend list_languages payload (net/languages.rs), whose display
// names are now English; the dto field keeps its legacy `nameRu` wire key.
const langs: Lang[] = [{ code: 'ru', nameRu: 'Russian' }, { code: 'en', nameRu: 'English' }];
const translators: TranslatorInfo[] = [
  { id: 'google', name: 'Google', kind: 'translate', needsConfig: false, configured: true },
];
const fonts: FontFamily[] = [
  { name: 'Georgia', hasBold: true, hasItalic: true, mono: false },
];
const lookupResult: LookupResult = {
  word: 'test', translation: null, dictionary: null,
  lookupCount: 1, suggestAdd: false, alreadyInVocab: false,
};
const vocabWord: VocabWord = {
  id: 1, word: 'test', translation: 'проверка', definition: null, transcription: null,
  pos: null, examples: [], bookUid: null, bookTitle: null, chapterIdx: null,
  context: null, contextCfi: null, addedAt: 1_700_000_000_000, status: 'new',
  reviewCount: 0, intervalDays: null, dueAt: null, lastReviewedAt: null, ease: 2.5,
};

/** Command name → resolved value. Unknown commands reject so tests catch typos. */
const RESPONSES: Record<string, unknown> = {
  get_smoke_config: null,

  list_books: [mockBook],
  list_tags: [] as Tag[],
  import_books: emptyImportReport,
  scan_directory: emptyImportReport,
  rescan_library: emptyImportReport,
  set_book_tags: undefined,
  delete_book: undefined,
  get_book: { ...mockBook, toc: [], chapters: [] },

  open_book: {
    book: { ...mockBook, toc: [], chapters: [
      { idx: 0, href: 'c0.xhtml', title: 'Глава 1', charCount: 100 },
      { idx: 1, href: 'c1.xhtml', title: 'Глава 2', charCount: 100 },
    ] },
    position: null,
    highlights: [], notes: [], bookmarks: [],
    indexStatus: emptyIndexStatus,
  },
  save_position: undefined,
  record_reading_tick: undefined,

  list_highlights: [],
  add_highlight: { id: 1, bookUid: 'aaaa1111', chapterIdx: 0, cfiStart: '/2', cfiEnd: '/2',
    color: '#ffe08a', text: '', createdAt: 1_700_000_000_000, hasNote: false },
  update_highlight: undefined,
  delete_highlight: undefined,
  list_notes: [],
  add_note: { id: 1, bookUid: 'aaaa1111', chapterIdx: 0, cfiStart: '/2', cfiEnd: '/2',
    selectedText: '', noteText: '', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 },
  update_note: undefined,
  delete_note: undefined,
  list_bookmarks: [],
  add_bookmark: (args: { bookUid: string; chapterIdx: number; cfi: string; label: string | null }) => ({
    id: 1, bookUid: args.bookUid, chapterIdx: args.chapterIdx, cfi: args.cfi,
    label: args.label, createdAt: 1_700_000_000_000,
  }),
  delete_bookmark: undefined,

  get_index_status: emptyIndexStatus,
  reindex_book: undefined,
  search_in_book: [],

  lookup_word: lookupResult,
  list_vocab: [] as VocabWord[],
  add_vocab_word: vocabWord,
  update_vocab_word: vocabWord,
  delete_vocab_word: undefined,
  get_review_queue: [] as VocabWord[],
  record_review: vocabWord,
  vocab_stats: emptyVocabStats,
  export_vocab: 0,
  import_vocab: 0,

  translate_text: { translatedText: '', detectedSourceLang: 'en', targetLang: 'ru',
    providerId: 'google' },
  detect_language: 'en',
  list_translators: translators,
  save_provider_config: undefined,
  test_provider: true,
  list_languages: langs,

  get_settings: structuredClone(DEFAULT_SETTINGS) as Settings,
  save_settings: (args: { patch?: unknown }) =>
    structuredClone((args?.patch as Settings) ?? DEFAULT_SETTINGS) as Settings,
  list_fonts: fonts,
  export_settings: undefined,
  import_settings: structuredClone(DEFAULT_SETTINGS) as Settings,
  backup_db: undefined,
  export_annotations: 0,
  import_annotations: 0,

  get_stats: emptyReadingStats,
  get_book_stats: { totalSeconds: 0, pagesTurned: 0, firstOpenedAt: null, lastOpenedAt: null,
    progress: 0 },
};

/** Recorded invocations: { cmd, args } — assertions read this. */
export const invokeCalls: { cmd: string; args: unknown }[] = [];

/** Swap a single command response for one test (restores via resetMocks). */
export function mockCommand(cmd: string, value: unknown): void {
  RESPONSES[cmd] = value;
}

/**
 * Shallow snapshot: `structuredClone` cannot clone the function-valued responses
 * (save_settings). Values are safe to share because invoke() clones on return.
 */
const DEFAULTS: Record<string, unknown> = { ...RESPONSES };

/** Restore default responses + clear the call log. */
export function resetMocks(): void {
  invokeCalls.length = 0;
  for (const [k, v] of Object.entries(DEFAULTS)) RESPONSES[k] = v;
  for (const k of Object.keys(RESPONSES)) {
    if (!(k in DEFAULTS)) delete RESPONSES[k];
  }
}

// --------------------------------------------------------------------------
// @tauri-apps/api mocks
// --------------------------------------------------------------------------

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    invokeCalls.push({ cmd, args });
    if (!(cmd in RESPONSES)) {
      throw new Error(`[test] unmocked invoke: ${cmd}`);
    }
    const v = RESPONSES[cmd];
    if (typeof v === 'function') return (v as (a: unknown) => unknown)(args);
    return v === undefined ? null : structuredClone(v);
  }),
}));

const unlisteners: (() => void)[] = [];

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, _handler: unknown) => {
    const un = () => {};
    unlisteners.push(un);
    return un;
  }),
  once: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
  message: vi.fn(async () => true),
  ask: vi.fn(async () => true),
  confirm: vi.fn(async () => true),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: vi.fn(async () => {}),
  openUrl: vi.fn(async () => {}),
  revealItemInDir: vi.fn(async () => {}),
}));

// Silence expected store warning logs during tests.
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  resetMocks();
  unlisteners.length = 0;
  // Note: we deliberately do NOT touch globalThis.localStorage here. Under Node 26 +
  // vitest the bare property access emits an ExperimentalWarning, and no unit test
  // mounts App.tsx (the only localStorage consumer), so clearing it is unnecessary.
});

export { DEFAULT_SHORTCUTS };
