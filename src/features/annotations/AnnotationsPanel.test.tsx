/**
 * AnnotationsPanel [F5] tests — §8: tabs, grouping, recolor, note edit/delete, jump seam.
 *
 * The frozen readerStore CRUD passthroughs are spied on WITHOUT stubbing, so the real
 * implementation still runs (lib/tauri is mocked by src/test/setup.ts) and the local
 * book.highlights/notes/bookmarks arrays stay in sync — that sync is part of what's asserted.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Bookmark, Highlight, Note, OpenBook } from '@/lib/types';
import AnnotationsPanel from '@/features/annotations/AnnotationsPanel';
import { FIND_EVENT } from '@/features/search/jump';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';

const UID = 'aaaa1111';
const OTHER_UID = 'bbbb2222';
const T0 = 1_700_000_000_000;

const HL_A: Highlight = {
  id: 11, bookUid: UID, chapterIdx: 0, cfiStart: 'epubcfi(/4/2/2/1:4)',
  cfiEnd: 'epubcfi(/4/2/2/1:20)', color: '#ffe08a', text: '', createdAt: T0, hasNote: true,
};
const HL_B: Highlight = {
  id: 12, bookUid: UID, chapterIdx: 2, cfiStart: 'epubcfi(/4/2/6/1:0)',
  cfiEnd: 'epubcfi(/4/2/6/1:9)', color: '#a8e6a3', text: 'a cold piece of meat', createdAt: T0 + 1000, hasNote: false,
};
/** Shares HL_A's range → supplies the highlight row's quoted text. */
const NOTE_LINKED: Note = {
  id: 21, bookUid: UID, chapterIdx: 0, cfiStart: HL_A.cfiStart, cfiEnd: HL_A.cfiEnd,
  selectedText: 'the monster rose', noteText: 'Первая встреча', createdAt: T0, updatedAt: T0,
};
const NOTE_FREE: Note = {
  id: 22, bookUid: UID, chapterIdx: 1, cfiStart: 'epubcfi(/4/2/4/1:2)',
  cfiEnd: 'epubcfi(/4/2/4/1:8)', selectedText: 'a lonely spark',
  noteText: 'Отдельная заметка без выделения', createdAt: T0, updatedAt: T0 + 500,
};
/** Other book → must be filtered out of every tab. */
const NOTE_OTHER: Note = {
  id: 23, bookUid: OTHER_UID, chapterIdx: 0, cfiStart: 'epubcfi(/4/2/2/1:1)',
  cfiEnd: 'epubcfi(/4/2/2/1:2)', selectedText: 'чужой текст',
  noteText: 'ЧУЖАЯ_ЗАМЕТКА', createdAt: T0, updatedAt: T0,
};
const BM_A: Bookmark = {
  id: 31, bookUid: UID, chapterIdx: 0, cfi: 'epubcfi(/4/2/2/1:4)', label: null, createdAt: T0,
};
const BM_B: Bookmark = {
  id: 32, bookUid: UID, chapterIdx: 2, cfi: 'epubcfi(/4/2/6/1:0)',
  label: 'Важное место', createdAt: Date.now() - 86_400_000,
};
const BM_OTHER: Bookmark = {
  id: 33, bookUid: OTHER_UID, chapterIdx: 0, cfi: 'epubcfi(/4/2/2/1:9)',
  label: null, createdAt: T0,
};
const HL_OTHER: Highlight = {
  id: 13, bookUid: OTHER_UID, chapterIdx: 0, cfiStart: 'epubcfi(/4/2/2/1:1)',
  cfiEnd: 'epubcfi(/4/2/2/1:2)', color: '#9ecbf5', text: 'чужое выделение', createdAt: T0, hasNote: false,
};

