/**
 * settingsStore — FROZEN (scaffold-FE), full implementation per ARCHITECTURE.md §5.2.
 * - load() via get_settings (falls back to DEFAULT_SETTINGS when the backend is absent)
 * - patch(p): deep-merge optimistic update + debounce(400 ms) save_settings
 * - theme: builtin by id ?? customThemes find ?? light
 * - fonts via list_fonts, cached; shortcuts record
 *
 * Framework-light: no React imports; components subscribe via useSettingsStore.
 */
import { create } from 'zustand';
import type { DeepPartial, FontFamily, Settings, Theme } from '@/lib/types';
import { getSettings, listFonts, saveSettings } from '@/lib/tauri';
import { BUILTIN_THEMES, builtinTheme } from '@/lib/themes';
import { debounce } from '@/lib/utils';
import { DEFAULT_SHORTCUTS } from '@/features/reader/Shortcuts';

/** §6.6 defaults (used before load resolves and as the merge base in tests). */
export const DEFAULT_SETTINGS: Settings = {
  ui: { themeId: 'light', customThemes: [], animations: true, autoHideChrome: true },
  page: {
    fontFamily: 'serif', fontSizePx: 19, fontWeight: 400, lineHeight: 1.65,
    letterSpacingEm: 0, textAlign: 'justify', paragraphIndentEm: 1.2,
    paragraphSpacingEm: 0.6, hyphenate: true, pageWidthPct: 100,
    scrollMaxWidthPx: 720,
    marginsPx: { top: 28, right: 40, bottom: 28, left: 40 },
    textColorOverride: null, backgroundColorOverride: null, linkColorOverride: null,
  },
  reading: {
    mode: 'paginated', pageTurn: 'slide', prefetch: true,
    wheelTurnsPage: true, clickZones: false,
  },
  translate: {
    defaultProviderId: 'google', defaultTargetLang: 'ru', popupOnSelect: false,
    providers: {},
  },
  dictionary: { defaultProviderId: 'dictionaryapi' },
  vocab: { suggestAfterLookups: 3, dailyReviewLimit: 50 },
  library: { watchedDirs: [], view: 'grid', sort: 'lastOpened', sortDesc: true },
  shortcuts: { ...DEFAULT_SHORTCUTS },
};

/** True for plain objects (not arrays/null) — merge boundary for deepMerge. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` over `base` (patch wins; arrays replaced wholesale). Pure. */
export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined | null): T {
  if (patch === undefined || patch === null) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) return { ...base, ...(patch as object) } as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = isPlainObject(cur) && isPlainObject(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

export interface SettingsState {
  settings: Settings;
  loaded: boolean;
  fonts: FontFamily[];
  fontsLoaded: boolean;

  load(): Promise<void>;
  patch(p: DeepPartial<Settings>): void;
  /** Force pending debounced save to fire now (used on quit/back). */
  flush(): void;
  loadFonts(): Promise<void>;
  /** builtin by id ?? customThemes ?? light (fallback per §5.2). */
  theme(): Theme;
  setThemeId(id: string): void;
  shortcuts(): Record<string, string>;
}

/** Persist the *full* settings object (backend merges patches; sending all is idempotent). */
const debouncedSave = debounce((s: Settings) => {
  void saveSettings(s).catch((e) => {
    console.error('save_settings failed', e);
  });
}, 400);

export const useSettingsStore = create<SettingsState>()((set, get) => ({
  settings: DEFAULT_SETTINGS,
  loaded: false,
  fonts: [],
  fontsLoaded: false,

  load: async () => {
    try {
      const s = await getSettings();
      // Backend guarantees a full Settings; merge over defaults defensively.
      const merged = deepMerge(DEFAULT_SETTINGS, s as DeepPartial<Settings>);
      set({ settings: merged, loaded: true });
    } catch (e) {
      // Backend absent (dev in plain browser / tests): keep defaults, mark loaded.
      console.warn('get_settings unavailable, using defaults', e);
      set({ loaded: true });
    }
  },

  patch: (p) => {
    const next = deepMerge(get().settings, p);
    set({ settings: next });          // optimistic, immediate
    debouncedSave(next);              // persisted after 400 ms quiet
  },

  flush: () => debouncedSave.flush(),

  loadFonts: async () => {
    if (get().fontsLoaded) return;
    try {
      const fonts = await listFonts();
      set({ fonts, fontsLoaded: true });
    } catch (e) {
      console.warn('list_fonts unavailable', e);
      set({ fontsLoaded: true });
    }
  },

  theme: () => {
    const { settings } = get();
    return builtinTheme(settings.ui.themeId)
      ?? settings.ui.customThemes.find((t) => t.id === settings.ui.themeId)
      ?? builtinTheme('light')!;
  },

  setThemeId: (id) => get().patch({ ui: { themeId: id } }),

  shortcuts: () => ({ ...DEFAULT_SHORTCUTS, ...get().settings.shortcuts }),
}));

/** Convenience: built-in theme list for pickers. */
export { BUILTIN_THEMES };
