/**
 * TagsBar — [F1] per ARCHITECTURE.md §5.5 / §6.9.
 *
 * Chip row: "All tags" + one chip per tag with its book count. The active chip is
 * accent-tinted. A trailing "File unavailable" chip toggles filter.missing between
 * 'hide' and 'only'; it renders only while some book is actually missing, so the
 * missing-file state stays reachable without cluttering an all-present library.
 *
 * Filter changes go through libraryStore.setFilter (frozen store owns list_books).
 */
import { useCallback } from 'react';
import { cn } from '@/lib/utils';
import { useLibraryStore } from '@/stores/libraryStore';
import type { LibraryFilter } from '@/lib/types';

const CHIP_BASE = cn(
  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]',
  'transition-colors',
);
const CHIP_MOTION = {
  transitionDuration: 'var(--dur-fast)',
  transitionTimingFunction: 'var(--ease)',
} as const;

function chipTone(active: boolean): string {
  return cn(
    CHIP_BASE,
    active
      ? cn(
        'border-[color-mix(in_srgb,var(--v-accent)_45%,transparent)]',
        'bg-[color-mix(in_srgb,var(--v-accent)_14%,transparent)]',
        'text-[var(--v-accent)]',
      )
      : cn(
        'border-[var(--v-border)] bg-transparent text-[var(--v-fg-muted)]',
        'hover:bg-[color-mix(in_srgb,var(--v-fg)_6%,transparent)] hover:text-[var(--v-fg)]',
      ),
  );
}

export interface TagsBarProps {
  className?: string;
}

export function TagsBar({ className }: TagsBarProps) {
  const tags = useLibraryStore((s) => s.tags);
  const filter = useLibraryStore((s) => s.filter);
  const setFilter = useLibraryStore((s) => s.setFilter);
  const missingCount = useLibraryStore((s) => s.books.reduce((n, b) => n + (b.missing ? 1 : 0), 0));

  const pickTag = useCallback((tag: string | null) => {
    setFilter({ tag });
  }, [setFilter]);

  const toggleMissing = useCallback(() => {
    const next: LibraryFilter['missing'] = filter.missing === 'only' ? 'hide' : 'only';
    setFilter({ missing: next });
  }, [filter.missing, setFilter]);

  const allActive = filter.tag === null;

  return (
    <div
      data-testid="tags-bar"
      className={cn(
        'flex items-center gap-2 overflow-x-auto border-b border-[var(--v-border)] px-5 py-2',
        className,
      )}
      style={{ scrollbarWidth: 'none' }}
    >
      <button
        type="button"
        data-testid="chip-all"
        aria-pressed={allActive}
        onClick={() => pickTag(null)}
        className={chipTone(allActive)}
        style={CHIP_MOTION}
      >
        All tags
      </button>

      {tags.map((t) => {
        const active = filter.tag === t.name;
        return (
          <button
            key={t.id}
            type="button"
            data-testid={`chip-tag-${t.name}`}
            aria-pressed={active}
            onClick={() => pickTag(active ? null : t.name)}
            className={chipTone(active)}
            style={CHIP_MOTION}
          >
            <span className="truncate">{t.name}</span>
            <span className="vellum-num text-[11px] opacity-70">{t.count}</span>
          </button>
        );
      })}

      {missingCount > 0 && (
        <button
          type="button"
          data-testid="chip-missing"
          aria-pressed={filter.missing === 'only'}
          onClick={toggleMissing}
          className={cn(chipTone(filter.missing === 'only'), 'ml-auto')}
          style={CHIP_MOTION}
        >
          File unavailable
          <span className="vellum-num text-[11px] opacity-70">{missingCount}</span>
        </button>
      )}
    </div>
  );
}

export default TagsBar;