function fakeBook(over: Partial<OpenBook> = {}): OpenBook {
  return {
    book: {
      uid: UID, title: 'Франкенштейн', authors: ['Шелли'], path: '/tmp/f.epub',
      coverUrl: null, progress: 0.3, positionChapterIdx: 0, totalChapters: 3,
      addedAt: T0, lastOpenedAt: T0, tags: [], sizeBytes: 2048, missing: false,
      toc: [{ title: 'Начало', chapterIdx: 0, cfi: '/2', level: 1, parentIdx: null }],
      chapters: [
        { idx: 0, href: 'c0.xhtml', title: 'Глава 1', charCount: 100 },
        { idx: 1, href: 'c1.xhtml', title: null, charCount: 100 },
        { idx: 2, href: 'c2.xhtml', title: 'Финал', charCount: 100 },
      ],
    },
    position: null,
    highlights: [HL_A, HL_B, HL_OTHER],
    notes: [NOTE_LINKED, NOTE_FREE, NOTE_OTHER],
    bookmarks: [BM_A, BM_B, BM_OTHER],
    indexStatus: { state: 'ready', chaptersDone: 3, chaptersTotal: 3 },
    ...over,
  };
}

function seed(over: Partial<OpenBook> = {}): void {
  useReaderStore.setState({
    book: fakeBook(over),
    indexStatus: { state: 'ready', chaptersDone: 3, chaptersTotal: 3 },
    chapterIdx: 0, loading: false, pendingTarget: null, lastCfi: null,
  });
}

async function mount(): Promise<void> {
  await act(async () => { render(<AnnotationsPanel />); });
}

/**
 * Both the drawer header and the type Segmented expose role="tab", and both have a "Notes"
 * tab — so every lookup is scoped to its own tablist by aria-label.
 */
function drawerTab(name: string): HTMLElement {
  return within(screen.getByRole('tablist', { name: 'Reading panels' })).getByRole('tab', { name });
}

function segTab(name: RegExp): HTMLElement {
  return within(screen.getByRole('tablist', { name: 'Annotation types' })).getByRole('tab', { name });
}

function switchTab(name: RegExp): void {
  act(() => { fireEvent.click(segTab(name)); });
}

function groupHeaders(): string[] {
  return screen.queryAllByTestId('chapter-group')
    .map((el) => el.querySelector('.vel-ap-group')?.textContent ?? '');
}

