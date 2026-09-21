/**
 * ChromeBars — [F2] per ARCHITECTURE.md §5.4.
 * Floating top + bottom chrome above the page (the page colour fills the reader root).
 *
 * Top: back · "title • chapter" · bookmark, contents, search, notes, Aa, theme,
 *      mode, fullscreen.
 * Bottom: prev-chapter · whole-book progress slider with chapter ticks · next-chapter ·
 *      "page {x} / {y} · {pct} %".
 *
 * Auto-hide (§5.4): mousemove (throttled 100 ms) / keypress / touch / a 48 px edge zone
 * shows the bars; after 2.5 s idle they hide. Any open overlay pins them visible.
 * Visibility lives in `uiStore.chromeVisible` so ReaderView can drop the cursor too.
 *
 * Styling note (same trap F5 documented): base.css's `button`/`input` resets are unlayered
 * and therefore outrank Tailwind's `@layer utilities` rules. Every button and the range
 * input below are styled by the scoped <style> block — a class selector beats those
 * element resets on specificity, whereas a font/colour/padding utility would silently lose.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Icon } from '@/components/icons';
import type { IconName } from '@/components/icons';
import { clamp } from '@/lib/utils';
import { useReaderStore } from '@/stores/readerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import {
  dispatchAction, findActionForEvent,
  isChromeForcedHidden, setChromeForcedHidden,
} from '@/features/reader/Shortcuts';

/** §5.4 — hide after this much idle time. */
const IDLE_HIDE_MS = 2500;
/** §5.4 — pointer near the top/bottom edge wakes the chrome. */
const EDGE_ZONE_PX = 48;
/** Throttle for the (very frequent) mousemove wake-ups. */
const MOVE_THROTTLE_MS = 100;
/** Max characters of "title • chapter" before the middle is elided. */
const HEADING_MAX = 46;

const CHROME_CSS = `
.vel-cb-btn{
  display:inline-flex; align-items:center; justify-content:center;
  width:36px; height:36px; flex:none; padding:0;
  border:0; border-radius:var(--radius-sm); background:none;
  color:var(--v-fg-muted); cursor:pointer;
  transition:background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.vel-cb-btn:hover:not(:disabled){
  background:color-mix(in srgb, var(--v-border) 40%, transparent);
  color:var(--v-fg);
}
.vel-cb-btn:disabled{ opacity:.35; cursor:default; }
.vel-cb-btn[data-on="true"]{ color:var(--v-accent); }
.vel-cb-heading{
  margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-size:13px; font-weight:500; color:var(--v-fg);
}
.vel-cb-progress{
  flex:none; margin-left:4px; font-size:12px; color:var(--v-fg-muted);
  font-variant-numeric:tabular-nums;
}
.vel-cb-track{ position:relative; flex:1; min-width:0; }
.vel-cb-range{
  width:100%; height:20px; margin:0; padding:0; box-sizing:border-box;
  background:transparent; border:0; border-radius:2px;
  -webkit-appearance:none; appearance:none; cursor:pointer;
}
.vel-cb-range:disabled{ opacity:.4; cursor:default; }
.vel-cb-range::-webkit-slider-thumb{
  -webkit-appearance:none; appearance:none;
  width:13px; height:13px; border-radius:50%;
  background:var(--v-accent); border:2px solid var(--v-bg-raise);
  box-shadow:0 0 0 1px var(--v-border);
}
.vel-cb-range::-moz-range-thumb{
  width:13px; height:13px; border-radius:50%; border:2px solid var(--v-bg-raise);
  background:var(--v-accent);
}
.vel-cb-tip{
  position:absolute; top:-34px; z-index:10; transform:translateX(-50%);
  max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  padding:3px 8px; font-size:11px; color:var(--v-fg);
  background:var(--v-bg-alt); border:1px solid var(--v-border);
  border-radius:var(--radius-sm); box-shadow:var(--v-shadow);
  pointer-events:none;
}
`;

