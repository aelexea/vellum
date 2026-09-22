/**
 * Preview fixture data — rich, realistic payloads so every view renders populated
 * (not empty-states) for design review. Served through the mocked invoke() in core.ts.
 *
 * This is a DESIGN-PREVIEW harness (tools/preview), separate from src/test/setup.ts.
 * Cover URLs point at real files under public/preview-fixtures so <img> loads them;
 * chapter HTML is fetched lazily from /preview-fixtures/chapters.json by the patched
 * window.fetch in preview-entry.tsx.
 */
import type {
  BookMeta, Bookmark, FontFamily, Highlight, Lang, Note, ReadingStats, SearchHit,
  Settings, Tag, TranslatorInfo, VocabStats, VocabWord,
} from '@/lib/types';

const DAY = 86_400_000;
const now = 1_726_000_000_000;

export const BOOKS: BookMeta[] = [
  {
    uid: 'pg84', title: 'Frankenstein; Or, The Modern Prometheus', authors: ['Mary Wollstonecraft Shelley'],
    path: '/books/pg84.epub', coverUrl: '/preview-fixtures/covers/pg84.jpg',
    progress: 0.42, positionChapterIdx: 5, totalChapters: 24, addedAt: now - 30 * DAY,
    lastOpenedAt: now - 2 * 3600_000, tags: ['gothic', 'classic'], sizeBytes: 460_000, missing: false,
  },
  {
    uid: 'pg2600', title: 'War and Peace', authors: ['graf Leo Tolstoy'],
    path: '/books/pg2600.epub', coverUrl: '/preview-fixtures/covers/pg2600.jpg',
    progress: 0.18, positionChapterIdx: 12, totalChapters: 367, addedAt: now - 22 * DAY,
    lastOpenedAt: now - 5 * DAY, tags: ['classic', 'russian'], sizeBytes: 1_800_000, missing: false,
  },
  {
    uid: 'pg11', title: 'Alice’s Adventures in Wonderland', authors: ['Lewis Carroll'],
    path: '/books/pg11.epub', coverUrl: '/preview-fixtures/covers/pg11.jpg',
    progress: 1, positionChapterIdx: 11, totalChapters: 12, addedAt: now - 60 * DAY,
    lastOpenedAt: now - 9 * DAY, tags: ['classic'], sizeBytes: 180_000, missing: false,
  },
  {
    uid: 'pg13', title: 'The Hunting of the Snark', authors: ['Lewis Carroll'],
    path: '/books/pg13.epub', coverUrl: '/preview-fixtures/covers/pg13.jpg',
    progress: 0, positionChapterIdx: null, totalChapters: 9, addedAt: now - 11 * DAY,
    lastOpenedAt: null, tags: ['poetry'], sizeBytes: 150_000, missing: false,
  },
  {
    uid: 'gone', title: 'A Book Whose File Moved', authors: ['Someone'],
    path: '/books/gone.epub', coverUrl: null, progress: 0.6, positionChapterIdx: 3,
    totalChapters: 10, addedAt: now - 40 * DAY, lastOpenedAt: now - 40 * DAY, tags: [],
    sizeBytes: 90_000, missing: true,
  },
];

export const TAGS: Tag[] = [
  { id: 1, name: 'classic', count: 3 }, { id: 2, name: 'gothic', count: 1 },
  { id: 3, name: 'russian', count: 1 }, { id: 4, name: 'poetry', count: 1 },
];

export const readerBook = BOOKS[0];

export const TOC = [
  { title: 'Letter 1', chapterIdx: 0, cfi: null, level: 0, parentIdx: null },
  { title: 'Letter 2', chapterIdx: 1, cfi: null, level: 0, parentIdx: null },
  { title: 'Letter 3', chapterIdx: 2, cfi: null, level: 0, parentIdx: null },
  { title: 'Letter 4', chapterIdx: 3, cfi: null, level: 0, parentIdx: null },
  { title: 'Chapter 1', chapterIdx: 4, cfi: null, level: 0, parentIdx: null },
  { title: 'Chapter 2', chapterIdx: 5, cfi: null, level: 0, parentIdx: null },
  { title: 'Chapter 3', chapterIdx: 6, cfi: null, level: 0, parentIdx: null },
  { title: 'Chapter 4', chapterIdx: 7, cfi: null, level: 0, parentIdx: null },
];

