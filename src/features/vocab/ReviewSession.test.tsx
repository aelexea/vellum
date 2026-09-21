/**
 * ReviewSession tests — [F4] §8: front→back flip, grade buttons/keys → record_review +
 * queue advance, §4.6 interval previews, summary and empty panes, exit confirm.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ReviewSession, { fmtInterval, intervalPreview } from '@/features/vocab/ReviewSession';
import type { VocabWord } from '@/lib/types';
import { invokeCalls, mockCommand } from '@/test/setup';
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

const firstCard = word({
  id: 11, word: 'serendipity', transcription: '[ˌserənˈdɪpəti]',
  translation: 'интуитивная прозорливость', definition: 'a happy accident',
  context: 'A happy serendipity.', bookTitle: 'Тестовая книга', chapterIdx: 2,
  examples: ['Pure serendipity.'], status: 'new', reviewCount: 0, intervalDays: null,
  dueAt: Date.now() - 1000,
});

const secondCard = word({
  id: 12, word: 'abyss', translation: 'бездна', dueAt: Date.now() - 500,
});

/** Seed the queue directly (mount only calls startReview when the queue is empty). */
function seedQueue(queue: VocabWord[]) {
  useVocabStore.setState({
    words: queue, queue, queuePos: 0, stats: EMPTY_VOCAB_STATS, reviewedThisSession: 0,
    filters: { status: null, bookUid: null, query: null, dueOnly: false }, loading: false,
  });
  mockCommand('record_review', (args: { id: number }) => {
    const src = queue.find((w) => w.id === args.id) ?? queue[0];
    return { ...src, reviewCount: src.reviewCount + 1, intervalDays: 1 };
  });
}

beforeEach(() => {
  cleanup();
  useVocabStore.setState({
    words: [], queue: [], queuePos: 0, stats: EMPTY_VOCAB_STATS, reviewedThisSession: 0,
  });
  useUiStore.setState({ toasts: [], overlay: 'review', pendingConfirm: null });
});

