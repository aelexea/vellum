/**
 * INTEGRATION SEAM [F5 → F2/F0]: a jump publishes `vellum:find` (FIND_EVENT) on window so
 * ChapterFrame/engine can run the in-chapter findText + flashRange that panels cannot do.
 */
import type { SearchHit } from '@/lib/types';
import { useReaderStore } from '@/stores/readerStore';

/** Name of the CustomEvent the engine side should subscribe to. */
export const FIND_EVENT = 'vellum:find';

export interface FindDetail {
  /** Chapter the reader was just pointed at. */
  chapterIdx: number;
  /** Text to locate + flash inside the chapter (search hits: the matched phrase). */
  text?: string;
  /** Exact CFI when the source annotation has one — preferred over `text`. */
  cfi?: string;
}

let lastJumpQuery: string | null = null;
let lastJump: FindDetail | null = null;

/** Query text of the most recent jump (search query, or highlighted/selected text). */
export function getLastJumpQuery(): string | null {
  return lastJumpQuery;
}

/** Full detail of the most recent jump; null when nothing jumped yet. */
export function getLastJump(): FindDetail | null {
  return lastJump;
}

function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/…|\.\.\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The matched phrase of a backend snippet (§4.5/§5.6): everything from the first `<mark>`
 * to the last `</mark>`, tags stripped. Spanning the whole marked region keeps the separator
 * text of a multi-token AND query ("<mark>white</mark> <mark>rabbit</mark>" → "white rabbit"),
 * which is what engine.findText needs to locate and flash the hit. Falls back to the longest
 * plain run when the backend sent no <mark> at all.
 */
export function snippetToText(snippet: string): string {
  const open = snippet.search(/<mark[\s>]/i) >= 0
    ? snippet.search(/<mark[\s>]/i)
    : snippet.toLowerCase().indexOf('<mark');
  const close = snippet.toLowerCase().lastIndexOf('</mark>');
  if (open >= 0 && close > open) {
    const marked = plain(snippet.slice(open, close + '</mark>'.length));
    if (marked.length > 0) return marked;
  }
  // No usable mark: longest plain run is the best available guess.
  return snippet
    .split(/<\/?mark>/i)
    .map(plain)
    .filter((s) => s.length > 0)
    .reduce((longest, run) => (run.length > longest.length ? run : longest), '');
}

function publish(detail: FindDetail): void {
  lastJump = detail;
  window.dispatchEvent(new CustomEvent<FindDetail>(FIND_EVENT, { detail }));
}

/**
 * Jump to a search hit. SearchHit carries no CFI (§4.1), so navigation is chapter-level:
 * `gotoChapter` republishes readerStore.pendingTarget (ChapterFrame reacts to `seq`), then
 * FIND_EVENT asks the engine to find + flash the matched phrase inside that chapter.
 */
export function jumpToHit(hit: SearchHit, query?: string): void {
  const text = snippetToText(hit.snippet);
  lastJumpQuery = query?.trim() || text || null;
  useReaderStore.getState().gotoChapter(hit.chapterIdx);
  publish({ chapterIdx: hit.chapterIdx, text: text || undefined });
}

/**
 * Jump to an exact CFI (annotations: highlights, notes, bookmarks).
 * Crossing chapters goes through `gotoChapter` first because it flushes the debounced
 * position save of the chapter being left (§5.2); `gotoCfi(cfi, chapterIdx)` then publishes
 * pendingTarget {chapterIdx, cfi} — one navigation for ChapterFrame to resolve.
 */
export function jumpToCfiTarget(chapterIdx: number, cfi: string, text?: string): void {
  lastJumpQuery = text?.trim() || null;
  const reader = useReaderStore.getState();
  if (reader.chapterIdx !== chapterIdx) reader.gotoChapter(chapterIdx);
  reader.gotoCfi(cfi, chapterIdx);
  publish({ chapterIdx, cfi, text: text || undefined });
}
