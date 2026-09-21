/**
 * ChapterFrame (§8) — the pure pipeline pieces F2 owns: srcdoc assembly (style injection +
 * theme/typography vars), the LRU chapter cache, and the engine layout math.
 *
 * The engine module is mocked: jsdom cannot lay out CSS columns and F0's controller needs
 * a real document, so only the F2-side logic is asserted here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/features/reader/engine/controller', () => ({
  ChapterController: class {
    constructor(_iframe: HTMLIFrameElement) { throw new Error('WP-F0'); }
  },
}));

import { __test__, buildSrcdoc, layoutOptsFor, getFrameOffset, setFrameOffset }
  from '@/features/reader/ChapterFrame';
import { useSettingsStore } from '@/stores/settingsStore';
import { DEFAULT_SETTINGS } from '@/stores/settingsStore';
import type { Settings } from '@/lib/types';

const { htmlCache, fetchChapter, GAP_PX } = __test__;

/** A representative B2-served chapter document. */
const CHAPTER = '<!DOCTYPE html><html class="vellum-doc"><head><title>c</title></head>'
  + '<body><p>Текст главы.</p></body></html>';

function settings(patch: Partial<Settings['page']> = {}): Settings {
  return {
    ...DEFAULT_SETTINGS,
    ui: { ...DEFAULT_SETTINGS.ui, themeId: 'light' },
    page: { ...DEFAULT_SETTINGS.page, ...patch },
  };
}

beforeEach(() => { htmlCache.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); htmlCache.clear(); });

describe('buildSrcdoc — style injection (§5.3)', () => {
  it('injects a <style> as the first child of <head>', () => {
    const out = buildSrcdoc(CHAPTER, settings());
    expect(out).toMatch(/<head[^>]*><style data-vellum="1">/);
    // The original head content survives.
    expect(out).toContain('<title>c</title>');
  });

  it('keeps the backend\'s <html> attributes and adds the inline style', () => {
    const out = buildSrcdoc(CHAPTER, settings());
    expect(out).toMatch(/<html class="vellum-doc" style="/);
  });

  it('carries the four page colour vars (§5.11)', () => {
    const out = buildSrcdoc(CHAPTER, settings());
    for (const v of ['--v-page-bg', '--v-page-fg', '--v-page-link', '--v-page-selection']) {
      expect(out).toContain(`${v}:`);
    }
  });

  it('injects the live theme accent (srcdoc cannot inherit host :root vars)', () => {
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, ui: { ...s.settings.ui, themeId: 'dark' } },
    }));
    const out = buildSrcdoc(CHAPTER, settings());
    // Dark theme accent per §5.11 — not the light-theme fallback the engine ships with.
    expect(out).toContain('--v-accent:#e0913f');
    expect(out).toContain('--v-ease:');
  });

  it('carries every typography var the engine stylesheet reads', () => {
    const out = buildSrcdoc(CHAPTER, settings());
    for (const v of [
      '--v-font-family', '--v-font-size', '--v-font-weight', '--v-line-height',
      '--v-letter-spacing', '--v-text-align', '--v-para-indent', '--v-para-spacing',
      // F0's readerBaseCss reads --v-hyphens (not --v-hyphenate).
      '--v-hyphens',
    ]) {
      expect(out, v).toContain(`${v}:`);
    }
  });

  it('maps settings.page values into the injected vars', () => {
    const out = buildSrcdoc(CHAPTER, settings({ fontSizePx: 24, lineHeight: 2 }));
    expect(out).toContain('--v-font-size:24px');
    expect(out).toContain('--v-line-height:2');
  });

  it('emits --v-hyphens:auto / none from the hyphenate flag', () => {
    expect(buildSrcdoc(CHAPTER, settings({ hyphenate: true }))).toContain('--v-hyphens:auto');
    expect(buildSrcdoc(CHAPTER, settings({ hyphenate: false }))).toContain('--v-hyphens:none');
  });

  it('honours the §11.5 page colour overrides over the theme', () => {
    const out = buildSrcdoc(CHAPTER, settings({
      backgroundColorOverride: '#123456',
      textColorOverride: '#abcdef',
      linkColorOverride: '#ff0000',
    }));
    expect(out).toContain('--v-page-bg:#123456');
    expect(out).toContain('--v-page-fg:#abcdef');
    expect(out).toContain('--v-page-link:#ff0000');
  });

  it('includes the turn-animation CSS with the §5.4 140 ms duration', () => {
    const out = buildSrcdoc(CHAPTER, settings());
    expect(out).toContain('#vellum-wrap');
    expect(out).toMatch(/transform 140ms/);
  });

  it('includes the engine readerBaseCss', () => {
    const out = buildSrcdoc(CHAPTER, settings());
    // A distinctive rule from F0's stylesheet.
    expect(out).toContain('vellum-doc');
  });

  it('wraps a bare fragment with no <html> into a full document', () => {
    const out = buildSrcdoc('<p>Только текст.</p>', settings());
    expect(out).toContain('<!DOCTYPE html>');
    expect(out).toMatch(/<html class="vellum-doc" style="/);
    expect(out).toContain('<p>Только текст.</p>');
  });

  it('injects into <body> when there is <html> but no <head>', () => {
    const out = buildSrcdoc('<html><body><p>x</p></body></html>', settings());
    expect(out).toMatch(/<body><style data-vellum="1">/);
  });
});

