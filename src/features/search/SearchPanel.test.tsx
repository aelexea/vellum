/**
 * SearchPanel [F5] tests — §8: smoke render + key interactions with lib/tauri mocked.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { IndexStatus, OpenBook, SearchHit } from '@/lib/types';

/** vi.hoisted so the vi.mock factory (hoisted above imports) can reach the handler registry. */
const h = vi.hoisted(() => ({
  handlers: {} as Record<string, ((payload: never) => void)[]>,
}));

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>();
  return {
    ...actual,
    searchInBook: vi.fn(async () => [] as SearchHit[]),
    getIndexStatus: vi.fn(async (): Promise<IndexStatus> => ({
      state: 'ready', chaptersDone: 0, chaptersTotal: 0,
    })),
    reindexBook: vi.fn(async () => undefined),
    onEvent: vi.fn(async (name: string, cb: (payload: never) => void) => {
      (h.handlers[name] ??= []).push(cb);
      return () => {};
    }),
  };
});

import {
  getIndexStatus, onEvent, reindexBook, searchInBook,
} from '@/lib/tauri';
import SearchPanel from '@/features/search/SearchPanel';
import { FIND_EVENT, getLastJumpQuery, snippetToText } from '@/features/search/jump';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';

const mockSearch = vi.mocked(searchInBook);
const mockIndexStatus = vi.mocked(getIndexStatus);
const mockReindex = vi.mocked(reindexBook);
const mockOnEvent = vi.mocked(onEvent);

const UID = 'aaaa1111';
const OTHER_UID = 'bbbb2222';

function fakeBook(indexStatus: IndexStatus): OpenBook {
  return {
    book: {
      uid: UID, title: 'Франкенштейн', authors: ['Шелли'], path: '/tmp/f.epub',
      coverUrl: null, progress: 0.3, positionChapterIdx: 0, totalChapters: 3,
      addedAt: 1_700_000_000_000, lastOpenedAt: 1_700_000_000_000, tags: [],
      sizeBytes: 2048, missing: false,
      toc: [{ title: 'Начало', chapterIdx: 0, cfi: '/2', level: 1, parentIdx: null }],
      chapters: [
        { idx: 0, href: 'c0.xhtml', title: 'Глава 1', charCount: 100 },
        { idx: 1, href: 'c1.xhtml', title: null, charCount: 100 },
        { idx: 2, href: 'c2.xhtml', title: 'Финал', charCount: 100 },
      ],
    },
    position: null,
    highlights: [], notes: [], bookmarks: [],
    indexStatus,
  };
}

const READY: IndexStatus = { state: 'ready', chaptersDone: 3, chaptersTotal: 3 };

/** Seed the frozen stores the way readerStore.open() would. */
function seed(status: IndexStatus = READY): void {
  useReaderStore.setState({
    book: fakeBook(status),
    indexStatus: status,
    chapterIdx: 0,
    loading: false,
    pendingTarget: null,
    lastCfi: null,
  });
}

/** Fire a backend event into every handler registered for it. */
function emit(name: string, payload: unknown): void {
  for (const cb of h.handlers[name] ?? []) {
    act(() => { (cb as (p: unknown) => void)(payload); });
  }
}

const hit = (over: Partial<SearchHit> = {}): SearchHit => ({
  chapterIdx: 1, chapterTitle: '', snippet: 'a <mark>monster</mark> b', score: -1.2, ...over,
});

/** Snippet text as rendered, <mark> included (getByText cannot cross element boundaries). */
function snippetText(): string[] {
  return [...document.querySelectorAll('.vel-sp-snippet')].map((el) => el.textContent ?? '');
}

/** Advance past the 150 ms debounce and let promises settle. */
async function flushDebounce(ms = 150): Promise<void> {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await act(async () => { await Promise.resolve(); });
}

/**
 * setup.ts deliberately leaves localStorage undefined under Node 26 + jsdom, so install an
 * in-memory stub for the tests that exercise recent searches.
 */
