/**
 * Typed wrappers over every backend command (§4.8) + events (§4.8) + dialog/opener helpers.
 * FROZEN (scaffold-FE). API per ARCHITECTURE.md §11.6.
 *
 * invoke command names are snake_case; arg objects are camelCase (Tauri 2 maps them to
 * Rust snake_case params automatically).
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as dialogOpen, save as dialogSave } from '@tauri-apps/plugin-dialog';
import { openPath as openerOpenPath, openUrl as openerOpenUrl } from '@tauri-apps/plugin-opener';
import type {
  BackendEventMap, BackendEventName,
  BookDetail, BookMeta, BookStats, Bookmark, FontFamily, Highlight,
  ImportReport, IndexStatus, Lang, LibraryFilter, LookupContext, LookupResult,
  Note, OpenBook, ProviderConfig, ReadingPosition, ReadingStats, SearchHit, Settings,
  Tag, TranslateResult, TranslatorInfo, VocabPatch, VocabStats, VocabWord, VocabWordInput,
  VocabWordStatus,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Smoke test config (tools/smoke.sh) — backend returns null unless VELLUM_SMOKE is set.
// ---------------------------------------------------------------------------

export type SmokeConfig = { book?: string; view?: string; overlay?: string; theme?: string };
export const getSmokeConfig = () => invoke<SmokeConfig | null>('get_smoke_config');

// ---------------------------------------------------------------------------
// library (§4.8)
// ---------------------------------------------------------------------------

export const importBooks = (paths: string[]) =>
  invoke<ImportReport>('import_books', { paths });

export const scanDirectory = (dir: string) =>
  invoke<ImportReport>('scan_directory', { dir });

export const rescanLibrary = () =>
  invoke<ImportReport>('rescan_library');

export const listBooks = (filter: LibraryFilter) =>
  invoke<BookMeta[]>('list_books', { filter });

export const listTags = () =>
  invoke<Tag[]>('list_tags');

export const setBookTags = (uid: string, tags: string[]) =>
  invoke<void>('set_book_tags', { uid, tags });

export const deleteBook = (uid: string, deleteFile: boolean) =>
  invoke<void>('delete_book', { uid, deleteFile });

export const getBook = (uid: string) =>
  invoke<BookDetail>('get_book', { uid });

// ---------------------------------------------------------------------------
// reader (§4.8)
// ---------------------------------------------------------------------------

export const openBook = (uid: string) =>
  invoke<OpenBook>('open_book', { uid });

export const savePosition = (uid: string, position: ReadingPosition) =>
  invoke<void>('save_position', { uid, position });

export const recordReadingTick = (uid: string, seconds: number, pagesTurned: number) =>
  invoke<void>('record_reading_tick', { uid, seconds, pagesTurned });

// ---------------------------------------------------------------------------
// annotations (§4.8)
// ---------------------------------------------------------------------------

export const listHighlights = (uid: string, chapterIdx: number | null) =>
  invoke<Highlight[]>('list_highlights', { uid, chapterIdx });

export const addHighlight = (
  bookUid: string, chapterIdx: number, cfiStart: string, cfiEnd: string, color: string, text: string,
) => invoke<Highlight>('add_highlight', { bookUid, chapterIdx, cfiStart, cfiEnd, color, text });

export const updateHighlight = (id: number, color: string) =>
  invoke<void>('update_highlight', { id, color });

export const deleteHighlight = (id: number) =>
  invoke<void>('delete_highlight', { id });

export const listNotes = (uid: string | null) =>
  invoke<Note[]>('list_notes', { uid });

export const addNote = (
  bookUid: string, chapterIdx: number, cfiStart: string, cfiEnd: string,
  selectedText: string, noteText: string,
) => invoke<Note>('add_note', { bookUid, chapterIdx, cfiStart, cfiEnd, selectedText, noteText });

export const updateNote = (id: number, noteText: string) =>
  invoke<void>('update_note', { id, noteText });

export const deleteNote = (id: number) =>
  invoke<void>('delete_note', { id });

export const listBookmarks = (uid: string | null) =>
  invoke<Bookmark[]>('list_bookmarks', { uid });

export const addBookmark = (bookUid: string, chapterIdx: number, cfi: string, label: string | null) =>
  invoke<Bookmark>('add_bookmark', { bookUid, chapterIdx, cfi, label });

export const deleteBookmark = (id: number) =>
  invoke<void>('delete_bookmark', { id });

// ---------------------------------------------------------------------------
// search (§4.8)
// ---------------------------------------------------------------------------

export const getIndexStatus = (uid: string) =>
  invoke<IndexStatus>('get_index_status', { uid });

export const reindexBook = (uid: string, force: boolean) =>
  invoke<void>('reindex_book', { uid, force });

export const searchInBook = (uid: string, query: string, limit: number | null = null) =>
  invoke<SearchHit[]>('search_in_book', { uid, query, limit });

// ---------------------------------------------------------------------------
// vocab (§4.8)
// ---------------------------------------------------------------------------

export const lookupWord = (word: string, context: LookupContext | null) =>
  invoke<LookupResult>('lookup_word', { word, context });

export const listVocab = (
  status: string | null, bookUid: string | null, query: string | null, dueOnly: boolean,
) => invoke<VocabWord[]>('list_vocab', { status, bookUid, query, dueOnly });

export const addVocabWord = (input: VocabWordInput) =>
  invoke<VocabWord>('add_vocab_word', {
    word: input.word,
    translation: input.translation ?? null,
    definition: input.definition ?? null,
    transcription: input.transcription ?? null,
    pos: input.pos ?? null,
    examples: input.examples ?? [],
    bookUid: input.bookUid ?? null,
    chapterIdx: input.chapterIdx ?? null,
    context: input.context ?? null,
    contextCfi: input.contextCfi ?? null,
    status: input.status ?? 'new',
  });

export const updateVocabWord = (id: number, patch: VocabPatch) =>
  invoke<VocabWord>('update_vocab_word', { id, patch });

export const deleteVocabWord = (id: number) =>
  invoke<void>('delete_vocab_word', { id });

export const getReviewQueue = (limit: number | null = null) =>
  invoke<VocabWord[]>('get_review_queue', { limit });

export const recordReview = (id: number, result: string) =>
  invoke<VocabWord>('record_review', { id, result });

export const vocabStats = () =>
  invoke<VocabStats>('vocab_stats');

export const exportVocab = (path: string, format: string) =>
  invoke<number>('export_vocab', { path, format });

export const importVocab = (path: string) =>
  invoke<number>('import_vocab', { path });

// ---------------------------------------------------------------------------
// translate (§4.8)
// ---------------------------------------------------------------------------

export const translateText = (text: string, from: string, to: string, providerId: string | null) =>
  invoke<TranslateResult>('translate_text', { text, from, to, providerId });

export const detectLanguage = (text: string) =>
  invoke<string>('detect_language', { text });

export const listTranslators = () =>
  invoke<TranslatorInfo[]>('list_translators');

export const saveProviderConfig = (providerId: string, cfg: ProviderConfig) =>
  invoke<void>('save_provider_config', { providerId, cfg });

export const testProvider = (providerId: string) =>
  invoke<boolean>('test_provider', { providerId });

export const listLanguages = () =>
  invoke<Lang[]>('list_languages');

// ---------------------------------------------------------------------------
// settings (§4.8)
// ---------------------------------------------------------------------------

export const getSettings = () =>
  invoke<Settings>('get_settings');

export const saveSettings = (patch: object) =>
  invoke<Settings>('save_settings', { patch });

export const listFonts = () =>
  invoke<FontFamily[]>('list_fonts');

export const exportSettings = (path: string) =>
  invoke<void>('export_settings', { path });

export const importSettings = (path: string) =>
  invoke<Settings>('import_settings', { path });

export const backupDb = (path: string) =>
  invoke<void>('backup_db', { path });

export const exportAnnotations = (uid: string | null, path: string, format: string) =>
  invoke<number>('export_annotations', { uid, path, format });

export const importAnnotations = (path: string) =>
  invoke<number>('import_annotations', { path });

// ---------------------------------------------------------------------------
// stats (§4.8)
// ---------------------------------------------------------------------------

export const getStats = (range: string) =>
  invoke<ReadingStats>('get_stats', { range });

export const getBookStats = (uid: string) =>
  invoke<BookStats>('get_book_stats', { uid });

// ---------------------------------------------------------------------------
// events (§4.8) — auto-unsubscribe returned as a promise per §11.6
// ---------------------------------------------------------------------------

/**
 * Subscribe to a backend event. Resolves to the unsubscribe function.
 * Typed overloads for the known events (§4.8), generic for anything else.
 */
