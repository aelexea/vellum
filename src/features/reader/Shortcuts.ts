/**
 * Keyboard shortcuts — default map per ARCHITECTURE.md §5.10, labels per §6.8.
 * Owned by [F2] (ShortcutsPanel [F3] consumes labels); scaffold provides the full
 * working implementation (map + parser/serializer + event matching).
 *
 * [F2] adds `dispatchAction` (§5.10): every action id wired to the frozen store APIs.
 *
 * IMPORTANT — no static store imports in this module: `settingsStore.ts` imports
 * `DEFAULT_SHORTCUTS` from here at module top level, so a static `@/stores/*` import
 * would create an init cycle (settingsStore would read DEFAULT_SHORTCUTS before this
 * module body ran → TDZ ReferenceError). Stores are therefore resolved lazily through
 * a cached dynamic import inside dispatchAction.
 */

// Type-only imports are erased at compile time → they cannot create the init cycle
// described above.
import type { LookupContext } from '@/lib/types';
import type { SelectionState } from '@/stores/readerStore';

export type ShortcutAction =
  | 'nextPage' | 'prevPage' | 'nextPageAlt' | 'prevPageAlt' | 'spaceNext'
  | 'nextChapter' | 'prevChapter'
  | 'toggleSearch' | 'toggleToc' | 'toggleAnnotations'
  | 'fontInc' | 'fontDec'
  | 'cycleTheme' | 'toggleMode' | 'toggleUi' | 'fullscreen'
  | 'bookmark' | 'translate' | 'dictionary' | 'addVocab'
  | 'openSettings' | 'backToLibrary' | 'startReview' | 'quit';

/** §5.10 — action id → default combo. */
export const DEFAULT_SHORTCUTS: Record<ShortcutAction, string> = {
  nextPage: 'Right',
  prevPage: 'Left',
  nextPageAlt: 'PageDown',
  prevPageAlt: 'PageUp',
  spaceNext: 'Space',
  nextChapter: 'Ctrl+Right',
  prevChapter: 'Ctrl+Left',
  toggleSearch: 'Ctrl+F',
  toggleToc: 'Ctrl+T',
  toggleAnnotations: 'Ctrl+Shift+A',
  fontInc: 'Ctrl+=',
  fontDec: 'Ctrl+-',
  cycleTheme: 'Ctrl+J',
  toggleMode: 'Ctrl+Shift+M',
  toggleUi: 'Ctrl+H',
  fullscreen: 'F11',
  bookmark: 'Ctrl+D',
  translate: 'Ctrl+Shift+T',
  dictionary: 'Ctrl+Shift+D',
  addVocab: 'Ctrl+Shift+V',
  openSettings: 'Ctrl+,',
  backToLibrary: 'Ctrl+L',
  startReview: 'Ctrl+Shift+R',
  quit: 'Ctrl+Q',
};

/** §6.8 — labels for the ShortcutsPanel rows. */
export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  nextPage: 'Next page',
  prevPage: 'Previous page',
  nextPageAlt: 'Next page',
  prevPageAlt: 'Previous page',
  spaceNext: 'Next page',
  nextChapter: 'Next chapter',
  prevChapter: 'Previous chapter',
  toggleSearch: 'Search',
  toggleToc: 'Contents',
  toggleAnnotations: 'Notes and highlights',
  fontInc: 'Larger font',
  fontDec: 'Smaller font',
  cycleTheme: 'Change theme',
  toggleMode: 'Scroll/page mode',
  toggleUi: 'Hide interface',
  fullscreen: 'Fullscreen',
  bookmark: 'Bookmark',
  translate: 'Translate selection',
  dictionary: 'Dictionary',
  addVocab: 'Add word to vocabulary',
  openSettings: 'Settings',
  backToLibrary: 'Back to library',
  startReview: 'Start review',
  quit: 'Quit',
};

/** Actions that require an active text selection (§5.10). */
export const SELECTION_SCOPED_ACTIONS: ReadonlySet<ShortcutAction> = new Set<ShortcutAction>([
  'translate', 'dictionary', 'addVocab',
]);

