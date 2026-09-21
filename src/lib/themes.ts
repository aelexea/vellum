/**
 * Built-in themes. FROZEN (scaffold-FE) — values exactly per ARCHITECTURE.md §5.11 table
 * (+ accentFg per §5.11 note). themes.css [F3] may add var sets, but this table is the
 * runtime source used by settingsStore.theme and uiStore.applyTheme.
 */
import type { Theme } from '@/lib/types';

export const HIGHLIGHT_COLORS = ['#ffe08a', '#a8e6a3', '#9ecbf5', '#f5a9c0', '#cdb4f6', '#f7c78e'] as const;

export const BUILTIN_THEMES: Theme[] = [
  {
    id: 'light', name: 'Light', builtin: true,
    ui: {
      bg: '#f6f5f3', bgAlt: '#ffffff', bgRaise: '#ffffff', fg: '#1f1c19', fgMuted: '#7a736b',
      accent: '#c2662d', accentFg: '#ffffff', border: '#e4e0da',
    },
    page: { bg: '#fcfbf9', fg: '#26221d', link: '#9a5b2d', selectionBg: 'rgba(194,102,45,.22)' },
  },
  {
    id: 'dark', name: 'Dark', builtin: true,
    ui: {
      bg: '#17171a', bgAlt: '#1f1f23', bgRaise: '#26262b', fg: '#e4e3e1', fgMuted: '#9b9aa0',
      accent: '#e0913f', accentFg: '#1a1206', border: '#2e2e34',
    },
    page: { bg: '#1a1a1e', fg: '#d8d6d2', link: '#e0a458', selectionBg: 'rgba(224,145,63,.28)' },
  },
  {
    id: 'sepia', name: 'Sepia', builtin: true,
    ui: {
      bg: '#ece1cd', bgAlt: '#f4ead8', bgRaise: '#f7f0e2', fg: '#43351f', fgMuted: '#8b7856',
      accent: '#9a6b3f', accentFg: '#ffffff', border: '#ddcfb4',
    },
    page: { bg: '#f4ead8', fg: '#3e2f1c', link: '#8a5a2b', selectionBg: 'rgba(154,107,63,.25)' },
  },
  {
    id: 'oled', name: 'OLED', builtin: true,
    ui: {
      bg: '#000000', bgAlt: '#0a0a0a', bgRaise: '#121212', fg: '#e6e6e6', fgMuted: '#8f8f8f',
      accent: '#e0913f', accentFg: '#1a1206', border: '#232323',
    },
    page: { bg: '#000000', fg: '#d9d9d9', link: '#e0b060', selectionBg: 'rgba(224,145,63,.30)' },
  },
];

/** Sensible elevation shadow per theme id (§5.11 --v-shadow). */
export const THEME_SHADOWS: Record<string, string> = {
  light: '0 1px 3px rgba(31,28,25,.08), 0 8px 24px rgba(31,28,25,.10)',
  dark: '0 1px 3px rgba(0,0,0,.5), 0 8px 24px rgba(0,0,0,.45)',
  sepia: '0 1px 3px rgba(67,53,31,.10), 0 8px 24px rgba(67,53,31,.12)',
  oled: '0 1px 3px rgba(0,0,0,.8), 0 8px 24px rgba(0,0,0,.7)',
};

export const DEFAULT_SHADOW = THEME_SHADOWS.dark;

export function builtinTheme(id: string): Theme | undefined {
  return BUILTIN_THEMES.find((t) => t.id === id);
}