describe('ReviewSession', () => {
  it('shows the front of the card, then flips to the back on Space', async () => {
    seedQueue([firstCard, secondCard]);
    render(<ReviewSession />);

    const front = await screen.findByTestId('review-front');
    expect(within(front).getByText('serendipity')).toBeInTheDocument();
    expect(within(front).getByText('[ˌserənˈdɪpəti]')).toBeInTheDocument();
    expect(screen.queryByTestId('review-back')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: ' ' });

    const back = await screen.findByTestId('review-back');
    expect(within(back).getByText('интуитивная прозорливость')).toBeInTheDocument();
    expect(within(back).getByText('a happy accident')).toBeInTheDocument();
    expect(within(back).getByText('A happy serendipity.')).toBeInTheDocument();
    expect(within(back).getByText('Тестовая книга · chapter 3')).toBeInTheDocument();
    expect(within(back).getByText('Pure serendipity.')).toBeInTheDocument();
    expect(screen.queryByTestId('review-front')).not.toBeInTheDocument();
  });

  it('"Show translation" button also flips the card', async () => {
    seedQueue([firstCard]);
    render(<ReviewSession />);

    fireEvent.click(await screen.findByRole('button', { name: 'Show translation' }));
    expect(await screen.findByTestId('review-back')).toBeInTheDocument();
  });

  it('grade buttons preview §4.6 intervals (first review of a new word)', async () => {
    seedQueue([firstCard]);
    render(<ReviewSession />);

    fireEvent.keyDown(window, { key: ' ' });
    const back = await screen.findByTestId('review-back');

    expect(within(back).getByTestId('grade-again').textContent).toContain('10m');
    expect(within(back).getByTestId('grade-hard').textContent).toContain('1d');
    expect(within(back).getByTestId('grade-good').textContent).toContain('1d');
    expect(within(back).getByTestId('grade-easy').textContent).toContain('3d');
    expect(within(back).getAllByText('1d')).toHaveLength(2);
  });

  it('grade "Good" records the review and advances the queue', async () => {
    seedQueue([firstCard, secondCard]);
    render(<ReviewSession />);

    fireEvent.keyDown(window, { key: ' ' });
    fireEvent.click(await screen.findByTestId('grade-good'));

    await waitFor(() => {
      const call = invokeCalls.find((c) => c.cmd === 'record_review');
      expect(call?.args).toEqual({ id: 11, result: 'good' });
    });
    expect(useVocabStore.getState().queuePos).toBe(1);
    expect(useVocabStore.getState().reviewedThisSession).toBe(1);

    // Next card is shown front-side again.
    const front = await screen.findByTestId('review-front');
    expect(within(front).getByText('abyss')).toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();
  });

  it('keys 1–4 grade the revealed card', async () => {
    seedQueue([firstCard, secondCard]);
    render(<ReviewSession />);

    fireEvent.keyDown(window, { key: ' ' });
    await screen.findByTestId('review-back');
    fireEvent.keyDown(window, { key: '4' });

    await waitFor(() => {
      const call = invokeCalls.find((c) => c.cmd === 'record_review');
      expect(call?.args).toEqual({ id: 11, result: 'easy' });
    });
  });

  it('grades are inert while the card is not revealed', async () => {
    seedQueue([firstCard, secondCard]);
    render(<ReviewSession />);
    await screen.findByTestId('review-front');

    fireEvent.keyDown(window, { key: '3' });
    expect(invokeCalls.filter((c) => c.cmd === 'record_review')).toHaveLength(0);
    expect(useVocabStore.getState().queuePos).toBe(0);
  });

  it('last card graded → summary pane with the reviewed count', async () => {
    seedQueue([firstCard]);
    render(<ReviewSession />);

    fireEvent.keyDown(window, { key: ' ' });
    fireEvent.click(await screen.findByTestId('grade-hard'));

    const summary = await screen.findByText('Words reviewed: 1');
    expect(summary).toBeInTheDocument();
    // Scoped: the header × is also labelled "Close".
    expect(within(summary.parentElement!).getByRole('button', { name: 'Close' }))
      .toBeInTheDocument();
  });

  it('"Close" on the summary closes the overlay', async () => {
    seedQueue([firstCard]);
    render(<ReviewSession />);
    fireEvent.keyDown(window, { key: ' ' });
    fireEvent.click(await screen.findByTestId('grade-hard'));
    const summary = await screen.findByText('Words reviewed: 1');

    fireEvent.click(within(summary.parentElement!).getByRole('button', { name: 'Close' }));
    expect(useUiStore.getState().overlay).toBeNull();
  });

  it('progress bar reflects reviewed / queue length', async () => {
    seedQueue([firstCard, secondCard]);
    render(<ReviewSession />);

    const bar = await screen.findByTestId('review-progress');
    expect(bar.style.width).toBe('0%');

    fireEvent.keyDown(window, { key: ' ' });
    fireEvent.click(await screen.findByTestId('grade-good'));

    await waitFor(() => {
      expect(screen.getByTestId('review-progress').style.width).toBe('50%');
    });
  });

  it('exit with progress asks for confirmation; cancel keeps the session', async () => {
    seedQueue([firstCard, secondCard]);
    render(<ReviewSession />);

    fireEvent.keyDown(window, { key: ' ' });
    fireEvent.click(await screen.findByTestId('grade-good'));
    await screen.findByText('abyss');

    const confirm = vi.spyOn(useUiStore.getState(), 'confirm').mockResolvedValue(false);
    fireEvent.click(screen.getByLabelText('Close'));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0].title).toBe('End review?');
    expect(useUiStore.getState().overlay).toBe('review');

    confirm.mockResolvedValue(true);
    fireEvent.click(screen.getByLabelText('Close'));
    await waitFor(() => expect(useUiStore.getState().overlay).toBeNull());
    confirm.mockRestore();
  });

  it('exit before any grade closes without confirmation', async () => {
    seedQueue([firstCard, secondCard]);
    render(<ReviewSession />);
    await screen.findByTestId('review-front');

    const confirm = vi.spyOn(useUiStore.getState(), 'confirm');
    fireEvent.click(screen.getByLabelText('Close'));

    await waitFor(() => expect(useUiStore.getState().overlay).toBeNull());
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('empty queue → "All done for today" with tomorrow count, no cards', async () => {
    const tomorrowCard = word({ id: 21, word: 'morrow', dueAt: Date.now() + DAY + 60_000 });
    mockCommand('get_review_queue', []);
    mockCommand('list_vocab', [tomorrowCard]);
    useVocabStore.setState({ words: [tomorrowCard], queue: [], queuePos: 0 });

    render(<ReviewSession />);

    expect(await screen.findByText('All done for today')).toBeInTheDocument();
    expect(screen.getByText(/Due tomorrow: 1 word/)).toBeInTheDocument();
    expect(screen.queryByTestId('review-front')).not.toBeInTheDocument();
    expect(invokeCalls.some((c) => c.cmd === 'get_review_queue')).toBe(true);
  });
});

describe('§4.6 interval math', () => {
  it('fmtInterval: minutes below an hour, hours below a day, rounded days', () => {
    expect(fmtInterval(10)).toBe('10m');
    expect(fmtInterval(45)).toBe('45m');
    expect(fmtInterval(180)).toBe('3h');
    expect(fmtInterval(23 * 60)).toBe('23h');
    expect(fmtInterval(24 * 60)).toBe('1d');
    expect(fmtInterval(4.8 * 24 * 60)).toBe('5d');
  });

  it('intervalPreview: first review (again/hard/good/easy)', () => {
    expect(intervalPreview(firstCard, 'again')).toBe('10m');
    expect(intervalPreview(firstCard, 'hard')).toBe('1d');
    expect(intervalPreview(firstCard, 'good')).toBe('1d');
    expect(intervalPreview(firstCard, 'easy')).toBe('3d');
  });

  it('intervalPreview: subsequent review uses interval × ease (×1.2 / ×ease / ×ease×1.3)', () => {
    const reviewed = word({ id: 31, word: 'x', intervalDays: 4, reviewCount: 3 });
    expect(intervalPreview(reviewed, 'again')).toBe('10m');
    expect(intervalPreview(reviewed, 'hard')).toBe('5d');    // 4 × 1.2 = 4.8
    expect(intervalPreview(reviewed, 'good')).toBe('10d');   // 4 × 2.5
    expect(intervalPreview(reviewed, 'easy')).toBe('13d');   // 4 × 2.5 × 1.3
  });

  it('intervalPreview reads the word\'s drifted ease, not the 2.5 default', () => {
    const drifted = word({ id: 32, word: 'y', intervalDays: 4, reviewCount: 3, ease: 2.65 });
    expect(intervalPreview(drifted, 'good')).toBe('11d');    // 4 × 2.65 = 10.6
    expect(intervalPreview(drifted, 'easy')).toBe('14d');    // 4 × 2.65 × 1.3 = 13.78
  });
});