describe('AnnotationsPanel', () => {
  beforeEach(() => {
    seed();
    useUiStore.setState({ overlay: 'annotations', view: 'reader', toasts: [], pendingConfirm: null });
    // Note deletion asks for confirmation; auto-accept it.
    vi.spyOn(useUiStore.getState(), 'confirm').mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
    useReaderStore.getState().stopHeartbeat();
    useReaderStore.setState({ book: null, pendingTarget: null });
    useUiStore.setState({ pendingConfirm: null });
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('renders the standalone drawer, the 3-tab header and the type Segmented', async () => {
    await mount();
    expect(screen.getByTestId('annotations-panel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Contents' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Search' })).toBeInTheDocument();
    expect(drawerTab('Notes')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tablist', { name: 'Annotation types' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Highlights/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches drawer tabs through uiStore.setOverlay', async () => {
    await mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Search' }));
    expect(useUiStore.getState().overlay).toBe('search');
    fireEvent.click(screen.getByRole('tab', { name: 'Contents' }));
    expect(useUiStore.getState().overlay).toBe('toc');
  });

  it('switches Segmented tabs and shows per-type counts of the CURRENT book only', async () => {
    await mount();
    // 2 own highlights (the OTHER_UID one is excluded).
    expect(segTab(/Highlights/).textContent).toContain('2');
    switchTab(/Notes/);
    expect(screen.getAllByTestId('note-row')).toHaveLength(2);
    expect(screen.queryByTestId('highlight-row')).not.toBeInTheDocument();

    switchTab(/Bookmarks/);
    expect(screen.getAllByTestId('bookmark-row')).toHaveLength(2);
    expect(screen.queryByTestId('note-row')).not.toBeInTheDocument();

    switchTab(/Highlights/);
    expect(screen.getAllByTestId('highlight-row')).toHaveLength(2);
  });

  it('never shows another book’s annotations', async () => {
    await mount();
    expect(screen.queryByText('ЧУЖАЯ_ЗАМЕТКА')).not.toBeInTheDocument();
    switchTab(/Notes/);
    expect(screen.queryByText('ЧУЖАЯ_ЗАМЕТКА')).not.toBeInTheDocument();
    expect(screen.queryByText('чужой текст')).not.toBeInTheDocument();
    switchTab(/Bookmarks/);
    expect(screen.getAllByTestId('bookmark-row')).toHaveLength(2);
  });

  it('groups highlights by chapter with "Chapter {idx+1} · {tocTitle}" headers', async () => {
    await mount();
    // Chapter 0 has a TOC title; chapter 2 falls back to chapters[].title.
    expect(groupHeaders()).toEqual(['Chapter 1 · Начало', 'Chapter 3 · Финал']);
    const groups = screen.getAllByTestId('chapter-group');
    expect(groups[0]?.querySelectorAll('[data-testid="highlight-row"]')).toHaveLength(1);
    expect(groups[1]?.querySelectorAll('[data-testid="highlight-row"]')).toHaveLength(1);
  });

  it('shows the highlight colour bar and the quote from the note covering the same range', async () => {
    await mount();
    const bars = screen.getAllByTestId('highlight-bar');
    expect(bars[0]).toHaveStyle({ background: '#ffe08a' });
    expect(bars[1]).toHaveStyle({ background: '#a8e6a3' });
    // HL_A has a linked note → its selectedText is the quoted line.
    expect(screen.getByText('“the monster rose”')).toBeInTheDocument();
    // HL_B has no text source (§4.1 Highlight carries no text) → placeholder.
    expect(screen.getByText('Highlight')).toBeInTheDocument();
  });

  it('recolors a highlight from the 6-dot popover → updateHighlight(id, color)', async () => {
    const spy = vi.spyOn(useReaderStore.getState(), 'updateHighlight');
    await mount();

    fireEvent.click(screen.getAllByLabelText('Highlight color')[0] as HTMLElement);
    const dots = HIGHLIGHT_DOT_LABELS.map((label) => screen.queryByLabelText(label));
    expect(dots.filter(Boolean)).toHaveLength(6);

    fireEvent.click(screen.getByLabelText('Color #9ecbf5') as HTMLElement);

    expect(spy).toHaveBeenCalledWith(11, '#9ecbf5');
    await act(async () => { await Promise.resolve(); });
    // The frozen store syncs the local array, so the bar repaints.
    const hl = useReaderStore.getState().book?.highlights.find((h) => h.id === 11);
    expect(hl?.color).toBe('#9ecbf5');
    expect(screen.getAllByTestId('highlight-bar')[0]).toHaveStyle({ background: '#9ecbf5' });
  });

  it('deletes a highlight without confirmation → removeHighlight(id)', async () => {
    const spy = vi.spyOn(useReaderStore.getState(), 'removeHighlight');
    await mount();
    expect(screen.getAllByTestId('highlight-row')).toHaveLength(2);

    fireEvent.click(screen.getAllByLabelText('Delete')[0] as HTMLElement);
    await act(async () => { await Promise.resolve(); });

    expect(spy).toHaveBeenCalledWith(11);
    expect(screen.getAllByTestId('highlight-row')).toHaveLength(1);
    expect(useUiStore.getState().confirm).not.toHaveBeenCalled();
  });

  it('jumps from a highlight: gotoChapter for the cross-chapter case + gotoCfi + FIND_EVENT', async () => {
    const gotoChapter = vi.spyOn(useReaderStore.getState(), 'gotoChapter');
    const gotoCfi = vi.spyOn(useReaderStore.getState(), 'gotoCfi');
    const details: unknown[] = [];
    const listener = (e: Event) => details.push((e as CustomEvent).detail);
    window.addEventListener(FIND_EVENT, listener);

    await mount();
    const groups = screen.getAllByTestId('chapter-group');
    fireEvent.click(groups[1]!.querySelector('[data-testid="highlight-row"]') as HTMLElement);

    // The seeded reader sits in chapter 0; the hit is in chapter 2 → chapter jump first.
    expect(gotoChapter).toHaveBeenCalledWith(2);
    expect(gotoCfi).toHaveBeenCalledWith(HL_B.cfiStart, 2);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatchObject({ chapterIdx: 2, cfi: HL_B.cfiStart });
    expect(useUiStore.getState().overlay).toBeNull();
    // pendingTarget is what ChapterFrame consumes (§5.2).
    expect(useReaderStore.getState().pendingTarget).toMatchObject({
      chapterIdx: 2, cfi: HL_B.cfiStart,
    });

    window.removeEventListener(FIND_EVENT, listener);
  });

  it('jumps within the current chapter without a redundant gotoChapter', async () => {
    useReaderStore.setState({ chapterIdx: 0 });
    const gotoChapter = vi.spyOn(useReaderStore.getState(), 'gotoChapter');
    const gotoCfi = vi.spyOn(useReaderStore.getState(), 'gotoCfi');
    await mount();

    fireEvent.click(screen.getAllByTestId('highlight-row')[0] as HTMLElement);
    expect(gotoChapter).not.toHaveBeenCalled();
    expect(gotoCfi).toHaveBeenCalledWith(HL_A.cfiStart, 0);
  });

  it('edits a note in the modal → updateNote(id, text)', async () => {
    const spy = vi.spyOn(useReaderStore.getState(), 'updateNote');
    await mount();
    switchTab(/Notes/);

    const rows = screen.getAllByTestId('note-row');
    fireEvent.click(rows[0]!.querySelector('[aria-label="Edit note"]') as HTMLElement);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const textarea = screen.getByLabelText('Note text') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Первая встреча');
    fireEvent.change(textarea, { target: { value: '  Обновлённый текст  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => { await Promise.resolve(); });

    // Trimmed on save (§5.6), routed through the frozen passthrough.
    expect(spy).toHaveBeenCalledWith(21, 'Обновлённый текст');
    expect(useReaderStore.getState().book?.notes.find((n) => n.id === 21)?.noteText)
      .toBe('Обновлённый текст');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancelling the note modal leaves the note untouched', async () => {
    const spy = vi.spyOn(useReaderStore.getState(), 'updateNote');
    await mount();
    switchTab(/Notes/);

    const rows = screen.getAllByTestId('note-row');
    fireEvent.click(rows[0]!.querySelector('[aria-label="Edit note"]') as HTMLElement);
    fireEvent.change(screen.getByLabelText('Note text'), { target: { value: 'черновик' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(spy).not.toHaveBeenCalled();
    expect(useReaderStore.getState().book?.notes.find((n) => n.id === 21)?.noteText)
      .toBe('Первая встреча');
  });

  it('confirms before deleting a note → removeNote(id)', async () => {
    const spy = vi.spyOn(useReaderStore.getState(), 'removeNote');
    await mount();
    switchTab(/Notes/);
    expect(screen.getAllByTestId('note-row')).toHaveLength(2);

    const rows = screen.getAllByTestId('note-row');
    fireEvent.click(rows[0]!.querySelector('[aria-label="Delete note"]') as HTMLElement);
    await act(async () => { await Promise.resolve(); });

    expect(useUiStore.getState().confirm).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Delete note?', danger: true, confirmLabel: 'Delete' }),
    );
    expect(spy).toHaveBeenCalledWith(21);
    expect(screen.getAllByTestId('note-row')).toHaveLength(1);
  });

  it('does not delete the note when the confirm dialog is dismissed', async () => {
    vi.spyOn(useUiStore.getState(), 'confirm').mockResolvedValue(false);
    const spy = vi.spyOn(useReaderStore.getState(), 'removeNote');
    await mount();
    switchTab(/Notes/);

    const rows = screen.getAllByTestId('note-row');
    fireEvent.click(rows[0]!.querySelector('[aria-label="Delete note"]') as HTMLElement);
    await act(async () => { await Promise.resolve(); });

    expect(spy).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('note-row')).toHaveLength(2);
  });

  it('shows quote, note text and a formatted date on note rows', async () => {
    await mount();
    switchTab(/Notes/);
    expect(screen.getByText('“a lonely spark”')).toBeInTheDocument();
    expect(screen.getByText('Отдельная заметка без выделения')).toBeInTheDocument();
    // fmtDate of a 2023 timestamp → "Nov 14 2023".
    expect(screen.getAllByText(/Nov/).length).toBeGreaterThan(0);
  });

  it('renders bookmark labels, "Bookmark" fallback and a relative date; delete → removeBookmark', async () => {
    const spy = vi.spyOn(useReaderStore.getState(), 'removeBookmark');
    await mount();
    switchTab(/Bookmarks/);

    expect(screen.getByText('Важное место')).toBeInTheDocument();
    expect(screen.getByText('Bookmark')).toBeInTheDocument();
    expect(screen.getByText('yesterday')).toBeInTheDocument();

    fireEvent.click(screen.getAllByLabelText('Delete bookmark')[0] as HTMLElement);
    await act(async () => { await Promise.resolve(); });
    expect(spy).toHaveBeenCalledWith(31);
    expect(screen.getAllByTestId('bookmark-row')).toHaveLength(1);
  });

  it('jumps from a bookmark to its exact cfi', async () => {
    const details: unknown[] = [];
    const listener = (e: Event) => details.push((e as CustomEvent).detail);
    window.addEventListener(FIND_EVENT, listener);
    await mount();
    switchTab(/Bookmarks/);

    fireEvent.click(screen.getByText('Важное место'));
    expect(details[0]).toMatchObject({ chapterIdx: 2, cfi: BM_B.cfi });
    expect(useUiStore.getState().overlay).toBeNull();
    window.removeEventListener(FIND_EVENT, listener);
  });

  it('shows the per-tab empty states with their hints', async () => {
    seed({ highlights: [], notes: [], bookmarks: [] });
    await mount();
    expect(screen.getByText('No highlights')).toBeInTheDocument();
    expect(screen.getByText('Select text while reading')).toBeInTheDocument();
    expect(screen.queryByTestId('chapter-group')).not.toBeInTheDocument();

    switchTab(/Notes/);
    expect(screen.getByText('No notes')).toBeInTheDocument();

    switchTab(/Bookmarks/);
    expect(screen.getByText('No bookmarks')).toBeInTheDocument();
    expect(screen.getByText(/Press Ctrl\+D while reading/)).toBeInTheDocument();
  });

  it('counts drop to zero and the empty state appears after the last row is deleted', async () => {
    seed({ highlights: [HL_A], notes: [], bookmarks: [] });
    await mount();
    expect(segTab(/Highlights/).textContent).toContain('1');
    expect(screen.getAllByTestId('highlight-row')).toHaveLength(1);

    fireEvent.click(screen.getByLabelText('Delete'));
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByTestId('highlight-row')).not.toBeInTheDocument();
    expect(screen.getByText('No highlights')).toBeInTheDocument();
    expect(segTab(/Highlights/).textContent).toContain('0');
  });

  it('renders nothing but a safe panel when no book is open', async () => {
    useReaderStore.setState({ book: null });
    await mount();
    expect(screen.getByTestId('annotations-panel')).toBeInTheDocument();
    expect(screen.getByText('No highlights')).toBeInTheDocument();
    expect(screen.queryByTestId('highlight-row')).not.toBeInTheDocument();
  });

  it('groups notes by chapter too', async () => {
    await mount();
    switchTab(/Notes/);
    // Chapter 0 (linked note) and chapter 1 (free note); chapter 1 has no title anywhere.
    expect(groupHeaders()).toEqual(['Chapter 1 · Начало', 'Chapter 2']);
  });
});

/** §5.11 frozen highlight palette → the popover dot labels asserted above. */
const HIGHLIGHT_DOT_LABELS = [
  'Color #ffe08a', 'Color #a8e6a3', 'Color #9ecbf5',
  'Color #f5a9c0', 'Color #cdb4f6', 'Color #f7c78e',
];
