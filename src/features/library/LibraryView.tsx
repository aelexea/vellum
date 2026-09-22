/**
 * LibraryView — [F1] per ARCHITECTURE.md §5.5 / §5.11 / §6.9.
 *
 * Header: "Vellum" wordmark, instant search, sort select, grid/list toggle, and the two
 * import buttons ("Add books" → dialog multi-select, "Scan folder" → dialog folder).
 * ImportBar rides under the header; TagsBar holds the chip row; content is a cover grid or a
 * list of 56 px rows.
 *
 * Filtering/sorting is derived client-side from libraryStore.books for instant feedback while
 * the same filter is written back through the frozen store's setFilter (so list_books keeps the
 * backend copy in sync).
 *
 * Drag & drop: Tauri 2 intercepts window drops natively, so real paths arrive through
 * `getCurrentWebview().onDragDropEvent` (loaded dynamically — the module is unavailable outside
 * the Tauri webview, e.g. under vitest). Plain DOM drop is handled too, but WebKitGTK exposes no
 * file path on `File`, so when nothing extractable arrives we show the retry hint instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import type { BookMeta, LibraryFilter } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useLibraryStore } from '@/stores/libraryStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { Icon } from '@/components/icons';
import { Modal } from '@/components/Modal';
import { Select } from '@/components/Select';
import type { SelectOption } from '@/components/Select';
import { Spinner } from '@/components/Spinner';
import BookCard from '@/features/library/BookCard';
import ImportBar from '@/features/library/ImportBar';
import TagsBar from '@/features/library/TagsBar';

/** §6.9 sort labels → LibraryFilter.sort values. */
export const SORT_OPTIONS: SelectOption[] = [
  { value: 'lastOpened', label: 'Recently opened' },
  { value: 'title', label: 'Title' },
  { value: 'author', label: 'Author' },
  { value: 'progress', label: 'Progress' },
  { value: 'added', label: 'Date added' },
];

const DROP_HINT = 'Drag files again or use the button';

/** Case-insensitive substring match over title + authors (§5.5 "filter by title/author"). */
function matchesQuery(book: BookMeta, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  if (book.title.toLowerCase().includes(needle)) return true;
  return book.authors.some((a) => a.toLowerCase().includes(needle));
}

function sortValue(book: BookMeta, sort: LibraryFilter['sort']): number | string {
  switch (sort) {
    case 'title': return book.title.toLowerCase();
    case 'author': return (book.authors[0] ?? '').toLowerCase();
    case 'progress': return book.progress;
    case 'added': return book.addedAt;
    case 'percent': return book.progress;
    case 'lastOpened':
    default: return book.lastOpenedAt ?? 0;
  }
}

/** Pure filter+sort over the store's books (query, tag, missing, sort/sortDesc). */
export function selectBooks(books: BookMeta[], filter: LibraryFilter): BookMeta[] {
  const query = filter.query ?? '';
  const out = books.filter((b) => {
    if (filter.missing === 'hide' && b.missing) return false;
    if (filter.missing === 'only' && !b.missing) return false;
    if (filter.tag !== null && !b.tags.includes(filter.tag)) return false;
    return matchesQuery(b, query);
  });

  const dir = filter.sortDesc ? -1 : 1;
  out.sort((a, b) => {
    const va = sortValue(a, filter.sort);
    const vb = sortValue(b, filter.sort);
    if (typeof va === 'string' || typeof vb === 'string') {
      return String(va).localeCompare(String(vb), 'ru') * dir;
    }
    if (va === vb) return b.addedAt - a.addedAt;   // stable tie-break: newest first
    return (va < vb ? -1 : 1) * dir;
  });
  return out;
}

/** 96 px open-book line drawing (§5.5 empty state): 1.5 px strokes, currentColor. */
function EmptyBookArt() {
  return (
    <svg
      width="96" height="72" viewBox="0 0 96 72" fill="none"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden data-testid="empty-art"
    >
      <path d="M48 18C40 12 27 10 14 12v40c13-2 26 0 34 6" />
      <path d="M48 18c8-6 21-8 34-6v40c-13-2-26 0-34 6" />
      <path d="M48 18v40" />
      <path d="M24 26h14M24 34h14M24 42h10" />
      <path d="M58 26h14M58 34h14M58 42h10" />
    </svg>
  );
}

