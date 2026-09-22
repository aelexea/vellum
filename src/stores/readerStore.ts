/**
 * readerStore — FROZEN (scaffold-FE), full implementation per ARCHITECTURE.md §5.2/§5.4/§7.
 * Book/chapter/page state, pending navigation target consumed by ChapterFrame [F2],
 * selection, debounced position save, annotation CRUD passthroughs, reading heartbeat.
 *
 * Framework-light: no React imports; components subscribe via useReaderStore.
 */
import { create } from 'zustand';
import type {
  Highlight, LookupContext, Note, OpenBook, ReadingPosition,
} from '@/lib/types';
import * as api from '@/lib/tauri';
import { clamp, debounce, errMsg } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';

export interface SelectionState {
  text: string;
  cfiStart: string;
  cfiEnd: string;
  /** Viewport px rect of the iframe (§5.3 SelectionInfo). */
  rect: { x: number; y: number; width: number; height: number };
  sentence: string;
  word: string | undefined;
}

/** Navigation request published by the store and consumed by ChapterFrame [F2]. */
export interface PendingTarget {
  seq: number;                     // monotonic; ChapterFrame reacts to changes
  chapterIdx?: number;
  cfi?: string;
  pageIndex?: number;
  pct?: number;                    // within-chapter 0..1
}

export interface ReaderState {
  book: OpenBook | null;
  loading: boolean;
  chapterIdx: number;
  pageIndex: number;
  pageCount: number;
  mode: 'paginated' | 'scroll';
  pctWithinChapter: number;
  selection: SelectionState | null;
  pendingTarget: PendingTarget | null;
  indexStatus: OpenBook['indexStatus'];
  /** Latest CFI of the reading head — maintained by ChapterFrame [F2]. */
  lastCfi: string | null;

  open(uid: string): Promise<void>;
  close(): Promise<void>;

  gotoChapter(i: number): void;
  gotoCfi(cfi: string, chapterIdx?: number): void;
  gotoPct(pct: number): void;
  nextPage(): void;
  prevPage(): void;
  setPage(i: number): void;
  setPctWithinChapter(pct: number): void;
  setMode(mode: 'paginated' | 'scroll'): void;
  setSelection(sel: SelectionState | null): void;
  setLastCfi(cfi: string | null): void;

  /** Debounced (1.5 s) — also flushed on chapter change/close (§5.2). */
  savePos(): void;
  savePosNow(): Promise<void>;
  globalPct(): number;

  addHighlight(cfiStart: string, cfiEnd: string, color: string, text: string): Promise<Highlight | null>;
  updateHighlight(id: number, color: string): Promise<void>;
  removeHighlight(id: number): Promise<void>;
  addNote(cfiStart: string, cfiEnd: string, selectedText: string, noteText: string): Promise<Note | null>;
  updateNote(id: number, noteText: string): Promise<void>;
  removeNote(id: number): Promise<void>;
  toggleBookmark(cfi: string, label?: string | null): Promise<void>;
  removeBookmark(id: number): Promise<void>;

  /** §7.4 — dictionary lookup; vocabStore stores the result, overlay shows DictPopup. */
  lookup(word: string, ctx: LookupContext | null): Promise<void>;

  startHeartbeat(): void;
  stopHeartbeat(): void;
  /** Page-turn delta fed to the heartbeat (§7.3). */
  accruePage(delta?: number): void;
  flushHeartbeat(): Promise<void>;

  setIndexStatus(s: OpenBook['indexStatus']): void;

  /** @internal heartbeat accumulators (kept in-store so close() can flush them). */
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  pendingSeconds: number;
  pendingPages: number;
  lastTickAt: number;
}

const HEARTBEAT_MS = 30_000;

let targetSeq = 1;

const debouncedSave = debounce((uid: string, pos: ReadingPosition) => {
  void api.savePosition(uid, pos).catch((e) => console.error('save_position failed', e));
}, 1500);