export const CHAPTERS = TOC.map((t, i) => ({ idx: i, href: `c${i}.xhtml`, title: t.title, charCount: 4000 }));

export const HIGHLIGHTS: Highlight[] = [
  { id: 1, bookUid: 'pg84', chapterIdx: 5, cfiStart: 'epubcfi(/2/10)', cfiEnd: 'epubcfi(/2/10:40)',
    color: '#ffe08a', text: 'I am by nature benevolent and good', createdAt: now - 3 * DAY, hasNote: true },
  { id: 2, bookUid: 'pg84', chapterIdx: 5, cfiStart: 'epubcfi(/2/14)', cfiEnd: 'epubcfi(/2/14:30)',
    color: '#9ecbf5', text: 'misery made me a fiend', createdAt: now - 3 * DAY, hasNote: false },
  { id: 3, bookUid: 'pg84', chapterIdx: 6, cfiStart: 'epubcfi(/2/4)', cfiEnd: 'epubcfi(/2/4:55)',
    color: '#a8e6a3', text: 'the cold stars looked down in mockery', createdAt: now - 2 * DAY, hasNote: false },
  { id: 4, bookUid: 'pg84', chapterIdx: 6, cfiStart: 'epubcfi(/2/9)', cfiEnd: 'epubcfi(/2/9:22)',
    color: '#f5a9c0', text: 'the bare trees waved their branches', createdAt: now - DAY, hasNote: true },
];

export const NOTES: Note[] = [
  { id: 1, bookUid: 'pg84', chapterIdx: 5, cfiStart: 'epubcfi(/2/10)', cfiEnd: 'epubcfi(/2/10:40)',
    selectedText: 'I am by nature benevolent and good', noteText: 'The creature’s core claim — contrast with his later violence.',
    createdAt: now - 3 * DAY, updatedAt: now - 3 * DAY },
  { id: 2, bookUid: 'pg84', chapterIdx: 6, cfiStart: 'epubcfi(/2/9)', cfiEnd: 'epubcfi(/2/9:22)',
    selectedText: 'the bare trees waved their branches', noteText: 'Pathetic fallacy again.',
    createdAt: now - DAY, updatedAt: now - DAY },
];

export const BOOKMARKS: Bookmark[] = [
  { id: 1, bookUid: 'pg84', chapterIdx: 4, cfi: 'epubcfi(/2/2)', label: 'Where Walton meets him', createdAt: now - 4 * DAY },
  { id: 2, bookUid: 'pg84', chapterIdx: 7, cfi: 'epubcfi(/2/16)', label: null, createdAt: now - 2 * DAY },
];

export const SEARCH_HITS: SearchHit[] = [
  { chapterIdx: 5, chapterTitle: 'Chapter 2',
    snippet: '…yet <mark>monster</mark> as I am, my heart was formed for love…', score: 9.4 },
  { chapterIdx: 6, chapterTitle: 'Chapter 3',
    snippet: '…the <mark>monster</mark> crept beneath the cottage wall and listened…', score: 8.1 },
  { chapterIdx: 9, chapterTitle: 'Chapter 6',
    snippet: '…I, the miserable <mark>monster</mark>, had killed the lovely child…', score: 7.6 },
];

export const FONTS: FontFamily[] = [
  { name: 'Serifa', hasBold: true, hasItalic: true, mono: false },
  { name: 'Georgia', hasBold: true, hasItalic: true, mono: false },
  { name: 'Charis SIL', hasBold: true, hasItalic: true, mono: false },
  { name: 'Literata', hasBold: true, hasItalic: true, mono: false },
  { name: 'Inter', hasBold: true, hasItalic: true, mono: false },
  { name: 'Source Sans 3', hasBold: true, hasItalic: true, mono: false },
  { name: 'JetBrains Mono', hasBold: true, hasItalic: true, mono: true },
  { name: 'Noto Serif', hasBold: true, hasItalic: true, mono: false },
  { name: 'Libre Baskerville', hasBold: true, hasItalic: false, mono: false },
  { name: 'EB Garamond', hasBold: false, hasItalic: true, mono: false },
];