export interface Combo {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** Canonical form: lowercase; arrows as 'right'/'left'; ' ' as 'space'. */
  key: string;
}

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Lowercase + fold layout/synonym variants to one canonical token. */
export function normalizeKey(raw: string): string {
  let k = raw.trim().toLowerCase();
  if (k.startsWith('arrow')) k = k.slice(5);        // ArrowRight → right
  if (k === ' ') k = 'space';
  if (k === '+') k = '=';                            // shifted '=' on many layouts
  if (k === '_') k = '-';
  if (k === '<') k = ',';
  if (k === '>') k = '.';
  if (k === 'control') k = 'ctrl';
  if (k === 'option' || k === 'cmd' || k === 'command') k = 'meta';
  return k;
}

const DISPLAY_KEYS: Record<string, string> = {
  right: 'Right', left: 'Left', up: 'Up', down: 'Down',
  pagedown: 'PageDown', pageup: 'PageUp',
  space: 'Space', escape: 'Esc', enter: 'Enter',
};

/** Canonical key → display form used in combos ('Ctrl+Shift+A', 'PageDown'). */
export function displayKey(k: string): string {
  if (DISPLAY_KEYS[k]) return DISPLAY_KEYS[k];
  if (/^f\d+$/.test(k)) return k.toUpperCase();
  if (k.length === 1) return k.toUpperCase();
  return k;
}

/**
 * Parse a combo string like 'Ctrl+Shift+A' / 'PageDown' / 'Ctrl+='.
 * Case-insensitive; supports Ctrl/Shift/Alt/Meta. Returns null for an empty string.
 */
export function parseCombo(s: string): Combo | null {
  const combo: Combo = { ctrl: false, shift: false, alt: false, meta: false, key: '' };
  const tokens = s.split('+').map((t) => t.trim()).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  for (const token of tokens) {
    const k = normalizeKey(token);
    if (k === 'ctrl' || k === 'shift' || k === 'alt' || k === 'meta') {
      combo[k] = true;
    } else {
      combo.key = k;
    }
  }
  if (!combo.key) return null;
  return combo;
}

/** Serialize a combo back to display form: Ctrl → Shift → Alt → Meta → Key. */
export function serializeCombo(c: Combo): string {
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.shift) parts.push('Shift');
  if (c.alt) parts.push('Alt');
  if (c.meta) parts.push('Meta');
  parts.push(displayKey(c.key));
  return parts.join('+');
}

/** Build a canonical Combo from a keyboard event. */
export function comboFromEvent(e: KeyLike): Combo {
  return {
    ctrl: e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
    meta: e.metaKey,
    key: normalizeKey(e.key),
  };
}

export function combosEqual(a: Combo, b: Combo): boolean {
  return a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt
    && a.meta === b.meta && a.key === b.key;
}

/** Find the action whose combo matches the event, or null. */
export function findActionForEvent(
  shortcuts: Record<string, string>, e: KeyLike,
): string | null {
  const ev = comboFromEvent(e);
  for (const [action, comboStr] of Object.entries(shortcuts)) {
    const c = parseCombo(comboStr);
    if (c && combosEqual(c, ev)) return action;
  }
  return null;
}

/** Another action already bound to the same combo → its id, else null. */
export function findConflict(
  shortcuts: Record<string, string>, action: string, comboStr: string,
): string | null {
  const target = parseCombo(comboStr);
  if (!target) return null;
  for (const [a, s] of Object.entries(shortcuts)) {
    if (a === action) continue;
    const c = parseCombo(s);
    if (c && combosEqual(c, target)) return a;
  }
  return null;
}

// ===========================================================================
// Dispatch (§5.10) — [F2]
// ===========================================================================

/** Every action id dispatchAction knows how to run (App uses it for preventDefault). */
export const DISPATCHABLE_ACTIONS: ReadonlySet<string> = new Set<string>(
  Object.keys(DEFAULT_SHORTCUTS),
);

export function isDispatchable(action: string): boolean {
  return DISPATCHABLE_ACTIONS.has(action);
}

/** §5.10 copy: selection-scoped actions with no active selection. */
export const NEEDS_SELECTION_TOAST = 'Select some text';

/** Font size bounds for fontInc/fontDec (§5.9 slider range). */
const FONT_MIN = 12;
const FONT_MAX = 32;

type ChromeToggleListener = () => void;
const chromeToggleListeners = new Set<ChromeToggleListener>();

