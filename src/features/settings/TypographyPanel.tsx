/**
 * TypographyPanel — [F3] per ARCHITECTURE.md §5.9 (Text section).
 * Live preview pane (mini book page, ~120-word sample) styled with the SAME
 * vars pipeline as the reader (font/size/weight/lineHeight/letterSpacing/align/indent/
 * spacing/hyphenate/margins/widths/page colours incl. overrides), re-rendering instantly.
 * Controls below patch settings.page immediately.
 */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/icons';
import { Segmented } from '@/components/Segmented';
import { Select } from '@/components/Select';
import type { SelectOption } from '@/components/Select';
import { Slider } from '@/components/Slider';
import { Switch } from '@/components/Switch';
import { useSettingsStore } from '@/stores/settingsStore';
import { cn } from '@/lib/utils';

/** ~120-word sample, classic public-domain-feeling prose about reading. */
const SAMPLE =
  "Reading is one of life's most pleasant pursuits. To open a book is to open a " +
  'window onto another world: foreign cities murmur there, the air smells of sea ' +
  'and road dust, and people long gone carry on their unhurried conversation. ' +
  'A good page comforts you in bad weather, brightens a long winter evening, and ' +
  'restores a half-forgotten calm and a faith in kindness. Now and then a single ' +
  'well-chosen line is enough to keep the day from turning gray and the room from ' +
  'feeling small. The reader never notices how time flies: letters gather into ' +
  'images, images into a whole life lived as if for real, with all its sorrows ' +
  'and joys. Set the book down at night and for a long while you still hear its ' +
  'quiet voice in the silence. So choose a typeface gently and without haste, for ' +
  'it is the typeface that must carry this unhurried human speech to your heart.';

const GENERIC_FONTS: SelectOption[] = [
  { value: 'serif', label: 'System (serif)' },
  { value: 'system-ui', label: 'System (sans-serif)' },
  { value: 'monospace', label: 'Monospace' },
];

const WEIGHTS: SelectOption[] = [
  { value: '300', label: 'Thin' },
  { value: '400', label: 'Regular' },
  { value: '500', label: 'Medium' },
  { value: '600', label: 'Semibold' },
  { value: '700', label: 'Bold' },
  { value: '900', label: 'Black' },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function toHex(v: string | null | undefined): string {
  return v && HEX_RE.test(v) ? v : '#000000';
}

/** Left-column label + muted description. */
function RowLabel({ label, desc }: { label: string; desc?: string }) {
  return (
    <div className="min-w-0">
      <div className="v-set-label">{label}</div>
      {desc && <div className="v-set-desc">{desc}</div>}
    </div>
  );
}

/** Numeric readout beside a slider (tabular). */
function Value({ children, width = 'w-12' }: { children: React.ReactNode; width?: string }) {
  return (
    <span className={cn('vellum-num shrink-0 text-right text-[12px]', width)}>{children}</span>
  );
}

/** Page colour override row: colour input + hex + Reset when set. */
function OverrideRow({
  label, value, themeDefault, onChange,
}: {
  label: string; value: string | null | undefined; themeDefault: string;
  onChange: (hex: string | null) => void;
}) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => { setText(value ?? ''); }, [value]);

  const set = value != null;
  const commit = (raw: string) => {
    setText(raw);
    const hex = raw.trim();
    const withHash = hex.startsWith('#') ? hex : `#${hex}`;
    if (HEX_RE.test(withHash)) onChange(withHash.toLowerCase());
  };

  return (
    <div className="flex items-center gap-2 py-1.5">
      <input
        type="color"
        className="v-color"
        aria-label={`${label} (palette)`}
        value={toHex(value ?? themeDefault)}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
      />
      <span className="w-[110px] shrink-0 text-[12px]">{label}</span>
      <input
        type="text"
        className={cn('vellum-selectable vellum-num h-7 w-[92px] shrink-0 text-[12px]',
          text.length > 0 && !HEX_RE.test(text.startsWith('#') ? text : `#${text}`) && 'border-[#b3453c]')}
        aria-label={`${label} (hex)`}
        placeholder="As in theme"
        value={text}
        spellCheck={false}
        onChange={(e) => commit(e.target.value)}
      />
      {set && (
        <button
          type="button"
          className="text-[12px] text-[var(--v-accent)] hover:underline"
          onClick={() => onChange(null)}
        >
          Reset
        </button>
      )}
    </div>
  );
}

