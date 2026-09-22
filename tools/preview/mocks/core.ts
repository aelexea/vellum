/**
 * Mock @tauri-apps/api surface for the preview harness (aliased over the real
 * modules by vite.preview.config.ts). invoke() resolves from the fixture table;
 * listen() is a no-op — the preview is a still frame, not a live session.
 */
import * as data from './data';

const responses: Record<string, unknown> = {
  get_smoke_config: null,

  list_books: data.BOOKS,
  list_tags: data.TAGS,
  import_books: { imported: [], skipped: [], failed: [] },
  scan_directory: { imported: [], skipped: [], failed: [] },
  rescan_library: { imported: [], skipped: [], failed: [] },
  set_book_tags: undefined,
  delete_book: undefined,
  get_book: data.OPEN_BOOK.book,

  open_book: data.OPEN_BOOK,
  save_position: undefined,
  record_reading_tick: undefined,

  list_highlights: data.HIGHLIGHTS,
  add_highlight: data.HIGHLIGHTS[0],
  update_highlight: undefined,
  delete_highlight: undefined,
  list_notes: data.NOTES,
  add_note: data.NOTES[0],
  update_note: undefined,
  delete_note: undefined,
  list_bookmarks: data.BOOKMARKS,
  add_bookmark: data.BOOKMARKS[0],
  delete_bookmark: undefined,

  get_index_status: data.OPEN_BOOK.indexStatus,
  reindex_book: undefined,
  search_in_book: data.SEARCH_HITS,

  lookup_word: data.LOOKUP,
  list_vocab: data.VOCAB,
  add_vocab_word: data.VOCAB[0],
  update_vocab_word: data.VOCAB[0],
  delete_vocab_word: undefined,
  // Mirrors the backend queue rule: due (due_at <= now) or new-and-never-reviewed.
  get_review_queue: data.VOCAB.filter((v) => (v.dueAt !== null && v.dueAt <= 1_726_000_000_000) || (v.status === 'new' && v.dueAt === null)),
  record_review: data.VOCAB[0],
  vocab_stats: data.VOCAB_STATS,
  export_vocab: 10,
  import_vocab: 0,

  translate_text: data.LOOKUP.translation,
  detect_language: 'en',
  list_translators: data.TRANSLATORS,
  save_provider_config: undefined,
  test_provider: true,
  list_languages: data.LANGS,

  get_settings: data.SETTINGS,
  save_settings: data.SETTINGS,
  list_fonts: data.FONTS,
  export_settings: undefined,
  import_settings: data.SETTINGS,
  backup_db: undefined,
  export_annotations: 12,
  import_annotations: 0,
  get_app_paths: { dataDir: '/home/reader/.local/share/com.vellum.reader' },

  get_stats: data.READING_STATS,
  get_book_stats: data.BOOK_STATS,
};

const clone = (v: unknown): unknown =>
  v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));

// @tauri-apps/api/core
export async function invoke(cmd: string, _args?: unknown): Promise<unknown> {
  if (!(cmd in responses)) throw new Error(`[preview] unmocked invoke: ${cmd}`);
  return clone(responses[cmd]);
}

// @tauri-apps/api/event
export async function listen(_event: string, _handler: unknown): Promise<() => void> {
  return () => {};
}
export async function once(_event: string, _handler: unknown): Promise<() => void> {
  return () => {};
}
export async function emit(): Promise<void> {}

// @tauri-apps/plugin-dialog
export async function open(): Promise<string | null> { return null; }
export async function save(): Promise<string | null> { return null; }
export async function message(): Promise<void> {}
export async function ask(): Promise<boolean> { return true; }
export async function confirm(): Promise<boolean> { return true; }

// @tauri-apps/plugin-opener
export async function openPath(): Promise<void> {}
export async function openUrl(): Promise<void> {}
export async function revealItemInDir(): Promise<void> {}

// @tauri-apps/api/path
export async function appDataDir(): Promise<string> {
  return '/home/reader/.local/share/com.vellum.reader';
}
