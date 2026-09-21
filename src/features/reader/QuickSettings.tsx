/**
 * QuickSettings — [F2] per ARCHITECTURE.md §5.4/§5.9.
 * Right drawer (300 px) rendered by App.tsx when `uiStore.overlay === 'quickSettings'`.
 *
 * Font size (A- … A+), font family, line height, margins, theme circles, reading mode and
 * a link into the full settings view. Every control writes through `settingsStore.patch`
 * (optimistic + debounced save inside the store); ChapterFrame re-layouts on change.
 */
import { useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '@/components/icons';
import { Segmented } from '@/components/Segmented';
import { Select } from '@/components/Select';
import { Slider } from '@/components/Slider';
import { BUILTIN_THEMES } from '@/lib/themes';
import { useReaderStore } from '@/stores/readerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

const DRAWER_W = 300;
const FONT_MIN = 12;
const FONT_MAX = 32;

/**
 * Scoped CSS for this drawer's own buttons. base.css's unlayered `button` reset (including
 * `font: inherit`, `background: none`, `border: none`) outranks Tailwind's `@layer
 * utilities`, so utilities for colour/background/border/font would silently lose here.
 */
const QS_CSS = `
.vel-qs-close{
  display:flex; align-items:center; justify-content:center;
  width:32px; height:32px; padding:0; border:0; border-radius:var(--radius-sm);
  background:none; color:var(--v-fg-muted); cursor:pointer;
  transition:background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.vel-qs-close:hover{ background:color-mix(in srgb, var(--v-border) 40%, transparent); color:var(--v-fg); }
.vel-qs-step{
  display:flex; align-items:center; justify-content:center;
  width:28px; height:28px; flex:none; padding:0;
  border:1px solid var(--v-border); border-radius:var(--radius-sm);
  background:var(--v-bg); color:var(--v-fg-muted); cursor:pointer;
  transition:color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.vel-qs-step:hover{ color:var(--v-accent); border-color:color-mix(in srgb, var(--v-fg) 25%, var(--v-border)); }
.vel-qs-step[data-dir="up"]{ color:var(--v-fg); }
.vel-qs-step-label{ line-height:1; font-family:inherit; }
.vel-qs-theme{
  position:relative; display:flex; align-items:center; justify-content:center;
  width:32px; height:32px; flex:none; padding:0; border-radius:50%; cursor:pointer;
  border:2px solid var(--v-border);
  transition:transform var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.vel-qs-theme:hover{ transform:scale(1.06); }
.vel-qs-theme[data-on="true"]{ border-color:var(--v-accent); }
.vel-qs-theme-dot{ display:block; width:12px; height:12px; border-radius:50%; }
`;

/**
 * The three CSS generic families (§6.6: the default is the `serif` generic, shown as
 * "System (serif)"). Concrete families come from `list_fonts`; naming them here
 * too would duplicate a label once the system list is loaded.
 */
const GENERIC_FONTS: { value: string; label: string }[] = [
  { value: 'serif', label: 'System (serif)' },
  { value: 'sans-serif', label: 'System (sans-serif)' },
  { value: 'monospace', label: 'Monospace' },
];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-4 py-2.5">
      <p className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--v-fg-muted)]">
        {label}
      </p>
      {children}
    </div>
  );
}