describe('layoutOptsFor — engine layout math (§5.3)', () => {
  it('derives pageWidthPx from container width × pageWidthPct − horizontal margins', () => {
    const opts = layoutOptsFor(settings({ pageWidthPct: 100 }), { width: 900, height: 600 }, 'paginated');
    // 900 × 1.0 − (40 + 40) = 820
    expect(opts.pageWidthPx).toBe(820);
  });

  it('applies pageWidthPct below 100', () => {
    const opts = layoutOptsFor(settings({ pageWidthPct: 50 }), { width: 900, height: 600 }, 'paginated');
    // 450 − 80 = 370
    expect(opts.pageWidthPx).toBe(370);
  });

  it('subtracts vertical margins from heightPx', () => {
    const opts = layoutOptsFor(settings({ pageWidthPct: 100 }), { width: 900, height: 600 }, 'paginated');
    // 600 − (28 + 28) = 544
    expect(opts.heightPx).toBe(544);
  });

  it('floors pageWidthPx and heightPx so a tiny window cannot go non-positive', () => {
    const opts = layoutOptsFor(settings({ pageWidthPct: 40 }), { width: 60, height: 20 }, 'paginated');
    expect(opts.pageWidthPx).toBeGreaterThanOrEqual(120);
    expect(opts.heightPx).toBeGreaterThanOrEqual(120);
  });

  it('passes the mode and scrollMaxWidthPx through for scroll mode', () => {
    const opts = layoutOptsFor(settings({ scrollMaxWidthPx: 720 }), { width: 900, height: 600 }, 'scroll');
    expect(opts.mode).toBe('scroll');
    expect(opts.maxWidthPx).toBe(720);
  });

  it('uses the shared column gap', () => {
    const opts = layoutOptsFor(settings(), { width: 900, height: 600 }, 'paginated');
    expect(opts.gapPx).toBe(GAP_PX);
    expect(GAP_PX).toBe(48);
  });

  it('hands the typography record to the engine', () => {
    const opts = layoutOptsFor(settings({ fontSizePx: 21 }), { width: 900, height: 600 }, 'paginated');
    expect(opts.typography['--v-font-size']).toBe('21px');
    expect(opts.typography['--v-margin-left']).toBe('40px');
  });
});

describe('chapter cache — LRU Map, cap 10 (§5.4)', () => {
  function mockFetch(body: string): void {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, text: async () => body,
    } as Response)));
  }

  it('fetches a chapter over the vellum:// protocol', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, text: async () => CHAPTER,
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchChapter('aaaa1111', 3)).resolves.toBe(CHAPTER);
    expect(fetchMock).toHaveBeenCalledWith('vellum://book/aaaa1111/chapter/3');
  });

  it('serves a repeat request from cache without refetching', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, text: async () => CHAPTER,
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await fetchChapter('aaaa1111', 1);
    await fetchChapter('aaaa1111', 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by uid:idx so different books do not collide', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true, status: 200, text: async () => `body:${url}`,
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const a = await fetchChapter('aaaa1111', 1);
    const b = await fetchChapter('bbbb2222', 1);
    expect(a).not.toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('caps the cache at 10 entries, evicting the oldest', async () => {
    mockFetch(CHAPTER);
    for (let i = 0; i < 12; i++) await fetchChapter('aaaa1111', i);
    expect(htmlCache.size).toBe(10);
    // The first two were evicted; the last ten remain.
    expect(htmlCache.has('aaaa1111:0')).toBe(false);
    expect(htmlCache.has('aaaa1111:1')).toBe(false);
    expect(htmlCache.has('aaaa1111:2')).toBe(true);
    expect(htmlCache.has('aaaa1111:11')).toBe(true);
  });

  it('refreshes recency so a re-read entry is not evicted first', async () => {
    mockFetch(CHAPTER);
    for (let i = 0; i < 10; i++) await fetchChapter('aaaa1111', i);
    // Touch the oldest so it becomes the newest.
    await fetchChapter('aaaa1111', 0);
    await fetchChapter('aaaa1111', 99);

    expect(htmlCache.has('aaaa1111:0')).toBe(true);
    expect(htmlCache.has('aaaa1111:1')).toBe(false);
  });

  it('does not cache a failed chapter fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 404, text: async () => '',
    } as Response)));
    await expect(fetchChapter('aaaa1111', 7)).rejects.toThrow(/404/);
    expect(htmlCache.size).toBe(0);
  });
});

describe('frame geometry', () => {
  it('publishes the iframe offset for SelectionToolbar', () => {
    setFrameOffset(120, 340);
    expect(getFrameOffset()).toEqual({ x: 120, y: 340 });
    setFrameOffset(0, 0);
    expect(getFrameOffset()).toEqual({ x: 0, y: 0 });
  });
});

describe('typography var names match the engine stylesheet', () => {
  it('uses --v-hyphens, the name F0 readerBaseCss reads', () => {
    const opts = layoutOptsFor(settings({ hyphenate: true }), { width: 900, height: 600 }, 'paginated');
    expect(opts.typography['--v-hyphens']).toBe('auto');
    expect(opts.typography).not.toHaveProperty('--v-hyphenate');
  });

  it('supplies --v-margin-* px values that pagination.marginsFrom reads', () => {
    const opts = layoutOptsFor(
      settings({ marginsPx: { top: 10, right: 20, bottom: 30, left: 40 } }),
      { width: 900, height: 600 },
      'paginated',
    );
    expect(opts.typography['--v-margin-top']).toBe('10px');
    expect(opts.typography['--v-margin-right']).toBe('20px');
    expect(opts.typography['--v-margin-bottom']).toBe('30px');
    expect(opts.typography['--v-margin-left']).toBe('40px');
  });
});

describe('settings store integration', () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: settings({ fontSizePx: 27 }) });
  });

  it('reads the live settings for layout', () => {
    const opts = layoutOptsFor(
      useSettingsStore.getState().settings, { width: 800, height: 600 }, 'paginated',
    );
    expect(opts.typography['--v-font-size']).toBe('27px');
  });
});