export function TypographyPanel() {
  const settings = useSettingsStore((s) => s.settings);
  const fonts = useSettingsStore((s) => s.fonts);
  const loadFonts = useSettingsStore((s) => s.loadFonts);
  const theme = useSettingsStore((s) => s.theme());
  const patch = useSettingsStore((s) => s.patch);
  const page = settings.page;

  const [colorsOpen, setColorsOpen] = useState(false);

  useEffect(() => { void loadFonts(); }, [loadFonts]);

  // Font options: generics first, then real families alphabetical, each in its own font.
  const fontOptions = useMemo<SelectOption[]>(() => {
    const real = [...fonts]
      .map((f) => f.name)
      .filter((n, i, arr) => arr.indexOf(n) === i)
      .sort((a, b) => a.localeCompare(b, 'en'))
      .map((name) => ({ value: name, label: name }));
    return [...GENERIC_FONTS, ...real];
  }, [fonts]);

  // Resolved page colours: override ?? theme.
  const pageBg = page.backgroundColorOverride ?? theme.page.bg;
  const pageFg = page.textColorOverride ?? theme.page.fg;
  const pageLink = page.linkColorOverride ?? theme.page.link;

  // CSS font-family: generic keywords pass through; real names get quoted.
  const cssFamily = GENERIC_FONTS.some((g) => g.value === page.fontFamily)
    ? page.fontFamily
    : `'${page.fontFamily}', serif`;

  const previewStyle: React.CSSProperties = {
    background: pageBg,
    color: pageFg,
    fontFamily: cssFamily,
    fontSize: `${page.fontSizePx}px`,
    fontWeight: page.fontWeight,
    lineHeight: page.lineHeight,
    letterSpacing: `${page.letterSpacingEm}em`,
    textAlign: page.textAlign,
    hyphens: page.hyphenate ? 'auto' : 'none',
    // Preview column honours margins, page width and scroll max width.
    padding: `${page.marginsPx.top}px ${page.marginsPx.right}px `
      + `${page.marginsPx.bottom}px ${page.marginsPx.left}px`,
  };

  const columnStyle: React.CSSProperties = {
    maxWidth: `${page.scrollMaxWidthPx}px`,
    width: `${page.pageWidthPct}%`,
    margin: '0 auto',
  };

  const pStyle: React.CSSProperties = {
    textIndent: `${page.paragraphIndentEm}em`,
    marginBottom: `${page.paragraphSpacingEm}em`,
  };

  return (
    <div className="flex flex-col">
      {/* ---------------------------------------------------- live preview */}
      <div
        className="sticky top-0 z-10 mb-4 max-h-[40vh] overflow-hidden rounded-[var(--radius)] border border-[var(--v-border)]"
        data-testid="typo-preview"
      >
        <div style={previewStyle} className="max-h-[40vh] overflow-y-auto">
          <div style={columnStyle}>
            <p style={pStyle}>{SAMPLE}</p>
            <p style={pStyle}>
              A link in the text looks{' '}
              <a href="#prev" style={{ color: pageLink }} onClick={(e) => e.preventDefault()}>
                like this
              </a>
              , and the selection uses the theme's soft accent.
            </p>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------- font family */}
      <div className="v-set-row">
        <RowLabel label="Font" />
        <div className="v-set-control">
          <Select
            ariaLabel="Font"
            className="w-full"
            searchable
            searchPlaceholder="Search fonts…"
            value={page.fontFamily}
            onChange={(v) => patch({ page: { fontFamily: v } })}
            options={fontOptions}
            renderOption={(o) => {
              // §5.9 — each option previews the sample in its own font.
              const family = GENERIC_FONTS.some((g) => g.value === o.value)
                ? o.value
                : `'${o.value}', serif`;
              return (
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate">{o.label}</span>
                  <span
                    className="ml-auto shrink-0 text-[11px] text-[var(--v-fg-muted)]"
                    style={{ fontFamily: family }}
                  >
                    Handgloves 0123
                  </span>
                </span>
              );
            }}
          />
        </div>
      </div>

      {/* --------------------------------------------------------- font size */}
      <div className="v-set-row">
        <RowLabel label="Size" />
        <div className="v-set-control">
          <Slider
            ariaLabel="Size"
            min={12}
            max={32}
            step={1}
            value={page.fontSizePx}
            format={(v) => `${v} px`}
            onChange={(v) => patch({ page: { fontSizePx: v } })}
          />
          <input
            type="number"
            className="vellum-num h-7 w-[56px] shrink-0 text-[12px]"
            aria-label="Size, px"
            min={12}
            max={32}
            value={page.fontSizePx}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) patch({ page: { fontSizePx: Math.min(32, Math.max(12, n)) } });
            }}
          />
        </div>
      </div>

      {/* ------------------------------------------------------------ weight */}
      <div className="v-set-row">
        <RowLabel label="Weight" />
        <div className="v-set-control">
          <Select
            ariaLabel="Weight"
            className="w-full"
            value={String(page.fontWeight)}
            onChange={(v) => patch({ page: { fontWeight: Number(v) } })}
            options={WEIGHTS}
          />
        </div>
      </div>

      {/* -------------------------------------------------------- line height */}
      <div className="v-set-row">
        <RowLabel label="Line spacing" />
        <div className="v-set-control">
          <Slider
            ariaLabel="Line spacing"
            min={1.0}
            max={2.4}
            step={0.05}
            value={page.lineHeight}
            format={(v) => v.toFixed(2)}
            onChange={(v) => patch({ page: { lineHeight: v } })}
          />
          <Value width="w-9">{page.lineHeight.toFixed(2)}</Value>
        </div>
      </div>

      {/* ---------------------------------------------------- letter spacing */}
      <div className="v-set-row">
        <RowLabel label="Letter spacing" />
        <div className="v-set-control">
          <Slider
            ariaLabel="Letter spacing"
            min={-0.05}
            max={0.3}
            step={0.005}
            value={page.letterSpacingEm}
            format={(v) => `${v.toFixed(3)} em`}
            onChange={(v) => patch({ page: { letterSpacingEm: v } })}
          />
          <Value width="w-16">{page.letterSpacingEm.toFixed(3)} em</Value>
        </div>
      </div>

      {/* ------------------------------------------------------------- align */}
      <div className="v-set-row">
        <RowLabel label="Alignment" />
        <div className="v-set-control">
          <Segmented
            ariaLabel="Alignment"
            value={page.textAlign}
            onChange={(v) => patch({ page: { textAlign: v } })}
            options={[
              { value: 'left', label: 'Left' },
              { value: 'justify', label: 'Justify' },
            ]}
          />
        </div>
      </div>

      {/* ---------------------------------------------------- paragraph indent */}
      <div className="v-set-row">
        <RowLabel label="Paragraph indent" />
        <div className="v-set-control">
          <Slider
            ariaLabel="Paragraph indent"
            min={0}
            max={3}
            step={0.05}
            value={page.paragraphIndentEm}
            format={(v) => `${v.toFixed(2)} em`}
            onChange={(v) => patch({ page: { paragraphIndentEm: v } })}
          />
          <Value width="w-16">{page.paragraphIndentEm.toFixed(2)} em</Value>
        </div>
      </div>

      {/* ------------------------------------------------- paragraph spacing */}
      <div className="v-set-row">
        <RowLabel label="Paragraph spacing" />
        <div className="v-set-control">
          <Slider
            ariaLabel="Paragraph spacing"
            min={0}
            max={2}
            step={0.05}
            value={page.paragraphSpacingEm}
            format={(v) => `${v.toFixed(2)} em`}
            onChange={(v) => patch({ page: { paragraphSpacingEm: v } })}
          />
          <Value width="w-16">{page.paragraphSpacingEm.toFixed(2)} em</Value>
        </div>
      </div>

      {/* --------------------------------------------------------- hyphenate */}
      <div className="py-2">
        <Switch
          label="Hyphenation"
          description="Break words by syllables — justified text looks neater."
          checked={page.hyphenate}
          onChange={(v) => patch({ page: { hyphenate: v } })}
        />
      </div>

      {/* --------------------------------------------------------- page width */}
      <div className="v-set-row">
        <RowLabel label="Page width" />
        <div className="v-set-control">
          <Slider
            ariaLabel="Page width"
            min={40}
            max={100}
            step={1}
            value={page.pageWidthPct}
            format={(v) => `${v} %`}
            onChange={(v) => patch({ page: { pageWidthPct: v } })}
          />
          <Value width="w-10">{page.pageWidthPct} %</Value>
        </div>
      </div>

      {/* --------------------------------------------------- scroll max width */}
      <div className="v-set-row">
        <RowLabel label="Text width (scroll)" />
        <div className="v-set-control">
          <Slider
            ariaLabel="Text width (scroll)"
            min={480}
            max={1200}
            step={10}
            value={page.scrollMaxWidthPx}
            format={(v) => `${v} px`}
            onChange={(v) => patch({ page: { scrollMaxWidthPx: v } })}
          />
          <Value width="w-14">{page.scrollMaxWidthPx}</Value>
        </div>
      </div>

      {/* ---------------------------------------------------------- margins */}
      <h2 className="v-set-head">Margins</h2>
      {([
        ['top', 'top'], ['right', 'right'], ['bottom', 'bottom'], ['left', 'left'],
      ] as const).map(([key, label]) => (
        <div className="v-set-row" key={key}>
          <RowLabel label={label} />
          <div className="v-set-control">
            <Slider
              ariaLabel={`Margins ${label}`}
              min={0}
              max={96}
              step={1}
              value={page.marginsPx[key]}
              format={(v) => `${v} px`}
              onChange={(v) => patch({ page: { marginsPx: { [key]: v } } })}
            />
            <Value width="w-10">{page.marginsPx[key]}</Value>
          </div>
        </div>
      ))}

      {/* ---------------------------------------------------- page colours */}
      <button
        type="button"
        className="v-set-head flex items-center gap-1.5 hover:text-[var(--v-fg)]"
        aria-expanded={colorsOpen}
        onClick={() => setColorsOpen((v) => !v)}
      >
        <span
          className="inline-flex transition-transform"
          style={{ transform: colorsOpen ? 'rotate(90deg)' : undefined,
            transitionDuration: 'var(--dur-fast)', transitionTimingFunction: 'var(--ease)' }}
        >
          <Icon name="chevronRight" size={14} />
        </span>
        Page colors
      </button>
      {colorsOpen && (
        <div className="v-section flex flex-col">
          <OverrideRow
            label="Text color"
            value={page.textColorOverride}
            themeDefault={theme.page.fg}
            onChange={(hex) => patch({ page: { textColorOverride: hex } })}
          />
          <OverrideRow
            label="Background color"
            value={page.backgroundColorOverride}
            themeDefault={theme.page.bg}
            onChange={(hex) => patch({ page: { backgroundColorOverride: hex } })}
          />
          <OverrideRow
            label="Link color"
            value={page.linkColorOverride}
            themeDefault={theme.page.link}
            onChange={(hex) => patch({ page: { linkColorOverride: hex } })}
          />
        </div>
      )}
    </div>
  );
}

export default TypographyPanel;
