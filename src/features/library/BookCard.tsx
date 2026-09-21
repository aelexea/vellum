/**
 * BookCard — [F1] per ARCHITECTURE.md §5.5 / §6.9.
 *
 * Grid variant: 3:4 cover, title (2-line clamp), author, relative last-opened, 2 px accent
 * progress bar, hover lift (-2 px, 160 ms) + deepened shadow.
 * List variant: 56 px row with a mini cover, percent readout and always-visible ⋯.
 *
 * When no cover bytes exist (coverUrl null or the fetch failed) a deterministic gradient
 * — hue hashed from the uid — carries the serif title initials.
 *
 * The card itself is a button (role/tabIndex/aria-label "Open {title}"): Enter opens it,
 * Delete starts the removal confirm. Memoized — LibraryView passes stable callbacks only.
 */
import { memo, useCallback, useState } from 'react';
import type {
  CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent,
} from 'react';
import type { BookMeta } from '@/lib/types';
import { clamp, cn, fmtRelative } from '@/lib/utils';
import { ContextMenu, menuPosFromEvent } from '@/components/ContextMenu';
import type { ContextMenuItem } from '@/components/ContextMenu';

/** Actions offered by the card menu. */
export type BookAction = 'open' | 'tags' | 'stats' | 'delete';

/** §6.9 copy — exact strings. */
export const MENU_ITEMS: ContextMenuItem[] = [
  { id: 'open', label: 'Open' },
  { id: 'tags', label: 'Tags…' },
  { id: 'stats', label: 'Stats' },
  { id: 'delete', label: 'Delete', danger: true },
];