export const useReaderStore = create<ReaderState>()((set, get) => {
  /** Build a ReadingPosition from current state (§5.4 globalPct formula). */
  const buildPosition = (): ReadingPosition | null => {
    const s = get();
    if (!s.book) return null;
    return {
      cfi: s.lastCfi,
      chapterIdx: s.chapterIdx,
      pctWithinChapter: s.pctWithinChapter,
      pageIndex: s.mode === 'paginated' ? s.pageIndex : null,
      pageCount: s.mode === 'paginated' ? s.pageCount : null,
      mode: s.mode,
      globalPct: s.globalPct(),
      savedAt: Date.now(),
    };
  };

  return {
    book: null,
    loading: false,
    chapterIdx: 0,
    pageIndex: 0,
    pageCount: 0,
    mode: 'paginated',
    pctWithinChapter: 0,
    selection: null,
    pendingTarget: null,
    indexStatus: { state: 'none', chaptersDone: 0, chaptersTotal: 0 },
    lastCfi: null,
    heartbeatTimer: null,
    pendingSeconds: 0,
    pendingPages: 0,
    lastTickAt: Date.now(),

    setLastCfi: (cfi) => set({ lastCfi: cfi }),

    open: async (uid) => {
      set({ loading: true });
      try {
        const ob = await api.openBook(uid);
        const pos = ob.position;
        // A saved position wins (per-book memory); otherwise honour the global
        // Settings → Reading preference instead of always defaulting to paginated.
        const { useSettingsStore } = await import('@/stores/settingsStore');
        const preferredMode = useSettingsStore.getState().settings.reading.mode;
        set({
          book: ob,
          loading: false,
          chapterIdx: pos?.chapterIdx ?? 0,
          pageIndex: pos?.pageIndex ?? 0,
          pageCount: pos?.pageCount ?? 0,
          mode: pos?.mode ?? preferredMode,
          pctWithinChapter: pos?.pctWithinChapter ?? 0,
          selection: null,
          indexStatus: ob.indexStatus,
          lastCfi: pos?.cfi ?? null,
          pendingSeconds: 0,
          pendingPages: 0,
          lastTickAt: Date.now(),
          // ChapterFrame restores the exact reading head once layout is done.
          pendingTarget: pos
            ? {
              seq: targetSeq++, chapterIdx: pos.chapterIdx, cfi: pos.cfi ?? undefined,
              pageIndex: pos.pageIndex ?? undefined, pct: pos.pctWithinChapter,
            }
            : { seq: targetSeq++, chapterIdx: 0, pageIndex: 0, pct: 0 },
        });
        get().startHeartbeat();
        get().savePos();
      } catch (e) {
        set({ loading: false });
        useUiStore.getState().toast(errMsg(e), 'error');
        throw e;
      }
    },

    close: async () => {
      get().stopHeartbeat();
      await get().flushHeartbeat();
      debouncedSave.flush();
      await get().savePosNow();
      set({
        book: null, chapterIdx: 0, pageIndex: 0, pageCount: 0,
        selection: null, pendingTarget: null, lastCfi: null,
        pctWithinChapter: 0, pendingSeconds: 0, pendingPages: 0,
      });
    },

    gotoChapter: (i) => {
      const s = get();
      if (!s.book) return;
      const total = s.book.book.chapters.length;
      if (total === 0) return;
      const idx = clamp(i, 0, total - 1);
      // Leaving a chapter persists the old position immediately (§5.2).
      debouncedSave.flush();
      set({
        chapterIdx: idx, pageIndex: 0, pctWithinChapter: 0, lastCfi: null,
        pendingTarget: { seq: targetSeq++, chapterIdx: idx, pageIndex: 0, pct: 0 },
      });
      get().savePos();
    },

    gotoCfi: (cfi, chapterIdx) => {
      const s = get();
      if (!s.book) return;
      const idx = chapterIdx ?? s.chapterIdx;
      set({
        lastCfi: cfi,
        ...(idx !== s.chapterIdx ? { chapterIdx: idx } : {}),
        pendingTarget: { seq: targetSeq++, chapterIdx: idx, cfi },
      });
      get().savePos();
    },

    gotoPct: (pct) => {
      set({ pendingTarget: { seq: targetSeq++, chapterIdx: get().chapterIdx, pct } });
    },

    nextPage: () => {
      const s = get();
      if (!s.book) return;
      const total = s.book.book.chapters.length;
      const atEnd = s.pageCount > 0 && s.pageIndex >= s.pageCount - 1;
      if (atEnd) {
        if (s.chapterIdx < total - 1) get().gotoChapter(s.chapterIdx + 1);
        return;
      }
      set((st) => ({ pageIndex: st.pageIndex + 1 }));
      get().accruePage(1);
      get().savePos();
    },

    prevPage: () => {
      const s = get();
      if (!s.book) return;
      if (s.pageIndex > 0) {
        set((st) => ({ pageIndex: st.pageIndex - 1 }));
        get().accruePage(-1);
        get().savePos();
        return;
      }
      if (s.chapterIdx > 0) {
        // Enter the previous chapter at its end; ChapterFrame resolves the last page.
        debouncedSave.flush();
        const idx = s.chapterIdx - 1;
        set({
          chapterIdx: idx, pageIndex: 0, pctWithinChapter: 1, lastCfi: null,
          pendingTarget: { seq: targetSeq++, chapterIdx: idx, pct: 1 },
        });
        get().savePos();
      }
    },

    setPage: (i) => set({ pageIndex: Math.max(0, i) }),

    setPctWithinChapter: (pct) => set({ pctWithinChapter: clamp(pct, 0, 1) }),

    setMode: (mode) => {
      set({ mode });
      get().savePos();
    },

    setSelection: (sel) => set({ selection: sel }),

    savePos: () => {
      const s = get();
      if (!s.book) return;
      const pos = buildPosition();
      if (pos) debouncedSave(s.book.book.uid, pos);
    },

    savePosNow: async () => {
      const s = get();
      if (!s.book) return;
      const pos = buildPosition();
      if (!pos) return;
      try {
        await api.savePosition(s.book.book.uid, pos);
      } catch (e) {
        console.error('save_position failed', e);
      }
    },

    globalPct: () => {
      const s = get();
      if (!s.book) return 0;
      const total = s.book.book.chapters.length || 1;
      return clamp((s.chapterIdx + s.pctWithinChapter) / total, 0, 1);
    },

    // -----------------------------------------------------------------------
    // Annotations — CRUD passthroughs keeping local arrays in sync (§5.2)
    // -----------------------------------------------------------------------

    addHighlight: async (cfiStart, cfiEnd, color, text) => {
      const s = get();
      if (!s.book) return null;
      try {
        const hl = await api.addHighlight(s.book.book.uid, s.chapterIdx, cfiStart, cfiEnd, color, text);
        set((st) => (st.book ? { book: { ...st.book, highlights: [...st.book.highlights, hl] } } : {}));
        return hl;
      } catch (e) {
        useUiStore.getState().toast(errMsg(e), 'error');
        return null;
      }
    },

    updateHighlight: async (id, color) => {
      try {
        await api.updateHighlight(id, color);
        set((st) => (st.book
          ? {
            book: {
              ...st.book,
              highlights: st.book.highlights.map((h) => (h.id === id ? { ...h, color } : h)),
            },
          }
          : {}));
      } catch (e) {
        useUiStore.getState().toast(errMsg(e), 'error');
      }
    },

    removeHighlight: async (id) => {
      try {
        await api.deleteHighlight(id);
        set((st) => (st.book
          ? { book: { ...st.book, highlights: st.book.highlights.filter((h) => h.id !== id) } }
          : {}));
      } catch (e) {
        useUiStore.getState().toast(errMsg(e), 'error');
      }
    },

    addNote: async (cfiStart, cfiEnd, selectedText, noteText) => {
      const s = get();
      if (!s.book) return null;
      try {
        const note = await api.addNote(
          s.book.book.uid, s.chapterIdx, cfiStart, cfiEnd, selectedText, noteText,
        );
        set((st) => (st.book
          ? {
            book: {
              ...st.book,
              notes: [...st.book.notes, note],
              // A note attached to an existing highlight sets hasNote (§4.1).
              highlights: st.book.highlights.map((h) =>
                h.cfiStart === cfiStart && h.cfiEnd === cfiEnd ? { ...h, hasNote: true } : h),
            },
          }
          : {}));
        return note;
      } catch (e) {
        useUiStore.getState().toast(errMsg(e), 'error');
        return null;
      }
    },

    updateNote: async (id, noteText) => {
      try {
        await api.updateNote(id, noteText);
        set((st) => (st.book
          ? {
            book: {
              ...st.book,
              notes: st.book.notes.map((n) =>
                n.id === id ? { ...n, noteText, updatedAt: Date.now() } : n),
            },
          }
          : {}));
      } catch (e) {
        useUiStore.getState().toast(errMsg(e), 'error');
      }
    },

    removeNote: async (id) => {
      const s = get();
      if (!s.book) return;
      const victim = s.book.notes.find((n) => n.id === id);
      try {
        await api.deleteNote(id);
        set((st) => (st.book
          ? {
            book: {
              ...st.book,
              notes: st.book.notes.filter((n) => n.id !== id),
              // Clear hasNote on the highlight that carried this note (same range).
              highlights: victim
                ? st.book.highlights.map((h) =>
                  h.cfiStart === victim.cfiStart && h.cfiEnd === victim.cfiEnd
                    ? { ...h, hasNote: false }
                    : h)
                : st.book.highlights,
            },
          }
          : {}));
      } catch (e) {
        useUiStore.getState().toast(errMsg(e), 'error');
      }
    },

    toggleBookmark: async (cfi, label = null) => {
      const s = get();
      if (!s.book) return;
      const existing = s.book.bookmarks.find(
        (b) => b.chapterIdx === s.chapterIdx && b.cfi === cfi,
      );
      if (existing) {
        await get().removeBookmark(existing.id);
        return;
      }
      try {
        const bm = await api.addBookmark(s.book.book.uid, s.chapterIdx, cfi, label);
        set((st) => (st.book ? { book: { ...st.book, bookmarks: [...st.book.bookmarks, bm] } } : {}));
      } catch (e) {
        useUiStore.getState().toast(errMsg(e), 'error');
      }
    },

    removeBookmark: async (id) => {
      try {
        await api.deleteBookmark(id);
        set((st) => (st.book
          ? { book: { ...st.book, bookmarks: st.book.bookmarks.filter((b) => b.id !== id) } }
          : {}));
      } catch (e) {
        useUiStore.getState().toast(errMsg(e), 'error');
      }
    },

    lookup: async (word, ctx) => {
      await useVocabStore.getState().lookup(word, ctx);
      useUiStore.getState().setOverlay('dict');
    },

    // -----------------------------------------------------------------------
    // Heartbeat (§5.2/§7.7): 30 s interval while reader view is visible
    // -----------------------------------------------------------------------

    startHeartbeat: () => {
      if (get().heartbeatTimer) return;
      set({ lastTickAt: Date.now() });
      const timer = setInterval(() => {
        const st = get();
        if (!st.book) return;
        if (useUiStore.getState().view !== 'reader') return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        void st.flushHeartbeat();
      }, HEARTBEAT_MS);
      set({ heartbeatTimer: timer });
    },

    stopHeartbeat: () => {
      const s = get();
      if (s.heartbeatTimer) clearInterval(s.heartbeatTimer);
      set({ heartbeatTimer: null });
    },

    accruePage: (delta = 1) => set((st) => ({ pendingPages: st.pendingPages + delta })),

    flushHeartbeat: async () => {
      const s = get();
      const now = Date.now();
      const elapsed = Math.max(0, Math.round((now - s.lastTickAt) / 1000));
      const seconds = s.pendingSeconds + elapsed;
      const pages = s.pendingPages;
      if (!s.book) {
        set({ pendingSeconds: 0, pendingPages: 0, lastTickAt: now });
        return;
      }
      set({ pendingSeconds: 0, pendingPages: 0, lastTickAt: now });
      if (seconds <= 0 && pages <= 0) return;
      try {
        await api.recordReadingTick(s.book.book.uid, seconds, pages);
      } catch (e) {
        // Put the delta back so the next tick retries rather than losing reading time.
        set((st) => ({
          pendingSeconds: st.pendingSeconds + seconds,
          pendingPages: st.pendingPages + pages,
        }));
        console.error('record_reading_tick failed', e);
      }
    },

    setIndexStatus: (st) => set({ indexStatus: st }),
  };
});