const V = (
  id: number, word: string, translation: string, status: VocabWord['status'],
  def: string, pos: string, ctx: string, interval: number | null, due: number | null,
  reviews: number, ease: number,
): VocabWord => ({
  id, word, translation, definition: def, transcription: null, pos,
  examples: [ctx], bookUid: 'pg84', bookTitle: 'Frankenstein', chapterIdx: 5,
  context: ctx, contextCfi: 'epubcfi(/2/10)', addedAt: now - (20 - id) * DAY, status,
  reviewCount: reviews, intervalDays: interval, dueAt: due, lastReviewedAt: due ? due - DAY : null, ease,
});

export const VOCAB: VocabWord[] = [
  V(1, 'benevolent', 'kind, generous', 'learning', 'well meaning and kindly', 'adj.',
    'I am by nature benevolent and good', 4, now + DAY, 3, 2.6),
  V(2, 'wretched', 'miserable', 'new', 'in a very unhappy or unfortunate state', 'adj.',
    'I am a wretched creature, abandoned by all', null, null, 0, 2.5),
  V(3, 'countenance', 'face, expression', 'learning', 'the appearance or expression of the face', 'n.',
    'his countenance expressed the deepest dejection', 2, now - DAY, 2, 2.3),
  V(4, 'ardent', 'enthusiastic', 'known', 'enthusiastic or passionate', 'adj.',
    'my ardent curiosity was never satisfied', 12, now + 5 * DAY, 7, 2.8),
  V(5, 'solitude', 'being alone', 'known', 'the state of being alone', 'n.',
    'I sought solitude to escape my torment', 20, now + 12 * DAY, 9, 2.9),
  V(6, 'melancholy', 'deep sadness', 'learning', 'a feeling of pensive sadness', 'n.',
    'a melancholy seized him that nothing could dispel', 6, now + 2 * DAY, 4, 2.5),
  V(7, 'endeavour', 'an attempt', 'new', 'an earnest and conscientious attempt', 'n.',
    'I will endeavour to relate the events plainly', null, null, 1, 2.5),
  V(8, 'sublime', 'awe-inspiring', 'known', 'of such excellence as to inspire great admiration', 'adj.',
    'the sublime scenery of the Alps', 30, now + 20 * DAY, 11, 3),
  V(9, 'wretched', 'miserable', 'new', 'very unhappy', 'adj.', 'a wretched fate', null, null, 0, 2.5),
  V(10, 'forlorn', 'pitifully sad', 'learning', 'pitifully sad and abandoned', 'adj.',
    'he looked forlorn and alone in the cold', 3, now, 2, 2.4),
];

export const VOCAB_STATS: VocabStats = {
  total: VOCAB.length,
  byStatus: { new: 3, learning: 4, known: 3 },
  dueToday: 2, reviewsToday: 5, addedThisWeek: 3,
};

export const READING_STATS: ReadingStats = {
  rangeSeconds: 3 * 3600 + 42 * 60,
  byDay: [
    { date: '2026-09-15', seconds: 1420 }, { date: '2026-09-16', seconds: 2380 },
    { date: '2026-09-17', seconds: 900 }, { date: '2026-09-18', seconds: 3100 },
    { date: '2026-09-19', seconds: 1780 }, { date: '2026-09-20', seconds: 2640 },
    { date: '2026-09-21', seconds: 1190 },
  ],
  pagesTurned: 412, booksTouched: 4, streakDays: 6,
};

export const BOOK_STATS = {
  totalSeconds: 2 * 3600 + 15 * 60, pagesTurned: 188,
  firstOpenedAt: now - 30 * DAY, lastOpenedAt: now - 2 * 3600_000, progress: 0.42,
};

export const LANGS: Lang[] = [
  { code: 'auto', nameRu: 'Detect language' }, { code: 'en', nameRu: 'English' },
  { code: 'ru', nameRu: 'Russian' }, { code: 'de', nameRu: 'German' },
  { code: 'fr', nameRu: 'French' }, { code: 'es', nameRu: 'Spanish' },
  { code: 'it', nameRu: 'Italian' }, { code: 'pt', nameRu: 'Portuguese' },
  { code: 'uk', nameRu: 'Ukrainian' },
];

