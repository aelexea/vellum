import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';
import { invokeCalls } from '@/test/setup';

const resetReader = () => {
  useReaderStore.setState({
    book: null, loading: false, chapterIdx: 0, pageIndex: 0, pageCount: 0,
    mode: 'paginated', pctWithinChapter: 0, selection: null, pendingTarget: null,
    lastCfi: null, heartbeatTimer: null, pendingSeconds: 0, pendingPages: 0,
    lastTickAt: Date.now(),
  });
};

describe('readerStore', () => {
  beforeEach(() => { vi.useFakeTimers(); resetReader(); useUiStore.setState({ view: 'library' }); });
  afterEach(() => { useReaderStore.getState().stopHeartbeat(); vi.useRealTimers(); });

  it('open() loads the book and sets a pendingTarget for ChapterFrame', async () => {
    await useReaderStore.getState().open('aaaa1111');
    const s = useReaderStore.getState();
    expect(s.book?.book.uid).toBe('aaaa1111');
    expect(s.loading).toBe(false);
    expect(s.pendingTarget).not.toBeNull();
    expect(s.pendingTarget?.chapterIdx).toBe(0);
    expect(invokeCalls.some((c) => c.cmd === 'open_book')).toBe(true);
  });

  it('open() starts the heartbeat; close() stops it and flushes position', async () => {
    await useReaderStore.getState().open('aaaa1111');
    expect(useReaderStore.getState().heartbeatTimer).not.toBeNull();

    await useReaderStore.getState().close();
    const s = useReaderStore.getState();
    expect(s.heartbeatTimer).toBeNull();
    expect(s.book).toBeNull();
    // close flushes position immediately (save_position invoked).
    expect(invokeCalls.some((c) => c.cmd === 'save_position')).toBe(true);
  });

  it('nextPage advances the page and accrues a heartbeat delta', async () => {
    await useReaderStore.getState().open('aaaa1111');
    useReaderStore.setState({ pageCount: 10, pageIndex: 2 });
    useReaderStore.getState().nextPage();
    const s = useReaderStore.getState();
    expect(s.pageIndex).toBe(3);
    expect(s.pendingPages).toBe(1);
  });

  it('nextPage at the last page rolls into the next chapter', async () => {
    await useReaderStore.getState().open('aaaa1111');
    // mock book has 2 chapters.
    useReaderStore.setState({ pageCount: 5, pageIndex: 4, chapterIdx: 0 });
    useReaderStore.getState().nextPage();
    expect(useReaderStore.getState().chapterIdx).toBe(1);
    expect(useReaderStore.getState().pageIndex).toBe(0);
  });

  it('prevPage at page 0 of chapter >0 enters the previous chapter at its end', async () => {
    await useReaderStore.getState().open('aaaa1111');
    useReaderStore.setState({ chapterIdx: 1, pageIndex: 0 });
    useReaderStore.getState().prevPage();
    const s = useReaderStore.getState();
    expect(s.chapterIdx).toBe(0);
    expect(s.pctWithinChapter).toBe(1);
  });

  it('gotoChapter clamps and republishes pendingTarget', async () => {
    await useReaderStore.getState().open('aaaa1111');
    const before = useReaderStore.getState().pendingTarget?.seq ?? 0;
    useReaderStore.getState().gotoChapter(999);
    const s = useReaderStore.getState();
    expect(s.chapterIdx).toBe(1);   // clamped to last chapter (2 chapters)
    expect((s.pendingTarget?.seq ?? 0)).toBeGreaterThan(before);
  });

  it('savePos() debounces 1.5 s into a single save_position', async () => {
    await useReaderStore.getState().open('aaaa1111');
    const savesBefore = invokeCalls.filter((c) => c.cmd === 'save_position').length;
    useReaderStore.getState().savePos();
    useReaderStore.getState().savePos();
    vi.advanceTimersByTime(1499);
    expect(invokeCalls.filter((c) => c.cmd === 'save_position')).toHaveLength(savesBefore);
    vi.advanceTimersByTime(1);
    expect(invokeCalls.filter((c) => c.cmd === 'save_position').length).toBeGreaterThan(savesBefore);
  });

  it('globalPct() = (chapterIdx + pctWithinChapter) / totalChapters', async () => {
    await useReaderStore.getState().open('aaaa1111');
    useReaderStore.setState({ chapterIdx: 1, pctWithinChapter: 0.5 });
    // 2 chapters → (1 + 0.5) / 2 = 0.75
    expect(useReaderStore.getState().globalPct()).toBeCloseTo(0.75);
  });

  it('heartbeat flush records reading time while reader view is visible', async () => {
    await useReaderStore.getState().open('aaaa1111');
    useUiStore.setState({ view: 'reader' });
    useReaderStore.setState({ lastTickAt: Date.now() - 30_000, pendingPages: 4 });
    await useReaderStore.getState().flushHeartbeat();
    const tick = invokeCalls.find((c) => c.cmd === 'record_reading_tick');
    expect(tick).toBeTruthy();
    const args = tick!.args as { uid: string; seconds: number; pagesTurned: number };
    expect(args.seconds).toBeGreaterThanOrEqual(29);
    expect(args.pagesTurned).toBe(4);
    expect(useReaderStore.getState().pendingPages).toBe(0);
  });

  it('addBookmark then toggleBookmark removes it (local array stays in sync)', async () => {
    await useReaderStore.getState().open('aaaa1111');
    await useReaderStore.getState().toggleBookmark('/2/4');
    expect(useReaderStore.getState().book?.bookmarks).toHaveLength(1);
    await useReaderStore.getState().toggleBookmark('/2/4');
    expect(useReaderStore.getState().book?.bookmarks).toHaveLength(0);
  });
});
