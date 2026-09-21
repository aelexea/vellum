/**
 * SelectionToolbar (§8) — appears on selection, the six §5.4 actions, the contract v1.3
 * 4-arg addHighlight, and the note modal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import SelectionToolbar from '@/features/reader/SelectionToolbar';
import { useReaderStore } from '@/stores/readerStore';
import type { SelectionState } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';
import { HIGHLIGHT_COLORS } from '@/lib/themes';
import { mockBook } from '@/test/setup';
import type { OpenBook, VocabWord } from '@/lib/types';

function fakeBook(): OpenBook {
  return {
    book: {
      ...mockBook,
      toc: [],
      chapters: [
        { idx: 0, href: 'c0.xhtml', title: 'Глава 1', charCount: 100 },
        { idx: 1, href: 'c1.xhtml', title: 'Глава 2', charCount: 100 },
      ],
    },
    position: null,
    highlights: [], notes: [], bookmarks: [],
    indexStatus: { state: 'none', chaptersDone: 0, chaptersTotal: 0 },
  };
}

const SEL: SelectionState = {
  text: 'white rabbit',
  cfiStart: 'epubcfi(/4/2/1:0)',
  cfiEnd: 'epubcfi(/4/2/1:12)',
  rect: { x: 100, y: 200, width: 120, height: 18 },
  sentence: 'The white rabbit ran past.',
  word: undefined,
};

function seed(selection: SelectionState | null = SEL): void {
  useReaderStore.setState({
    book: fakeBook(), loading: false, chapterIdx: 1,
    pageIndex: 0, pageCount: 5, mode: 'paginated', pctWithinChapter: 0,
    selection, pendingTarget: null, lastCfi: null,
  } as never);
  useUiStore.setState({ view: 'reader', overlay: null, toasts: [] });
}

describe('SelectionToolbar visibility', () => {
  beforeEach(() => seed());
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing without a selection', () => {
    seed(null);
    render(<SelectionToolbar />);
    expect(screen.queryByTestId('selection-toolbar')).toBeNull();
  });

  it('appears once a selection is set (§8)', () => {
    seed(null);
    const { rerender } = render(<SelectionToolbar />);
    expect(screen.queryByTestId('selection-toolbar')).toBeNull();

    act(() => { useReaderStore.setState({ selection: SEL }); });
    rerender(<SelectionToolbar />);
    expect(screen.getByTestId('selection-toolbar')).toBeInTheDocument();
    expect(screen.getByRole('toolbar')).toHaveAccessibleName('Selection actions');
  });

  it('offers all six §5.4 actions', () => {
    render(<SelectionToolbar />);
    for (const label of ['Translate', 'Dictionary', 'Highlight', 'Note', 'Add to vocabulary', 'Copy']) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });
});

describe('SelectionToolbar actions', () => {
  beforeEach(() => seed());
  afterEach(() => vi.restoreAllMocks());

  it('Translate → uiStore overlay translate (§8)', async () => {
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Translate'));
    await waitFor(() => expect(useUiStore.getState().overlay).toBe('translate'));
  });

  it('Dictionary → readerStore.lookup with the selected word and sentence context', async () => {
    const lookup = vi.spyOn(useReaderStore.getState(), 'lookup').mockResolvedValue(undefined);
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Dictionary'));
    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    const [word, ctx] = lookup.mock.calls[0];
    expect(word).toBe('white rabbit');
    expect(ctx).toMatchObject({
      bookUid: mockBook.uid, chapterIdx: 1, cfi: 'epubcfi(/4/2/1:0)',
    });
  });

  it('Copy writes to the clipboard and toasts "Copied"', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, configurable: true, writable: true,
    });
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('white rabbit'));
    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.msg)).toContain('Copied');
    });
  });

  it('Add to vocabulary adds the prefilled word and clears the selection', async () => {
    const add = vi.spyOn(useVocabStore.getState(), 'add')
      .mockResolvedValue({ id: 9, word: 'white rabbit', ease: 2.5 } as VocabWord);
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Add to vocabulary'));
    await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(add.mock.calls[0][0]).toMatchObject({
      word: 'white rabbit',
      context: 'The white rabbit ran past.',
      contextCfi: 'epubcfi(/4/2/1:0)',
      bookUid: mockBook.uid,
      chapterIdx: 1,
    });
    await waitFor(() => {
      expect(useUiStore.getState().toasts.map((t) => t.msg)).toContain('Word added');
    });
  });
});

describe('SelectionToolbar highlight colours', () => {
  beforeEach(() => seed());
  afterEach(() => vi.restoreAllMocks());

  it('Highlight opens the 6-colour popover (§5.11 palette)', () => {
    render(<SelectionToolbar />);
    expect(screen.queryByTestId('color-dots')).toBeNull();
    fireEvent.click(screen.getByLabelText('Highlight'));
    expect(screen.getByTestId('color-dots')).toBeInTheDocument();
    expect(screen.getByTestId('color-dots').querySelectorAll('button')).toHaveLength(
      HIGHLIGHT_COLORS.length,
    );
  });

  it('picking a colour calls addHighlight with the contract v1.3 text arg', async () => {
    const addHighlight = vi.spyOn(useReaderStore.getState(), 'addHighlight')
      .mockResolvedValue(null);
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Highlight'));
    fireEvent.click(screen.getByLabelText(`Highlight in ${HIGHLIGHT_COLORS[0]}`));

    await waitFor(() => expect(addHighlight).toHaveBeenCalledTimes(1));
    expect(addHighlight).toHaveBeenCalledWith(
      'epubcfi(/4/2/1:0)', 'epubcfi(/4/2/1:12)', HIGHLIGHT_COLORS[0], 'white rabbit',
    );
  });

  it('"Remove" appears only when a highlight already covers this range', () => {
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Highlight'));
    expect(screen.queryByText('Remove')).toBeNull();

    act(() => {
      useReaderStore.setState((s) => ({
        book: {
          ...s.book!,
          highlights: [{
            id: 4, bookUid: mockBook.uid, chapterIdx: 1,
            cfiStart: 'epubcfi(/4/2/1:0)', cfiEnd: 'epubcfi(/4/2/1:12)',
            color: HIGHLIGHT_COLORS[0], createdAt: 1, text: 'white rabbit',
          } as never],
        },
      }));
    });
    expect(screen.getByText('Remove')).toBeInTheDocument();
  });

  it('"Remove" deletes the existing highlight', async () => {
    useReaderStore.setState((s) => ({
      book: {
        ...s.book!,
        highlights: [{
          id: 4, bookUid: mockBook.uid, chapterIdx: 1,
          cfiStart: 'epubcfi(/4/2/1:0)', cfiEnd: 'epubcfi(/4/2/1:12)',
          color: HIGHLIGHT_COLORS[0], createdAt: 1, text: 'white rabbit',
        } as never],
      },
    }));
    const removeHighlight = vi.spyOn(useReaderStore.getState(), 'removeHighlight')
      .mockResolvedValue(undefined);
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Highlight'));
    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => expect(removeHighlight).toHaveBeenCalledWith(4));
  });
});

describe('SelectionToolbar note modal', () => {
  beforeEach(() => seed());
  afterEach(() => vi.restoreAllMocks());

  it('Note opens the "Note" dialog with the quoted selection', () => {
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Note'));
    expect(screen.getByRole('dialog', { name: 'Note' })).toBeInTheDocument();
    expect(screen.getByText('white rabbit')).toBeInTheDocument();
    expect(screen.getByTestId('note-text')).toHaveValue('');
  });

  it('Save is disabled until there is text, then saves the note', async () => {
    const addNote = vi.spyOn(useReaderStore.getState(), 'addNote').mockResolvedValue(null);
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Note'));

    const save = screen.getByText('Save');
    expect(save).toBeDisabled();

    fireEvent.change(screen.getByTestId('note-text'), { target: { value: 'Моя заметка' } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);

    await waitFor(() => expect(addNote).toHaveBeenCalledWith(
      'epubcfi(/4/2/1:0)', 'epubcfi(/4/2/1:12)', 'white rabbit', 'Моя заметка',
    ));
    expect(screen.queryByRole('dialog', { name: 'Note' })).toBeNull();
  });

  it('Cancel closes the modal without saving', () => {
    const addNote = vi.spyOn(useReaderStore.getState(), 'addNote').mockResolvedValue(null);
    render(<SelectionToolbar />);
    fireEvent.click(screen.getByLabelText('Note'));
    fireEvent.change(screen.getByTestId('note-text'), { target: { value: 'черновик' } });
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByRole('dialog', { name: 'Note' })).toBeNull();
    expect(addNote).not.toHaveBeenCalled();
  });
});
