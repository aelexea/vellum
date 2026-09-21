/**
 * uiStore — FROZEN (scaffold-FE), full implementation per ARCHITECTURE.md §5.2/§5.12.
 * Custom state router (no react-router), overlay slots, toasts, confirm-as-Promise,
 * theme application (computes every --v-* CSS var from settingsStore's theme).
 *
 * Framework-light: no React imports; components subscribe via useUiStore.
 */
import { create } from 'zustand';
import type { Theme } from '@/lib/types';
import { BUILTIN_THEMES, THEME_SHADOWS, DEFAULT_SHADOW } from '@/lib/themes';
import { useSettingsStore } from '@/stores/settingsStore';
import { useReaderStore } from '@/stores/readerStore';

export type View = 'library' | 'reader' | 'vocab' | 'stats' | 'settings';

export type Overlay =
  | 'toc' | 'search' | 'annotations' | 'quickSettings'
  | 'review' | 'translate' | 'dict';

/** Left-drawer overlays share one slot (§5.12) and are mutually exclusive. */
export const LEFT_DRAWER_OVERLAYS: readonly Overlay[] = ['toc', 'search', 'annotations'];

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: number;
  msg: string;
  kind: ToastKind;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Extra checkbox rendered in the dialog (e.g. "Delete file from disk"). */
  checkboxLabel?: string;
  danger?: boolean;
}

export interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean, checked: boolean) => void;
}

/** Result of confirm(): user choice + optional checkbox state. */
export interface ConfirmResult { ok: boolean; checked: boolean; }

export interface UiState {
  view: View;
  overlay: Overlay | null;
  toasts: Toast[];
  pendingConfirm: PendingConfirm | null;
  /** Reader chrome visibility (§5.4 auto-hide); F2 drives it. */
  chromeVisible: boolean;
  booting: boolean;

  setView(v: View): void;
  setOverlay(o: Overlay | null): void;
  /** Same overlay → close; different → switch. */
  toggleOverlay(o: Overlay): void;
  closeOverlay(): void;

  toast(msg: string, kind?: ToastKind): number;
  dismissToast(id: number): void;

  confirm(opts: ConfirmOptions): Promise<boolean>;
  /** confirm + checkbox state (delete-book flow, §6.9). */
  confirmWithCheck(opts: ConfirmOptions): Promise<ConfirmResult>;
  resolveConfirm(ok: boolean, checked?: boolean): void;

  setChromeVisible(v: boolean): void;
  setBooting(v: boolean): void;

  /** Open a book and switch to the reader view (§5.2). */
  openBook(uid: string): Promise<void>;
  /** Back to library: flush position + heartbeat first (§5.12). */
  backToLibrary(): Promise<void>;

  applyTheme(): void;
}

let toastSeq = 1;
const TOAST_TTL = 3000;

/** Write one CSS custom property on <html>. */
function setVar(name: string, value: string): void {
  document.documentElement.style.setProperty(name, value);
}

/**
 * Compute every --v-* var from the active theme (§5.11), honouring the page colour
 * overrides in settings.page (§5.9/§11.5): override ?? theme value.
 */
export function computeThemeVars(theme: Theme, page: {
  textColorOverride?: string | null;
  backgroundColorOverride?: string | null;
  linkColorOverride?: string | null;
}): Record<string, string> {
  return {
    '--v-bg': theme.ui.bg,
    '--v-bg-alt': theme.ui.bgAlt,
    '--v-bg-raise': theme.ui.bgRaise,
    '--v-fg': theme.ui.fg,
    '--v-fg-muted': theme.ui.fgMuted,
    '--v-accent': theme.ui.accent,
    '--v-accent-fg': theme.ui.accentFg,
    '--v-border': theme.ui.border,
    '--v-shadow': THEME_SHADOWS[theme.id] ?? DEFAULT_SHADOW,
    // page vars: engine passes these into the iframe (§5.11)
    '--v-page-bg': page.backgroundColorOverride ?? theme.page.bg,
    '--v-page-fg': page.textColorOverride ?? theme.page.fg,
    '--v-page-link': page.linkColorOverride ?? theme.page.link,
    '--v-page-selection': theme.page.selectionBg,
  };
}

export const useUiStore = create<UiState>()((set, get) => ({
  view: 'library',
  overlay: null,
  toasts: [],
  pendingConfirm: null,
  chromeVisible: true,
  booting: true,

  setView: (v) => set({ view: v, overlay: null }),

  setOverlay: (o) => set({ overlay: o }),

  toggleOverlay: (o) => set((s) => ({ overlay: s.overlay === o ? null : o })),

  closeOverlay: () => set({ overlay: null }),

  toast: (msg, kind = 'info') => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, msg, kind }] }));
    setTimeout(() => get().dismissToast(id), TOAST_TTL);
    return id;
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  confirm: async (opts) => (await get().confirmWithCheck(opts)).ok,

  confirmWithCheck: (opts) =>
    new Promise<ConfirmResult>((resolve) => {
      // A previous dialog is abandoned (resolved false) rather than stacked.
      get().pendingConfirm?.resolve(false, false);
      set({
        pendingConfirm: {
          ...opts,
          resolve: (ok, checked) => resolve({ ok, checked }),
        },
      });
    }),

  resolveConfirm: (ok, checked = false) => {
    const pending = get().pendingConfirm;
    if (!pending) return;
    set({ pendingConfirm: null });
    pending.resolve(ok, checked);
  },

  setChromeVisible: (v) => set({ chromeVisible: v }),
  setBooting: (v) => set({ booting: v }),

  openBook: async (uid) => {
    set({ view: 'reader', overlay: null, chromeVisible: true });
    await useReaderStore.getState().open(uid);
  },

  backToLibrary: async () => {
    // Flush reading state before leaving the reader (§5.12).
    const reader = useReaderStore.getState();
    await reader.close();
    set({ view: 'library', overlay: null });
  },

  applyTheme: () => {
    const settings = useSettingsStore.getState();
    const theme = settings.theme();
    const vars = computeThemeVars(theme, settings.settings.page);
    for (const [name, value] of Object.entries(vars)) setVar(name, value);
    // Animations switch → data attribute consumed by base.css (§5.9).
    document.documentElement.dataset.animations = settings.settings.ui.animations ? 'on' : 'off';
    document.documentElement.dataset.theme = theme.id;
  },
}));

/** Cycle built-in themes (§5.10 cycleTheme); custom themes are skipped. */
export function cycleTheme(): void {
  const settings = useSettingsStore.getState();
  const ids = BUILTIN_THEMES.map((t) => t.id);
  const cur = ids.indexOf(settings.settings.ui.themeId);
  const next = ids[(cur + 1) % ids.length];
  settings.setThemeId(next);
  useUiStore.getState().applyTheme();
}
