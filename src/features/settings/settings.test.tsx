/**
 * F3 settings UI tests (§8). RTL + jsdom; settingsStore seeded via setState; the
 * Tauri surface is mocked in src/test/setup.ts (invoke logged to invokeCalls,
 * plugin-dialog/plugin-opener mocked).
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import * as dialog from '@tauri-apps/plugin-dialog';
import * as opener from '@tauri-apps/plugin-opener';

import SettingsView from '@/features/settings/SettingsView';
import { ShortcutsPanel } from '@/features/settings/ShortcutsPanel';
import { TypographyPanel } from '@/features/settings/TypographyPanel';
import { ThemeEditor } from '@/features/settings/ThemeEditor';
import { TranslatorsPanel } from '@/features/settings/TranslatorsPanel';
import { BackupPanel } from '@/features/settings/BackupPanel';
import { BUILTIN_THEMES } from '@/lib/themes';
import { DEFAULT_SETTINGS, useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { invokeCalls, mockCommand } from '@/test/setup';
import type { Settings } from '@/lib/types';

const saveCalls = () => invokeCalls.filter((c) => c.cmd === 'save_settings');

function seed(patch?: Partial<Settings>) {
  useSettingsStore.setState({
    settings: patch
      ? { ...structuredClone(DEFAULT_SETTINGS), ...patch }
      : structuredClone(DEFAULT_SETTINGS),
    loaded: true, fonts: [], fontsLoaded: false,
  });
  useUiStore.setState({ view: 'settings', toasts: [], pendingConfirm: null });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  seed();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --------------------------------------------------------------------------
// SettingsView shell + nav
// --------------------------------------------------------------------------
describe('SettingsView', () => {
  it('renders the 8-section left nav and switches panes', () => {
    render(<SettingsView />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const items = within(nav).getAllByRole('button');
    expect(items).toHaveLength(8);
    expect(items.map((b) => b.textContent)).toEqual([
      'Appearance', 'Text', 'Reading', 'Translation',
      'Dictionary (study)', 'Library', 'Shortcuts', 'Data',
    ]);
    // Appearance is default: theme cards present.
    expect(screen.getByText('Create theme')).toBeInTheDocument();

    // Switch to Reading.
    fireEvent.click(within(nav).getByRole('button', { name: /Reading/ }));
    expect(screen.getByText('Reading mode')).toBeInTheDocument();
    expect(screen.queryByText('Create theme')).not.toBeInTheDocument();
  });

  it('clicking a theme card patches ui.themeId and persists (debounced)', async () => {
    render(<SettingsView />);
    const darkCard = screen.getByRole('button', { name: /Dark/ });
    fireEvent.click(darkCard);

    expect(useSettingsStore.getState().settings.ui.themeId).toBe('dark');

    // Persistence is debounced 400 ms by the store.
    act(() => { vi.advanceTimersByTime(450); });
    await waitFor(() => expect(saveCalls().length).toBeGreaterThan(0));
  });

  it('toggling Animations writes the kill-switch data attribute', () => {
    render(<SettingsView />);
    expect(document.documentElement.dataset.animations).toBe('on');
    const sw = screen.getByRole('switch', { name: 'Animations' });
    fireEvent.click(sw);
    expect(useSettingsStore.getState().settings.ui.animations).toBe(false);
    expect(document.documentElement.dataset.animations).toBe('false');
  });

  it('back arrow returns to the previous view', () => {
    useUiStore.setState({ view: 'settings' });
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(useUiStore.getState().view).toBe('library');
  });

  it('library section: Rescan calls rescan_library + toasts count', async () => {
    mockCommand('rescan_library', { imported: [{}, {}], skipped: [], failed: [] });
    render(<SettingsView />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(within(nav).getByRole('button', { name: /Library/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));

    await waitFor(() =>
      expect(invokeCalls.some((c) => c.cmd === 'rescan_library')).toBe(true));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => t.msg === 'Books added: 2')).toBe(true));
  });
});

// --------------------------------------------------------------------------
// ThemeEditor
// --------------------------------------------------------------------------
describe('ThemeEditor', () => {
  it('hex input updates the live preview and save pushes a custom theme', async () => {
    const theme = {
      id: '', name: '',
      builtin: false,
      ui: { bg: '#ffffff', bgAlt: '#ffffff', bgRaise: '#ffffff', fg: '#000000',
        fgMuted: '#777777', accent: '#c2662d', accentFg: '#ffffff', border: '#e4e0da' },
      page: { bg: '#fcfbf9', fg: '#26221d', link: '#9a5b2d', selectionBg: 'rgba(0,0,0,.2)' },
    };

    render(<ThemeEditor theme={theme} onClose={() => {}} />);

    // Change the accent colour via its hex field.
    const accentHex = screen.getByLabelText('Accent (hex)');
    fireEvent.change(accentHex, { target: { value: '#123456' } });

    // Preview reflects it: the accent bar background.
    const bar = document.querySelector('.tp-bar') as HTMLElement;
    expect(bar.style.background).toContain('18, 52, 86'); // rgb(18,52,86)

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const custom = useSettingsStore.getState().settings.ui.customThemes;
    expect(custom).toHaveLength(1);
    expect(custom[0]!.ui.accent).toBe('#123456');
    expect(useSettingsStore.getState().settings.ui.themeId).toBe(custom[0]!.id);
  });

  it('editing a clone of a built-in theme never mutates BUILTIN_THEMES', () => {
    const light = BUILTIN_THEMES.find((t) => t.id === 'light')!;
    const snapshot = JSON.parse(JSON.stringify(light)) as typeof light;

    render(<ThemeEditor theme={{ ...light, id: '', name: '', builtin: false }} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Accent (hex)'), { target: { value: '#000000' } });
    fireEvent.change(screen.getByLabelText('Page background (hex)'), { target: { value: '#000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    // The frozen built-in table must be untouched (draft was spread, not aliased).
    expect(JSON.parse(JSON.stringify(light))).toEqual(snapshot);
    expect(useSettingsStore.getState().settings.ui.customThemes).toHaveLength(1);
  });

  it('invalid hex does not commit but valid one does', () => {
    const theme = {
      id: '', name: 'X', builtin: false,
      ui: { bg: '#ffffff', bgAlt: '#ffffff', bgRaise: '#ffffff', fg: '#000000',
        fgMuted: '#777777', accent: '#c2662d', accentFg: '#ffffff', border: '#e4e0da' },
      page: { bg: '#fcfbf9', fg: '#26221d', link: '#9a5b2d', selectionBg: 'rgba(0,0,0,.2)' },
    };
    render(<ThemeEditor theme={theme} onClose={() => {}} />);
    const hex = screen.getByLabelText('Accent (hex)');
    fireEvent.change(hex, { target: { value: '#zzz' } });
    const bar = document.querySelector('.tp-bar') as HTMLElement;
    expect(bar.style.background).toContain('194, 102, 45'); // unchanged #c2662d
    fireEvent.change(hex, { target: { value: '#00ff00' } });
    expect((document.querySelector('.tp-bar') as HTMLElement).style.background)
      .toContain('0, 255, 0');
  });
});

// --------------------------------------------------------------------------
// TypographyPanel
// --------------------------------------------------------------------------
describe('TypographyPanel', () => {
  it('loads fonts on mount and renders them in the font select', async () => {
    mockCommand('list_fonts', [
      { name: 'Georgia', hasBold: true, hasItalic: true, mono: false },
      { name: 'Arial', hasBold: true, hasItalic: false, mono: false },
    ]);
    render(<TypographyPanel />);
    await waitFor(() => expect(useSettingsStore.getState().fonts.length).toBe(2));
  });

  it('font-size slider patches page.fontSizePx and updates the preview', async () => {
    render(<TypographyPanel />);
    await act(async () => {});   // flush loadFonts effect
    const preview = screen.getByTestId('typo-preview');
    const before = (preview.firstElementChild as HTMLElement).style.fontSize;

    // §8: slider change patches page.fontSizePx.
    const slider = screen.getByLabelText('Size');
    expect(slider).toHaveAttribute('type', 'range');
    fireEvent.change(slider, { target: { value: '27' } });
    expect(useSettingsStore.getState().settings.page.fontSizePx).toBe(27);

    const after = (screen.getByTestId('typo-preview').firstElementChild as HTMLElement).style.fontSize;
    expect(after).toBe('27px');
    expect(before).not.toBe(after);

    // The numeric field stays in sync and also patches.
    const sizeNum = screen.getByLabelText('Size, px');
    expect(sizeNum).toHaveValue(27);
    fireEvent.change(sizeNum, { target: { value: '16' } });
    expect(useSettingsStore.getState().settings.page.fontSizePx).toBe(16);
  });

  it('align segmented patches page.textAlign', async () => {
    render(<TypographyPanel />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('tab', { name: 'Left' }));
    expect(useSettingsStore.getState().settings.page.textAlign).toBe('left');
    const col = screen.getByTestId('typo-preview').firstElementChild as HTMLElement;
    expect(col.style.textAlign).toBe('left');
  });

  it('page colour override writes settings and offers Reset', async () => {
    render(<TypographyPanel />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Page colors/ }));
    const hex = screen.getByLabelText('Text color (hex)');
    fireEvent.change(hex, { target: { value: '#ff0000' } });
    expect(useSettingsStore.getState().settings.page.textColorOverride).toBe('#ff0000');
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(useSettingsStore.getState().settings.page.textColorOverride).toBeNull();
  });
});

// --------------------------------------------------------------------------
// suggestAfterLookups (Dictionary section, rendered inline in SettingsView)
// --------------------------------------------------------------------------
describe('Dictionary section', () => {
  it('suggestAfterLookups slider patches vocab.suggestAfterLookups', async () => {
    render(<SettingsView />);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(within(nav).getByRole('button', { name: /Dictionary \(study\)/ }));
    await act(async () => {});   // flush TranslatorsPanel listTranslators effect
    const slider = screen.getByLabelText('Suggest word after N lookups');
    fireEvent.change(slider, { target: { value: '7' } });
    expect(useSettingsStore.getState().settings.vocab.suggestAfterLookups).toBe(7);
  });
});

// --------------------------------------------------------------------------
// ShortcutsPanel
// --------------------------------------------------------------------------
describe('ShortcutsPanel', () => {
  it('captures a new combo and patches shortcuts[action]', () => {
    render(<ShortcutsPanel />);
    const field = screen.getByRole('button', { name: /Shortcut: Contents/ });
    fireEvent.click(field);
    expect(screen.getByText('Press keys…')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'F4', ctrlKey: false, shiftKey: false, altKey: false, metaKey: false });
    expect(useSettingsStore.getState().settings.shortcuts.toggleToc).toBe('F4');
  });

  it('rejects a conflicting combo with a toast and keeps the old value', () => {
    render(<ShortcutsPanel />);
    // 'toggleSearch' default is Ctrl+F. Rebind toggleToc to Ctrl+F → conflict.
    const field = screen.getByRole('button', { name: /Shortcut: Contents/ });
    fireEvent.click(field);
    fireEvent.keyDown(window, { key: 'f', ctrlKey: true, shiftKey: false, altKey: false, metaKey: false });

    expect(useSettingsStore.getState().settings.shortcuts.toggleToc).toBe('Ctrl+T'); // unchanged
    expect(useUiStore.getState().toasts.some((t) => /Already assigned/.test(t.msg))).toBe(true);
  });

  it('Backspace clears, Esc cancels', () => {
    render(<ShortcutsPanel />);
    const field = screen.getByRole('button', { name: /Shortcut: Contents/ });
    fireEvent.click(field);
    fireEvent.keyDown(window, { key: 'Backspace' });
    expect(useSettingsStore.getState().settings.shortcuts.toggleToc).toBe('');

    fireEvent.click(field);
    fireEvent.keyDown(window, { key: 'Escape' });
    // still '' — Esc only cancels capture, does not change value
    expect(useSettingsStore.getState().settings.shortcuts.toggleToc).toBe('');
    expect(screen.queryByText('Press keys…')).not.toBeInTheDocument();
  });

  it('captures Ctrl+Shift+T on the translate row (§8 example) and patches', () => {
    render(<ShortcutsPanel />);
    const field = screen.getByRole('button', { name: /Shortcut: Translate selection/ });
    fireEvent.click(field);
    // Ctrl+Shift+T is this row's own default; re-binding to itself is not a conflict.
    fireEvent.keyDown(window, { key: 'T', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false });
    expect(useSettingsStore.getState().settings.shortcuts.translate).toBe('Ctrl+Shift+T');
  });

  it('Reset all restores defaults', () => {
    seed({ shortcuts: { ...DEFAULT_SETTINGS.shortcuts, toggleToc: '' } });
    render(<ShortcutsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset all' }));
    expect(useSettingsStore.getState().settings.shortcuts.toggleToc).toBe('Ctrl+T');
  });
});

// --------------------------------------------------------------------------
// TranslatorsPanel
// --------------------------------------------------------------------------
const PROVIDERS = [
  { id: 'google', name: 'Google', kind: 'translate', needsConfig: false, configured: true },
  { id: 'lingva', name: 'Lingva', kind: 'translate', needsConfig: true, configured: false },
  { id: 'libre', name: 'LibreTranslate', kind: 'translate', needsConfig: true, configured: false },
  { id: 'dictionaryapi', name: 'Dictionary API', kind: 'dict', needsConfig: false, configured: true },
];

describe('TranslatorsPanel', () => {
  beforeEach(() => {
    mockCommand('list_translators', PROVIDERS);
  });

  it('translate mode shows the provider select, target lang and popup switch', async () => {
    render(<TranslatorsPanel mode="translate" />);
    expect(screen.getByRole('switch', { name: 'Show translation immediately on selection' }))
      .toBeInTheDocument();

    // Wait for listTranslators() + listLanguages() before reading Select contents.
    await waitFor(() => expect(screen.getByText('Lingva')).toBeInTheDocument());
    expect(screen.getByRole('combobox', { name: 'Translation provider' })).toHaveTextContent('Google');
    // The language labels come from the list_languages mock in src/test/setup.ts
    // (English names, matching the backend net/languages.rs table).
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Target language' })).toHaveTextContent('Russian'));

    // translate-kind providers only — the dict one belongs to the Dictionary section.
    expect(screen.queryByText('Dictionary API')).not.toBeInTheDocument();
  });

  it('changing the default provider patches translate.defaultProviderId', async () => {
    render(<TranslatorsPanel mode="translate" />);
    // Wait for listTranslators() so the Select has options.
    await waitFor(() => expect(screen.getByText('Lingva')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('combobox', { name: 'Translation provider' }));
    fireEvent.click(screen.getByRole('option', { name: /Lingva/ }));
    expect(useSettingsStore.getState().settings.translate.defaultProviderId).toBe('lingva');
  });

  it('Test connection calls test_provider and toasts "Works"', async () => {
    mockCommand('test_provider', true);
    render(<TranslatorsPanel mode="translate" />);
    await waitFor(() => expect(screen.getByText('Lingva')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: 'Test connection' })[0]!);
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'test_provider')).toBe(true));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => t.msg === 'Works')).toBe(true));
  });

  it('a failed connection test toasts "Doesn\'t work"', async () => {
    mockCommand('test_provider', false);
    render(<TranslatorsPanel mode="translate" />);
    await waitFor(() => expect(screen.getByText('Lingva')).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole('button', { name: 'Test connection' })[0]!);
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => t.msg === "Doesn't work")).toBe(true));
  });

  it('base URL commits on blur → patch + save_provider_config', async () => {
    render(<TranslatorsPanel mode="translate" />);
    await waitFor(() => expect(screen.getByText('Lingva')).toBeInTheDocument());

    const url = screen.getByLabelText('Lingva: server address');
    fireEvent.change(url, { target: { value: 'https://lingva.example.org' } });
    // Not committed while typing.
    expect(invokeCalls.some((c) => c.cmd === 'save_provider_config')).toBe(false);
    fireEvent.blur(url);

    expect(useSettingsStore.getState().settings.translate.providers.lingva?.baseUrl)
      .toBe('https://lingva.example.org');
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'save_provider_config')).toBe(true));
  });

  it('libre shows a password API key field that commits on blur', async () => {
    render(<TranslatorsPanel mode="translate" />);
    await waitFor(() => expect(screen.getByText('LibreTranslate')).toBeInTheDocument());

    const key = screen.getByLabelText('LibreTranslate: API key');
    expect(key).toHaveAttribute('type', 'password');
    fireEvent.change(key, { target: { value: 'secret-key' } });
    fireEvent.blur(key);
    expect(useSettingsStore.getState().settings.translate.providers.libre?.apiKey)
      .toBe('secret-key');
  });

  it('dict mode lists the dictionary provider only', async () => {
    render(<TranslatorsPanel mode="dict" />);
    // The name appears twice: the Select's selected label and the provider card.
    await waitFor(() => expect(screen.getAllByText('Dictionary API').length).toBeGreaterThan(0));
    expect(screen.getByRole('combobox', { name: 'Dictionary provider' }))
      .toHaveTextContent('Dictionary API');
    expect(screen.queryByText('Lingva')).not.toBeInTheDocument();
    // No target-language / popup controls in the dictionary section.
    expect(screen.queryByRole('combobox', { name: 'Target language' })).not.toBeInTheDocument();
  });
});

// --------------------------------------------------------------------------
// BackupPanel
// --------------------------------------------------------------------------
describe('BackupPanel', () => {
  it('Export vocabulary opens the format popover then save dialog + export_vocab', async () => {
    vi.mocked(dialog.save).mockResolvedValue('/tmp/vocab.json');
    mockCommand('export_vocab', 5);

    render(<BackupPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Export vocabulary/ }));
    // Popover with formats.
    fireEvent.click(screen.getByRole('tab', { name: 'JSON' }));

    await waitFor(() => expect(dialog.save).toHaveBeenCalled());
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'export_vocab')).toBe(true));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => /words: 5/.test(t.msg))).toBe(true));
  });

  it('Import vocabulary calls import_vocab and toasts the count', async () => {
    vi.mocked(dialog.open).mockResolvedValue('/tmp/vocab.json');
    mockCommand('import_vocab', 12);

    render(<BackupPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Import vocabulary/ }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'import_vocab')).toBe(true));
    await waitFor(() =>
      expect(useUiStore.getState().toasts.some((t) => t.msg === 'Words imported: 12')).toBe(true));
  });

  it('Back up database calls backup_db', async () => {
    vi.mocked(dialog.save).mockResolvedValue('/tmp/backup.db');
    render(<BackupPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Back up database/ }));
    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'backup_db')).toBe(true));
  });

  it('Open data folder calls opener openPath', async () => {
    render(<BackupPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Open data folder/ }));
    await waitFor(() => expect(opener.openPath).toHaveBeenCalled());
  });

  it('shows the auto-backup info line', () => {
    render(<BackupPanel />);
    expect(screen.getByText('Auto-backup runs every 7 days')).toBeInTheDocument();
  });
});
