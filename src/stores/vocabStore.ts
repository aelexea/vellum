/**
 * vocabStore — FROZEN (scaffold-FE), full implementation per ARCHITECTURE.md §5.2/§4.6/§7.4/§7.6.
 * Word list with filters, review queue, stats, add/update/delete, lookup_word wiring
 * (sets `suggest` when the backend says suggestAdd — SuggestChip [F6] renders it).
 *
 * Framework-light: no React imports; components subscribe via useVocabStore.
 */
import { create } from 'zustand';
import type {
  LookupContext, LookupResult, ReviewResult, VocabPatch, VocabStats,
  VocabWord, VocabWordInput, VocabWordStatus,
} from '@/lib/types';
import * as api from '@/lib/tauri';
import { errMsg } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';

/** Data needed to prefill add_vocab_word from a lookup (§7.4 "Add to vocabulary"). */
export interface VocabSuggest {
  word: string;
  translation: string | null;
  definition: string | null;
  transcription: string | null;
  pos: string | null;
  context: string | null;
  contextCfi: string | null;
  bookUid: string | null;
  chapterIdx: number | null;
  lookupCount: number;
}

export interface VocabFilters {
  status: VocabWordStatus | null;
  bookUid: string | null;
  query: string | null;
  dueOnly: boolean;
}

export const EMPTY_VOCAB_STATS: VocabStats = {
  total: 0, byStatus: { new: 0, learning: 0, known: 0 },
  dueToday: 0, reviewsToday: 0, addedThisWeek: 0,
};

export interface VocabState {
  words: VocabWord[];
  queue: VocabWord[];
  queuePos: number;
  stats: VocabStats;
  filters: VocabFilters;
  loading: boolean;
  lastLookup: LookupResult | null;
  suggest: VocabSuggest | null;
  /** Words dismissed via the SuggestChip "×" — not re-suggested this session (§5.7). */
  dismissedSuggestions: string[];
  reviewedThisSession: number;

  load(filters?: Partial<VocabFilters>): Promise<void>;
  setFilters(patch: Partial<VocabFilters>): void;
  loadStats(): Promise<void>;

  add(input: VocabWordInput): Promise<VocabWord | null>;
  update(id: number, patch: VocabPatch): Promise<void>;
  remove(id: number): Promise<void>;
  /** Status pill click cycles new→learning→known (§5.8). */
  cycleStatus(id: number): Promise<void>;

  lookup(word: string, ctx: LookupContext | null): Promise<LookupResult | null>;
  setSuggest(s: VocabSuggest | null): void;
  dismissSuggest(): void;

  startReview(): Promise<void>;
  review(result: ReviewResult): Promise<void>;
  endReview(): void;

  exportTo(path: string, format: 'json' | 'csv' | 'anki'): Promise<number | null>;
  importFrom(path: string): Promise<number | null>;
}

