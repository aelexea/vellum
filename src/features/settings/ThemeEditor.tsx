/**
 * ThemeEditor — [F3] per ARCHITECTURE.md §5.9.
 * Modal editor for a custom theme. `theme` is a draft (id '' = new) or null (closed).
 * Two colour groups (Interface / Book page), each row = native colour input +
 * bidirectional hex field (validated #rrggbb). Live mini-page preview. Save pushes or
 * updates settings.ui.customThemes and switches to it; Cancel discards.
 */
import { useEffect, useState } from 'react';
import { Modal } from '@/components/Modal';
import type { Theme } from '@/lib/types';
import { cn, slug } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

/** Mini book-page mock — shared by theme cards (SettingsView) and this editor's preview. */
export function PageMock({ theme, className }: { theme: Theme; className?: string }) {
  return (
    <div
      className={cn('vellum-theme-preview', className)}
      style={{ background: theme.page.bg }}
      data-testid="page-mock"
    >
      <div className="tp-bar" style={{ background: theme.ui.accent }} />
      <div className="tp-line" style={{ background: theme.page.fg }} />
      <div className="tp-line" style={{ background: theme.page.fg }} />
      <div className="tp-line short" style={{ background: theme.page.fg }} />
    </div>
  );
}

type UiKey = keyof Theme['ui'];
type PageKey = keyof Theme['page'];

const UI_FIELDS: { key: UiKey; label: string }[] = [
  { key: 'bg', label: 'Background' },
  { key: 'bgAlt', label: 'Background (alternate)' },
  { key: 'bgRaise', label: 'Background (raised)' },
  { key: 'fg', label: 'Text color' },
  { key: 'fgMuted', label: 'Muted text' },
  { key: 'accent', label: 'Accent' },
  { key: 'accentFg', label: 'Text on accent' },
  { key: 'border', label: 'Borders' },
];

const PAGE_FIELDS: { key: PageKey; label: string }[] = [
  { key: 'bg', label: 'Page background' },
  { key: 'fg', label: 'Text color' },
  { key: 'link', label: 'Link color' },
  { key: 'selectionBg', label: 'Selection' },
];

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

/** Normalise a hex string to #rrggbb; return null when invalid. */
function normHex(v: string): string | null {
  const s = v.trim();
  const withHash = s.startsWith('#') ? s : `#${s}`;
  return HEX_RE.test(withHash) ? withHash.toLowerCase() : null;
}

/** One colour row: swatch + hex text, bidirectional. */
function ColorRow({
  label, value, onChange,
}: { label: string; value: string; onChange: (hex: string) => void }) {
  // Local text lets the user type an in-progress/invalid value without losing focus.
  const [text, setText] = useState(value);
  // A cloned built-in theme carries an rgba() selectionBg; flagging that red before the
  // user has typed anything would look like an error, so only validate after a touch.
  const [touched, setTouched] = useState(false);
  useEffect(() => { setText(value); setTouched(false); }, [value]);

  const commit = (raw: string) => {
    setTouched(true);
    setText(raw);
    const hex = normHex(raw);
    if (hex) onChange(hex);
  };

  const valid = HEX_RE.test(text.trim().startsWith('#') ? text.trim() : `#${text.trim()}`);

  return (
    <div className="flex items-center gap-2 py-1">
      <input
        type="color"
        className="v-color"
        aria-label={`${label} (palette)`}
        value={HEX_RE.test(value) ? value : '#000000'}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
      />
      <span className="w-[150px] shrink-0 truncate text-[12px]">{label}</span>
      <input
        type="text"
        className={cn(
          'vellum-selectable vellum-num h-7 w-[96px] shrink-0 text-[12px]',
          touched && !valid && text.length > 0 && 'border-[#b3453c]',
        )}
        aria-label={`${label} (hex)`}
        value={text}
        spellCheck={false}
        onChange={(e) => commit(e.target.value)}
      />
    </div>
  );
}

export interface ThemeEditorProps {
  /** Draft theme (id '' = new) or null to keep the modal closed. */
  theme: Theme | null;
  onClose: () => void;
}

export function ThemeEditor({ theme, onClose }: ThemeEditorProps) {
  const patch = useSettingsStore((s) => s.patch);
  const settings = useSettingsStore((s) => s.settings);
  const applyTheme = useUiStore((s) => s.applyTheme);

  const [draft, setDraft] = useState<Theme | null>(theme);

  // Reset the draft whenever a (different) theme is handed in.
  useEffect(() => { setDraft(theme); }, [theme]);

  if (draft === null) return null;

  const setUi = (key: UiKey, hex: string) =>
    setDraft({ ...draft, ui: { ...draft.ui, [key]: hex } });
  const setPage = (key: PageKey, hex: string) =>
    setDraft({ ...draft, page: { ...draft.page, [key]: hex } });

  const save = () => {
    const name = draft.name.trim();
    const id = draft.id.trim() || `custom-${slug(name) || 'theme'}-${Date.now().toString(36)}`;
    const saved: Theme = { ...draft, id, name: name || 'Custom theme', builtin: false };

    const existing = settings.ui.customThemes.findIndex((t) => t.id === saved.id);
    const next = [...settings.ui.customThemes];
    if (existing >= 0) next[existing] = saved;
    else next.push(saved);

    patch({ ui: { customThemes: next, themeId: saved.id } });
    applyTheme();
    onClose();
  };

  return (
    <Modal
      onClose={onClose}
      title={draft.id ? 'Edit theme' : 'Create theme'}
      widthClass="max-w-lg"
      footer={
        <>
          <button type="button" className="vellum-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="vellum-btn vellum-btn-accent" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex items-center gap-2 text-[13px]">
          <span className="w-[110px] shrink-0">Theme name</span>
          <input
            type="text"
            className="vellum-selectable h-8 w-full text-[13px]"
            value={draft.name}
            placeholder="My theme"
            aria-label="Theme name"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>

        <div className="grid grid-cols-[1fr_auto] gap-4">
          <div className="min-w-0">
            <h3 className="v-set-head">Interface</h3>
            <div className="flex flex-col">
              {UI_FIELDS.map((f) => (
                <ColorRow
                  key={f.key}
                  label={f.label}
                  value={draft.ui[f.key]}
                  onChange={(hex) => setUi(f.key, hex)}
                />
              ))}
            </div>

            <h3 className="v-set-head">Book page</h3>
            <div className="flex flex-col">
              {PAGE_FIELDS.map((f) => (
                <ColorRow
                  key={f.key}
                  label={f.label}
                  value={draft.page[f.key]}
                  onChange={(hex) => setPage(f.key, hex)}
                />
              ))}
            </div>
          </div>

          <div className="w-[150px] shrink-0">
            <h3 className="v-set-head">Preview</h3>
            <PageMock theme={draft} className="h-[150px]" />
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default ThemeEditor;
