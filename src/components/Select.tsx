/**
 * Select — base impl (scaffold-FE; F6 polished internals, props frozen).
 * Custom listbox with full keyboard nav. Search auto-enables above 8 options;
 * rendered rows are capped at 200 (type-ahead narrows long lists, e.g. fonts).
 *
 * Styling note: base.css's unlayered `button`/`input` resets outrank Tailwind's
 * `@layer utilities`, so the trigger and search field get their border/background/padding/
 * font-size from the scoped <style> block below rather than utilities that would lose.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';

const SELECT_CSS = `
.vellum-select-trigger{
  box-sizing:border-box;
  border:1px solid var(--v-border); border-radius:var(--radius-sm);
  background:var(--v-bg-alt); padding:0 10px; font-size:13px; color:var(--v-fg);
  cursor:pointer;
  transition:border-color var(--dur-fast) var(--ease);
}
.vellum-select-trigger[data-open="true"]{ border-color:var(--v-accent); }
.vellum-select-trigger:disabled{ opacity:.45; cursor:default; }
.vellum-select-search{ font-size:13px; }
`;

/** Search field appears automatically above this many options (§5.9 pickers). */
const SEARCH_THRESHOLD = 8;
/** Max rows rendered at once; query filtering narrows longer lists. */
const MAX_ROWS = 200;

export interface SelectOption {
  value: string;
  label: string;
  /** Muted secondary line (e.g. font family sample). */
  hint?: string;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  value: string | null;
  onChange: (value: string) => void;
  ariaLabel: string;
  /** Show a search box (font pickers, target language). */
  searchable?: boolean;
  searchPlaceholder?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  menuClassName?: string;
  /** Optional render override for an option row. */
  renderOption?: (o: SelectOption) => ReactNode;
}

export function Select({
  options, value, onChange, ariaLabel, searchable, searchPlaceholder = 'Search…',
  placeholder = 'Not selected', disabled, className, menuClassName, renderOption,
}: SelectProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Explicit prop wins; otherwise search appears once the list is long enough.
  const searchOn = searchable ?? options.length > SEARCH_THRESHOLD;

  const selected = options.find((o) => o.value === value) ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, MAX_ROWS);
    return options
      .filter((o) => o.label.toLowerCase().includes(q)
        || o.value.toLowerCase().includes(q))
      .slice(0, MAX_ROWS);
  }, [options, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      const idx = Math.max(0, filtered.findIndex((o) => o.value === value));
      setActive(idx);
      if (searchOn) setTimeout(() => searchRef.current?.focus(), 0);
      else listRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the active row visible. Guarded: environments without layout
  // (jsdom tests, SSR) do not implement scrollIntoView.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [active, open]);

  const commit = (i: number) => {
    const o = filtered[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (disabled) return;
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (open) commit(active);
        else setOpen(true);
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!open) { setOpen(true); break; }
        setActive((a) => Math.min(filtered.length - 1, a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) { setOpen(true); break; }
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Home':
        if (open) { e.preventDefault(); setActive(0); }
        break;
      case 'End':
        if (open) { e.preventDefault(); setActive(Math.max(0, filtered.length - 1)); }
        break;
      case 'Escape':
        if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
        break;
      case 'Tab':
        setOpen(false);
        break;
      default:
        break;
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <style>{SELECT_CSS}</style>
      <button
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? `${id}-list` : undefined}
        disabled={disabled}
        data-open={open}
        className="vellum-select-trigger flex h-8 w-full items-center justify-between gap-2"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onKeyDown}
      >
        <span className={cn('truncate', !selected && 'text-[var(--v-fg-muted)]')}>
          {selected?.label ?? placeholder}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
             className="shrink-0 text-[var(--v-fg-muted)]"
             style={{
               transform: open ? 'rotate(180deg)' : undefined,
               transition: 'transform var(--dur-fast) var(--ease)',
             }}
             aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className={cn(
            'vellum-panel vellum-scale-in absolute left-0 top-full z-50 mt-1 w-full overflow-hidden p-1',
            menuClassName,
          )}
          style={{ animationDuration: '120ms' }}
        >
          {searchOn && (
            <div className="p-1">
              <input
                ref={searchRef}
                type="text"
                value={query}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="vellum-select-search h-7 w-full"
                onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setActive(0); listRef.current?.focus(); }
                  else onKeyDown(e);
                }}
              />
            </div>
          )}
          <div
            id={`${id}-list`}
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel}
            tabIndex={-1}
            className="max-h-56 overflow-y-auto"
            onKeyDown={onKeyDown}
          >
            {filtered.length === 0 && (
              <p className="px-2 py-2 text-[12px] text-[var(--v-fg-muted)]">Nothing found</p>
            )}
            {filtered.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                data-active={i === active}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-sm)]',
                  'px-2 py-1.5 text-[13px]',
                  i === active && 'bg-[color-mix(in_srgb,var(--v-accent)_12%,transparent)]',
                  o.value === value && 'text-[var(--v-accent)]',
                  o.disabled && 'cursor-default opacity-40',
                )}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(i)}
              >
                {renderOption ? renderOption(o) : (
                  <>
                    <span className="truncate">{o.label}</span>
                    {o.hint && (
                      <span className="shrink-0 text-[11px] text-[var(--v-fg-muted)]">{o.hint}</span>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default Select;