/** Shared bar surface: raised, slightly transparent, blurred, hairline border (§5.4). */
const barStyle = (visible: boolean, edge: 'top' | 'bottom'): CSSProperties => ({
  position: 'absolute',
  left: 0,
  right: 0,
  top: edge === 'top' ? 0 : undefined,
  bottom: edge === 'bottom' ? 0 : undefined,
  zIndex: 20,
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  height: 48,
  padding: '0 8px',
  boxSizing: 'border-box',
  background: 'color-mix(in srgb, var(--v-bg-raise) 95%, transparent)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  borderBottom: edge === 'top' ? '1px solid var(--v-border)' : undefined,
  borderTop: edge === 'bottom' ? '1px solid var(--v-border)' : undefined,
  // opacity + translateY, 180 ms var(--ease) (§5.4)
  transition: 'opacity var(--dur-med) var(--ease), transform var(--dur-med) var(--ease)',
  opacity: visible ? 1 : 0,
  transform: visible
    ? 'translateY(0)'
    : `translateY(${edge === 'top' ? '-100%' : '100%'})`,
  pointerEvents: visible ? 'auto' : 'none',
});

/** Keep the middle of "title • chapter" when it is too long (§5.4). */
export function truncateMiddle(s: string, max = HEADING_MAX): string {
  if (s.length <= max) return s;
  const keep = Math.floor((max - 1) / 2);
  return `${s.slice(0, keep)}…${s.slice(s.length - keep)}`;
}

interface ChromeButtonProps {
  icon: IconName;
  label: string;
  onClick: () => void;
  /** Accent colour (overlay open, mode state). */
  active?: boolean;
  /** Filled accent — bookmark exists in this chapter. */
  filled?: boolean;
  disabled?: boolean;
}