/** "Tags…" modal: toggle existing tags, type a new one and press Enter to add it. */
function TagsModal({
  book, tags, onClose,
}: {
  book: BookMeta;
  tags: string[];
  onClose: () => void;
}) {
  const setTags = useLibraryStore((s) => s.setTags);
  const [selected, setSelected] = useState<string[]>(book.tags);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const toggle = useCallback((name: string) => {
    setSelected((cur) => (cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name]));
  }, []);

  const commitDraft = useCallback(() => {
    const name = draft.trim();
    if (name === '') return;
    setSelected((cur) => (cur.includes(name) ? cur : [...cur, name]));
    setDraft('');
  }, [draft]);

  const save = useCallback(async () => {
    setSaving(true);
    await setTags(book.uid, selected);
    setSaving(false);
    onClose();
  }, [book.uid, onClose, selected, setTags]);

  return (
    <Modal
      onClose={onClose}
      title="Tags"
      widthClass="max-w-sm"
      footer={(
        <>
          <button type="button" className="vellum-btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="vellum-btn vellum-btn-accent"
            disabled={saving}
            onClick={() => { void save(); }}
          >
            Save
          </button>
        </>
      )}
    >
      <p className="truncate text-[12px] text-[var(--v-fg-muted)]" title={book.title}>
        {book.title}
      </p>

      <div data-testid="tags-modal" className="mt-3 flex flex-wrap gap-1.5">
        {tags.length === 0 && selected.length === 0 && (
          <p className="text-[12px] text-[var(--v-fg-muted)]">No tags yet</p>
        )}
        {Array.from(new Set([...tags, ...selected])).map((name) => {
          const on = selected.includes(name);
          return (
            <button
              key={name}
              type="button"
              data-testid={`tag-chip-${name}`}
              aria-pressed={on}
              onClick={() => toggle(name)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
                on
                  ? cn(
                    'border-[color-mix(in_srgb,var(--v-accent)_45%,transparent)]',
                    'bg-[color-mix(in_srgb,var(--v-accent)_14%,transparent)] text-[var(--v-accent)]',
                  )
                  : 'border-[var(--v-border)] text-[var(--v-fg-muted)] hover:text-[var(--v-fg)]',
              )}
              style={{
                transitionDuration: 'var(--dur-fast)',
                transitionTimingFunction: 'var(--ease)',
              }}
            >
              {name}
            </button>
          );
        })}
      </div>

      <input
        type="text"
        value={draft}
        autoFocus
        data-testid="tag-input"
        placeholder="New tag"
        aria-label="New tag"
        className="mt-3 h-8 w-full text-[13px]"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); commitDraft(); }
        }}
        onBlur={commitDraft}
      />
    </Modal>
  );
}