/**
 * Ctrl+H hides the chrome until the user asks for it back. The flag lives here so both
 * ChromeBars (idle/wake timer) and ReaderView (cursor, click zones) agree: without it a
 * mousemove wake-up would instantly undo the force-hide.
 */
let chromeForcedHidden = false;

export function isChromeForcedHidden(): boolean {
  return chromeForcedHidden;
}

export function setChromeForcedHidden(v: boolean): void {
  chromeForcedHidden = v;
}

/** Flip the force-hide flag and apply it to uiStore.chromeVisible. */
export async function toggleChromeHidden(): Promise<void> {
  const { ui } = await bundle();
  const next = !chromeForcedHidden;
  chromeForcedHidden = next;
  ui.useUiStore.getState().setChromeVisible(!next);
}

/**
 * ReaderView subscribes so a click-zone centre tap can toggle the chrome too.
 * dispatchAction falls back to flipping `uiStore.chromeVisible` directly when nothing is
 * mounted (e.g. unit tests).
 */
export function subscribeChromeToggle(cb: ChromeToggleListener): () => void {
  chromeToggleListeners.add(cb);
  return () => { chromeToggleListeners.delete(cb); };
}

interface StoreBundle {
  ui: typeof import('@/stores/uiStore');
  reader: typeof import('@/stores/readerStore');
  settings: typeof import('@/stores/settingsStore');
  vocab: typeof import('@/stores/vocabStore');
}

let bundlePromise: Promise<StoreBundle> | null = null;

/** Cached dynamic import of the frozen stores (see the module header for why). */
function bundle(): Promise<StoreBundle> {
  bundlePromise ??= Promise.all([
    import('@/stores/uiStore'),
    import('@/stores/readerStore'),
    import('@/stores/settingsStore'),
    import('@/stores/vocabStore'),
  ]).then(([ui, reader, settings, vocab]) => ({ ui, reader, settings, vocab }));
  return bundlePromise;
}

/** F11 / maximize: Tauri window API first, DOM fullscreen as fallback. */
export async function toggleFullscreen(): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const isFull = await win.isFullscreen();
    await win.setFullscreen(!isFull);
    return;
  } catch {
    /* not running under Tauri (tests / plain browser) → DOM fallback */
  }
  try {
    const el = document.documentElement;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el.requestFullscreen?.();
  } catch {
    /* fullscreen unavailable — ignore */
  }
}

/**
 * Close the application window (Ctrl+Q). Flushes reading state first when a book is open,
 * so quitting from the reader cannot lose the last position or the accumulated heartbeat
 * (§5.12 — leaving the reader saves position + flushes the heartbeat).
 */
export async function quitApp(): Promise<void> {
  try {
    const { reader, settings } = await bundle();
    const rs = reader.useReaderStore.getState();
    if (rs.book) await rs.close();
    // Persist any debounced settings edit before the window goes away.
    settings.useSettingsStore.getState().flush();
  } catch (e) {
    // Never let a failed flush block quitting.
    console.error('quit flush failed', e);
  }
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  } catch (e) {
    console.error('quit failed', e);
  }
}

/**
 * Run a shortcut action (§5.10). Resolves the frozen stores lazily, so it is safe to
 * call from anywhere (App keydown, chrome buttons, panels). Unknown ids are ignored.
 *
 * @returns true when the action was recognised and dispatched.
 */