/** 36 px icon button — design bar: hover bg var(--v-border)/40, 120 ms. */
function ChromeButton({ icon, label, onClick, active, filled, disabled }: ChromeButtonProps) {
  return (
    <button
      type="button"
      className="vel-cb-btn"
      aria-label={label}
      title={label}
      aria-pressed={active ?? undefined}
      data-on={filled || active || undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={18} />
    </button>
  );
}

export default function ChromeBars() {
  const book = useReaderStore((s) => s.book);
  const chapterIdx = useReaderStore((s) => s.chapterIdx);
  const pageIndex = useReaderStore((s) => s.pageIndex);
  const pageCount = useReaderStore((s) => s.pageCount);
  const bookmarks = useReaderStore((s) => (s.book ? s.book.bookmarks : null));
  const mode = useReaderStore((s) => s.mode);
  // (chapterIdx + pctWithinChapter) / totalChapters — the §5.4 whole-book progress.
  const globalPct = useReaderStore((s) => {
    const total = s.book?.book.chapters.length || 1;
    return clamp((s.chapterIdx + s.pctWithinChapter) / total, 0, 1);
  });

  const overlay = useUiStore((s) => s.overlay);
  const chromeVisible = useUiStore((s) => s.chromeVisible);
  const setChromeVisible = useUiStore((s) => s.setChromeVisible);
  const backToLibrary = useUiStore((s) => s.backToLibrary);
  const toggleOverlay = useUiStore((s) => s.toggleOverlay);

  const autoHide = useSettingsStore((s) => s.settings.ui.autoHideChrome);
  const themeId = useSettingsStore((s) => s.settings.ui.themeId);

  /** Live chapter index while the slider is dragged (committed on release). */
  const [scrubIdx, setScrubIdx] = useState<number | null>(null);

  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastMove = useRef(0);

  const clearTimer = (): void => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  // An open overlay (or auto-hide off) pins the chrome visible (§5.4).
  const pinned = overlay !== null || !autoHide;

  useEffect(() => {
    if (pinned) {
      clearTimer();
      setChromeVisible(true);
      return;
    }
    // A Ctrl+H force-hide wins over the "show on mount / chapter change" default.
    if (isChromeForcedHidden()) {
      clearTimer();
      setChromeVisible(false);
      return;
    }
    setChromeVisible(true);
    hideTimer.current = setTimeout(() => setChromeVisible(false), IDLE_HIDE_MS);
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned, chapterIdx, overlay]);

  useEffect(() => {
    if (pinned) return;

    /** Show the bars and restart the idle countdown (§5.4). */
    const wake = (): void => {
      // Any interaction lifts a Ctrl+H force-hide.
      if (isChromeForcedHidden()) setChromeForcedHidden(false);
      setChromeVisible(true);
      clearTimer();
      hideTimer.current = setTimeout(() => setChromeVisible(false), IDLE_HIDE_MS);
    };

    const onMouseMove = (e: MouseEvent): void => {
      const now = Date.now();
      const nearEdge = e.clientY <= EDGE_ZONE_PX
        || e.clientY >= window.innerHeight - EDGE_ZONE_PX;
      // Throttled, but a pointer inside an edge zone always wakes immediately.
      if (!nearEdge && now - lastMove.current < MOVE_THROTTLE_MS) return;
      lastMove.current = now;
      wake();
    };

    const onKey = (e: KeyboardEvent): void => {
      // App's capture-phase handler already ran. Waking on the very key that hides the
      // chrome (Ctrl+H) would instantly undo it, so skip that one action.
      const shortcuts = useSettingsStore.getState().shortcuts();
      if (findActionForEvent(shortcuts, e) === 'toggleUi') return;
      wake();
    };
    const onTouch = (): void => { wake(); };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('keydown', onKey);
    window.addEventListener('touchstart', onTouch, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('touchstart', onTouch);
      clearTimer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinned]);

  // ------------------------------------------------------------------- content
  const total = book?.book.chapters.length ?? 0;

  const chapterTitle = useMemo(() => {
    const t = book?.book.chapters[chapterIdx]?.title?.trim();
    return t && t.length > 0 ? t : `chapter ${chapterIdx + 1}`;
  }, [book, chapterIdx]);

  const heading = truncateMiddle(`${book?.book.title ?? ''} • ${chapterTitle}`.trim());

  const hasBookmark = bookmarks?.some((b) => b.chapterIdx === chapterIdx) ?? false;
  const visible = chromeVisible || pinned;

  const sliderIdx = scrubIdx ?? chapterIdx;
  const sliderMax = Math.max(0, total - 1);

  /** Chapter tick marks as gradient stops on the track (§5.4). */
  const trackBackground = useMemo(() => {
    const filled = 'var(--v-accent)';
    const rest = 'color-mix(in srgb, var(--v-fg) 16%, transparent)';
    if (sliderMax <= 0) return `linear-gradient(to right, ${filled} 100%)`;
    const pct = (sliderIdx / sliderMax) * 100;
    const stops = [`${filled} ${pct}%`, `${rest} ${pct}%`];
    const tick = 'color-mix(in srgb, var(--v-fg) 38%, transparent)';
    for (let i = 1; i < sliderMax; i++) {
      const at = (i / sliderMax) * 100;
      stops.push(`${rest} calc(${at}% - 1px)`, `${tick} calc(${at}% - 1px)`);
      stops.push(`${tick} calc(${at}% + 1px)`, `${rest} calc(${at}% + 1px)`);
    }
    return `linear-gradient(to right, ${stops.join(', ')})`;
  }, [sliderMax, sliderIdx]);

  const tooltipTitle = useMemo(() => {
    const t = book?.book.chapters[sliderIdx]?.title?.trim();
    return t && t.length > 0 ? t : `chapter ${sliderIdx + 1}`;
  }, [book, sliderIdx]);

  const commitScrub = (): void => {
    const idx = scrubIdx;
    setScrubIdx(null);
    if (idx !== null && idx !== chapterIdx) useReaderStore.getState().gotoChapter(idx);
  };

  const pctText = `${Math.round(globalPct * 100)}`;

  return (
    <div
      data-testid="chrome-bars"
      data-chrome-hidden={!visible}
      style={{ position: 'absolute', inset: 0, zIndex: 20, pointerEvents: 'none' }}
    >
      <style>{CHROME_CSS}</style>

      {/* ------------------------------------------------------------------ top */}
      <header data-testid="chrome-top" style={barStyle(visible, 'top')}>
        <ChromeButton
          icon="arrowLeft"
          label="Back to library"
          onClick={() => { void backToLibrary(); }}
        />

        <p
          data-testid="chrome-heading"
          className="vel-cb-heading"
          style={{ flex: 1, minWidth: 0, margin: '0 4px' }}
          title={`${book?.book.title ?? ''} — ${chapterTitle}`}
        >
          {heading}
        </p>

        <ChromeButton
          icon="bookmark"
          label="Bookmark"
          filled={hasBookmark}
          active={hasBookmark}
          disabled={!book}
          onClick={() => { void dispatchAction('bookmark'); }}
        />
        <ChromeButton
          icon="toc"
          label="Contents"
          active={overlay === 'toc'}
          onClick={() => toggleOverlay('toc')}
        />
        <ChromeButton
          icon="search"
          label="Search"
          active={overlay === 'search'}
          onClick={() => toggleOverlay('search')}
        />
        <ChromeButton
          icon="notes"
          label="Notes"
          active={overlay === 'annotations'}
          onClick={() => toggleOverlay('annotations')}
        />
        <ChromeButton
          icon="type"
          label="Text appearance"
          active={overlay === 'quickSettings'}
          onClick={() => toggleOverlay('quickSettings')}
        />
        <ChromeButton
          icon={themeId === 'light' || themeId === 'sepia' ? 'sun' : 'moon'}
          label="Change theme"
          onClick={() => { void dispatchAction('cycleTheme'); }}
        />
        <ChromeButton
          icon={mode === 'paginated' ? 'columns' : 'scroll'}
          label="Scroll/page mode"
          onClick={() => { void dispatchAction('toggleMode'); }}
        />
        <ChromeButton
          icon="maximize"
          label="Fullscreen"
          onClick={() => { void dispatchAction('fullscreen'); }}
        />
      </header>

      {/* --------------------------------------------------------------- bottom */}
      <footer data-testid="chrome-bottom" style={{ ...barStyle(visible, 'bottom'), gap: 8 }}>
        <ChromeButton
          icon="chevronLeft"
          label="Previous chapter"
          disabled={chapterIdx <= 0}
          onClick={() => useReaderStore.getState().gotoChapter(chapterIdx - 1)}
        />

        <div className="vel-cb-track">
          {scrubIdx !== null && (
            <span
              data-testid="scrub-tooltip"
              className="vel-cb-tip"
              style={{ left: `${sliderMax > 0 ? (scrubIdx / sliderMax) * 100 : 0}%` }}
            >
              {tooltipTitle}
            </span>
          )}
          <input
            type="range"
            data-testid="chapter-slider"
            className="vel-cb-range"
            aria-label="Book progress"
            min={0}
            max={sliderMax}
            step={1}
            value={sliderIdx}
            disabled={total === 0}
            style={{
              backgroundImage: trackBackground,
              backgroundSize: '100% 3px',
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'center',
            }}
            onChange={(e) => setScrubIdx(Number(e.target.value))}
            onPointerUp={commitScrub}
            onBlur={() => setScrubIdx(null)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitScrub(); }}
          />
        </div>

        <ChromeButton
          icon="chevronRight"
          label="Next chapter"
          disabled={total === 0 || chapterIdx >= total - 1}
          onClick={() => useReaderStore.getState().gotoChapter(chapterIdx + 1)}
        />

        <span data-testid="chrome-progress" className="vel-cb-progress">
          {mode === 'paginated' && pageCount > 0
            ? `page ${pageIndex + 1} / ${pageCount} · ${pctText} %`
            : `${pctText} %`}
        </span>
      </footer>
    </div>
  );
}
