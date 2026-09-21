import { describe, expect, it } from 'vitest';
import { BUILTIN_THEMES, HIGHLIGHT_COLORS, THEME_SHADOWS, builtinTheme } from '@/lib/themes';

describe('BUILTIN_THEMES', () => {
  it('contains exactly the four frozen themes in table order', () => {
    expect(BUILTIN_THEMES.map((t) => t.id)).toEqual(['light', 'dark', 'sepia', 'oled']);
  });

  it('every theme has the full Theme shape and is builtin', () => {
    for (const t of BUILTIN_THEMES) {
      expect(t.builtin).toBe(true);
      expect(typeof t.name).toBe('string');
      for (const k of ['bg', 'bgAlt', 'bgRaise', 'fg', 'fgMuted', 'accent', 'accentFg', 'border'] as const) {
        expect(t.ui[k], `ui.${k}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
      for (const k of ['bg', 'fg', 'link'] as const) {
        expect(t.page[k], `page.${k}`).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
      expect(t.page.selectionBg).toMatch(/^rgba\(/);
      expect(THEME_SHADOWS[t.id]).toBeTruthy();
    }
  });

  it('matches the frozen §5.11 colour table', () => {
    const light = builtinTheme('light')!;
    expect(light.ui.bg).toBe('#f6f5f3');
    expect(light.ui.accent).toBe('#c2662d');
    expect(light.ui.accentFg).toBe('#ffffff');
    expect(light.page.bg).toBe('#fcfbf9');
    expect(light.page.selectionBg).toBe('rgba(194,102,45,.22)');

    const dark = builtinTheme('dark')!;
    expect(dark.ui.bg).toBe('#17171a');
    expect(dark.ui.accentFg).toBe('#1a1206');
    expect(dark.page.selectionBg).toBe('rgba(224,145,63,.28)');

    const sepia = builtinTheme('sepia')!;
    expect(sepia.ui.bg).toBe('#ece1cd');
    expect(sepia.ui.accentFg).toBe('#ffffff');

    const oled = builtinTheme('oled')!;
    expect(oled.ui.bg).toBe('#000000');
    expect(oled.page.bg).toBe('#000000');
    expect(oled.ui.accentFg).toBe('#1a1206');
  });

  it('highlight palette is the frozen six colours', () => {
    expect([...HIGHLIGHT_COLORS]).toEqual(
      ['#ffe08a', '#a8e6a3', '#9ecbf5', '#f5a9c0', '#cdb4f6', '#f7c78e'],
    );
  });
});