const memoryStore: Record<string, string> = {};
beforeEach(() => {
  for (const k of Object.keys(memoryStore)) delete memoryStore[k];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => (k in memoryStore ? memoryStore[k] : null),
      setItem: (k: string, v: string) => { memoryStore[k] = String(v); },
      removeItem: (k: string) => { delete memoryStore[k]; },
      clear: () => { for (const k of Object.keys(memoryStore)) delete memoryStore[k]; },
      key: (i: number) => Object.keys(memoryStore)[i] ?? null,
      get length() { return Object.keys(memoryStore).length; },
    },
  });
});

describe('SearchPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.handlers = {};
    localStorage.clear();
    seed();
    useUiStore.setState({ overlay: 'search', view: 'reader', toasts: [] });
    mockSearch.mockResolvedValue([]);
    mockIndexStatus.mockResolvedValue({ state: 'ready', chaptersDone: 3, chaptersTotal: 3 });
  });

  afterEach(() => {
    cleanup();
    useReaderStore.getState().stopHeartbeat();
    useReaderStore.setState({ book: null, pendingTarget: null });
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('renders the standalone drawer with the 3-tab header and an autofocused input', async () => {
    await act(async () => { render(<SearchPanel />); });
    expect(screen.getByTestId('search-panel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Contents' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Search' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Notes' })).toBeInTheDocument();
    const input = screen.getByPlaceholderText('Search book');
    expect(input).toHaveFocus();
    // Empty query → hint + no results yet.
    expect(screen.getByText('Searches the whole book')).toBeInTheDocument();
    expect(screen.queryByText(/Found:/)).not.toBeInTheDocument();
  });

  it('switches drawer tabs through uiStore.setOverlay', async () => {
    await act(async () => { render(<SearchPanel />); });
    fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(useUiStore.getState().overlay).toBe('annotations');
    fireEvent.click(screen.getByRole('tab', { name: 'Contents' }));
    expect(useUiStore.getState().overlay).toBe('toc');
  });

  it('debounces 150 ms and calls searchInBook exactly once with the query', async () => {
    await act(async () => { render(<SearchPanel />); });
    const input = screen.getByPlaceholderText('Search book');
    fireEvent.change(input, { target: { value: 'mons' } });
    await flushDebounce(100);
    expect(mockSearch).not.toHaveBeenCalled();          // still inside the debounce window
    fireEvent.change(input, { target: { value: 'monster' } });
    await flushDebounce(149);
    expect(mockSearch).not.toHaveBeenCalled();          // retyped → timer restarted
    await flushDebounce(1);
    expect(mockSearch).toHaveBeenCalledTimes(1);
    expect(mockSearch).toHaveBeenCalledWith(UID, 'monster', null);
  });

  it('ignores a stale response (request-race guard)', async () => {
    let releaseFirst: (v: SearchHit[]) => void = () => {};
    const first = new Promise<SearchHit[]>((res) => { releaseFirst = res; });
    mockSearch
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce([hit({ snippet: 'newest <mark>hit</mark>' })]);

    await act(async () => { render(<SearchPanel />); });
    const input = screen.getByPlaceholderText('Search book');
    fireEvent.change(input, { target: { value: 'aaa' } });
    await flushDebounce();
    expect(mockSearch).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: 'bbb' } });
    await flushDebounce();
    expect(mockSearch).toHaveBeenCalledTimes(2);

    // The stale first response lands last and must be dropped.
    await act(async () => { releaseFirst([hit({ snippet: 'stale <mark>hit</mark>' })]); });
    expect(snippetText()).toEqual(['newest hit']);
    expect(document.querySelector('.vel-sp-snippet mark')?.textContent).toBe('hit');
  });

  it('renders results with the count line, chapter titles and <mark> snippets', async () => {
    mockSearch.mockResolvedValue([
      hit({ chapterIdx: 0, chapterTitle: 'Начало', snippet: 'the <mark>monster</mark> rose' }),
      hit({ chapterIdx: 1, chapterTitle: '', snippet: 'a <mark>monster</mark> too' }),
    ]);
    await act(async () => { render(<SearchPanel />); });
    fireEvent.change(screen.getByPlaceholderText('Search book'), { target: { value: 'monster' } });
    await flushDebounce();

    expect(screen.getByText('Found: 2')).toBeInTheDocument();
    expect(screen.getByText('Начало')).toBeInTheDocument();
    // Untitled chapter → "chapter {idx+1}" prefix (§5.6/§6.9).
    expect(screen.getByText('chapter 2')).toBeInTheDocument();

    const marks = document.querySelectorAll('.vel-sp-snippet mark');
    expect(marks).toHaveLength(2);
    expect(marks[0]?.textContent).toBe('monster');
  });

  it('shows "Nothing found" for zero results', async () => {
    mockSearch.mockResolvedValue([]);
    await act(async () => { render(<SearchPanel />); });
    fireEvent.change(screen.getByPlaceholderText('Search book'), { target: { value: 'zzz' } });
    await flushDebounce();
    expect(screen.getByText('Nothing found')).toBeInTheDocument();
  });

  it('jumps on hit click: gotoChapter + FIND_EVENT, closes the drawer, records the query', async () => {
    mockSearch.mockResolvedValue([hit({ chapterIdx: 2, snippet: 'a <mark>monster</mark> rose' })]);
    const gotoChapter = vi.spyOn(useReaderStore.getState(), 'gotoChapter');
    const details: unknown[] = [];
    const listener = (e: Event) => details.push((e as CustomEvent).detail);
    window.addEventListener(FIND_EVENT, listener);

    await act(async () => { render(<SearchPanel />); });
    fireEvent.change(screen.getByPlaceholderText('Search book'), { target: { value: 'monster' } });
    await flushDebounce();

    fireEvent.click(screen.getByText('chapter 3'));

    expect(gotoChapter).toHaveBeenCalledWith(2);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ chapterIdx: 2, text: 'monster' });
    expect(useUiStore.getState().overlay).toBeNull();
    expect(getLastJumpQuery()).toBe('monster');
    window.removeEventListener(FIND_EVENT, listener);
  });

  it('index none → "No index built" + build button → reindexBook(uid, true)', async () => {
    const none: IndexStatus = { state: 'none', chaptersDone: 0, chaptersTotal: 0 };
    seed(none);
    mockIndexStatus.mockResolvedValue(none);

    await act(async () => { render(<SearchPanel />); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('No index built')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Build index' }));
    expect(mockReindex).toHaveBeenCalledWith(UID, true);
    // Optimistically switches to the indexing state.
    expect(useReaderStore.getState().indexStatus.state).toBe('indexing');
  });

  it('indexing → spinner + "Indexing… {done}/{total}" updated live by index-progress', async () => {
    const indexing: IndexStatus = { state: 'indexing', chaptersDone: 4, chaptersTotal: 120 };
    seed(indexing);
    mockIndexStatus.mockResolvedValue(indexing);

    await act(async () => { render(<SearchPanel />); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('index-progress')).toBeInTheDocument();
    expect(screen.getByText('Indexing… 4/120')).toBeInTheDocument();
    expect(mockOnEvent).toHaveBeenCalledWith('index-progress', expect.any(Function));

    emit('index-progress', { bookUid: UID, done: 34, total: 120 });
    expect(screen.getByText('Indexing… 34/120')).toBeInTheDocument();

    // Progress for another book must be ignored.
    emit('index-progress', { bookUid: OTHER_UID, done: 99, total: 99 });
    expect(screen.getByText('Indexing… 34/120')).toBeInTheDocument();
  });

  it('index-done auto-runs the query typed while indexing', async () => {
    const indexing: IndexStatus = { state: 'indexing', chaptersDone: 0, chaptersTotal: 12 };
    seed(indexing);
    mockIndexStatus.mockResolvedValue(indexing);
    mockSearch.mockResolvedValue([hit({ snippet: 'late <mark>monster</mark>' })]);

    await act(async () => { render(<SearchPanel />); });
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByPlaceholderText('Search book'), { target: { value: 'monster' } });
    await flushDebounce();
    expect(screen.getByTestId('index-progress')).toBeInTheDocument();

    emit('index-done', { bookUid: UID });
    await act(async () => { await Promise.resolve(); });

    expect(useReaderStore.getState().indexStatus.state).toBe('ready');
    expect(snippetText()).toEqual(['late monster']);
    expect(mockSearch).toHaveBeenCalledWith(UID, 'monster', null);
  });

  it('index-error → "Indexing error" with a retry that reindexes', async () => {
    const err: IndexStatus = { state: 'error', chaptersDone: 0, chaptersTotal: 0 };
    seed(err);
    mockIndexStatus.mockResolvedValue(err);

    await act(async () => { render(<SearchPanel />); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('Indexing error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Build index' }));
    expect(mockReindex).toHaveBeenCalledTimes(1);
  });

  it('keeps up to 6 recent searches and refills the input from a chip', async () => {
    localStorage.setItem('vellum.search.recent', JSON.stringify(['альфа', 'бета']));
    mockSearch.mockResolvedValue([]);

    await act(async () => { render(<SearchPanel />); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText('Recent searches')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'альфа' }));
    await flushDebounce();

    expect(screen.getByPlaceholderText('Search book')).toHaveValue('альфа');
    expect(mockSearch).toHaveBeenCalledWith(UID, 'альфа', null);

    // The used query moves to the front of the persisted list.
    const stored = JSON.parse(localStorage.getItem('vellum.search.recent') ?? '[]');
    expect(stored[0]).toBe('альфа');
    expect(stored).toHaveLength(2);
  });

  it('caps the persisted recent list at 6 entries', async () => {
    mockSearch.mockResolvedValue([]);
    await act(async () => { render(<SearchPanel />); });
    await act(async () => { await Promise.resolve(); });

    for (const q of ['один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь']) {
      fireEvent.change(screen.getByPlaceholderText('Search book'), { target: { value: q } });
      await flushDebounce();
    }
    const stored = JSON.parse(localStorage.getItem('vellum.search.recent') ?? '[]');
    expect(stored).toHaveLength(6);
    expect(stored[0]).toBe('семь');
    expect(stored).not.toContain('один');
  });

  it('the clear button empties the input and drops the results', async () => {
    mockSearch.mockResolvedValue([hit()]);
    await act(async () => { render(<SearchPanel />); });
    fireEvent.change(screen.getByPlaceholderText('Search book'), { target: { value: 'monster' } });
    await flushDebounce();
    expect(screen.getByText('Found: 1')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Clear'));
    expect(screen.getByPlaceholderText('Search book')).toHaveValue('');
    expect(screen.queryByText('Found: 1')).not.toBeInTheDocument();
  });

  it('Esc clears the input first instead of closing the drawer', async () => {
    mockSearch.mockResolvedValue([hit()]);
    await act(async () => { render(<SearchPanel />); });
    fireEvent.change(screen.getByPlaceholderText('Search book'), { target: { value: 'monster' } });
    await flushDebounce();

    fireEvent.keyDown(window, { key: 'Escape' });
    // First Esc: input cleared, drawer stays open.
    expect(screen.getByPlaceholderText('Search book')).toHaveValue('');
    expect(useUiStore.getState().overlay).toBe('search');
  });

  it('refreshes the index status for the current book on mount', async () => {
    await act(async () => { render(<SearchPanel />); });
    await act(async () => { await Promise.resolve(); });
    expect(mockIndexStatus).toHaveBeenCalledWith(UID);
  });
});

describe('snippetToText (jump helper)', () => {
  it('returns the matched phrase, stripping tags and ellipsis context', () => {
    // Single token: only the match, not the surrounding context FTS5 pads with.
    expect(snippetToText('…the <mark>monster</mark> rose slowly…')).toBe('monster');
    // Multi-token AND query: the whole marked span, separators kept.
    expect(snippetToText('<mark>white</mark> <mark>rabbit</mark> sat')).toBe('white rabbit');
    expect(snippetToText('<mark>a</mark> longer <mark>tail here</mark>')).toBe('a longer tail here');
    expect(snippetToText('')).toBe('');
    expect(snippetToText('<mark></mark>')).toBe('');
    // No <mark> at all → longest plain run as a fallback.
    expect(snippetToText('short then a much longer run')).toBe('short then a much longer run');
  });
});