export const TRANSLATORS: TranslatorInfo[] = [
  { id: 'google', name: 'Google', kind: 'translate', needsConfig: false, configured: true },
  { id: 'lingva', name: 'Lingva', kind: 'translate', needsConfig: true, configured: false },
  { id: 'libre', name: 'LibreTranslate', kind: 'translate', needsConfig: true, configured: false },
  { id: 'dictionaryapi', name: 'DictionaryAPI', kind: 'dict', needsConfig: false, configured: true },
];

export const LOOKUP = {
  word: 'benevolent',
  translation: { translatedText: 'добрый, благородный', detectedSourceLang: 'en', targetLang: 'ru', providerId: 'google' },
  dictionary: {
    word: 'benevolent', transcription: '/bəˈnɛvələnt/',
    meanings: [
      { pos: 'adjective', definitions: [
        { definition: 'well meaning and kindly', example: 'a benevolent smile', synonyms: ['kind', 'kindly', 'good-natured'] },
        { definition: 'charitable', example: 'a benevolent fund', synonyms: ['charitable', 'altruistic'] },
      ] },
    ],
  },
  lookupCount: 3, suggestAdd: false, alreadyInVocab: true,
};

/** Inlined (not imported) to avoid a settingsStore → tauri → mock import cycle. */
export const SETTINGS: Settings = {
  ui: { themeId: 'light', customThemes: [], animations: true, autoHideChrome: true },
  page: {
    fontFamily: 'Serifa', fontSizePx: 19, fontWeight: 400, lineHeight: 1.65,
    letterSpacingEm: 0, textAlign: 'justify', paragraphIndentEm: 1.2, paragraphSpacingEm: 0.6,
    hyphenate: true, pageWidthPct: 100, scrollMaxWidthPx: 720,
    marginsPx: { top: 28, right: 40, bottom: 28, left: 40 },
    textColorOverride: null, backgroundColorOverride: null, linkColorOverride: null,
  },
  reading: { mode: 'paginated', pageTurn: 'slide', prefetch: true, wheelTurnsPage: true, clickZones: false },
  translate: {
    defaultProviderId: 'google', defaultTargetLang: 'ru', popupOnSelect: true,
    providers: { google: { enabled: true, baseUrl: null, apiKey: null } },
  },
  dictionary: { defaultProviderId: 'dictionaryapi' },
  vocab: { suggestAfterLookups: 3, dailyReviewLimit: 50 },
  library: { watchedDirs: ['/home/reader/Books'], view: 'grid', sort: 'lastOpened', sortDesc: true },
  shortcuts: {
    nextPage: 'Right', prevPage: 'Left', nextChapter: 'Ctrl+Right', prevChapter: 'Ctrl+Left',
    fontLarger: 'Ctrl+=', fontSmaller: 'Ctrl+-', search: 'Ctrl+F', toc: 'Ctrl+T',
    annotations: 'Ctrl+Shift+A', bookmark: 'Ctrl+D', translate: 'Ctrl+Shift+T',
    dictionary: 'Ctrl+Shift+D', addVocab: 'Ctrl+Shift+V', review: 'Ctrl+Shift+R',
    cycleTheme: 'Ctrl+J', toggleMode: 'Ctrl+Shift+M', hideChrome: 'Ctrl+H',
    fullscreen: 'F11', settings: 'Ctrl+,', backToLibrary: 'Ctrl+L', quit: 'Ctrl+Q',
  },
};

export const OPEN_BOOK = {
  book: { ...readerBook, toc: TOC, chapters: CHAPTERS },
  position: {
    cfi: 'epubcfi(/2/10)', chapterIdx: 5, pctWithinChapter: 0.3, pageIndex: 2, pageCount: 8,
    mode: 'paginated' as const, globalPct: 0.42, savedAt: now,
  },
  highlights: HIGHLIGHTS, notes: NOTES, bookmarks: BOOKMARKS,
  indexStatus: { state: 'ready' as const, chaptersDone: 24, chaptersTotal: 24 },
};
