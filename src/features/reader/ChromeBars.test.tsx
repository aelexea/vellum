/**
 * ChromeBars (§8) — auto-hide idle timer, wake-up gestures, pinned overlays, and the
 * bottom-bar counter/heading/slider wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import ChromeBars, { truncateMiddle } from '@/features/reader/ChromeBars';
import { useReaderStore } from '@/stores/readerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { dispatchAction, setChromeForcedHidden } from '@/features/reader/Shortcuts';
import { mockBook } from '@/test/setup';
import type { OpenBook } from '@/lib/types';

const IDLE_HIDE_MS = 2500;

function fakeBook(chapters = 3): OpenBook {
  return {
    book: {
      ...mockBook,
      toc: [],
      chapters: Array.from({ length: chapters }, (_, i) => ({
        idx: i, href: `c${i}.xhtml`, title: `Глава ${i + 1}`, charCount: 100,
      })),
    },
    position: null,
    highlights: [], notes: [], bookmarks: [],
    indexStatus: { state: 'none', chaptersDone: 0, chaptersTotal: 0 },
  };
}

function seed(patch: Record<string, unknown> = {}): void {
  useReaderStore.setState({
    book: fakeBook(), chapterIdx: 1, pageIndex: 2, pageCount: 10,
    mode: 'paginated', pctWithinChapter: 0.5, selection: null, lastCfi: null,
    ...patch,
  } as never);
  useUiStore.setState({ view: 'reader', overlay: null, chromeVisible: true });
  useSettingsStore.setState((s) => ({
    settings: {
      ...s.settings,
      ui: { ...s.settings.ui, autoHideChrome: true },
      reading: { ...s.settings.reading, mode: 'paginated' },
    },
  }));
  setChromeForcedHidden(false);
}

describe('truncateMiddle', () => {
  it('leaves short strings alone', () => {
    expect(truncateMiddle('a • b', 46)).toBe('a • b');
  });

  it('keeps both ends of a long string', () => {
    const s = 'x'.repeat(30) + ' • ' + 'y'.repeat(30);
    const out = truncateMiddle(s, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).toContain('…');
    expect(out.startsWith('x')).toBe(true);
    expect(out.endsWith('y')).toBe(true);
  });
});

describe('ChromeBars auto-hide (§5.4)', () => {
  beforeEach(() => { vi.useFakeTimers(); seed(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('is visible on mount', () => {
    render(<ChromeBars />);
    expect(screen.getByTestId('chrome-bars')).toHaveAttribute('data-chrome-hidden', 'false');
    expect(useUiStore.getState().chromeVisible).toBe(true);
  });

  it('hides after 2.5 s idle', () => {
    render(<ChromeBars />);
    act(() => { vi.advanceTimersByTime(IDLE_HIDE_MS); });
    expect(useUiStore.getState().chromeVisible).toBe(false);
    expect(screen.getByTestId('chrome-bars')).toHaveAttribute('data-chrome-hidden', 'true');
  });

  it('does not hide before the idle timeout elapses', () => {
    render(<ChromeBars />);
    act(() => { vi.advanceTimersByTime(IDLE_HIDE_MS - 100); });
    expect(useUiStore.getState().chromeVisible).toBe(true);
  });

  it('a mousemove inside the top edge zone wakes it immediately', () => {
    render(<ChromeBars />);
    act(() => { vi.advanceTimersByTime(IDLE_HIDE_MS); });
    expect(useUiStore.getState().chromeVisible).toBe(false);

    fireEvent.mouseMove(window, { clientY: 10, clientX: 300 });
    expect(useUiStore.getState().chromeVisible).toBe(true);
  });

  it('a keypress wakes it and restarts the idle countdown', () => {
    render(<ChromeBars />);
    act(() => { vi.advanceTimersByTime(IDLE_HIDE_MS); });
    expect(useUiStore.getState().chromeVisible).toBe(false);

    fireEvent.keyDown(window, { key: 'x' });
    expect(useUiStore.getState().chromeVisible).toBe(true);

    // The countdown restarted, so it is still visible just under 2.5 s later.
    act(() => { vi.advanceTimersByTime(IDLE_HIDE_MS - 200); });
    expect(useUiStore.getState().chromeVisible).toBe(true);
    act(() => { vi.advanceTimersByTime(400); });
    expect(useUiStore.getState().chromeVisible).toBe(false);
  });

  it('an open overlay pins the chrome visible', () => {
    seed();
    useUiStore.setState({ overlay: 'toc' });
    render(<ChromeBars />);
    act(() => { vi.advanceTimersByTime(IDLE_HIDE_MS * 3); });
    expect(useUiStore.getState().chromeVisible).toBe(true);
    expect(screen.getByTestId('chrome-bars')).toHaveAttribute('data-chrome-hidden', 'false');
  });

  it('never hides when autoHideChrome is off', () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, ui: { ...s.settings.ui, autoHideChrome: false } },
    }));
    render(<ChromeBars />);
    act(() => { vi.advanceTimersByTime(IDLE_HIDE_MS * 3); });
    expect(useUiStore.getState().chromeVisible).toBe(true);
  });

  it('does not undo a Ctrl+H force-hide on the very key that hid it', async () => {
    render(<ChromeBars />);
    // The capture-phase App handler already ran dispatchAction('toggleUi').
    await act(async () => { await dispatchAction('toggleUi'); });
    expect(useUiStore.getState().chromeVisible).toBe(false);

    fireEvent.keyDown(window, { key: 'h', ctrlKey: true });
    expect(useUiStore.getState().chromeVisible).toBe(false);
  });
});

describe('ChromeBars content', () => {
  beforeEach(() => { seed(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows "title • chapter"', () => {
    render(<ChromeBars />);
    expect(screen.getByTestId('chrome-heading').textContent).toBe('Тестовая книга • Глава 2');
  });

  it('falls back to "chapter N" when a chapter has no title', () => {
    useReaderStore.setState((s) => ({
      book: {
        ...s.book!,
        book: {
          ...s.book!.book,
          chapters: s.book!.book.chapters.map((c) => ({ ...c, title: null })),
        },
      },
    }));
    render(<ChromeBars />);
    expect(screen.getByTestId('chrome-heading').textContent).toContain('chapter 2');
  });

  it('renders "page {x} / {y} · {pct} %"', () => {
    render(<ChromeBars />);
    // chapterIdx 1 of 3 chapters, 50 % through → (1 + 0.5) / 3 = 50 %.
    expect(screen.getByTestId('chrome-progress').textContent).toBe('page 3 / 10 · 50 %');
  });

  it('marks the bookmark button filled when one exists in this chapter', () => {
    useReaderStore.setState((s) => ({
      book: {
        ...s.book!,
        bookmarks: [{
          id: 1, bookUid: mockBook.uid, chapterIdx: 1, cfi: 'epubcfi(/4/2)',
          label: null, createdAt: 1,
        }],
      },
    }));
    render(<ChromeBars />);
    expect(screen.getByLabelText('Bookmark')).toHaveAttribute('aria-pressed', 'true');
  });

  it('the slider spans 0..totalChapters-1 and commits a chapter jump on release', () => {
    // Stubbed so the real (async) navigation cannot leak a state update past the assertion.
    const spy = vi.spyOn(useReaderStore.getState(), 'gotoChapter').mockImplementation(() => {});
    render(<ChromeBars />);
    const slider = screen.getByTestId('chapter-slider') as HTMLInputElement;
    expect(slider.max).toBe('2');
    expect(slider.value).toBe('1');

    fireEvent.change(slider, { target: { value: '2' } });
    // Live drag only shows the tooltip; nothing is committed yet.
    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByTestId('scrub-tooltip').textContent).toBe('Глава 3');

    fireEvent.pointerUp(slider);
    expect(spy).toHaveBeenCalledWith(2);
  });

  it.each([
    ['Contents', 'toc'],
    ['Search', 'search'],
    ['Notes', 'annotations'],
    ['Text appearance', 'quickSettings'],
  ] as const)('"%s" toggles the %s overlay', (label, overlay) => {
    render(<ChromeBars />);
    fireEvent.click(screen.getByLabelText(label));
    expect(useUiStore.getState().overlay).toBe(overlay);
    fireEvent.click(screen.getByLabelText(label));
    expect(useUiStore.getState().overlay).toBeNull();
  });

  it('back → uiStore.backToLibrary', () => {
    const spy = vi.spyOn(useUiStore.getState(), 'backToLibrary')
      .mockResolvedValue(undefined);
    render(<ChromeBars />);
    fireEvent.click(screen.getByLabelText('Back to library'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('disables prev-chapter on the first chapter', () => {
    seed({ chapterIdx: 0 });
    render(<ChromeBars />);
    expect(screen.getByLabelText('Previous chapter')).toBeDisabled();
    expect(screen.getByLabelText('Next chapter')).not.toBeDisabled();
  });

  it('disables next-chapter on the last chapter', () => {
    seed({ chapterIdx: 2 });
    render(<ChromeBars />);
    expect(screen.getByLabelText('Next chapter')).toBeDisabled();
  });
});
