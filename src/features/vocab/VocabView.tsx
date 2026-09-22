/**
 * VocabView — [F4] per ARCHITECTURE.md §5.8/§6.9.
 * Word list: search (debounce 150 ms → vocabStore.load), status segmented with counts,
 * book filter, local sort, review entry point, context jump, status pill cycling,
 * row menu (edit / delete). No virtualisation (< 5k rows) but rows opt into
 * `content-visibility: auto`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContextMenu, menuPosFromEvent } from '@/components/ContextMenu';
import { Icon } from '@/components/icons';
import { Segmented } from '@/components/Segmented';
import type { SegmentedOption } from '@/components/Segmented';
import { Select } from '@/components/Select';
import type { SelectOption } from '@/components/Select';
import { Spinner } from '@/components/Spinner';
import WordEditor from '@/features/vocab/WordEditor';
import type { VocabWord, VocabWordStatus } from '@/lib/types';
import { debounce } from '@/lib/utils';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';

export type StatusFilter = 'all' | VocabWordStatus;
export type SortKey = 'added' | 'due' | 'alpha';

export const STATUS_LABEL: Record<VocabWordStatus, string> = {
  new: 'New',
  learning: 'Learning',
  known: 'Known',
};

const DAY_MS = 86_400_000;
const SEARCH_DEBOUNCE_MS = 150;

function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * §6.9 due copy: 'today' / 'tomorrow' / 'in {n}d' / 'overdue'.
 * Null when the word has no due date yet (never reviewed, status 'new').
 */
