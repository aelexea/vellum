/**
 * dispatchAction map (§8) — every §5.10 action id triggers the expected frozen-store call.
 * The engine is never reached from here; the Tauri window API is mocked for
 * fullscreen/quit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const win = vi.hoisted(() => ({
  isFullscreen: vi.fn(async () => false),
  setFullscreen: vi.fn(async (_v: boolean) => {}),
  close: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));

import {
  DEFAULT_SHORTCUTS, NEEDS_SELECTION_TOAST,
  dispatchAction, isChromeForcedHidden, isDispatchable, setChromeForcedHidden,
} from '@/features/reader/Shortcuts';
import { useReaderStore } from '@/stores/readerStore';
import type { SelectionState } from '@/stores/readerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';
import { mockBook } from '@/test/setup';
import type { OpenBook, VocabWord } from '@/lib/types';

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

const selection = (text: string, word?: string): SelectionState => ({
  text,
  cfiStart: 'epubcfi(/4/2/1:0)',
  cfiEnd: 'epubcfi(/4/2/1:5)',
  rect: { x: 10, y: 20, width: 60, height: 18 },
  sentence: `${text} — предложение целиком.`,
  word,
});

function seedReader(patch: Partial<ReturnType<typeof useReaderStore.getState>> = {}): void {
  useReaderStore.setState({
    book: fakeBook(),
    loading: false,
    chapterIdx: 1,
    pageIndex: 2,
    pageCount: 10,
    mode: 'paginated',
    pctWithinChapter: 0.2,
    selection: null,
    pendingTarget: null,
    lastCfi: 'epubcfi(/4/2/1:0)',
    ...patch,
  } as Partial<ReturnType<typeof useReaderStore.getState>>);
}

function resetStores(): void {
  useReaderStore.setState({
    book: null, loading: false, chapterIdx: 0, pageIndex: 0, pageCount: 0,
    mode: 'paginated', pctWithinChapter: 0, selection: null, pendingTarget: null,
    lastCfi: null,
  });
  useUiStore.setState({ view: 'library', overlay: null, toasts: [], chromeVisible: true });
  useSettingsStore.setState({
    settings: structuredClone(useSettingsStore.getState().settings),
  });
  setChromeForcedHidden(false);
}

describe('dispatchAction — coverage', () => {
  it('knows every action id in the frozen default map (§5.10)', () => {
    for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
      expect(isDispatchable(action), action).toBe(true);
    }
  });

  it('returns false for an unknown action id', async () => {
    await expect(dispatchAction('definitelyNotAnAction')).resolves.toBe(false);
  });
});

describe('dispatchAction — paging', () => {
  beforeEach(seedReader);
  afterEach(() => { vi.restoreAllMocks(); resetStores(); });

  it.each(['nextPage', 'nextPageAlt', 'spaceNext'])('%s → readerStore.nextPage', async (action) => {
    const spy = vi.spyOn(useReaderStore.getState(), 'nextPage');
    await expect(dispatchAction(action)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each(['prevPage', 'prevPageAlt'])('%s → readerStore.prevPage', async (action) => {
    const spy = vi.spyOn(useReaderStore.getState(), 'prevPage');
    await dispatchAction(action);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('nextChapter → gotoChapter(chapterIdx + 1)', async () => {
    const spy = vi.spyOn(useReaderStore.getState(), 'gotoChapter');
    await dispatchAction('nextChapter');
    expect(spy).toHaveBeenCalledWith(2);
  });

  it('prevChapter → gotoChapter(chapterIdx - 1)', async () => {
    const spy = vi.spyOn(useReaderStore.getState(), 'gotoChapter');
    await dispatchAction('prevChapter');
    expect(spy).toHaveBeenCalledWith(0);
  });
});

describe('dispatchAction — overlays and views', () => {
  beforeEach(seedReader);
  afterEach(() => { vi.restoreAllMocks(); resetStores(); });

  it.each([
    ['toggleSearch', 'search'],
    ['toggleToc', 'toc'],
    ['toggleAnnotations', 'annotations'],
  ] as const)('%s toggles the %s overlay', async (action, overlay) => {
    await dispatchAction(action);
    expect(useUiStore.getState().overlay).toBe(overlay);
    // Toggling the same overlay again closes it.
    await dispatchAction(action);
    expect(useUiStore.getState().overlay).toBeNull();
  });

  it('startReview → review overlay', async () => {
    await dispatchAction('startReview');
    expect(useUiStore.getState().overlay).toBe('review');
  });

  it('openSettings → settings view', async () => {
    await dispatchAction('openSettings');
    expect(useUiStore.getState().view).toBe('settings');
  });

  it('backToLibrary → uiStore.backToLibrary (flushes position first)', async () => {
    const spy = vi.spyOn(useUiStore.getState(), 'backToLibrary');
    await dispatchAction('backToLibrary');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchAction — typography, theme, mode, chrome', () => {
  beforeEach(seedReader);
  afterEach(() => { vi.restoreAllMocks(); resetStores(); });

  it('fontInc patches fontSizePx + 1', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, page: { ...s.settings.page, fontSizePx: 19 } },
    }));
    const spy = vi.spyOn(useSettingsStore.getState(), 'patch');
    await dispatchAction('fontInc');
    expect(spy).toHaveBeenCalledWith({ page: { fontSizePx: 20 } });
  });

  it('fontDec patches fontSizePx - 1', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, page: { ...s.settings.page, fontSizePx: 19 } },
    }));
    const spy = vi.spyOn(useSettingsStore.getState(), 'patch');
    await dispatchAction('fontDec');
    expect(spy).toHaveBeenCalledWith({ page: { fontSizePx: 18 } });
  });

  it('fontInc clamps at 32 px', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, page: { ...s.settings.page, fontSizePx: 32 } },
    }));
    const spy = vi.spyOn(useSettingsStore.getState(), 'patch');
    await dispatchAction('fontInc');
    expect(spy).not.toHaveBeenCalled();
  });

  it('fontDec clamps at 12 px', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, page: { ...s.settings.page, fontSizePx: 12 } },
    }));
    const spy = vi.spyOn(useSettingsStore.getState(), 'patch');
    await dispatchAction('fontDec');
    expect(spy).not.toHaveBeenCalled();
  });

  it('cycleTheme advances to the next built-in theme', async () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, ui: { ...s.settings.ui, themeId: 'light' } },
    }));
    await dispatchAction('cycleTheme');
    expect(useSettingsStore.getState().settings.ui.themeId).toBe('dark');
  });

  it('toggleMode flips paginated ↔ scroll in settings and the reader', async () => {
    const setMode = vi.spyOn(useReaderStore.getState(), 'setMode');
    const patch = vi.spyOn(useSettingsStore.getState(), 'patch');
    await dispatchAction('toggleMode');
    expect(patch).toHaveBeenCalledWith({ reading: { mode: 'scroll' } });
    expect(setMode).toHaveBeenCalledWith('scroll');
    expect(useSettingsStore.getState().settings.reading.mode).toBe('scroll');
  });

  it('toggleUi force-hides the chrome; a second call brings it back', async () => {
    await dispatchAction('toggleUi');
    expect(isChromeForcedHidden()).toBe(true);
    expect(useUiStore.getState().chromeVisible).toBe(false);

    await dispatchAction('toggleUi');
    expect(isChromeForcedHidden()).toBe(false);
    expect(useUiStore.getState().chromeVisible).toBe(true);
  });

  it('fullscreen toggles the Tauri window fullscreen state', async () => {
    await dispatchAction('fullscreen');
    expect(win.isFullscreen).toHaveBeenCalled();
    expect(win.setFullscreen).toHaveBeenCalledWith(true);
  });

  it('quit closes the window', async () => {
    await dispatchAction('quit');
    expect(win.close).toHaveBeenCalledTimes(1);
  });
});

describe('dispatchAction — bookmark', () => {
  beforeEach(seedReader);
  afterEach(() => { vi.restoreAllMocks(); resetStores(); });

  it('toggles a bookmark at the current reading head', async () => {
    const spy = vi.spyOn(useReaderStore.getState(), 'toggleBookmark');
    await dispatchAction('bookmark');
    expect(spy).toHaveBeenCalledWith('epubcfi(/4/2/1:0)');
  });

  it('is a no-op without an open book', async () => {
    useReaderStore.setState({ book: null });
    const spy = vi.spyOn(useReaderStore.getState(), 'toggleBookmark');
    await expect(dispatchAction('bookmark')).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('dispatchAction — selection-scoped (§5.10)', () => {
  beforeEach(() => seedReader({ selection: selection('hello', 'hello') }));
  afterEach(() => { vi.restoreAllMocks(); resetStores(); });

  it('translate opens the translate overlay', async () => {
    await dispatchAction('translate');
    expect(useUiStore.getState().overlay).toBe('translate');
  });

  it('dictionary looks the selected word up with its sentence context', async () => {
    const spy = vi.spyOn(useReaderStore.getState(), 'lookup');
    await dispatchAction('dictionary');
    expect(spy).toHaveBeenCalledTimes(1);
    const [word, ctx] = spy.mock.calls[0];
    expect(word).toBe('hello');
    expect(ctx).toMatchObject({ bookUid: mockBook.uid, chapterIdx: 1, cfi: 'epubcfi(/4/2/1:0)' });
  });

  it('addVocab prefills the word + context and toasts "Word added"', async () => {
    const spy = vi.spyOn(useVocabStore.getState(), 'add');
    spy.mockResolvedValue({ id: 7, word: 'hello', ease: 2.5 } as VocabWord);
    await dispatchAction('addVocab');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({
      word: 'hello',
      contextCfi: 'epubcfi(/4/2/1:0)',
      bookUid: mockBook.uid,
      chapterIdx: 1,
    });
    expect(useUiStore.getState().toasts.map((t) => t.msg)).toContain('Word added');
  });

  it.each(['translate', 'dictionary', 'addVocab'])(
    '%s without a selection toasts "Select some text"',
    async (action) => {
      useReaderStore.setState({ selection: null });
      const lookup = vi.spyOn(useReaderStore.getState(), 'lookup');
      await dispatchAction(action);
      expect(useUiStore.getState().toasts.map((t) => t.msg)).toContain(NEEDS_SELECTION_TOAST);
      expect(lookup).not.toHaveBeenCalled();
      expect(useUiStore.getState().overlay).toBeNull();
    },
  );

  it('a whitespace-only selection counts as no selection', async () => {
    useReaderStore.setState({ selection: selection('   ') });
    await dispatchAction('translate');
    expect(useUiStore.getState().toasts.map((t) => t.msg)).toContain(NEEDS_SELECTION_TOAST);
    expect(useUiStore.getState().overlay).toBeNull();
  });

  it('dictionary falls back to the whole selection when it is not a single word', async () => {
    useReaderStore.setState({ selection: selection('two words', undefined) });
    const spy = vi.spyOn(useReaderStore.getState(), 'lookup');
    await dispatchAction('dictionary');
    expect(spy.mock.calls[0][0]).toBe('two words');
  });
});
