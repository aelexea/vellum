import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  cn, clamp, debounce, esc, fmtDate, fmtDuration, fmtRelative, slug,
} from '@/lib/utils';

describe('cn', () => {
  it('joins truthy class names', () => {
    expect(cn('a', false, 'b', null, undefined, 'c')).toBe('a b c');
    expect(cn()).toBe('');
  });
});

describe('clamp', () => {
  it('clamps to bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe('debounce', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once after quiet period', () => {
    const fn = vi.fn();
    const d = debounce(fn, 400);
    d(1); d(2); d(3);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(399);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3); // last args win
  });

  it('cancel() drops the pending call', () => {
    const fn = vi.fn();
    const d = debounce(fn, 400);
    d('x');
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('flush() fires immediately', () => {
    const fn = vi.fn();
    const d = debounce(fn, 400);
    d('y');
    d.flush();
    expect(fn).toHaveBeenCalledWith('y');
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1); // not fired twice
  });
});

describe('fmtDuration', () => {
  it('formats hours+minutes compactly', () => {
    expect(fmtDuration(2 * 3600 + 15 * 60)).toBe('2h 15m');
    expect(fmtDuration(3600)).toBe('1h');
    expect(fmtDuration(45 * 60)).toBe('45m');
    expect(fmtDuration(30)).toBe('0m');
    expect(fmtDuration(0)).toBe('0m');
  });
});

describe('fmtRelative', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('"just now" under a minute', () => {
    vi.setSystemTime(new Date('2026-03-10T12:00:00'));
    expect(fmtRelative(Date.now() - 30_000)).toBe('just now');
  });

  it('minutes ago', () => {
    vi.setSystemTime(new Date('2026-03-10T12:00:00'));
    expect(fmtRelative(Date.now() - 5 * 60_000)).toBe('5 min ago');
    expect(fmtRelative(Date.now() - 60_000)).toBe('1 min ago');
  });

  it('"yesterday" for the previous calendar day', () => {
    vi.setSystemTime(new Date('2026-03-10T12:00:00'));
    const yesterday = new Date('2026-03-09T18:00:00').getTime();
    expect(fmtRelative(yesterday)).toBe('yesterday');
  });

  it('correct plural for day/days and week/weeks', () => {
    vi.setSystemTime(new Date('2026-03-20T12:00:00'));
    // Calendar-based so DST transitions can't shift the day count.
    const daysAgo = (n: number) => {
      const d = new Date('2026-03-20T09:00:00');
      d.setDate(d.getDate() - n);
      return d.getTime();
    };
    expect(fmtRelative(daysAgo(1))).toBe('yesterday');
    expect(fmtRelative(daysAgo(2))).toBe('2 days ago');
    expect(fmtRelative(daysAgo(3))).toBe('3 days ago');
    expect(fmtRelative(daysAgo(5))).toBe('5 days ago');
    expect(fmtRelative(daysAgo(6))).toBe('6 days ago');
    expect(fmtRelative(daysAgo(8))).toBe('1 week ago');
    expect(fmtRelative(daysAgo(14))).toBe('2 weeks ago');
    expect(fmtRelative(daysAgo(21))).toBe('3 weeks ago');
  });

  it('falls back to fmtDate past 30 days', () => {
    vi.setSystemTime(new Date('2026-03-20T12:00:00'));
    const old = new Date('2026-01-05T09:00:00').getTime();
    expect(fmtRelative(old)).toBe('Jan 5');
  });
});

describe('fmtDate', () => {
  it('formats "Oct 12"', () => {
    const ts = new Date(2025, 9, 12).getTime(); // October = month 9
    // Same-year output depends on "now"; year suffix otherwise. Both start with "Oct 12".
    expect(fmtDate(ts)).toMatch(/^Oct 12( 2025)?$/);
  });
});

describe('esc', () => {
  it('escapes HTML metacharacters', () => {
    expect(esc(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('slug', () => {
  it('lowercases and dashes', () => {
    expect(slug('Моя Тема 2')).toBe('моя-тема-2');
    expect(slug('  Hello World! ')).toBe('hello-world');
  });
});
