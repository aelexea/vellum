/**
 * Pure UI utilities. FROZEN (scaffold-FE) — API per ARCHITECTURE.md §11.6.
 */

/** Join class names, dropping falsy values. */
export function cn(...classes: (string | false | null | undefined | 0)[]): string {
  return classes.filter(Boolean).join(' ');
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
  flush(): void;
}

/** Debounce with `.cancel()` (drop pending) and `.flush()` (fire pending now). */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;

  const debounced = (...args: A): void => {
    lastArgs = args;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = lastArgs;
      lastArgs = null;
      if (a) fn(...a);
    }, ms);
  };
  debounced.cancel = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      const a = lastArgs;
      lastArgs = null;
      if (a) fn(...a);
    }
  };
  return debounced;
}

export function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** English plural: 1 → singular, everything else → plural ("day"/"days"). */
function plural(n: number, one: string, many: string): string {
  return Math.abs(n) === 1 ? one : many;
}

/** Seconds → "2h 15m" / "45m" / "1h". Under a minute → "0m". */
export function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** unix ms → "Oct 12". Same year → month+day; other years append year. */
export function fmtDate(ts: number): string {
  const d = new Date(ts);
  const dayMonth = `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
  if (d.getFullYear() === new Date().getFullYear()) return dayMonth;
  return `${dayMonth} ${d.getFullYear()}`;
}

/**
 * unix ms → "just now" (< 1 min) / "N min ago" / "yesterday" (previous calendar day,
 * < 7 days) / "N days ago" (< 30 days) / else fmtDate.
 * Day counts use Math.round so a DST transition inside the span can't shift them.
 */
export function fmtRelative(ts: number): string {
  const now = Date.now();
  const diffMs = now - ts;
  if (diffMs < 60_000) return 'just now';

  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin} min ago`;

  const dayStart = (t: number): number => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((dayStart(now) - dayStart(ts)) / 86_400_000);
  if (days === 0) return `${Math.floor(diffMs / 3_600_000)} h ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} ${plural(days, 'day', 'days')} ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `${weeks} ${plural(weeks, 'week', 'weeks')} ago`;
  }
  return fmtDate(ts);
}

/** HTML-escape (for anything interpolated into snippet HTML). */
export function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Lowercase, non-alnum → '-', trimmed/collapsed dashes (theme ids, anchors). */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-+|-+$/g, '');
}

/** Tauri rejects with the AppError string (§4.2); normalise for toasts. */
export function errMsg(e: unknown): string {
  if (typeof e === 'string') return `Error: ${e}`;
  if (e instanceof Error) return `Error: ${e.message}`;
  return 'Error: unknown error';
}

/** Copy text to clipboard; resolves false on failure. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
