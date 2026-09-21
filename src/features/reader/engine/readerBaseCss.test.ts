/**
 * §8 F0 / §11.6 — the injected reader CSS.
 *
 * This string goes into all three pooled iframes, so it is checked against the coverage list
 * in §5.3 and §11.6 (var hooks, highlight/flash styles, media clamping, link colour) and
 * against the < 4 KB budget. A truncated or unbalanced stylesheet would silently break the
 * reading experience, which no runtime error would surface.
 */
import { describe, expect, it } from 'vitest';
import { readerBaseCss } from './readerBaseCss';
import { readerBaseCss as shimmed } from '@/styles/readerBaseCss';

const css = readerBaseCss;

describe('readerBaseCss — shape', () => {
  it('is a non-empty string', () => {
    expect(typeof css).toBe('string');
    expect(css.trim().length).toBeGreaterThan(100);
  });

  it('stays under the 4 KB budget', () => {
    expect(Buffer.byteLength(css, 'utf8')).toBeLessThan(4096);
  });

  it('has balanced braces (not truncated mid-rule)', () => {
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      // A negative depth means a stray closer — also a corruption signal.
      expect(depth, 'brace depth must never go negative').toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('contains no obvious template corruption', () => {
    expect(css).not.toContain('undefined');
    expect(css).not.toContain('[object Object]');
    expect(css).not.toContain('${');
  });

  it('is the same module the §11.6 path re-exports', () => {
    expect(shimmed).toBe(css);
  });
});

describe('readerBaseCss — §5.3 coverage', () => {
  it('clamps media to the column width', () => {
    expect(css).toMatch(/img,svg,video[^{]*\{[^}]*max-width:100%/);
    expect(css).toMatch(/height:auto/);
  });

  it('drives paragraph spacing and indent from vars', () => {
    expect(css).toContain('--v-para-spacing');
    expect(css).toContain('--v-para-indent');
    expect(css).toMatch(/p\{[^}]*text-indent:var\(--v-para-indent/);
  });

  it('drives typography from vars with §6.6 fallbacks', () => {
    expect(css).toContain('font-family:var(--v-font-family,serif)');
    expect(css).toContain('--v-font-size');
    expect(css).toContain('--v-line-height');
    expect(css).toContain('--v-letter-spacing');
    expect(css).toContain('--v-font-weight');
  });

  it('drives text-align and hyphens from vars', () => {
    expect(css).toContain('text-align:var(--v-text-align');
    expect(css).toContain('hyphens:var(--v-hyphens');
  });

  it('uses the page foreground/background vars', () => {
    expect(css).toContain('--v-page-fg');
    expect(css).toContain('--v-page-bg');
  });

  it('styles highlight marks as clickable with rounded corners', () => {
    expect(css).toMatch(/mark\.vellum-hl\{[^}]*border-radius:2px/);
    expect(css).toMatch(/mark\.vellum-hl\{[^}]*cursor:pointer/);
    expect(css).toMatch(/mark\.vellum-hl\{[^}]*padding:\.05em 0/);
  });

  it('renders the note marker via ::after', () => {
    expect(css).toContain('mark.vellum-note::after');
    // The ▎ marker is escaped as \258E so the stylesheet stays ASCII-safe.
    expect(css).toMatch(/content:'\\258E'/);
  });

  it('defines the flash animation and its keyframes', () => {
    expect(css).toMatch(/mark\.vellum-flash\{[^}]*animation:vellum-flash/);
    expect(css).toContain('@keyframes vellum-flash');
    expect(css).toMatch(/animation:vellum-flash 1\.2s/);
  });

  it('uses the page selection var for ::selection', () => {
    expect(css).toMatch(/::selection\{[^}]*background:var\(--v-page-selection/);
  });

  it('colours links with the page link var', () => {
    expect(css).toMatch(/a\{[^}]*color:var\(--v-page-link/);
  });

  it('lets tables and pre blocks scroll horizontally instead of breaking the column', () => {
    expect(css).toMatch(/table\{[^}]*overflow-x:auto/);
    expect(css).toMatch(/pre\{[^}]*overflow-x:auto/);
  });

  it('keeps headings from being orphaned at a page break', () => {
    expect(css).toMatch(/page-break-after:avoid/);
    expect(css).toMatch(/break-after:avoid/);
  });

  it('sets orphans and widows on paragraphs', () => {
    expect(css).toMatch(/p\{[^}]*orphans:2/);
    expect(css).toMatch(/widows:2/);
  });

  it('keeps figures from splitting across pages', () => {
    expect(css).toMatch(/figure\{[^}]*break-inside:avoid/);
  });

  it('disables webkit text size adjustment', () => {
    expect(css).toMatch(/-webkit-text-size-adjust:100%/);
  });

  it('targets the .vellum-doc baseline B2 adds to <html>', () => {
    expect(css).toContain('.vellum-doc');
  });

  it('suppresses highlight tint under an active selection', () => {
    expect(css).toContain('mark.vellum-hl::selection');
  });

  it('supports box-decoration-break so multi-line marks look continuous', () => {
    expect(css).toContain('box-decoration-break:clone');
  });
});

describe('readerBaseCss — token discipline (§5.11)', () => {
  it('uses only frozen --v-* and token names', () => {
    const vars = new Set<string>();
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) vars.add(m[1] as string);
    // Theme colours + typography vars (injected at runtime) and the frozen §5.11 motion/shape
    // tokens, which are redeclared on :root inside this stylesheet because the app's tokens do
    // not cascade into a separate iframe document. `--f` is the stylesheet's own local alias
    // for the page foreground, asserted below to be declared rather than dangling.
    const allowed = new Set([
      '--v-page-bg', '--v-page-fg', '--v-page-link', '--v-page-selection', '--v-accent',
      '--v-font-family', '--v-font-size', '--v-font-weight', '--v-line-height',
      '--v-letter-spacing', '--v-text-align', '--v-hyphens', '--v-hyphen-limit',
      '--v-para-spacing', '--v-para-indent', '--v-quote-margin', '--v-hl-bg',
      '--ease', '--dur-fast', '--dur-med', '--radius-sm', '--f',
    ]);
    const unknown = [...vars].filter((v) => !allowed.has(v));
    expect(unknown).toEqual([]);
  });

  it('declares every custom property it consumes, except runtime-injected ones', () => {
    const declared = new Set<string>();
    for (const m of css.matchAll(/(--[a-z0-9-]+):/g)) declared.add(m[1] as string);
    const used = new Set<string>();
    for (const m of css.matchAll(/var\((--[a-z0-9-]+)/g)) used.add(m[1] as string);
    // These arrive from applyTypography()/applyTheme() at runtime, never from this file, and
    // --v-hl-bg is set inline per-mark by highlight.renderHighlights (see HL_BG_VAR).
    const injected = new Set([
      '--v-page-bg', '--v-page-fg', '--v-page-link', '--v-page-selection', '--v-accent',
      '--v-font-family', '--v-font-size', '--v-font-weight', '--v-line-height',
      '--v-letter-spacing', '--v-text-align', '--v-hyphens', '--v-hyphen-limit',
      '--v-para-spacing', '--v-para-indent', '--v-quote-margin', '--v-hl-bg',
    ]);
    const dangling = [...used].filter((v) => !declared.has(v) && !injected.has(v));
    expect(dangling).toEqual([]);
  });

  it('redeclares the frozen motion tokens locally so the iframe is self-contained', () => {
    expect(css).toMatch(/:root\{[^}]*--ease:cubic-bezier\(\.2,0,0,1\)/);
    expect(css).toMatch(/:root\{[^}]*--dur-fast:120ms/);
  });

  it('respects the reduced-motion preference', () => {
    expect(css).toContain('@media (prefers-reduced-motion:reduce)');
    expect(css).toMatch(/mark\.vellum-flash\{animation:none/);
  });

  it('falls back to a light-theme page colour per §5.11', () => {
    // #fcfbf9 / #26221d are the frozen light theme page bg/fg.
    expect(css).toContain('#fcfbf9');
    expect(css).toContain('#26221d');
  });

  it('never hardcodes the accent so a non-light theme cannot flash orange', () => {
    // #c2662d is the frozen light-theme accent. srcdoc cannot inherit host :root vars, so a
    // hardcoded fallback would make dark/sepia/OLED themes flash light-orange whenever
    // --v-accent was not injected. The fallback chain must stay var-driven.
    expect(css).not.toContain('#c2662d');
    expect(css).toMatch(/var\(--v-accent,var\(--v-page-selection,/);
  });
});
