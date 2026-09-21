/**
 * VocabView + WordEditor tests — [F4] §8.
 * Seeds responses via the harness (mockCommand); asserts against invokeCalls and spies
 * on uiStore.openBook / readerStore.gotoCfi for the context-jump flow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import VocabView, { fmtDue, sortWords } from '@/features/vocab/VocabView';
import type { VocabStats, VocabWord } from '@/lib/types';
import { invokeCalls, mockCommand } from '@/test/setup';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';
import { EMPTY_VOCAB_STATS, useVocabStore } from '@/stores/vocabStore';

const DAY = 86_400_000;

function word(p: Partial<VocabWord> & { id: number; word: string }): VocabWord {
  return {
    translation: null, definition: null, transcription: null, pos: null, examples: [],
    bookUid: null, bookTitle: null, chapterIdx: null, context: null, contextCfi: null,
    addedAt: Date.now(), status: 'new', reviewCount: 0, intervalDays: null, dueAt: null,
    lastReviewedAt: null, ease: 2.5, ...p,
  };
}

const seedWords: VocabWord[] = [
  word({
    id: 1, word: 'serendipity', transcription: '[ˌserənˈdɪpəti]', translation: 'интуитивная прозорливость',
    context: 'A happy serendipity.', contextCfi: 'epubcfi(/4/2/6)', bookUid: 'aaaa1111',
    bookTitle: 'Тестовая книга', chapterIdx: 2, status: 'new', addedAt: 100,
  }),
  word({
    id: 2, word: 'abyss', translation: 'бездна', status: 'learning',
    dueAt: Date.now() - 3600_000, intervalDays: 4, reviewCount: 2, addedAt: 200,
  }),
];

const seedStats: VocabStats = {
  ...EMPTY_VOCAB_STATS,
  total: 2, byStatus: { new: 1, learning: 1, known: 0 }, dueToday: 3,
};

function seed({ words = seedWords, stats = seedStats }: { words?: VocabWord[]; stats?: VocabStats } = {}) {
  mockCommand('list_vocab', (args: { status?: string | null; query?: string | null; bookUid?: string | null }) => {
    let out = words;
    if (args.status) out = out.filter((w) => w.status === args.status);
    if (args.query) out = out.filter((w) => w.word.includes(args.query!));
    return out;
  });
  mockCommand('vocab_stats', stats);
}

beforeEach(() => {
  cleanup();
  useVocabStore.setState({
    words: [], queue: [], queuePos: 0, stats: EMPTY_VOCAB_STATS,
    filters: { status: null, bookUid: null, query: null, dueOnly: false }, loading: false,
  });
  useUiStore.setState({ toasts: [], overlay: null, pendingConfirm: null });
});

describe('VocabView', () => {
  it('renders word rows with transcription, translation and due label', async () => {
    seed();
    render(<VocabView />);

    expect(await screen.findByText('serendipity')).toBeInTheDocument();
    expect(screen.getByText('[ˌserənˈdɪpəti]')).toBeInTheDocument();
    expect(screen.getByText('интуитивная прозорливость')).toBeInTheDocument();

    const rows = await screen.findAllByTestId('vocab-row');
    expect(rows).toHaveLength(2);
    // overdue word shows the accent-red due copy (§6.9)
    expect(screen.getByText('overdue')).toBeInTheDocument();
  });

  it('shows status counts from vocab_stats in the segmented header', async () => {
    seed();
    render(<VocabView />);

    await screen.findByText('serendipity');
    expect(screen.getByRole('tab', { name: /All/ }).textContent).toContain('2');
    expect(screen.getByRole('tab', { name: /New/ }).textContent).toContain('1');
    expect(screen.getByRole('tab', { name: /Learning/ }).textContent).toContain('1');
    expect(screen.getByRole('tab', { name: /Known/ }).textContent).toContain('0');
    // review button badge = dueToday
    expect(screen.getByRole('button', { name: /Review/ }).textContent).toContain('3');
  });

  it('status filter reloads the list through the store filter', async () => {
    seed();
    render(<VocabView />);
    await screen.findByText('serendipity');

    fireEvent.click(screen.getByRole('tab', { name: /Learning/ }));

    await waitFor(() => {
      expect(screen.queryByText('serendipity')).not.toBeInTheDocument();
    });
    expect(screen.getByText('abyss')).toBeInTheDocument();
    const call = invokeCalls.filter((c) => c.cmd === 'list_vocab').at(-1);
    expect((call?.args as { status?: string }).status).toBe('learning');
  });

  it('debounces the search input (150 ms) into a query-filtered reload', async () => {
    seed();
    render(<VocabView />);
    await screen.findByText('serendipity');
    const before = invokeCalls.filter((c) => c.cmd === 'list_vocab').length;

    fireEvent.change(screen.getByLabelText('Search word'), { target: { value: 'abyss' } });
    // Debounced: nothing fired synchronously.
    expect(invokeCalls.filter((c) => c.cmd === 'list_vocab').length).toBe(before);

    await waitFor(() => {
      const calls = invokeCalls.filter((c) => c.cmd === 'list_vocab');
      expect(calls.length).toBeGreaterThan(before);
      expect((calls.at(-1)?.args as { query?: string }).query).toBe('abyss');
    });
  });

  it('context click opens the book and jumps to the CFI', async () => {
    seed();
    render(<VocabView />);
    const ctx = await screen.findByTestId('vocab-context');
    expect(ctx.textContent).toContain('Тестовая книга · chapter 3');

    // Spies go on the settled state object: zustand replaces it on every set(),
    // and no ui/reader sets happen between here and the click.
    const openBook = vi.spyOn(useUiStore.getState(), 'openBook').mockResolvedValue(undefined);
    const gotoCfi = vi.spyOn(useReaderStore.getState(), 'gotoCfi').mockImplementation(() => {});
    fireEvent.click(ctx);

    await waitFor(() => expect(openBook).toHaveBeenCalledWith('aaaa1111'));
    expect(gotoCfi).toHaveBeenCalledWith('epubcfi(/4/2/6)', 2);
    openBook.mockRestore();
    gotoCfi.mockRestore();
  });

  it('status pill click cycles status via update_vocab_word', async () => {
    seed();
    render(<VocabView />);
    await screen.findByText('serendipity');

    const pill = screen.getAllByTestId('vocab-status-pill')
      .find((el) => el.textContent === 'New');
    expect(pill).toBeDefined();
    fireEvent.click(pill!);

    await waitFor(() => {
      const call = invokeCalls.find((c) => c.cmd === 'update_vocab_word');
      expect(call).toBeDefined();
      expect(call?.args).toEqual({ id: 1, patch: { status: 'learning' } });
    });
  });

  it('"Review" button sets the review overlay', async () => {
    seed();
    render(<VocabView />);
    await screen.findByText('serendipity');

    fireEvent.click(screen.getByRole('button', { name: /Review/ }));
    expect(useUiStore.getState().overlay).toBe('review');
    useUiStore.setState({ overlay: null });
  });

  it('shows the empty state when there are no words', async () => {
    seed({ words: [], stats: EMPTY_VOCAB_STATS });
    render(<VocabView />);

    expect(await screen.findByText('No words yet')).toBeInTheDocument();
    expect(screen.getByText(/Select words while reading/)).toBeInTheDocument();
  });

  it('row menu "Edit" opens WordEditor and "Save" patches the word', async () => {
    seed();
    render(<VocabView />);
    const rows = await screen.findAllByTestId('vocab-row');
    const row = rows.find((r) => within(r).queryByText('serendipity'))!;

    fireEvent.click(within(row).getByLabelText('Actions'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog', { name: 'Edit word' });
    const translation = within(dialog).getByLabelText('Translation') as HTMLInputElement;
    fireEvent.change(translation, { target: { value: 'счастливая случайность' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      const call = invokeCalls.filter((c) => c.cmd === 'update_vocab_word').at(-1);
      expect((call?.args as { id: number; patch: { translation?: string } }).id).toBe(1);
      expect((call?.args as { id: number; patch: { translation?: string } }).patch.translation)
        .toBe('счастливая случайность');
    });
    // ToastHost is mounted by App, not by the view — assert on the store.
    await waitFor(() => {
      expect(useUiStore.getState().toasts.some((t) => t.msg === 'Done')).toBe(true);
    });
  });
});

describe('pure helpers', () => {
  it('fmtDue: today / tomorrow / in Nd / overdue', () => {
    const now = Date.parse('2026-09-21T12:00:00');
    expect(fmtDue(now - 60_000, now)).toBe('overdue');
    expect(fmtDue(now + 3600_000, now)).toBe('today');
    expect(fmtDue(now + DAY, now)).toBe('tomorrow');
    expect(fmtDue(now + 5 * DAY, now)).toBe('in 5d');
    expect(fmtDue(null, now)).toBeNull();
  });

  it('sortWords: added (newest first) and alpha (ru collation)', () => {
    expect(sortWords(seedWords, 'added').map((w) => w.id)).toEqual([2, 1]);
    expect(sortWords(seedWords, 'alpha').map((w) => w.word)).toEqual(['abyss', 'serendipity']);
    // due: nulls first (new/never-reviewed words come before scheduled ones)
    expect(sortWords(seedWords, 'due').map((w) => w.id)).toEqual([1, 2]);
  });
});