export function onEvent<K extends BackendEventName>(
  name: K, cb: (payload: BackendEventMap[K]) => void,
): Promise<() => void>;
export function onEvent<T = unknown>(name: string, cb: (payload: T) => void): Promise<() => void>;
export function onEvent<T>(name: string, cb: (payload: T) => void): Promise<() => void> {
  return listen<T>(name, (event) => cb(event.payload)).then((unlisten) => () => unlisten());
}

// ---------------------------------------------------------------------------
// dialog helpers (plugin-dialog)
// ---------------------------------------------------------------------------

/** Multi-select .epub files. Resolves null when the dialog is cancelled. */
export async function openFiles(): Promise<string[] | null> {
  const picked = await dialogOpen({
    multiple: true,
    filters: [{ name: 'EPUB', extensions: ['epub'] }],
    title: 'Add books',
  });
  if (picked === null) return null;
  return Array.isArray(picked) ? picked : [picked];
}

/** Pick a directory. Resolves null when cancelled. */
export async function openDir(): Promise<string | null> {
  const picked = await dialogOpen({ directory: true, multiple: false, title: 'Scan folder' });
  if (picked === null) return null;
  return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}

export interface SaveFilter { name: string; extensions: string[] }

/** Save-file picker. Resolves null when cancelled. */
export async function saveFile(defaultName: string, filters?: SaveFilter[]): Promise<string | null> {
  return dialogSave({ defaultPath: defaultName, filters });
}

// ---------------------------------------------------------------------------
// opener helpers (plugin-opener)
// ---------------------------------------------------------------------------

export const openPath = (path: string): Promise<void> => openerOpenPath(path);
export const openUrl = (url: string): Promise<void> => openerOpenUrl(url);

/** Convenience alias for the vocab status type re-export. */
export type { VocabWordStatus };
