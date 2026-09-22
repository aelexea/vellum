/**
 * ReaderView — [F2] per ARCHITECTURE.md §5.4/§7.2.
 *
 * Root reading surface: the page colour fills it and the chrome floats above. Mounts the
 * iframe pool (ChapterFrame), the top/bottom bars (ChromeBars) and the SelectionToolbar.
 * TocPanel / QuickSettings are mounted by App.tsx as overlays (§5.12).
 *
 * Input owned here (§5.4):
 *  - click zones (setting, default off): left/right 25 % turn pages, centre toggles chrome
 *  - wheel: in paginated mode with `wheelTurnsPage` it turns pages (throttled 120 ms) and
 *    the default scroll is prevented; in scroll mode the iframe scrolls natively
 *  - touch: horizontal swipe > 50 px turns pages
 *  - the root takes focus on mount so the global shortcuts work immediately
 *
 * Esc closes overlays (handled by App.tsx). Ctrl+H force-hides the chrome through the
 * Shortcuts.ts subscription so the idle timer cannot immediately re-show it.
 */
import { useCallback, useEffect, useRef } from 'react';
import { Icon } from '@/components/icons';
import ChapterFrame from '@/features/reader/ChapterFrame';
import ChromeBars from '@/features/reader/ChromeBars';
import SelectionToolbar from '@/features/reader/SelectionToolbar';
import {
  isChromeForcedHidden, setChromeForcedHidden,
  subscribeChromeToggle, toggleChromeHidden,
} from '@/features/reader/Shortcuts';
import { cn } from '@/lib/utils';
import { useReaderStore } from '@/stores/readerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

/** §5.4 — wheel page turns are throttled so one flick cannot skip several pages. */
const WHEEL_THROTTLE_MS = 120;
/** §5.4 — minimum horizontal swipe to count as a page turn. */
const SWIPE_MIN_DX = 50;
/** Click zones: outer quarters turn pages, the middle toggles chrome. */
const ZONE_FRACTION = 0.25;

/** The reading surface when the file is gone (§6.9 "File unavailable"). */
function UnavailableBook() {
  const backToLibrary = useUiStore((s) => s.backToLibrary);
  return (
    <div className="fixed inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-[var(--v-page-bg)] text-[var(--v-page-fg)]">
      <p className="text-[15px]">File unavailable</p>
      <button
        type="button"
        className="vellum-btn"
        data-testid="reader-back"
        onClick={() => { void backToLibrary(); }}
      >
        <Icon name="arrowLeft" size={15} />
        Back
      </button>
    </div>
  );
}