export async function dispatchAction(action: string): Promise<boolean> {
  if (!DISPATCHABLE_ACTIONS.has(action)) return false;
  const { ui, reader, settings, vocab } = await bundle();
  const uiState = ui.useUiStore.getState();
  const readerState = reader.useReaderStore.getState();
  const settingsState = settings.useSettingsStore.getState();

  switch (action as ShortcutAction) {
    // ---------------------------------------------------------- paging (§7.3)
    case 'nextPage':
    case 'nextPageAlt':
    case 'spaceNext':
      readerState.nextPage();
      return true;

    case 'prevPage':
    case 'prevPageAlt':
      readerState.prevPage();
      return true;

    // ------------------------------------------------------- chapter stepping
    case 'nextChapter':
      if (!readerState.book) return true;
      readerState.gotoChapter(readerState.chapterIdx + 1);
      return true;

    case 'prevChapter':
      if (!readerState.book) return true;
      readerState.gotoChapter(readerState.chapterIdx - 1);
      return true;

    // -------------------------------------------------------------- overlays
    case 'toggleSearch':
      uiState.toggleOverlay('search');
      return true;
    case 'toggleToc':
      uiState.toggleOverlay('toc');
      return true;
    case 'toggleAnnotations':
      uiState.toggleOverlay('annotations');
      return true;
    case 'startReview':
      // Load the due queue before the overlay mounts so ReviewSession cannot flash empty
      // (it also self-loads when the queue is empty, so this is a pre-warm, not a dupe).
      await vocab.useVocabStore.getState().startReview();
      uiState.setOverlay('review');
      return true;
    case 'openSettings':
      uiState.setView('settings');
      return true;
    case 'backToLibrary':
      await uiState.backToLibrary();
      return true;

    // ------------------------------------------------------------ typography
    case 'fontInc':
    case 'fontDec': {
      const delta = action === 'fontInc' ? 1 : -1;
      const cur = settingsState.settings.page.fontSizePx;
      const next = Math.min(FONT_MAX, Math.max(FONT_MIN, cur + delta));
      if (next !== cur) settingsState.patch({ page: { fontSizePx: next } });
      return true;
    }

    // ----------------------------------------------------------------- theme
    case 'cycleTheme':
      ui.cycleTheme();
      return true;

    // ------------------------------------------------------------------ mode
    case 'toggleMode': {
      const next = settingsState.settings.reading.mode === 'paginated' ? 'scroll' : 'paginated';
      settingsState.patch({ reading: { mode: next } });
      readerState.setMode(next);
      return true;
    }

    // ---------------------------------------------------------------- chrome
    case 'toggleUi': {
      // Set the shared flag first so no wake-up timer can undo the hide (§5.4).
      const next = !chromeForcedHidden;
      chromeForcedHidden = next;
      uiState.setChromeVisible(!next);
      for (const cb of chromeToggleListeners) cb();
      return true;
    }

    case 'fullscreen':
      await toggleFullscreen();
      return true;

    // -------------------------------------------------------------- bookmark
    case 'bookmark': {
      if (!readerState.book) return true;
      await readerState.toggleBookmark(readerState.lastCfi ?? '');
      return true;
    }

    // ------------------------------------------------- selection-scoped (§7.4)
    case 'translate': {
      const sel = readerState.selection;
      if (!sel || !sel.text.trim()) {
        uiState.toast(NEEDS_SELECTION_TOAST, 'info');
        return true;
      }
      uiState.setOverlay('translate');
      return true;
    }

    case 'dictionary': {
      const sel = readerState.selection;
      if (!sel || !sel.text.trim()) {
        uiState.toast(NEEDS_SELECTION_TOAST, 'info');
        return true;
      }
      const word = (sel.word ?? sel.text).trim();
      await readerState.lookup(word, lookupContext(reader, sel));
      return true;
    }

    case 'addVocab': {
      const sel = readerState.selection;
      if (!sel || !sel.text.trim()) {
        uiState.toast(NEEDS_SELECTION_TOAST, 'info');
        return true;
      }
      const rs = readerState;
      const last = vocab.useVocabStore.getState().lastLookup;
      const added = await vocab.useVocabStore.getState().add({
        word: (sel.word ?? sel.text).trim(),
        translation: last?.translation?.translatedText ?? null,
        definition: last?.dictionary?.meanings[0]?.definitions[0]?.definition ?? null,
        transcription: last?.dictionary?.transcription ?? null,
        pos: last?.dictionary?.meanings[0]?.pos ?? null,
        examples: [],
        bookUid: rs.book?.book.uid ?? null,
        chapterIdx: rs.book ? rs.chapterIdx : null,
        context: sel.sentence || sel.text,
        contextCfi: sel.cfiStart,
      });
      if (added) uiState.toast('Word added', 'success');
      return true;
    }

    case 'quit':
      await quitApp();
      return true;

    default:
      return false;
  }
}

/** Build the LookupContext (§4.1) for the current selection. */
function lookupContext(
  reader: StoreBundle['reader'],
  sel: SelectionState,
): LookupContext | null {
  const rs = reader.useReaderStore.getState();
  if (!rs.book) return null;
  return {
    bookUid: rs.book.book.uid,
    chapterIdx: rs.chapterIdx,
    sentence: sel.sentence || sel.text,
    cfi: sel.cfiStart,
  };
}