export function fmtDue(dueAt: number | null, now: number = Date.now()): string | null {
  if (dueAt === null) return null;
  if (dueAt < now) return 'overdue';
  const days = Math.round((dayStart(dueAt) - dayStart(now)) / DAY_MS);
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days}d`;
}

/** Local sort (§5.8 sort select): added (newest first) / due (nulls first, like the SRS queue) / alpha. */
export function sortWords(words: VocabWord[], key: SortKey): VocabWord[] {
  const out = [...words];
  switch (key) {
    case 'added':
      out.sort((a, b) => b.addedAt - a.addedAt);
      break;
    case 'due':
      out.sort((a, b) => (a.dueAt ?? Number.NEGATIVE_INFINITY) - (b.dueAt ?? Number.NEGATIVE_INFINITY));
      break;
    case 'alpha':
      out.sort((a, b) => a.word.localeCompare(b.word, 'ru'));
      break;
  }
  return out;
}

/** Fixed hues for the pill tints (theme-independent, §5.8 allows color-mix here). */
const PILL_STYLE: Record<VocabWordStatus, { color: string; background: string; border: string }> = {
  new: { color: 'var(--v-fg-muted)', background: 'transparent', border: '1px solid var(--v-border)' },
  learning: {
    color: 'var(--v-accent)',
    background: 'color-mix(in srgb, var(--v-accent) 14%, transparent)',
    border: '1px solid transparent',
  },
  known: {
    color: 'color-mix(in srgb, #3f9a55 88%, var(--v-fg))',
    background: 'color-mix(in srgb, #3f9a55 16%, transparent)',
    border: '1px solid transparent',
  },
};

const OVERDUE_COLOR = 'color-mix(in srgb, #c2524a 85%, var(--v-fg))';

const SORT_OPTIONS: SelectOption[] = [
  { value: 'added', label: 'Date added' },
  { value: 'due', label: 'Review due' },
  { value: 'alpha', label: 'Alphabetical' },
];

export default function VocabView() {
  const words = useVocabStore((s) => s.words);
  const stats = useVocabStore((s) => s.stats);
  const filters = useVocabStore((s) => s.filters);
  const loading = useVocabStore((s) => s.loading);

  const [query, setQuery] = useState(filters.query ?? '');
  const [sort, setSort] = useState<SortKey>('added');
  const [editing, setEditing] = useState<VocabWord | null>(null);
  const [menu, setMenu] = useState<{ word: VocabWord; x: number; y: number } | null>(null);

  // Search → vocabStore.load, debounced 150 ms (§5.8).
  const runSearch = useRef(
    debounce((q: string) => {
      void useVocabStore.getState().load({ query: q.trim() === '' ? null : q.trim() });
    }, SEARCH_DEBOUNCE_MS),
  ).current;
  useEffect(() => () => runSearch.cancel(), [runSearch]);

  useEffect(() => {
    void useVocabStore.getState().load();
  }, []);

  const statusFilter: StatusFilter = filters.status ?? 'all';

  const statusOptions = useMemo<SegmentedOption<StatusFilter>[]>(() => [
    { value: 'all', label: 'All', count: stats.total },
    { value: 'new', label: STATUS_LABEL.new, count: stats.byStatus.new },
    { value: 'learning', label: STATUS_LABEL.learning, count: stats.byStatus.learning },
    { value: 'known', label: STATUS_LABEL.known, count: stats.byStatus.known },
  ], [stats]);

  const bookOptions = useMemo<SelectOption[]>(() => {
    const seen = new Map<string, string>();
    for (const w of words) {
      if (w.bookUid && w.bookTitle) seen.set(w.bookUid, w.bookTitle);
    }
    return [
      { value: 'all', label: 'All books' },
      ...[...seen.entries()].map(([uid, title]) => ({ value: uid, label: title })),
    ];
  }, [words]);

  const visible = useMemo(() => sortWords(words, sort), [words, sort]);

  const onStatusChange = useCallback((v: StatusFilter) => {
    void useVocabStore.getState().load({ status: v === 'all' ? null : v });
  }, []);

  const onBookChange = useCallback((v: string) => {
    void useVocabStore.getState().load({ bookUid: v === 'all' ? null : v });
  }, []);

  /** Context line → open the book, then jump to the saved CFI (§5.8). */
  const jumpToContext = useCallback(async (w: VocabWord) => {
    if (!w.bookUid) return;
    await useUiStore.getState().openBook(w.bookUid);
    if (w.contextCfi) {
      useReaderStore.getState().gotoCfi(w.contextCfi, w.chapterIdx ?? undefined);
    }
  }, []);

  const onDelete = useCallback(async (w: VocabWord) => {
    const ok = await useUiStore.getState().confirm({
      title: `Delete word “${w.word}”?`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (ok) await useVocabStore.getState().remove(w.id);
  }, []);

  const onMenuSelect = useCallback((id: string) => {
    const target = menu?.word;
    setMenu(null);
    if (!target) return;
    if (id === 'edit') setEditing(target);
    else if (id === 'delete') void onDelete(target);
  }, [menu, onDelete]);

  return (
    <div className="vellum-fade-in flex h-full flex-col" style={{ animationDuration: '160ms' }}>
      {/* ------------------------------------------------------------ header */}
      <header className="flex flex-col gap-3 border-b border-[var(--v-border)] px-5 py-3.5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="vellum-icon-btn -ml-1.5"
            aria-label="Back to library"
            title="Back to library"
            onClick={() => useUiStore.getState().setView('library')}
          >
            <Icon name="arrowLeft" size={18} />
          </button>
          <h1 className="text-[17px] font-semibold tracking-[-0.01em]">Study vocabulary</h1>
          <div className="flex-1" />
          <button
            type="button"
            className="vellum-btn vellum-btn-accent"
            onClick={() => useUiStore.getState().setOverlay('review')}
          >
            <Icon name="play" size={13} />
            Review
            {stats.dueToday > 0 && (
              <span className="ml-0.5 inline-flex items-center gap-1.5">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-[var(--v-accent-fg)]"
                  aria-hidden
                />
                <span className="vellum-num text-[12px]">{stats.dueToday}</span>
              </span>
            )}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--v-fg-muted)]">
              <Icon name="search" size={14} />
            </span>
            <input
              type="text"
              value={query}
              placeholder="Search words…"
              aria-label="Search word"
              className="h-8 w-full pl-7 text-[13px]"
              onChange={(e) => {
                setQuery(e.target.value);
                runSearch(e.target.value);
              }}
            />
          </div>

          <Segmented
            options={statusOptions}
            value={statusFilter}
            onChange={onStatusChange}
            ariaLabel="Word status"
          />

          <Select
            options={bookOptions}
            value={filters.bookUid ?? 'all'}
            onChange={onBookChange}
            ariaLabel="Book"
            className="w-[170px]"
          />

          <Select
            options={SORT_OPTIONS}
            value={sort}
            onChange={(v) => setSort(v as SortKey)}
            ariaLabel="Sort"
            className="w-[168px]"
          />
        </div>
      </header>

    {/* -------------------------------------------------------------- list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {loading && words.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-[var(--v-fg-muted)]">
            <Spinner size={20} />
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 py-16 text-center">
            <p className="text-[15px] font-medium">No words yet</p>
            <p className="max-w-[320px] text-[13px] text-[var(--v-fg-muted)]">
              Select words while reading and tap Add to vocabulary
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {visible.map((w) => {
              const due = fmtDue(w.dueAt);
              return (
                <div
                  key={w.id}
                  data-testid="vocab-row"
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 rounded-[var(--radius)] border border-transparent px-3 py-2 transition-colors hover:border-[var(--v-border)] hover:bg-[var(--v-bg-alt)]"
                  style={{
                    contentVisibility: 'auto',
                    containIntrinsicSize: 'auto 64px',
                    transitionDuration: 'var(--dur-fast)',
                    transitionTimingFunction: 'var(--ease)',
                  }}
                >
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-[15px] font-semibold">{w.word}</span>
                      {w.transcription && (
                        <span className="shrink-0 text-[11px] text-[var(--v-fg-muted)]">
                          {w.transcription}
                        </span>
                      )}
                    </div>

                    {w.translation && (
                      <p className="line-clamp-1 text-[13px] text-[var(--v-fg)]">{w.translation}</p>
                    )}

                    {w.context && (
                      <button
                        type="button"
                        data-testid="vocab-context"
                        className="mt-0.5 block max-w-full text-left text-[12px] text-[var(--v-fg-muted)] hover:text-[var(--v-accent)]"
                        style={{ transitionDuration: 'var(--dur-fast)' }}
                        onClick={() => void jumpToContext(w)}
                        title="Go to place in book"
                      >
                        <span className="line-clamp-1 italic">
                          {w.context}
                          {w.bookTitle && (
                            <span className="not-italic">
                              {' · '}
                              {w.bookTitle}
                              {w.chapterIdx !== null && ` · chapter ${w.chapterIdx + 1}`}
                            </span>
                          )}
                        </span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {due && (
                      <span
                        className="vellum-num whitespace-nowrap text-[11px]"
                        style={{ color: due === 'overdue' ? OVERDUE_COLOR : 'var(--v-fg-muted)' }}
                      >
                        {due}
                      </span>
                    )}

                    <button
                      type="button"
                      data-testid="vocab-status-pill"
                      aria-label={`Status: ${STATUS_LABEL[w.status]}`}
                      className="whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11px] font-medium"
                      style={{
                        ...PILL_STYLE[w.status],
                        transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease)',
                      }}
                      onClick={() => void useVocabStore.getState().cycleStatus(w.id)}
                    >
                      {STATUS_LABEL[w.status]}
                    </button>

                    <button
                      type="button"
                      className="vellum-icon-btn h-7 w-7 text-[15px] leading-none"
                      aria-label="Actions"
                      onClick={(e) => setMenu({ word: w, ...menuPosFromEvent(e) })}
                    >
                      ⋯
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ----------------------------------------------------------- overlays */}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={[
          { id: 'edit', label: 'Edit', icon: <Icon name="edit" size={14} /> },
          { id: 'delete', label: 'Delete', danger: true, icon: <Icon name="trash" size={14} /> },
        ]}
        onSelect={onMenuSelect}
        onClose={() => setMenu(null)}
      />

      {editing && (
        <WordEditor
          key={editing.id}
          word={editing}
          onClose={() => {
            setEditing(null);
            void useVocabStore.getState().loadStats();
          }}
        />
      )}
    </div>
  );
}