export const useVocabStore = create<VocabState>()((set, get) => ({
  words: [],
  queue: [],
  queuePos: 0,
  stats: EMPTY_VOCAB_STATS,
  filters: { status: null, bookUid: null, query: null, dueOnly: false },
  loading: false,
  lastLookup: null,
  suggest: null,
  dismissedSuggestions: [],
  reviewedThisSession: 0,

  load: async (filters) => {
    const next = filters ? { ...get().filters, ...filters } : get().filters;
    if (filters) set({ filters: next });
    set({ loading: true });
    try {
      const [words, stats] = await Promise.all([
        api.listVocab(next.status, next.bookUid, next.query, next.dueOnly),
        api.vocabStats(),
      ]);
      set({ words, stats, loading: false });
    } catch (e) {
      set({ loading: false });
      console.warn('vocab load failed', e);
    }
  },

  setFilters: (patch) => void get().load(patch),

  loadStats: async () => {
    try {
      set({ stats: await api.vocabStats() });
    } catch (e) {
      console.warn('vocab_stats failed', e);
    }
  },

  add: async (input) => {
    try {
      const w = await api.addVocabWord(input);
      set((s) => ({ words: [w, ...s.words] }));
      void get().loadStats();
      useUiStore.getState().toast('Word added', 'success');
      return w;
    } catch (e) {
      useUiStore.getState().toast(errMsg(e), 'error');
      return null;
    }
  },

  update: async (id, patch) => {
    try {
      const w = await api.updateVocabWord(id, patch);
      set((s) => ({
        words: s.words.map((x) => (x.id === id ? w : x)),
        queue: s.queue.map((x) => (x.id === id ? w : x)),
      }));
      void get().loadStats();
    } catch (e) {
      useUiStore.getState().toast(errMsg(e), 'error');
    }
  },

  remove: async (id) => {
    try {
      await api.deleteVocabWord(id);
      set((s) => ({
        words: s.words.filter((w) => w.id !== id),
        queue: s.queue.filter((w) => w.id !== id),
      }));
      void get().loadStats();
    } catch (e) {
      useUiStore.getState().toast(errMsg(e), 'error');
    }
  },

  cycleStatus: async (id) => {
    const w = get().words.find((x) => x.id === id);
    if (!w) return;
    const order: VocabWordStatus[] = ['new', 'learning', 'known'];
    const next = order[(order.indexOf(w.status) + 1) % order.length];
    await get().update(id, { status: next });
  },

  lookup: async (word, ctx) => {
    try {
      const res = await api.lookupWord(word, ctx);
      set({ lastLookup: res });
      if (
        res.suggestAdd && !res.alreadyInVocab
        && !get().dismissedSuggestions.includes(res.word.toLowerCase())
      ) {
        set({
          suggest: {
            word: res.word,
            translation: res.translation?.translatedText ?? null,
            definition: res.dictionary?.meanings[0]?.definitions[0]?.definition ?? null,
            transcription: res.dictionary?.transcription ?? null,
            pos: res.dictionary?.meanings[0]?.pos ?? null,
            context: ctx?.sentence ?? null,
            contextCfi: ctx?.cfi ?? null,
            bookUid: ctx?.bookUid ?? null,
            chapterIdx: ctx?.chapterIdx ?? null,
            lookupCount: res.lookupCount,
          },
        });
      }
      return res;
    } catch (e) {
      useUiStore.getState().toast(errMsg(e), 'error');
      set({ lastLookup: null });
      return null;
    }
  },

  setSuggest: (s) => set({ suggest: s }),

  dismissSuggest: () => {
    const s = get().suggest;
    set((st) => ({
      suggest: null,
      dismissedSuggestions: s
        ? [...st.dismissedSuggestions, s.word.toLowerCase()]
        : st.dismissedSuggestions,
    }));
  },

  startReview: async () => {
    try {
      const queue = await api.getReviewQueue(null);
      set({ queue, queuePos: 0, reviewedThisSession: 0 });
      if (queue.length === 0) {
        useUiStore.getState().toast('No words due for review', 'info');
      }
    } catch (e) {
      useUiStore.getState().toast(errMsg(e), 'error');
    }
  },

  review: async (result) => {
    const { queue, queuePos } = get();
    const card = queue[queuePos];
    if (!card) return;
    try {
      const updated = await api.recordReview(card.id, result);
      set((s) => ({
        queue: s.queue.map((w) => (w.id === updated.id ? updated : w)),
        words: s.words.map((w) => (w.id === updated.id ? updated : w)),
        queuePos: s.queuePos + 1,
        reviewedThisSession: s.reviewedThisSession + 1,
      }));
      void get().loadStats();
      // Queue exhausted → caller (ReviewSession [F4]) shows the summary; we keep
      // queuePos === queue.length as the "done" signal.
    } catch (e) {
      useUiStore.getState().toast(errMsg(e), 'error');
    }
  },

  endReview: () => {
    const n = get().reviewedThisSession;
    set({ queue: [], queuePos: 0, reviewedThisSession: 0 });
    if (n > 0) useUiStore.getState().toast(`Words reviewed: ${n}`, 'success');
  },

  exportTo: async (path, format) => {
    try {
      const n = await api.exportVocab(path, format);
      useUiStore.getState().toast('Done', 'success');
      return n;
    } catch (e) {
      useUiStore.getState().toast(errMsg(e), 'error');
      return null;
    }
  },

  importFrom: async (path) => {
    try {
      const n = await api.importVocab(path);
      useUiStore.getState().toast(`Words added: ${n}`, 'success');
      await get().load();
      return n;
    } catch (e) {
      useUiStore.getState().toast(errMsg(e), 'error');
      return null;
    }
  },
}));