export default function QuickSettings() {
  const page = useSettingsStore((s) => s.settings.page);
  const reading = useSettingsStore((s) => s.settings.reading);
  const themeId = useSettingsStore((s) => s.settings.ui.themeId);
  const patch = useSettingsStore((s) => s.patch);
  const loadFonts = useSettingsStore((s) => s.loadFonts);
  const fonts = useSettingsStore((s) => s.fonts);
  const fontsLoaded = useSettingsStore((s) => s.fontsLoaded);
  const setThemeId = useSettingsStore((s) => s.setThemeId);

  const setMode = useReaderStore((s) => s.setMode);
  const closeOverlay = useUiStore((s) => s.closeOverlay);
  const setView = useUiStore((s) => s.setView);
  const applyTheme = useUiStore((s) => s.applyTheme);

  // Font list is fetched lazily the first time the drawer opens.
  useEffect(() => {
    if (!fontsLoaded) void loadFonts();
  }, [fontsLoaded, loadFonts]);

  const fontOptions = useMemo(() => {
    const seen = new Set(GENERIC_FONTS.map((f) => f.value));
    const fromSystem = fonts
      .filter((f) => !f.mono && !seen.has(f.name))
      .map((f) => ({ value: f.name, label: f.name }));
    return [...GENERIC_FONTS, ...fromSystem];
  }, [fonts]);

  const nudgeFont = (delta: number): void => {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, page.fontSizePx + delta));
    if (next !== page.fontSizePx) patch({ page: { fontSizePx: next } });
  };

  const pickTheme = (id: string): void => {
    setThemeId(id);
    applyTheme();
  };

  const changeMode = (m: 'paginated' | 'scroll'): void => {
    patch({ reading: { mode: m } });
    setMode(m);
  };

  return (
    <aside
      data-testid="quick-settings"
      className="vellum-panel vellum-slide-in-right absolute right-0 top-0 z-40 flex h-full flex-col overflow-hidden rounded-none border-y-0 border-r-0"
      style={{ width: DRAWER_W, animationDuration: 'var(--dur-med)' }}
      aria-label="Text appearance"
    >
      <style>{QS_CSS}</style>
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--v-border)] px-3">
        <h2 className="text-[13px] font-semibold">Appearance</h2>
        <button
          type="button"
          aria-label="Close"
          className="vel-qs-close"
          onClick={closeOverlay}
        >
          <Icon name="close" size={16} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {/* ---------------------------------------------------------- font size */}
        <Row label="Size">
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Smaller font"
              data-testid="font-dec"
              className="vel-qs-step"
              data-dir="down"
              onClick={() => nudgeFont(-1)}
            >
              <span className="vel-qs-step-label" style={{ fontSize: 13 }}>A</span>
            </button>
            <Slider
              value={page.fontSizePx}
              min={FONT_MIN}
              max={FONT_MAX}
              step={1}
              ariaLabel="Font size"
              onChange={(v) => patch({ page: { fontSizePx: v } })}
              format={(v) => `${v}`}
              className="flex-1"
            />
            <button
              type="button"
              aria-label="Larger font"
              data-testid="font-inc"
              className="vel-qs-step"
              data-dir="up"
              onClick={() => nudgeFont(1)}
            >
              <span className="vel-qs-step-label" style={{ fontSize: 16 }}>A</span>
            </button>
          </div>
        </Row>

        {/* -------------------------------------------------------- font family */}
        <Row label="Font">
          <Select
            options={fontOptions}
            value={page.fontFamily}
            ariaLabel="Font"
            searchable
            searchPlaceholder="Search fonts…"
            onChange={(v) => patch({ page: { fontFamily: v } })}
          />
        </Row>

        {/* --------------------------------------------------------- line height */}
        <Row label="Line spacing">
          <Slider
            value={page.lineHeight}
            min={1}
            max={2.4}
            step={0.05}
            ariaLabel="Line spacing"
            onChange={(v) => patch({ page: { lineHeight: v } })}
            format={(v) => v.toFixed(2)}
          />
        </Row>

        {/* ------------------------------------------------------------- margins */}
        <Row label="Margins">
          <Slider
            value={page.marginsPx.left}
            min={0}
            max={96}
            step={2}
            ariaLabel="Margins"
            onChange={(v) => patch({
              page: { marginsPx: { top: v, right: v, bottom: v, left: v } },
            })}
            format={(v) => `${v} px`}
          />
        </Row>

        {/* -------------------------------------------------------------- themes */}
        <Row label="Theme">
          <div className="flex items-center gap-2.5">
            {BUILTIN_THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                data-testid={`theme-${t.id}`}
                aria-label={t.name}
                title={t.name}
                aria-pressed={themeId === t.id}
                onClick={() => pickTheme(t.id)}
                className="vel-qs-theme"
                data-on={themeId === t.id || undefined}
                style={{ background: t.page.bg }}
              >
                <span className="vel-qs-theme-dot" style={{ background: t.ui.accent }} />
              </button>
            ))}
          </div>
        </Row>

        {/* ---------------------------------------------------------------- mode */}
        <Row label="Reading mode">
          <Segmented
            ariaLabel="Reading mode"
            value={reading.mode}
            onChange={changeMode}
            size="sm"
            className="w-full"
            options={[
              { value: 'paginated', label: 'Pages' },
              { value: 'scroll', label: 'Scroll' },
            ]}
          />
        </Row>
      </div>

      <footer className="shrink-0 border-t border-[var(--v-border)] p-2">
        <button
          type="button"
          data-testid="all-settings"
          className="vellum-btn vellum-btn-ghost w-full justify-center"
          onClick={() => { closeOverlay(); setView('settings'); }}
        >
          <Icon name="settings" size={15} />
          All settings
        </button>
      </footer>
    </aside>
  );
}