export default function ReaderView() {
  const book = useReaderStore((s) => s.book);
  const nextPage = useReaderStore((s) => s.nextPage);
  const prevPage = useReaderStore((s) => s.prevPage);

  const autoHide = useSettingsStore((s) => s.settings.ui.autoHideChrome);
  const clickZones = useSettingsStore((s) => s.settings.reading.clickZones);
  const wheelTurnsPage = useSettingsStore((s) => s.settings.reading.wheelTurnsPage);
  const popupOnSelect = useSettingsStore((s) => s.settings.translate.popupOnSelect);
  const selection = useReaderStore((s) => s.selection);
  // readerStore.mode is authoritative: it is restored from the saved position and is the
  // mode ChapterFrame actually laid out, which may differ from settings.reading.mode.
  const mode = useReaderStore((s) => s.mode);
  const chromeVisible = useUiStore((s) => s.chromeVisible);
  const setChromeVisible = useUiStore((s) => s.setChromeVisible);
  const overlay = useUiStore((s) => s.overlay);

  const rootRef = useRef<HTMLDivElement>(null);
  const wheelLock = useRef(0);

  // --------------------------------------------------------------- focus root
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // --------------------------------------------- translate popup on selection
  // Settings → Translation "Show translation immediately on selection": open the
  // translate overlay as soon as a real selection appears, so the user doesn't have
  // to reach for the toolbar or Ctrl+Shift+T. Only fires on a fresh selection edge.
  const popupOpenedFor = useRef<string | null>(null);
  useEffect(() => {
    const text = selection?.text.trim() || null;
    if (!text) { popupOpenedFor.current = null; return; }
    if (!popupOnSelect) return;
    if (popupOpenedFor.current === text) return;
    popupOpenedFor.current = text;
    useUiStore.getState().setOverlay('translate');
  }, [selection, popupOnSelect]);

  // --------------------------------------------------- Ctrl+H chrome force-hide
  // The flag itself lives in Shortcuts.ts so ChromeBars' wake-up timer honours it too.
  useEffect(() => subscribeChromeToggle(() => {
    void toggleChromeHidden();
  }), []);

  /** Centre tap of the click zones toggles the chrome (§5.4). */
  const toggleChrome = useCallback(() => {
    void toggleChromeHidden();
  }, []);

  /** Any interaction lifts a force-hide (§5.4: visible on mouse move / touch). */
  const wakeChrome = useCallback(() => {
    if (isChromeForcedHidden()) {
      setChromeForcedHidden(false);
      setChromeVisible(true);
    }
  }, [setChromeVisible]);

  // ------------------------------------------------------------------ click zones
  useEffect(() => {
    const el = rootRef.current;
    if (!el || !clickZones) return;

    let downX = 0;
    let downY = 0;
    let downAt = 0;

    const onDown = (e: PointerEvent): void => {
      downX = e.clientX; downY = e.clientY; downAt = Date.now();
    };

    const onUp = (e: PointerEvent): void => {
      // Ignore drags (text selection) and anything but a quick tap.
      const dx = Math.abs(e.clientX - downX);
      const dy = Math.abs(e.clientY - downY);
      if (dx > 8 || dy > 8 || Date.now() - downAt > 500) return;
      if (e.button !== 0) return;
      // Let the chrome and the selection toolbar keep their own clicks.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-chrome],[role="toolbar"],button,a')) return;

      const rect = el.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / Math.max(1, rect.width);
      if (frac <= ZONE_FRACTION) prevPage();
      else if (frac >= 1 - ZONE_FRACTION) nextPage();
      else toggleChrome();          // centre tap shows/hides the bars (§5.4)
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
    };
  }, [clickZones, nextPage, prevPage, toggleChrome]);

  // ------------------------------------------------------------------------ wheel
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    if (mode !== 'paginated' || !wheelTurnsPage) return;

    const onWheel = (e: WheelEvent): void => {
      // The chrome bars sit inside this root and must keep their own wheel (they are
      // overlay drawers rendered by App, i.e. outside this subtree).
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-chrome]')) return;

      const now = Date.now();
      if (now - wheelLock.current < WHEEL_THROTTLE_MS) { e.preventDefault(); return; }
      wheelLock.current = now;

      e.preventDefault();          // paginated mode owns the wheel (§5.4)
      wakeChrome();
      if (e.deltaY > 0 || e.deltaX > 0) nextPage();
      else if (e.deltaY < 0 || e.deltaX < 0) prevPage();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [mode, wheelTurnsPage, nextPage, prevPage, wakeChrome]);

  // ------------------------------------------------------------------------ touch
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;

    const onStart = (e: TouchEvent): void => {
      const t = e.changedTouches[0];
      if (!t) return;
      startX = t.clientX; startY = t.clientY;
      wakeChrome();
    };

    const onEnd = (e: TouchEvent): void => {
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) < SWIPE_MIN_DX || Math.abs(dy) > Math.abs(dx)) return;
      if (dx < 0) nextPage();   // swipe left → next
      else prevPage();          // swipe right → prev
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
    };
  }, [nextPage, prevPage, wakeChrome]);

  // The mouse cursor disappears with the chrome (§5.4) so reading stays uncluttered.
  // The mouse cursor disappears with the chrome (§5.4); an open drawer keeps it.
  const hideCursor = autoHide && !chromeVisible && overlay === null;

  if (!book) return <UnavailableBook />;
  if (book.book.missing) return <UnavailableBook />;

  return (
    <div
      ref={rootRef}
      data-testid="reader-view"
      tabIndex={-1}
      className={cn(
        'fixed inset-0 overflow-hidden bg-[var(--v-page-bg)] outline-none',
        hideCursor && 'cursor-none',
      )}
      onPointerMove={wakeChrome}
      onPointerDown={wakeChrome}
    >
      <ChapterFrame />
      <SelectionToolbar />
      <div data-chrome="1" className="pointer-events-none absolute inset-0">
        <ChromeBars />
      </div>
    </div>
  );
}