/** Stable uid hash → 0..359; same book always gets the same fallback cover. */
export function hueFromUid(uid: string): number {
  let h = 2166136261;
  for (let i = 0; i < uid.length; i += 1) {
    h ^= uid.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}

/**
 * Up to two uppercase initials for the fallback cover ("War and Peace" → "WP").
 * Single-character words (conjunctions like "and") are skipped when a longer word follows.
 */
export function titleInitials(title: string): string {
  const words = title.trim().split(/[\s—-]+/).filter(Boolean);
  if (words.length === 0) return '…';
  const meaningful = words.filter((w) => w.length > 1);
  const source = meaningful.length > 0 ? meaningful : words;
  const first = source[0]?.[0] ?? '';
  const second = source.length > 1 ? (source[1]?.[0] ?? '') : '';
  return (first + second).toUpperCase();
}

/** 0..1 progress → whole percent (bar width + list readout). */
export function pctOf(progress: number): number {
  return Math.round(clamp(progress, 0, 1) * 100);
}

export interface BookCardProps {
  book: BookMeta;
  /** 'grid' (cover tile) or 'list' (56 px row). */
  variant?: 'grid' | 'list';
  onOpen(book: BookMeta): void;
  onTags(book: BookMeta): void;
  onStats(book: BookMeta): void;
  onDelete(book: BookMeta): void;
}

const COVER_HOVER_SHADOW =
  '0 1px 3px color-mix(in srgb, var(--v-fg) 14%, transparent),'
  + ' 0 14px 32px color-mix(in srgb, var(--v-fg) 18%, transparent)';

function CoverFallback({ book, initialsSize }: { book: BookMeta; initialsSize: number }) {
  const hue = hueFromUid(book.uid);
  return (
    <div
      aria-hidden
      data-testid="cover-fallback"
      data-hue={hue}
      className="flex h-full w-full items-center justify-center"
      style={{
        background:
          `linear-gradient(160deg, hsl(${hue} 30% 44%), hsl(${(hue + 36) % 360} 24% 26%))`,
      }}
    >
      <span
        className="font-serif leading-none text-white/85"
        style={{ fontSize: initialsSize }}
      >
        {titleInitials(book.title)}
      </span>
    </div>
  );
}

/** 2 px accent bar pinned to the bottom of a cover (§5.5). */
function ProgressBar({ progress }: { progress: number }) {
  const pct = pctOf(progress);
  return (
    <div
      role="progressbar"
      aria-label="Progress"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className="absolute inset-x-0 bottom-0 h-[2px] bg-[color-mix(in_srgb,var(--v-fg)_14%,transparent)]"
    >
      <div
        data-testid="progress-bar"
        className="h-full bg-[var(--v-accent)]"
        style={{ width: `${pct}%`, transition: 'width var(--dur-med) var(--ease)' }}
      />
    </div>
  );
}

function MenuButton({
  floating, onClick, menuOpen,
}: {
  /** Grid: overlay in the cover corner, revealed on hover. List: inline, always visible. */
  floating: boolean;
  onClick(e: ReactMouseEvent<HTMLButtonElement>): void;
  menuOpen: boolean;
}) {
  return (
    <button
      type="button"
      aria-label="Book menu"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      data-testid="card-menu"
      data-open={menuOpen}
      onClick={onClick}
      className={cn(
        'vellum-icon-btn !h-7 !w-7 shrink-0 rounded-full',
        'bg-[color-mix(in_srgb,var(--v-bg-alt)_78%,transparent)] backdrop-blur-[2px]',
        'transition-opacity',
        floating && cn(
          'absolute right-1 top-1 z-10 opacity-0',
          'group-hover:opacity-100 focus-visible:opacity-100 data-[open=true]:opacity-100',
        ),
      )}
      style={{ transitionDuration: 'var(--dur-fast)', transitionTimingFunction: 'var(--ease)' }}
    >
      <span className="text-[15px] leading-none" aria-hidden>⋯</span>
    </button>
  );
}

function BookCardInner({
  book, variant = 'grid', onOpen, onTags, onStats, onDelete,
}: BookCardProps) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [coverFailed, setCoverFailed] = useState(false);

  const run = useCallback((action: BookAction) => {
    if (action === 'open') onOpen(book);
    else if (action === 'tags') onTags(book);
    else if (action === 'stats') onStats(book);
    else onDelete(book);
  }, [book, onOpen, onTags, onStats, onDelete]);

  const activate = useCallback(() => onOpen(book), [book, onOpen]);

  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      activate();
    } else if (e.key === 'Delete') {
      e.preventDefault();
      onDelete(book);
    }
  }, [activate, book, onDelete]);

  const openMenu = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenuAt(menuPosFromEvent(e));
  }, []);

  const menuOpen = menuAt !== null;
  const showFallback = book.coverUrl === null || coverFailed;
  const authors = book.authors.join(', ') || '—';

  const menuEl = menuOpen && (
    <ContextMenu
      open
      x={menuAt.x}
      y={menuAt.y}
      items={MENU_ITEMS}
      onSelect={(id) => run(id as BookAction)}
      onClose={() => setMenuAt(null)}
    />
  );

  if (variant === 'list') {
    return (
      <>
        <div
          role="button"
          tabIndex={0}
          aria-label={`Open ${book.title}`}
          data-testid="book-card"
          data-uid={book.uid}
          onClick={activate}
          onKeyDown={onKeyDown}
          onContextMenu={openMenu}
          className={cn(
            'group flex h-14 cursor-pointer items-center gap-3 rounded-[var(--radius-sm)] px-2',
            'transition-colors hover:bg-[color-mix(in_srgb,var(--v-fg)_5%,transparent)]',
            book.missing && 'opacity-60',
          )}
          style={{
            contentVisibility: 'auto',
            containIntrinsicSize: 'auto 56px',
            transitionDuration: 'var(--dur-fast)',
            transitionTimingFunction: 'var(--ease)',
          }}
        >
          <div
            className="relative h-full shrink-0 overflow-hidden rounded-[4px]"
            style={{ aspectRatio: '3 / 4', boxShadow: 'var(--v-shadow)' }}
          >
            {showFallback
              ? <CoverFallback book={book} initialsSize={13} />
              : (
                <img
                  src={book.coverUrl!}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="h-full w-full object-cover"
                  onError={() => setCoverFailed(true)}
                />
              )}
            <ProgressBar progress={book.progress} />
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium text-[var(--v-fg)]">{book.title}</p>
            <p className="truncate text-[12px] text-[var(--v-fg-muted)]">{authors}</p>
          </div>

          {book.missing && (
            <span
              data-testid="missing-badge"
              className="shrink-0 rounded-[var(--radius-sm)] border border-[var(--v-border)] px-1.5 py-0.5 text-[10px] text-[var(--v-fg-muted)]"
            >
              File unavailable
            </span>
          )}

          <span className="vellum-num w-11 shrink-0 text-right text-[12px] text-[var(--v-fg)]">
            {pctOf(book.progress)} %
          </span>
          <span className="w-24 shrink-0 text-right text-[11px] text-[var(--v-fg-muted)]">
            {book.lastOpenedAt !== null ? fmtRelative(book.lastOpenedAt) : ''}
          </span>

          <MenuButton floating={false} onClick={openMenu} menuOpen={menuOpen} />
        </div>
        {menuEl}
      </>
    );
  }

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${book.title}`}
        data-testid="book-card"
        data-uid={book.uid}
        onClick={activate}
        onKeyDown={onKeyDown}
        onContextMenu={openMenu}
        className={cn(
          'group flex cursor-pointer flex-col gap-2 outline-none',
          book.missing && 'opacity-60',
        )}
        style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 268px' }}
      >
        <div
          className={cn(
            'relative aspect-[3/4] w-full overflow-hidden rounded-[8px] bg-[var(--v-bg-raise)]',
            'shadow-[var(--v-shadow)] duration-[160ms] ease-[var(--ease)]',
            'transition-[transform,box-shadow]',
            'group-hover:-translate-y-0.5 group-hover:shadow-[var(--vellum-cover-hover-shadow)]',
          )}
          style={{ '--vellum-cover-hover-shadow': COVER_HOVER_SHADOW } as CSSProperties}
        >
          {showFallback
            ? <CoverFallback book={book} initialsSize={28} />
            : (
              <img
                src={book.coverUrl!}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
                onError={() => setCoverFailed(true)}
              />
            )}

          {book.missing && (
            <span
              data-testid="missing-badge"
              className="absolute left-1.5 top-1.5 rounded-[var(--radius-sm)] border border-[var(--v-border)] bg-[color-mix(in_srgb,var(--v-bg-alt)_85%,transparent)] px-1.5 py-0.5 text-[10px] text-[var(--v-fg-muted)]"
            >
              File unavailable
            </span>
          )}

          <ProgressBar progress={book.progress} />
          <MenuButton floating onClick={openMenu} menuOpen={menuOpen} />
        </div>

        <div className="min-w-0">
          <p
            className="text-[13px] font-medium leading-snug text-[var(--v-fg)]"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
            title={book.title}
          >
            {book.title}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-[var(--v-fg-muted)]" title={authors}>
            {authors}
          </p>
          <p className="mt-0.5 h-[16px] text-[11px] text-[var(--v-fg-muted)]">
            {book.lastOpenedAt !== null ? fmtRelative(book.lastOpenedAt) : ''}
          </p>
        </div>
      </div>
      {menuEl}
    </>
  );
}

export const BookCard = memo(BookCardInner);
export default BookCard;
