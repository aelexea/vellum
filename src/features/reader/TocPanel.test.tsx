/**
 * TocPanel (§8) — the shared 3-tab drawer header (F5 seam), tree indentation by level,
 * current-chapter highlighting, and click → gotoCfi/gotoChapter + close.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// jsdom does not implement scrollIntoView; TocPanel calls it to reveal the active entry.
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

import TocPanel from '@/features/reader/TocPanel';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';
import { mockBook } from '@/test/setup';
import type { OpenBook, TocEntry } from '@/lib/types';

const TOC: TocEntry[] = [
  { title: 'Часть первая', chapterIdx: 0, cfi: null, level: 1, parentIdx: null },
  { title: 'Глава 1', chapterIdx: 0, cfi: 'epubcfi(/4/2)', level: 2, parentIdx: 0 },
  { title: 'Глава 2', chapterIdx: 1, cfi: 'epubcfi(/4/4)', level: 2, parentIdx: 0 },
  { title: 'Без cfi', chapterIdx: 2, cfi: null, level: 1, parentIdx: null },
];

function fakeBook(): OpenBook {
  return {
    book: {
      ...mockBook,
      toc: TOC,
      chapters: Array.from({ length: 3 }, (_, i) => ({
        idx: i, href: `c${i}.xhtml`, title: `Глава ${i + 1}`, charCount: 100,
      })),
    },
    position: null,
    highlights: [], notes: [], bookmarks: [],
    indexStatus: { state: 'none', chaptersDone: 0, chaptersTotal: 0 },
  } as OpenBook & { book: OpenBook['book'] };
}

function seed(chapterIdx: number): void {
  useReaderStore.setState({
    book: fakeBook(), loading: false, chapterIdx,
    pageIndex: 0, pageCount: 0, mode: 'paginated', pctWithinChapter: 0,
    selection: null, pendingTarget: null, lastCfi: null,
  } as never);
  useUiStore.setState({ view: 'reader', overlay: 'toc' });
}

describe('TocPanel shared tab header (F5 seam)', () => {
  beforeEach(() => seed(1));
  afterEach(() => vi.restoreAllMocks());

  it('renders the three drawer tabs with "Contents" active', () => {
    render(<TocPanel />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Contents', 'Search', 'Notes']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('uses the same class names as SearchPanel/AnnotationsPanel so drawers do not jump', () => {
    render(<TocPanel />);
    expect(document.querySelector('.vel-sp-tabs')).not.toBeNull();
    expect(document.querySelectorAll('.vel-sp-tab')).toHaveLength(3);
  });

  it('switching a tab changes uiStore.overlay', () => {
    render(<TocPanel />);
    fireEvent.click(screen.getAllByRole('tab')[1]);
    expect(useUiStore.getState().overlay).toBe('search');
    fireEvent.click(screen.getAllByRole('tab')[2]);
    expect(useUiStore.getState().overlay).toBe('annotations');
  });

  it('the close button clears the overlay', () => {
    render(<TocPanel />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(useUiStore.getState().overlay).toBeNull();
  });
});

describe('TocPanel tree', () => {
  beforeEach(() => seed(1));
  afterEach(() => vi.restoreAllMocks());

  it('renders every entry', () => {
    render(<TocPanel />);
    expect(screen.getAllByTestId('toc-entry')).toHaveLength(TOC.length);
    expect(screen.getByText('Часть первая')).toBeInTheDocument();
    expect(screen.getByText('Без cfi')).toBeInTheDocument();
  });

  it('indents by (level - 1) * 16 px', () => {
    render(<TocPanel />);
    const entries = screen.getAllByTestId('toc-entry');
    // level 1 → 12 px base; level 2 → 12 + 16 = 28 px.
    expect(entries[0]).toHaveStyle({ paddingLeft: '12px' });
    expect(entries[1]).toHaveStyle({ paddingLeft: '28px' });
    expect(entries[2]).toHaveStyle({ paddingLeft: '28px' });
    expect(entries[3]).toHaveStyle({ paddingLeft: '12px' });
  });

  it('marks level-1 entries semibold via data-level', () => {
    render(<TocPanel />);
    const entries = screen.getAllByTestId('toc-entry');
    expect(entries[0]).toHaveAttribute('data-level', '1');
    expect(entries[1]).toHaveAttribute('data-level', '2');
  });

  it('highlights every entry of the current chapter, not just the first', () => {
    seed(0);
    render(<TocPanel />);
    const entries = screen.getAllByTestId('toc-entry');
    // Chapter 0 owns «Часть первая» (level 1) and «Глава 1» (level 2).
    expect(entries[0]).toHaveAttribute('data-active', 'true');
    expect(entries[1]).toHaveAttribute('data-active', 'true');
    expect(entries[2]).toHaveAttribute('data-active', 'false');
  });

  it('clicking an entry with a cfi calls gotoCfi and closes the drawer', () => {
    const gotoCfi = vi.spyOn(useReaderStore.getState(), 'gotoCfi').mockImplementation(() => {});
    render(<TocPanel />);
    fireEvent.click(screen.getByText('Глава 1'));
    expect(gotoCfi).toHaveBeenCalledWith('epubcfi(/4/2)', 0);
    expect(useUiStore.getState().overlay).toBeNull();
  });

  it('clicking an entry without a cfi falls back to gotoChapter', () => {
    const gotoChapter = vi.spyOn(useReaderStore.getState(), 'gotoChapter').mockImplementation(() => {});
    render(<TocPanel />);
    fireEvent.click(screen.getByText('Без cfi'));
    expect(gotoChapter).toHaveBeenCalledWith(2);
    expect(useUiStore.getState().overlay).toBeNull();
  });

  it('falls back to "chapter N" when an entry has no title', () => {
    useReaderStore.setState((s) => ({
      book: {
        ...s.book!,
        book: {
          ...s.book!.book,
          toc: [{ title: '', chapterIdx: 1, cfi: null, level: 1, parentIdx: null }],
        },
      },
    }));
    render(<TocPanel />);
    expect(screen.getByText('chapter 2')).toBeInTheDocument();
  });

  it('shows an empty state when the book has no TOC', () => {
    useReaderStore.setState((s) => ({
      book: { ...s.book!, book: { ...s.book!.book, toc: [] } },
    }));
    render(<TocPanel />);
    expect(screen.getByText('Contents are empty')).toBeInTheDocument();
    expect(screen.queryAllByTestId('toc-entry')).toHaveLength(0);
  });
});