export function LibraryView() {
  const books = useLibraryStore((s) => s.books);
  const tags = useLibraryStore((s) => s.tags);
  const filter = useLibraryStore((s) => s.filter);
  const loading = useLibraryStore((s) => s.loading);
  const importing = useLibraryStore((s) => s.importing);
  const setFilter = useLibraryStore((s) => s.setFilter);
  const importPaths = useLibraryStore((s) => s.importPaths);
  const scanDir = useLibraryStore((s) => s.scanDir);
  const removeBook = useLibraryStore((s) => s.remove);

  const view = useSettingsStore((s) => s.settings.library.view);
  const patchSettings = useSettingsStore((s) => s.patch);

  const openBook = useUiStore((s) => s.openBook);
  const toast = useUiStore((s) => s.toast);
  const setView = useUiStore((s) => s.setView);
  const confirmWithCheck = useUiStore((s) => s.confirmWithCheck);

  const [tagTarget, setTagTarget] = useState<BookMeta | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [query, setQuery] = useState(filter.query ?? '');
  const dropDepth = useRef(0);

  const visible = useMemo(() => selectBooks(books, filter), [books, filter]);
  const hasMissing = useMemo(() => books.some((b) => b.missing), [books]);

  // ------------------------------------------------------------ settings sync
  // Honor the persisted default view/sort once (§5.9 "Library: default view/sort").
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current) return;
    synced.current = true;
    const lib = useSettingsStore.getState().settings.library;
    if (lib.sort !== filter.sort || lib.sortDesc !== filter.sortDesc) {
      setFilter({ sort: lib.sort, sortDesc: lib.sortDesc });
    }
  }, [filter.sort, filter.sortDesc, setFilter]);

  // ------------------------------------------------------------ search (instant)
  // Query filtering is pure client-side over the loaded books (§5.5 "instant"): write
  // filter.query directly without a list_books round-trip per keystroke. Discrete actions
  // (sort/tag/missing) go through setFilter, which does reload from the store.
  const onSearchChange = useCallback((value: string) => {
    setQuery(value);
    useLibraryStore.setState((s) => ({
      filter: { ...s.filter, query: value.trim() === '' ? null : value.trim() },
    }));
  }, []);

  // ------------------------------------------------------------ actions
  const handleOpen = useCallback((book: BookMeta) => {
    void openBook(book.uid);
  }, [openBook]);

  const handleTags = useCallback((book: BookMeta) => setTagTarget(book), []);

  const handleStats = useCallback((_book: BookMeta) => {
    // Interim: per-book stats live in the stats view (F4 owns it).
    setView('stats');
  }, [setView]);

  const handleDelete = useCallback(async (book: BookMeta) => {
    const res = await confirmWithCheck({
      title: `Delete book “${book.title}”?`,
      checkboxLabel: 'Delete file from disk',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (res.ok) await removeBook(book.uid, res.checked);
  }, [confirmWithCheck, removeBook]);

  const onAddBooks = useCallback(() => { void importPaths(); }, [importPaths]);
  const onScanDir = useCallback(() => { void scanDir(); }, [scanDir]);

  const onViewChange = useCallback((next: 'grid' | 'list') => {
    patchSettings({ library: { view: next } });
  }, [patchSettings]);

  const onSortChange = useCallback((value: string) => {
    const sort = value as LibraryFilter['sort'];
    // Picking a field also resets the direction to the natural one for it:
    // text sorts read A→Я ascending (localeCompare stays on the 'ru' locale), date/progress
    // read newest/largest first.
    const sortDesc = sort === 'title' || sort === 'author' ? false : true;
    setFilter({ sort, sortDesc });
    patchSettings({ library: { sort, sortDesc } });
  }, [patchSettings, setFilter]);

  const onToggleDesc = useCallback(() => {
    setFilter({ sortDesc: !filter.sortDesc });
    patchSettings({ library: { sortDesc: !filter.sortDesc } });
  }, [filter.sortDesc, patchSettings, setFilter]);

  // ------------------------------------------------------------ import via drop
  const importDropped = useCallback((paths: string[]) => {
    const epubs = paths.filter((p) => p.toLowerCase().endsWith('.epub'));
    if (epubs.length === 0) {
      toast(DROP_HINT, 'info');
      return;
    }
    void importPaths(epubs);
  }, [importPaths, toast]);

  // Native Tauri drop events carry real filesystem paths (§4.8 import_books).
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const internals = (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
        if (!internals) return;                     // not a Tauri webview (tests/browser)
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const off = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === 'enter' || payload.type === 'over') setDragOver(true);
          else if (payload.type === 'leave') setDragOver(false);
          else if (payload.type === 'drop') {
            setDragOver(false);
            importDropped(payload.paths);
          }
        });
        if (cancelled) off();
        else unlisten = off;
      } catch {
        // Webview API unavailable — DOM drop below still works when paths are exposed.
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [importDropped]);

  // DOM drag & drop: preventDefault so the webview doesn't navigate away from the app.
  const onDragEnter = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    dropDepth.current += 1;
    if (e.dataTransfer.types.includes('Files')) setDragOver(true);
  }, []);

  const onDragOver = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragLeave = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    dropDepth.current = Math.max(0, dropDepth.current - 1);
    if (dropDepth.current === 0) setDragOver(false);
  }, []);

  const onDrop = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    dropDepth.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    // WebKitGTK leaves File.path empty; only an exposed path can be imported.
    const paths = files
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => typeof p === 'string' && p !== '');
    if (paths.length === 0) {
      if (files.length > 0) toast(DROP_HINT, 'info');
      return;
    }
    importDropped(paths);
  }, [importDropped, toast]);

  // ------------------------------------------------------------ render
  const isEmptyLibrary = books.length === 0 && !loading;
  const noMatches = !isEmptyLibrary && visible.length === 0;

  return (
    <div
      data-testid="library-view"
      className="flex h-full w-full flex-col bg-[var(--v-bg)] text-[var(--v-fg)]"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {/* ---------------------------------------------------------------- header */}
      <header className="relative shrink-0 border-b border-[var(--v-border)]">
        <div className="flex items-center gap-4 px-5 py-3">
          <h1
            className="shrink-0 select-none text-[15px] font-semibold tracking-[0.22em] text-[var(--v-fg)]"
            data-testid="wordmark"
          >
            Vellum
          </h1>

          <div className="relative min-w-0 flex-1 max-w-sm">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--v-fg-muted)]">
              <Icon name="search" size={15} />
            </span>
            <input
              type="search"
              value={query}
              data-testid="search-input"
              placeholder="Search books…"
              aria-label="Search books…"
              onChange={(e) => onSearchChange(e.target.value)}
              className="h-8 w-full pl-8 pr-2 text-[13px]"
            />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Select
              options={SORT_OPTIONS}
              value={filter.sort}
              onChange={onSortChange}
              ariaLabel="Sort"
              className="w-44"
              menuClassName="w-44"
            />
            <button
              type="button"
              className="vellum-icon-btn"
              aria-label={filter.sortDesc ? 'Ascending' : 'Descending'}
              title={filter.sortDesc ? 'Descending' : 'Ascending'}
              data-testid="sort-dir"
              onClick={onToggleDesc}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                   style={{
                     transform: filter.sortDesc ? 'none' : 'rotate(180deg)',
                     transition: 'transform var(--dur-fast) var(--ease)',
                   }}>
                <path d="M12 5v14M6 13l6 6 6-6" />
              </svg>
            </button>

            <div className="flex items-center gap-0.5" role="group" aria-label="View">
              <button
                type="button"
                className="vellum-icon-btn"
                aria-label="Grid"
                aria-pressed={view === 'grid'}
                data-active={view === 'grid'}
                data-testid="view-grid"
                onClick={() => onViewChange('grid')}
              >
                <Icon name="columns" size={17} />
              </button>
              <button
                type="button"
                className="vellum-icon-btn"
                aria-label="List"
                aria-pressed={view === 'list'}
                data-active={view === 'list'}
                data-testid="view-list"
                onClick={() => onViewChange('list')}
              >
                <Icon name="toc" size={17} />
              </button>
            </div>

            <span className="mx-1 h-5 w-px shrink-0 bg-[var(--v-border)]" aria-hidden />

            {/* Global navigation — library is the only view with no chrome bars. */}
            <div className="flex items-center gap-0.5" role="group" aria-label="Navigate">
              <button
                type="button"
                className="vellum-icon-btn"
                aria-label="Vocabulary"
                title="Vocabulary"
                data-testid="nav-vocab"
                onClick={() => setView('vocab')}
              >
                <Icon name="book" size={17} />
              </button>
              <button
                type="button"
                className="vellum-icon-btn"
                aria-label="Statistics"
                title="Statistics"
                data-testid="nav-stats"
                onClick={() => setView('stats')}
              >
                <Icon name="columns" size={17} />
              </button>
              <button
                type="button"
                className="vellum-icon-btn"
                aria-label="Settings"
                title="Settings"
                data-testid="nav-settings"
                onClick={() => setView('settings')}
              >
                <Icon name="settings" size={17} />
              </button>
            </div>

            <span className="mx-1 h-5 w-px shrink-0 bg-[var(--v-border)]" aria-hidden />

            <button
              type="button"
              className="vellum-btn vellum-btn-accent shrink-0"
              disabled={importing}
              data-testid="add-books"
              onClick={onAddBooks}
            >
              <Icon name="plus" size={15} />
              Add books
            </button>
            <button
              type="button"
              className="vellum-btn shrink-0"
              disabled={importing}
              data-testid="scan-dir"
              onClick={onScanDir}
            >
              <Icon name="layers" size={15} />
              Scan folder
            </button>
          </div>
        </div>

        <ImportBar />
      </header>

      {/* The bar also carries the "File unavailable" chip, so it stays reachable while any
          book is missing even with no tags defined. */}
      {tags.length > 0 || filter.tag !== null || hasMissing ? <TagsBar /> : null}

      {/* --------------------------------------------------------------- content */}
      <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading && books.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[var(--v-fg-muted)]">
            <Spinner size={22} />
          </div>
        ) : isEmptyLibrary || noMatches ? (
          <div
            data-testid="empty-state"
            className="flex h-full flex-col items-center justify-center gap-3 text-center"
          >
            {isEmptyLibrary ? (
              <>
                <div className="text-[var(--v-fg-muted)] opacity-70"><EmptyBookArt /></div>
                <p className="text-[15px] font-medium text-[var(--v-fg)]">
                  Add your first book
                </p>
                <p className="max-w-xs text-[13px] text-[var(--v-fg-muted)]">
                  Choose EPUB files or a folder of books
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <button
                    type="button"
                    className="vellum-btn vellum-btn-accent"
                    data-testid="empty-add"
                    disabled={importing}
                    onClick={onAddBooks}
                  >
                    <Icon name="plus" size={15} />
                    Add books
                  </button>
                  <button
                    type="button"
                    className="vellum-btn"
                    data-testid="empty-scan"
                    disabled={importing}
                    onClick={onScanDir}
                  >
                    <Icon name="layers" size={15} />
                    Scan folder
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-[14px] text-[var(--v-fg)]">Nothing found</p>
                <button
                  type="button"
                  className="vellum-btn vellum-btn-ghost"
                  data-testid="reset-filter"
                  onClick={() => {
                    setQuery('');
                    setFilter({ query: null, tag: null, missing: 'hide' });
                  }}
                >
                  Reset filters
                </button>
              </>
            )}
          </div>
        ) : view === 'grid' ? (
          <div
            data-testid="grid"
            className="grid gap-5"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))' }}
          >
            {visible.map((book) => (
              <BookCard
                key={book.uid}
                book={book}
                variant="grid"
                onOpen={handleOpen}
                onTags={handleTags}
                onStats={handleStats}
                onDelete={(b) => { void handleDelete(b); }}
              />
            ))}
          </div>
        ) : (
          <div data-testid="list" className="flex flex-col gap-0.5">
            {visible.map((book) => (
              <BookCard
                key={book.uid}
                book={book}
                variant="list"
                onOpen={handleOpen}
                onTags={handleTags}
                onStats={handleStats}
                onDelete={(b) => { void handleDelete(b); }}
              />
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------- drop veil */}
      {dragOver && (
        <div
          data-testid="drop-overlay"
          className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center vellum-fade-in"
          style={{ animationDuration: '120ms' }}
        >
          <div className="absolute inset-3 rounded-[var(--radius)] border border-dashed border-[var(--v-accent)] bg-[color-mix(in_srgb,var(--v-accent)_7%,transparent)]" />
          <span className="relative rounded-full border border-[var(--v-border)] bg-[var(--v-bg-alt)] px-3 py-1.5 text-[13px] text-[var(--v-fg)] shadow-[var(--v-shadow)]">
            Drop EPUB files
          </span>
        </div>
      )}

      {tagTarget !== null && (
        <TagsModal
          book={tagTarget}
          tags={tags.map((t) => t.name)}
          onClose={() => setTagTarget(null)}
        />
      )}
    </div>
  );
}

export default LibraryView;
