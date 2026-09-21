/**
 * libraryStore — FROZEN (scaffold-FE), full implementation per ARCHITECTURE.md §5.2/§5.5/§7.1.
 * Book list, tags, client-side filter/sort via list_books(LibraryFilter), import flows
 * through dialog helpers, import-progress event subscription for the top progress bar.
 *
 * Framework-light: no React imports; components subscribe via useLibraryStore.
 */
import { create } from 'zustand';
import type { BookMeta, ImportProgressEvent, ImportReport, LibraryFilter, Tag } from '@/lib/types';
import * as api from '@/lib/tauri';
import { onEvent } from '@/lib/tauri';
import { errMsg } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';

export const DEFAULT_FILTER: LibraryFilter = {
  query: null, tag: null, sort: 'lastOpened', sortDesc: true, missing: 'hide',
};

export interface ImportProgress {
  done: number;
  total: number;
  current: string;
}

export interface LibraryState {
  books: BookMeta[];
  tags: Tag[];
  filter: LibraryFilter;
  loading: boolean;
  importing: boolean;
  importProgress: ImportProgress | null;

  load(): Promise<void>;
  setFilter(patch: Partial<LibraryFilter>): void;
  resetFilter(): void;

  /** "Add books" — dialog multi-select .epub → import_books (§7.1). */
  importPaths(paths?: string[]): Promise<ImportReport | null>;
  /** "Scan folder" — dialog folder → scan_directory. */
  scanDir(dir?: string): Promise<ImportReport | null>;
  rescan(): Promise<void>;

  setTags(uid: string, tags: string[]): Promise<void>;
  /** Remove book; `andFile` also deletes the file from disk (§6.9 confirm flow). */
  remove(uid: string, andFile: boolean): Promise<void>;

  subscribeEvents(): Promise<void>;
  unsubscribeEvents(): void;
}

let unsubscribes: (() => void)[] = [];
let subscribed = false;

function reportToast(rep: ImportReport | null): void {
  if (!rep) return;
  const ui = useUiStore.getState();
  if (rep.imported.length > 0) {
    ui.toast(`Books added: ${rep.imported.length}`, 'success');
  }
  for (const f of rep.failed.slice(0, 3)) {
    ui.toast(`Error: ${f.path} — ${f.reason}`, 'error');
  }
}

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  books: [],
  tags: [],
  filter: { ...DEFAULT_FILTER },
  loading: false,
  importing: false,
  importProgress: null,

  load: async () => {
    set({ loading: true });
    try {
      const [books, tags] = await Promise.all([
        api.listBooks(get().filter),
        api.listTags(),
      ]);
      set({ books, tags, loading: false });
    } catch (e) {
      set({ loading: false });
      console.warn('library load failed', e);
    }
  },

  setFilter: (patch) => {
    const filter = { ...get().filter, ...patch };
    set({ filter });
    void get().load();
  },

  resetFilter: () => {
    set({ filter: { ...DEFAULT_FILTER } });
    void get().load();
  },

  importPaths: async (paths) => {
    const ui = useUiStore.getState();
    let picked = paths;
    if (!picked) {
      try {
        const res = await api.openFiles();
        if (!res || res.length === 0) return null;
        picked = res;
      } catch (e) {
        ui.toast(errMsg(e), 'error');
        return null;
      }
    }
    set({ importing: true, importProgress: { done: 0, total: picked.length, current: '' } });
    try {
      const rep = await api.importBooks(picked);
      reportToast(rep);
      await get().load();
      return rep;
    } catch (e) {
      ui.toast(errMsg(e), 'error');
      return null;
    } finally {
      set({ importing: false, importProgress: null });
    }
  },

  scanDir: async (dir) => {
    const ui = useUiStore.getState();
    let target = dir;
    if (!target) {
      try {
        const res = await api.openDir();
        if (!res) return null;
        target = res;
      } catch (e) {
        ui.toast(errMsg(e), 'error');
        return null;
      }
    }
    set({ importing: true });
    try {
      const rep = await api.scanDirectory(target);
      reportToast(rep);
      await get().load();
      return rep;
    } catch (e) {
      ui.toast(errMsg(e), 'error');
      return null;
    } finally {
      set({ importing: false, importProgress: null });
    }
  },

  rescan: async () => {
    set({ importing: true });
    try {
      await api.rescanLibrary();
      await get().load();
    } catch (e) {
      console.warn('rescan failed', e);
    } finally {
      set({ importing: false });
    }
  },

  setTags: async (uid, tags) => {
    try {
      await api.setBookTags(uid, tags);
      // Optimistic local update + refresh tag counts.
      set((s) => ({
        books: s.books.map((b) => (b.uid === uid ? { ...b, tags } : b)),
      }));
      const fresh = await api.listTags();
      set({ tags: fresh });
    } catch (e) {
      useUiStore.getState().toast(errMsg(e), 'error');
    }
  },

  remove: async (uid, andFile) => {
    try {
      await api.deleteBook(uid, andFile);
      set((s) => ({ books: s.books.filter((b) => b.uid !== uid) }));
      const fresh = await api.listTags();
      set({ tags: fresh });
    } catch (e) {
      useUiStore.getState().toast(errMsg(e), 'error');
    }
  },

  subscribeEvents: async () => {
    if (subscribed) return;
    subscribed = true;
    try {
      const un1 = await onEvent<ImportProgressEvent>('import-progress', (p) => {
        set({ importProgress: { done: p.done, total: p.total, current: p.current } });
      });
      const un2 = await onEvent<{ bookUid: string }>('index-done', () => {
        // Index state changes book metadata; a cheap reload keeps badges fresh.
        void get().load();
      });
      unsubscribes = [un1, un2];
    } catch (e) {
      subscribed = false;
      console.warn('event subscription unavailable', e);
    }
  },

  unsubscribeEvents: () => {
    for (const u of unsubscribes) u();
    unsubscribes = [];
    subscribed = false;
  },
}));
