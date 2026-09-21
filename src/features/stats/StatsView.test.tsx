/**
 * StatsView tests — [F4] §8: tiles from a mocked get_stats, range switch refetches,
 * ring dasharray math, bar buckets per range, vocab mini-tiles, empty state.
 *
 * The backend surface is mocked through the shared harness (src/test/setup.ts
 * mockCommand/invokeCalls) rather than vi.mock('@/lib/tauri'): a module mock there would
 * also stub the exports the frozen stores import (listVocab, vocabStats, listBooks…).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import StatsView, { RING_CIRCUMFERENCE, buildBars } from '@/features/stats/StatsView';
import type { ReadingStats } from '@/lib/types';
import { invokeCalls, mockCommand } from '@/test/setup';
import { useLibraryStore } from '@/stores/libraryStore';
import { useUiStore } from '@/stores/uiStore';
import { EMPTY_VOCAB_STATS, useVocabStore } from '@/stores/vocabStore';

const DAY = 86_400_000;

function localDay(offsetDays: number): string {
  const d = new Date(Date.now() - offsetDays * DAY);
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

const seedStats: ReadingStats = {
  rangeSeconds: 5400,           // 1h 30m
  byDay: [
    { date: localDay(6), seconds: 600 },
    { date: localDay(1), seconds: 1200 },
    { date: localDay(0), seconds: 900 },   // today: 15 min of the 30-min goal
  ],
  pagesTurned: 42,
  booksTouched: 3,
  streakDays: 7,
};

const seedVocabStats = {
  ...EMPTY_VOCAB_STATS,
  total: 25, byStatus: { new: 10, learning: 9, known: 6 }, dueToday: 4,
};

function seed() {
  mockCommand('get_stats', () => structuredClone(seedStats));
  mockCommand('vocab_stats', seedVocabStats);
  useVocabStore.setState({ words: [], queue: [], queuePos: 0, stats: seedVocabStats });
  useLibraryStore.setState({
    books: [{
      uid: 'aaaa1111', title: 'Тестовая книга', authors: [], path: '/tmp/test.epub',
      coverUrl: null, progress: 0.25, positionChapterIdx: 1, totalChapters: 4,
      addedAt: 0, lastOpenedAt: 1_700_000_900_000, tags: [], sizeBytes: 1, missing: false,
    }],
    tags: [], loading: false, importing: false, importProgress: null,
  });
}

beforeEach(() => {
  cleanup();
  useVocabStore.setState({ stats: EMPTY_VOCAB_STATS });
  useUiStore.setState({ toasts: [], view: 'stats' });
});

describe('StatsView', () => {
  it('renders the four tiles from get_stats', async () => {
    seed();
    render(<StatsView />);

    expect(await screen.findByText('1h 30m')).toBeInTheDocument();
    expect(screen.getByText('Reading time')).toBeInTheDocument();
    expect(screen.getByText('Pages turned')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    // "Books" appears twice: the booksTouched tile and the per-book section header.
    expect(screen.getAllByText('Books').length).toBe(2);
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Streak')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
  });

  it('fetches the selected range and refetches on range switch', async () => {
    seed();
    render(<StatsView />);
    await screen.findByText('1h 30m');

    expect((invokeCalls.find((c) => c.cmd === 'get_stats')?.args as { range: string }).range)
      .toBe('week');

    fireEvent.click(screen.getByRole('tab', { name: 'Month' }));
    await waitFor(() => {
      const calls = invokeCalls.filter((c) => c.cmd === 'get_stats');
      expect((calls.at(-1)?.args as { range: string }).range).toBe('month');
    });

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    await waitFor(() => {
      const calls = invokeCalls.filter((c) => c.cmd === 'get_stats');
      expect((calls.at(-1)?.args as { range: string }).range).toBe('all');
    });
  });

  it('today ring dasharray = progress of the 30-min goal', async () => {
    seed();
    render(<StatsView />);
    await screen.findByText('1h 30m');

    const ring = screen.getByTestId('stats-ring');
    // today = 900 s = 15 min → half of the 1800 s goal
    const expected = `${RING_CIRCUMFERENCE * 0.5} ${RING_CIRCUMFERENCE}`;
    expect(ring.getAttribute('stroke-dasharray')).toBe(expected);
    expect(screen.getByText('15m')).toBeInTheDocument();
    expect(screen.getByText('of 30 min')).toBeInTheDocument();
  });

  it('caps the ring at a full circle when the goal is exceeded', async () => {
    seed();
    mockCommand('get_stats', () => ({
      ...seedStats,
      rangeSeconds: 7200,
      byDay: [{ date: localDay(0), seconds: 7200 }],
    }));
    render(<StatsView />);
    // "2h" shows both in the ring centre and the Reading time tile.
    await screen.findAllByText('2h');

    expect(screen.getByTestId('stats-ring').getAttribute('stroke-dasharray'))
      .toBe(`${RING_CIRCUMFERENCE} ${RING_CIRCUMFERENCE}`);
  });

  it('renders the vocab mini-tiles and jumps to the vocab view on click', async () => {
    seed();
    render(<StatsView />);
    await screen.findByText('1h 30m');

    expect(screen.getByText('Total words')).toBeInTheDocument();
    expect(screen.getByText('25')).toBeInTheDocument();
    expect(screen.getByText('Learning')).toBeInTheDocument();
    expect(screen.getByText('Due for review')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Total words/ }));
    expect(useUiStore.getState().view).toBe('vocab');
    useUiStore.setState({ view: 'stats' });
  });

  it('lists per-book progress rows', async () => {
    seed();
    render(<StatsView />);
    await screen.findByText('1h 30m');

    expect(screen.getByText('Тестовая книга')).toBeInTheDocument();
    expect(screen.getAllByText('25 %').length).toBeGreaterThan(0);
  });

  it('shows the empty state when there is no reading data', async () => {
    seed();
    mockCommand('get_stats', () => ({
      rangeSeconds: 0, byDay: [], pagesTurned: 0, booksTouched: 0, streakDays: 0,
    }));
    render(<StatsView />);

    expect(await screen.findByText('No stats yet — open a book')).toBeInTheDocument();
    expect(screen.queryByTestId('stats-chart')).not.toBeInTheDocument();
  });

  it('renders 7 bars for the week range, today highlighted', async () => {
    seed();
    render(<StatsView />);
    await screen.findByText('1h 30m');

    const chart = screen.getByTestId('stats-chart');
    const bars = within(chart).getAllByTestId('stats-bar');
    expect(bars).toHaveLength(7);
    expect(bars.filter((b) => b.dataset.today !== undefined)).toHaveLength(1);
    expect(screen.getByText('Mon')).toBeInTheDocument();
    expect(screen.getByText('Sun')).toBeInTheDocument();
  });
});

describe('buildBars', () => {
  it('week → 7 buckets ending today, sparse days zero-filled', () => {
    const bars = buildBars(seedStats.byDay, 'week');
    expect(bars).toHaveLength(7);
    expect(bars.at(-1)?.today).toBe(true);
    expect(bars.at(-1)?.seconds).toBe(900);
    expect(bars.filter((b) => b.seconds === 0)).toHaveLength(4);
    expect(bars[0].label).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
  });

  it('month → 30 thin day buckets', () => {
    const bars = buildBars(seedStats.byDay, 'month');
    expect(bars).toHaveLength(30);
    expect(bars.at(-1)?.today).toBe(true);
  });

  it('all → last 12 present days with "mmm d" labels', () => {
    const byDay = Array.from({ length: 20 }, (_, i) => ({
      date: localDay(19 - i), seconds: 60 * (i + 1),
    }));
    const bars = buildBars(byDay, 'all');
    expect(bars).toHaveLength(12);
    expect(bars[0].key).toBe(byDay[8].date);
    expect(bars.at(-1)?.key).toBe(byDay[19].date);
    expect(bars[0].label).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(bars.every((b) => b.today === false)).toBe(true);
  });
});
