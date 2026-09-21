/**
 * Segmented — base impl (scaffold-FE; props frozen).
 * Pill switcher (view toggle, annotation tabs, stats range…).
 *
 * Styling note: base.css's unlayered `button` reset (padding/font/background/color) outranks
 * Tailwind's `@layer utilities`, so the pill's padding, font-size, weight and active colours
 * come from the scoped <style> block below rather than utilities that would silently lose.
 */
import { cn } from '@/lib/utils';

const SEGMENTED_CSS = `
.vellum-seg-btn{
  border:0; font-weight:500; line-height:1; cursor:pointer;
  background:none; color:var(--v-fg-muted);
  transition:color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease);
}
.vellum-seg-btn:hover{ color:var(--v-fg); }
.vellum-seg-btn[data-size="sm"]{ padding:4px 8px; font-size:11px; }
.vellum-seg-btn[data-size="md"]{ padding:4px 10px; font-size:12px; }
.vellum-seg-btn[data-active="true"]{ background:var(--v-bg-raise); color:var(--v-fg); }
.vellum-seg-btn:disabled{ opacity:.4; cursor:default; }
`;

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Optional small count badge ("Highlights 12"). */
  count?: number;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  className?: string;
}

export function Segmented<T extends string>({
  options, value, onChange, ariaLabel, size = 'md', className,
}: SegmentedProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center gap-0.5 rounded-[var(--radius)] border border-[var(--v-border)] bg-[var(--v-bg)] p-0.5',
        className,
      )}
    >
      <style>{SEGMENTED_CSS}</style>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            data-active={active}
            data-size={size}
            className={cn(
              'vellum-seg-btn inline-flex items-center gap-1.5 rounded-[var(--radius-sm)]',
              active && 'shadow-sm',
            )}
            onClick={() => onChange(o.value)}
          >
            {o.label}
            {o.count !== undefined && (
              <span className="vellum-num text-[10px] opacity-70">{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default Segmented;
