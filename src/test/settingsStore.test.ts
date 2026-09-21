import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { DEFAULT_SETTINGS, deepMerge, useSettingsStore } from '@/stores/settingsStore';
import { invokeCalls } from '@/test/setup';
import type { Settings } from '@/lib/types';

const saveCalls = () => invokeCalls.filter((c) => c.cmd === 'save_settings');

describe('deepMerge', () => {
  it('merges nested objects and replaces arrays wholesale', () => {
    const base = {
      ui: { themeId: 'light', animations: true },
      library: { watchedDirs: ['/a', '/b'], view: 'grid' as const },
    };
    const merged = deepMerge(base, {
      ui: { themeId: 'dark' },
      library: { watchedDirs: ['/c'] },
    });
    expect(merged.ui.themeId).toBe('dark');
    expect(merged.ui.animations).toBe(true);      // untouched sibling kept
    expect(merged.library.watchedDirs).toEqual(['/c']); // array replaced, not concatenated
    expect(base.ui.themeId).toBe('light');        // base not mutated
  });

  it('ignores undefined patch values', () => {
    const merged = deepMerge({ a: 1, b: 2 }, { a: undefined, b: 3 });
    expect(merged).toEqual({ a: 1, b: 3 });
  });
});

describe('settingsStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useSettingsStore.setState({
      settings: structuredClone(DEFAULT_SETTINGS),
      loaded: false, fonts: [], fontsLoaded: false,
    });
  });
  afterEach(() => vi.useRealTimers());

  it('load() reads settings from the backend and marks loaded', async () => {
    await useSettingsStore.getState().load();
    const st = useSettingsStore.getState();
    expect(st.loaded).toBe(true);
    expect(st.settings.page.fontSizePx).toBe(DEFAULT_SETTINGS.page.fontSizePx);
    expect(invokeCalls.some((c) => c.cmd === 'get_settings')).toBe(true);
  });

  it('patch() applies optimistically and immediately', () => {
    useSettingsStore.getState().patch({ page: { fontSizePx: 24 } });
    expect(useSettingsStore.getState().settings.page.fontSizePx).toBe(24);
    // Not yet persisted — debounce pending.
    expect(saveCalls()).toHaveLength(0);
  });

  it('patch() persists once after the 400 ms debounce, with merged args', () => {
    const s = useSettingsStore.getState();
    s.patch({ page: { fontSizePx: 22 } });
    s.patch({ page: { fontSizePx: 23 } });
    s.patch({ page: { fontSizePx: 24 } });
    vi.advanceTimersByTime(399);
    expect(saveCalls()).toHaveLength(0);
    vi.advanceTimersByTime(1);
    const calls = saveCalls();
    expect(calls).toHaveLength(1);                       // debounced to a single save
    const patch = (calls[0].args as { patch: Settings }).patch;
    expect(patch.page.fontSizePx).toBe(24);                // last value wins
    expect(patch.ui.themeId).toBe(DEFAULT_SETTINGS.ui.themeId); // full settings sent
  });

  it('flush() forces the pending save (quit/back path)', () => {
    useSettingsStore.getState().patch({ ui: { themeId: 'oled' } });
    useSettingsStore.getState().flush();
    expect(saveCalls()).toHaveLength(1);
    const patch = (saveCalls()[0].args as { patch: { ui: { themeId: string } } }).patch;
    expect(patch.ui.themeId).toBe('oled');
  });

  it('theme() resolves builtin by id, then customThemes, then light', () => {
    const s = useSettingsStore.getState();

    s.patch({ ui: { themeId: 'sepia' } });
    expect(s.theme().id).toBe('sepia');

    const custom = {
      ...structuredClone(DEFAULT_SETTINGS.ui.customThemes[0] ?? {
        id: 'mine', name: 'Моя', builtin: false,
        ui: { bg: '#111', bgAlt: '#222', bgRaise: '#333', fg: '#eee', fgMuted: '#aaa',
          accent: '#c2662d', accentFg: '#fff', border: '#444' },
        page: { bg: '#111', fg: '#eee', link: '#e0a458', selectionBg: 'rgba(0,0,0,.3)' },
      }),
      id: 'mine',
    };
    s.patch({ ui: { themeId: 'mine', customThemes: [custom] } });
    expect(s.theme().id).toBe('mine');

    s.patch({ ui: { themeId: 'nope', customThemes: [] } });
    expect(s.theme().id).toBe('light');   // fallback per §5.2
  });

  it('shortcuts() layers user bindings over the defaults', () => {
    useSettingsStore.getState().patch({ shortcuts: { toggleSearch: 'Ctrl+K' } });
    const sc = useSettingsStore.getState().shortcuts();
    expect(sc.toggleSearch).toBe('Ctrl+K');
    expect(sc.toggleToc).toBe('Ctrl+T');  // untouched default survives
  });

  it('loadFonts() caches the fc-list result', async () => {
    await useSettingsStore.getState().loadFonts();
    expect(useSettingsStore.getState().fonts.length).toBeGreaterThan(0);
    const first = invokeCalls.filter((c) => c.cmd === 'list_fonts').length;
    // Second call is served from cache — no extra list_fonts invoke.
    await useSettingsStore.getState().loadFonts();
    expect(invokeCalls.filter((c) => c.cmd === 'list_fonts')).toHaveLength(first);
  });

  it('survives a backend failure by keeping defaults', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('no backend'));
    await useSettingsStore.getState().load();
    const st = useSettingsStore.getState();
    expect(st.loaded).toBe(true);
    expect(st.settings.page.fontSizePx).toBe(DEFAULT_SETTINGS.page.fontSizePx);
  });
});
