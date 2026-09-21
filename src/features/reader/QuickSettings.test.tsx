/**
 * QuickSettings (§8) — font size slider patches settingsStore, steppers clamp, theme
 * circles, mode segmented, and "All settings" navigation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import QuickSettings from '@/features/reader/QuickSettings';
import { useReaderStore } from '@/stores/readerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { BUILTIN_THEMES } from '@/lib/themes';

function seed(): void {
  useReaderStore.setState({
    book: null, loading: false, chapterIdx: 0, pageIndex: 0, pageCount: 0,
    mode: 'paginated', pctWithinChapter: 0, selection: null, pendingTarget: null,
    lastCfi: null,
  } as never);
  useUiStore.setState({ view: 'reader', overlay: 'quickSettings' });
  useSettingsStore.setState((s) => ({
    fontsLoaded: true,
    fonts: [],
    settings: {
      ...s.settings,
      page: { ...s.settings.page, fontSizePx: 19, lineHeight: 1.65 },
      reading: { ...s.settings.reading, mode: 'paginated' },
      ui: { ...s.settings.ui, themeId: 'light' },
    },
  }));
}

describe('QuickSettings font size (§8)', () => {
  beforeEach(seed);
  afterEach(() => vi.restoreAllMocks());

  it('the size slider patches settingsStore with fontSizePx', async () => {
    const patch = vi.spyOn(useSettingsStore.getState(), 'patch');
    render(<QuickSettings />);
    const slider = screen.getByLabelText('Font size') as HTMLInputElement;
    expect(slider.value).toBe('19');

    fireEvent.change(slider, { target: { value: '24' } });
    expect(patch).toHaveBeenCalledWith({ page: { fontSizePx: 24 } });
    await waitFor(() => expect(useSettingsStore.getState().settings.page.fontSizePx).toBe(24));
  });

  it('the A+ stepper increments fontSizePx by 1', () => {
    const patch = vi.spyOn(useSettingsStore.getState(), 'patch');
    render(<QuickSettings />);
    fireEvent.click(screen.getByTestId('font-inc'));
    expect(patch).toHaveBeenCalledWith({ page: { fontSizePx: 20 } });
  });

  it('the A- stepper decrements fontSizePx by 1', () => {
    const patch = vi.spyOn(useSettingsStore.getState(), 'patch');
    render(<QuickSettings />);
    fireEvent.click(screen.getByTestId('font-dec'));
    expect(patch).toHaveBeenCalledWith({ page: { fontSizePx: 18 } });
  });

  it('the steppers clamp at 32 / 12 px', () => {
    const patch = vi.spyOn(useSettingsStore.getState(), 'patch');
    useSettingsStore.setState((s) => ({
      settings: { ...s.settings, page: { ...s.settings.page, fontSizePx: 32 } },
    }));
    render(<QuickSettings />);
    fireEvent.click(screen.getByTestId('font-inc'));
    expect(patch).not.toHaveBeenCalled();
  });
});

describe('QuickSettings other controls', () => {
  beforeEach(seed);
  afterEach(() => vi.restoreAllMocks());

  it('line-height slider patches lineHeight', () => {
    const patch = vi.spyOn(useSettingsStore.getState(), 'patch');
    render(<QuickSettings />);
    fireEvent.change(screen.getByLabelText('Line spacing'), { target: { value: '1.9' } });
    expect(patch).toHaveBeenCalledWith({ page: { lineHeight: 1.9 } });
  });

  it('the margins slider applies one value to all four sides', () => {
    const patch = vi.spyOn(useSettingsStore.getState(), 'patch');
    render(<QuickSettings />);
    fireEvent.change(screen.getByLabelText('Margins'), { target: { value: '16' } });
    expect(patch).toHaveBeenCalledWith({
      page: { marginsPx: { top: 16, right: 16, bottom: 16, left: 16 } },
    });
  });

  it('font family select patches fontFamily', async () => {
    useSettingsStore.setState({
      fonts: [{ name: 'Georgia', hasBold: true, hasItalic: true, mono: false }],
      fontsLoaded: true,
    });
    const patch = vi.spyOn(useSettingsStore.getState(), 'patch');
    render(<QuickSettings />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Font' }));
    fireEvent.click(screen.getByText('Georgia'));
    expect(patch).toHaveBeenCalledWith({ page: { fontFamily: 'Georgia' } });
  });

  it('renders a circle for every built-in theme; clicking one sets it', async () => {
    const applyTheme = vi.spyOn(useUiStore.getState(), 'applyTheme').mockImplementation(() => {});
    render(<QuickSettings />);
    for (const t of BUILTIN_THEMES) {
      expect(screen.getByTestId(`theme-${t.id}`)).toBeInTheDocument();
    }
    fireEvent.click(screen.getByTestId('theme-dark'));
    await waitFor(() => expect(useSettingsStore.getState().settings.ui.themeId).toBe('dark'));
    expect(applyTheme).toHaveBeenCalled();
  });

  it('the active theme circle is pressed', () => {
    render(<QuickSettings />);
    expect(screen.getByTestId('theme-light')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('theme-dark')).toHaveAttribute('aria-pressed', 'false');
  });

  it('the mode segmented patches settings and the reader store', () => {
    const patch = vi.spyOn(useSettingsStore.getState(), 'patch');
    const setMode = vi.spyOn(useReaderStore.getState(), 'setMode').mockImplementation(() => {});
    render(<QuickSettings />);
    fireEvent.click(screen.getByRole('tab', { name: 'Scroll' }));
    expect(patch).toHaveBeenCalledWith({ reading: { mode: 'scroll' } });
    expect(setMode).toHaveBeenCalledWith('scroll');
  });

  it('"All settings" closes the drawer and switches to the settings view', () => {
    render(<QuickSettings />);
    fireEvent.click(screen.getByTestId('all-settings'));
    expect(useUiStore.getState().overlay).toBeNull();
    expect(useUiStore.getState().view).toBe('settings');
  });

  it('the close button clears the overlay', () => {
    render(<QuickSettings />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(useUiStore.getState().overlay).toBeNull();
  });

  it('loads the font list lazily when not yet fetched', async () => {
    useSettingsStore.setState({ fontsLoaded: false, fonts: [] });
    const loadFonts = vi.spyOn(useSettingsStore.getState(), 'loadFonts')
      .mockResolvedValue(undefined);
    render(<QuickSettings />);
    await waitFor(() => expect(loadFonts).toHaveBeenCalled());
  });

  it('does not reload fonts when already loaded', () => {
    const loadFonts = vi.spyOn(useSettingsStore.getState(), 'loadFonts')
      .mockResolvedValue(undefined);
    render(<QuickSettings />);
    expect(loadFonts).not.toHaveBeenCalled();
  });
});

describe('QuickSettings generic font fallbacks (§5.4)', () => {
  beforeEach(seed);
  afterEach(() => vi.restoreAllMocks());

  it('offers the generic serif/sans families with English labels', () => {
    render(<QuickSettings />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Font' }));
    // The frozen Select shows the selected label in the trigger AND as a list row, so
    // scope to the listbox to assert the offered options.
    const list = within(screen.getByRole('listbox'));
    expect(list.getByText('System (serif)')).toBeInTheDocument();
    expect(list.getByText('System (sans-serif)')).toBeInTheDocument();
    expect(list.getByText('Monospace')).toBeInTheDocument();
  });

  it('shows the currently selected family', () => {
    act(() => {
      useSettingsStore.setState((s) => ({
        settings: { ...s.settings, page: { ...s.settings.page, fontFamily: 'serif' } },
      }));
    });
    render(<QuickSettings />);
    expect(screen.getByRole('combobox', { name: 'Font' }).textContent)
      .toContain('System (serif)');
  });
});
