/**
 * ChapterFrame — [F2] per ARCHITECTURE.md §5.4/§7.2/§7.3.
 *
 * A pool of 3 absolutely-stacked, same-origin iframes. No `sandbox` attribute: srcdoc must
 * stay same-origin so the engine gets direct `contentDocument` access (§4.3); chapter HTML
 * is already sanitized by the backend (B2 lol_html pass). Only the current iframe is
 * visible — neighbours are kept warm (`visibility:hidden`) and prefetched, so a chapter
 * turn that hits a warm slot is a role swap with no load at all.
 *
 * Load pipeline (§5.4): fetch(`vellum://book/{uid}/chapter/{idx}`) → LRU text cache →
 * inject readerBaseCss + theme/typography vars + turn-animation CSS → iframe.srcdoc →
 * controller.ready() → controller.layout({mode,…}) → apply the pending position.
 *
 * The frozen engine facade (F0) is consumed verbatim. Two integration notes:
 *  - `cfiAtPage` is not on the facade, so it is called from pagination.ts against
 *    `controller.chapterRoot().ownerDocument`.
 *  - every engine call is guarded: F0's stubs throw `WP-F0` until the engine lands, and
 *    jsdom cannot lay out columns. On failure the chapter is still shown unpaginated
 *    rather than taking the reader down.
 */
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
} from 'react';
import { ChapterController } from '@/features/reader/engine/controller';
import type { ControllerLayoutOpts } from '@/features/reader/engine/controller';
import { readerBaseCss } from '@/features/reader/engine/readerBaseCss';
import type { HighlightItem } from '@/features/reader/engine/highlight';
import type { PageTurnAnimation } from '@/features/reader/engine/pagination';
import type { Settings } from '@/lib/types';
import { openUrl } from '@/lib/tauri';
import { clamp, cn } from '@/lib/utils';
import { FIND_EVENT } from '@/features/search/jump';
import type { FindDetail } from '@/features/search/jump';
import { useReaderStore } from '@/stores/readerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

/** §5.4 — three pooled iframes (prev / current / next). */
const POOL_SIZE = 3;
/** LRU cap for decoded chapter HTML (§5.4 fetch cache). */
const CACHE_CAP = 10;
/** Column gap in paginated mode; a page step is pageWidth + gap (§5.3 setPage math). */
const GAP_PX = 48;
/** Turn animation duration must match TURN_CSS below (§5.4: 140 ms). */
const TURN_MS = 140;

/**
 * CSS for the page-turn animation, injected next to readerBaseCss. readerBaseCss is F0's
 * (do not edit); the facade's setPage() only translates #vellum-wrap, so the transition
 * itself is owned here (§5.4 slide/fade/none).
 */
const TURN_CSS = `
#vellum-wrap { transition: transform ${TURN_MS}ms var(--ease), opacity ${TURN_MS}ms var(--ease); }
html[data-vellum-turn="fade"] #vellum-wrap { transition: opacity ${TURN_MS}ms var(--ease); }
`;

// ---------------------------------------------------------------------------
// Frame geometry — where the visible iframe sits in window coords, so
// SelectionToolbar can map an iframe-local selection rect onto the app viewport.
// Owned here (the frame is the only thing that knows) and read by SelectionToolbar.
// ---------------------------------------------------------------------------
let frameOffset = { x: 0, y: 0 };

export function setFrameOffset(x: number, y: number): void {
  frameOffset = { x, y };
}

export function getFrameOffset(): { x: number; y: number } {
  return frameOffset;
}

// ---------------------------------------------------------------------------
// Chapter HTML cache — LRU Map keyed `${uid}:${idx}` (§5.4, cap 10).
// ---------------------------------------------------------------------------
const htmlCache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const v = htmlCache.get(key);
  if (v !== undefined) {
    htmlCache.delete(key);
    htmlCache.set(key, v);   // refresh recency
  }
  return v;
}

function cacheSet(key: string, value: string): void {
  if (htmlCache.has(key)) htmlCache.delete(key);
  htmlCache.set(key, value);
  while (htmlCache.size > CACHE_CAP) {
    const oldest = htmlCache.keys().next();
    if (oldest.done) break;
    htmlCache.delete(oldest.value);
  }
}

/** Fetch one chapter's rewritten XHTML over the vellum:// protocol (§4.3). */
async function fetchChapter(uid: string, idx: number): Promise<string> {
  const key = `${uid}:${idx}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;
  const res = await fetch(`vellum://book/${uid}/chapter/${idx}`);
  if (!res.ok) throw new Error(`chapter ${idx}: HTTP ${res.status}`);
  const text = await res.text();
  cacheSet(key, text);
  return text;
}

// ---------------------------------------------------------------------------
// srcdoc assembly — theme page vars + typography + readerBaseCss + turn CSS (§5.3).
// ---------------------------------------------------------------------------

/** Page colour vars from the active theme, honouring the §11.5 overrides. */
function pageVars(settings: Settings): Record<string, string> {
  const theme = useSettingsStore.getState().theme();
  const p = settings.page;
  return {
    '--v-page-bg': p.backgroundColorOverride ?? theme.page.bg,
    '--v-page-fg': p.textColorOverride ?? theme.page.fg,
    '--v-page-link': p.linkColorOverride ?? theme.page.link,
    '--v-page-selection': theme.page.selectionBg,
    // srcdoc creates its own document, so host :root vars do NOT cascade in. The engine's
    // search-flash keyframe reads --v-accent with a light-theme fallback; injecting the
    // live accent keeps the flash matching dark/sepia/OLED themes.
    '--v-accent': theme.ui.accent,
    '--v-ease': 'cubic-bezier(0.2,0,0,1)',
  };
}

/** Typography record handed to engine layout (css var name → value). */
function typographyVars(settings: Settings): Record<string, string> {
  const p = settings.page;
  return {
    '--v-font-family': p.fontFamily,
    '--v-font-size': `${p.fontSizePx}px`,
    '--v-font-weight': String(p.fontWeight),
    '--v-line-height': String(p.lineHeight),
    '--v-letter-spacing': `${p.letterSpacingEm}em`,
    '--v-text-align': p.textAlign,
    '--v-para-indent': `${p.paragraphIndentEm}em`,
    '--v-para-spacing': `${p.paragraphSpacingEm}em`,
    // F0's readerBaseCss reads `--v-hyphens` (NOT --v-hyphenate) — matched to the engine.
    '--v-hyphens': p.hyphenate ? 'auto' : 'none',
    '--v-margin-top': `${p.marginsPx.top}px`,
    '--v-margin-right': `${p.marginsPx.right}px`,
    '--v-margin-bottom': `${p.marginsPx.bottom}px`,
    '--v-margin-left': `${p.marginsPx.left}px`,
    '--v-page-width-pct': String(p.pageWidthPct),
    '--v-scroll-max-width': `${p.scrollMaxWidthPx}px`,
  };
}

function allVars(settings: Settings): Record<string, string> {
  return { ...pageVars(settings), ...typographyVars(settings) };
}

function styleString(settings: Settings): string {
  return Object.entries(allVars(settings)).map(([k, v]) => `${k}:${v}`).join(';');
}

/**
 * Full srcdoc: a <style> (vars + readerBaseCss + turn CSS) in <head>, plus the vars as
 * inline style attrs on <html>. Defensive fallbacks cover chapters without <head>/<html>.
 */
export function buildSrcdoc(chapterHtml: string, settings: Settings): string {
  const vars = styleString(settings);
  const styleTag = `<style data-vellum="1">:root{${vars}}${readerBaseCss}${TURN_CSS}</style>`;
  const styleAttr = ` style="${vars}"`;

  if (/<head[^>]*>/i.test(chapterHtml)) {
    return chapterHtml
      .replace(/<head([^>]*)>/i, (_m, attrs: string) => `<head${attrs}>${styleTag}`)
      .replace(/<html([^>]*)>/i, (_m, attrs: string) => `<html${attrs}${styleAttr}>`);
  }
  if (/<html[^>]*>/i.test(chapterHtml)) {
    return chapterHtml
      .replace(/<html([^>]*)>/i, (_m, attrs: string) => `<html${attrs}${styleAttr}>`)
      .replace(/<body([^>]*)>/i, (_m, attrs: string) => `<body${attrs}>${styleTag}`);
  }
  return `<!DOCTYPE html><html class="vellum-doc"${styleAttr}><head>${styleTag}</head><body>${chapterHtml}</body></html>`;
}

/** Layout options for the engine facade (§5.3 ControllerLayoutOpts). */
export function layoutOptsFor(
  settings: Settings,
  box: { width: number; height: number },
  mode: 'paginated' | 'scroll',
): ControllerLayoutOpts {
  const p = settings.page;
  const pageWidthPx = Math.max(
    120,
    Math.round((box.width * p.pageWidthPct) / 100) - p.marginsPx.left - p.marginsPx.right,
  );
  return {
    mode,
    maxWidthPx: p.scrollMaxWidthPx,
    pageWidthPx,
    gapPx: GAP_PX,
    heightPx: Math.max(120, box.height - p.marginsPx.top - p.marginsPx.bottom),
    typography: typographyVars(settings),
  };
}

// ---------------------------------------------------------------------------
// Engine guards — degrade instead of crashing while F0's stubs throw.
// ---------------------------------------------------------------------------
function safePages(ctrl: ChapterController): number {
  try {
    const n = ctrl.pages();
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch { return 1; }
}

function safeCurrentPage(ctrl: ChapterController): number {
  try {
    const n = ctrl.currentPage();
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch { return 0; }
}

/** CFI of the current reading head, for readerStore.setLastCfi → savePos (§5.4). */
function safeCurrentCfi(ctrl: ChapterController): string | null {
  try { return ctrl.currentCfi(); } catch { return null; }
}

/** Within-chapter progress 0..1 (page math in paginated mode, scrollTop in scroll mode). */
function safeProgress(ctrl: ChapterController): number {
  try {
    const p = ctrl.progress();
    return Number.isFinite(p) ? clamp(p, 0, 1) : 0;
  } catch { return 0; }
}

/** Chapter content height in px, for sizing the iframe in scroll mode (§5.3). */
function safeContentHeight(ctrl: ChapterController): number {
  try {
    const h = ctrl.contentHeight();
    return Number.isFinite(h) && h > 0 ? h : 0;
  } catch { return 0; }
}

function safeSetPage(ctrl: ChapterController, page: number, animate: PageTurnAnimation): void {
  try { ctrl.setPage(page, animate); } catch { /* engine not ready */ }
}

function safeGoto(ctrl: ChapterController, where: number | string): void {
  try { ctrl.goto(where); } catch { /* engine not ready */ }
}

// ---------------------------------------------------------------------------
// Pool slot bookkeeping
// ---------------------------------------------------------------------------
interface Slot {
  chapterIdx: number | null;
  controller: ChapterController | null;
  pages: number;
  /** Detaches the iframe→parent keydown forwarder (see wireKeyForwarding). */
  unforwardKeys?: () => void;
}

const emptySlot = (): Slot => ({ chapterIdx: null, controller: null, pages: 0 });

/**
 * Forward keydown events from a chapter iframe up to the app window.
 *
 * The global shortcut handler (App.tsx) listens on the parent `window`, but once the
 * reader clicks/selects text inside a chapter, focus moves into the iframe's own
 * document and its key events no longer bubble to the parent — silently killing every
 * shortcut, including the selection-scoped ones (translate/dictionary/add-to-vocab)
 * that matter most right after selecting text. Re-dispatch an equivalent event on the
 * parent window so App's capture-phase listener sees it.
 *
 * The iframe default is suppressed ONLY when the app actually handled the key
 * (`dispatchEvent` returns false once a listener calls preventDefault). That keeps
 * browser-native actions the app does not own — notably Ctrl+C to copy book text —
 * working inside the chapter.
 */
function wireKeyForwarding(iframe: HTMLIFrameElement): () => void {
  const win = iframe.contentWindow;
  if (!win) return () => {};
  const onKey = (e: KeyboardEvent) => {
    const synth = new KeyboardEvent('keydown', {
      key: e.key, code: e.code,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
      bubbles: true, cancelable: true,
    });
    const unhandled = window.dispatchEvent(synth);
    if (!unhandled) e.preventDefault();
  };
  win.addEventListener('keydown', onKey, true);
  return () => { try { win.removeEventListener('keydown', onKey, true); } catch { /* frame gone */ } };
}

/** Restore target handed to a freshly laid-out chapter. */
interface Position {
  cfi?: string;
  pageIndex?: number;
  pct?: number;
}

export default function ChapterFrame() {
  const uid = useReaderStore((s) => s.book?.book.uid ?? null);
  const chapterIdx = useReaderStore((s) => s.chapterIdx);
  const pageIndex = useReaderStore((s) => s.pageIndex);
  const mode = useReaderStore((s) => s.mode);
  const pendingTarget = useReaderStore((s) => s.pendingTarget);
  const highlights = useReaderStore((s) => (s.book ? s.book.highlights : null));
  const prefetch = useSettingsStore((s) => s.settings.reading.prefetch);
  const pageTurn = useSettingsStore((s) => s.settings.reading.pageTurn);
  const settings = useSettingsStore((s) => s.settings);

  const iframeRefs = useRef<(HTMLIFrameElement | null)[]>(
    Array.from({ length: POOL_SIZE }, () => null),
  );
  const slots = useRef<Slot[]>(Array.from({ length: POOL_SIZE }, emptySlot));
  /** Mirrors the rendered slot so callbacks can read it without a re-render. */
  const currentRef = useRef(0);
  const [current, setCurrent] = useState(0);

  const boxRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  /** Monotonic token: only the newest navigation may publish results. */
  const tokenRef = useRef(0);
  const lastSeq = useRef(0);
  const lastAppliedPage = useRef(-1);
  /** ResizeObserver tracking the scroll-mode chapter height (§5.3). */
  const scrollRo = useRef<ResizeObserver | null>(null);
  /**
   * In-chapter find+flash request from a panel jump (F5's `vellum:find` seam). The event
   * fires synchronously with `readerStore.gotoChapter/gotoCfi`, i.e. before the target
   * chapter is loaded and laid out, so it is queued here and applied once layout lands.
   */
  const pendingFind = useRef<FindDetail | null>(null);

  // --------------------------------------------------------------- measurement
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = (): void => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    // jsdom has no ResizeObserver; the initial measure still sizes the pool.
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ------------------------------------------------------------- slot teardown
  const disposeSlot = useCallback((i: number): void => {
    try { slots.current[i].controller?.dispose(); } catch { /* ignore */ }
    try { slots.current[i].unforwardKeys?.(); } catch { /* ignore */ }
    slots.current[i] = emptySlot();
  }, []);

  useEffect(() => () => {
    scrollRo.current?.disconnect();
    scrollRo.current = null;
    for (let i = 0; i < POOL_SIZE; i++) {
      try { slots.current[i].controller?.dispose(); } catch { /* ignore */ }
      try { slots.current[i].unforwardKeys?.(); } catch { /* ignore */ }
      slots.current[i] = emptySlot();
    }
  }, []);

  /**
   * Pick the slot to load a new chapter into: reuse a warm one if it already holds the
   * chapter, else an empty non-current slot, else the slot farthest from the current one.
   */
  const slotFor = useCallback((idx: number): number => {
    const warm = slots.current.findIndex((s) => s.chapterIdx === idx);
    if (warm >= 0) return warm;
    const cur = currentRef.current;
    for (let d = 1; d < POOL_SIZE; d++) {
      const i = (cur + d) % POOL_SIZE;
      if (slots.current[i].chapterIdx === null) return i;
    }
    return (cur + 2) % POOL_SIZE;
  }, []);

  // ------------------------------------------------------- highlights + links
  const paintHighlights = useCallback((i: number): void => {
    const slot = slots.current[i];
    if (!slot.controller || slot.chapterIdx === null) return;
    const items = (highlights ?? [])
      .filter((h) => h.chapterIdx === slot.chapterIdx)
      .map<HighlightItem>((h) => ({
        id: h.id, cfiStart: h.cfiStart, cfiEnd: h.cfiEnd, color: h.color, hasNote: h.hasNote,
      }));
    try { slot.controller.setHighlights(items); } catch { /* engine not ready */ }
  }, [highlights]);

  const wireController = useCallback((ctrl: ChapterController, idx: number): void => {
    try {
      ctrl.onSelect((sel) => {
        // Only the visible chapter drives the selection toolbar.
        if (slots.current[currentRef.current].chapterIdx !== idx) return;
        const reader = useReaderStore.getState();
        if (!sel || !sel.text.trim()) { reader.setSelection(null); return; }
        reader.setSelection({
          text: sel.text,
          cfiStart: sel.cfiStart,
          cfiEnd: sel.cfiEnd,
          rect: { x: sel.rect.x, y: sel.rect.y, width: sel.rect.width, height: sel.rect.height },
          sentence: sel.sentence,
          word: sel.word,
        });
      });
    } catch { /* optional hook */ }

    try {
      // The richer link router (§4.3). The facade fires both onLinkClick and onAnyLinkClick
      // for internal links, so only this one is registered — never both.
      ctrl.onAnyLinkClick((link) => {
        switch (link.kind) {
          case 'external':
            // http(s)/mailto/tel and a[data-vellum-external] → opener plugin, never navigate.
            void openUrl(link.url).catch((e) => console.error('openUrl failed', e));
            break;
          case 'internal': {
            // The legacy `#vellum-link:{idx}:{fragment}` form carries a spine index; B2's
            // `vellum-link://{zipPath}` reports NO_CHAPTER_IDX (-1) and is resolved here —
            // chapters[].href is the same zip-root-relative, percent-decoded form.
            const reader = useReaderStore.getState();
            let idx = link.link.chapterIdx;
            if (idx < 0 && link.link.zipPath) {
              const chapters = reader.book?.book.chapters ?? [];
              const hit = chapters.find((c) => c.href === link.link.zipPath);
              if (hit) idx = Number(hit.idx);
            }
            if (idx >= 0) reader.gotoChapter(idx);
            break;
          }
          case 'inpage':
            // Already scrolled into view by the controller itself.
            break;
          default:
            break;
        }
      });
    } catch { /* optional hook */ }
  }, []);

  // ------------------------------------------------------------ position apply
  /**
   * Move a loaded slot to `pos` and publish the resulting page/cfi to the store so
   * savePos() (§7.3) and the chrome counter stay in sync.
   */
  const applyPosition = useCallback((i: number, pos: Position | null, animate: PageTurnAnimation): void => {
    const slot = slots.current[i];
    const ctrl = slot.controller;
    if (!ctrl) return;
    const reader = useReaderStore.getState();
    const isScroll = reader.mode === 'scroll';

    let page = 0;
    if (pos?.cfi) {
      safeGoto(ctrl, pos.cfi);
      page = safeCurrentPage(ctrl);
    } else if (!isScroll && typeof pos?.pageIndex === 'number') {
      page = clamp(pos.pageIndex, 0, Math.max(0, slot.pages - 1));
      safeSetPage(ctrl, page, animate);
    } else if (typeof pos?.pct === 'number') {
      if (isScroll) safeGoto(ctrl, pos.pct);
      else {
        page = clamp(Math.round(pos.pct * (slot.pages - 1)), 0, Math.max(0, slot.pages - 1));
        safeSetPage(ctrl, page, animate);
      }
    }

    lastAppliedPage.current = page;
    useReaderStore.setState({ pageCount: slot.pages });
    if (isScroll) {
      // Scroll mode has no page index; progress comes from scrollTop (§5.3).
      reader.setPctWithinChapter(safeProgress(ctrl));
    } else {
      reader.setPage(page);
      reader.setPctWithinChapter(slot.pages > 1 ? page / (slot.pages - 1) : 0);
    }
    const cfi = safeCurrentCfi(ctrl);
    if (cfi) reader.setLastCfi(cfi);
    reader.savePos();
  }, []);

  /** Publish the visible iframe's window offset for SelectionToolbar. */
  const publishOffset = useCallback((i: number): void => {
    const el = iframeRefs.current[i];
    if (!el) { setFrameOffset(0, 0); return; }
    const r = el.getBoundingClientRect();
    setFrameOffset(r.left, r.top);
  }, []);

  /**
   * Scroll mode sizing (§5.3): the caller grows the iframe to the chapter's content height
   * and lets the container scroll natively; paginated mode instead clips to the box.
   * A ResizeObserver on the chapter body keeps the height correct as images load.
   */
  const syncScrollHeight = useCallback((i: number): void => {
    const iframe = iframeRefs.current[i];
    const slot = slots.current[i];
    if (!iframe) return;
    if (useReaderStore.getState().mode !== 'scroll' || !slot?.controller) {
      iframe.style.height = '100%';
      scrollRo.current?.disconnect();
      scrollRo.current = null;
      return;
    }
    const apply = (): void => {
      const h = safeContentHeight(slot.controller!);
      if (h > 0) iframe.style.height = `${h}px`;
    };
    apply();
    scrollRo.current?.disconnect();
    const body = slot.controller.chapterRoot();
    if (body && typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(apply);
      ro.observe(body);
      scrollRo.current = ro;
    }
  }, []);

  /**
   * Run a queued panel jump (F5's `vellum:find` seam) now that slot `i` is loaded and laid
   * out. Stale requests — a fast double-jump where the event's chapter no longer matches —
   * are dropped. A `cfi` navigates precisely and flashes the range; `text` uses the
   * facade's findAndFlash, which both pages to the hit and flashes it.
   */
  const consumePendingFind = useCallback((i: number): void => {
    const detail = pendingFind.current;
    if (!detail) return;
    const slot = slots.current[i];
    const ctrl = slot.controller;
    if (!ctrl || slot.chapterIdx === null) return;
    // Ignore events for a different chapter than the one now showing.
    if (detail.chapterIdx !== slot.chapterIdx) return;
    pendingFind.current = null;

    try {
      if (detail.cfi) {
        // Exact CFI (annotations): goto keeps scroll-mode smooth navigation, then flashCfi
        // pages to it in paginated mode and flashes the range.
        ctrl.goto({ cfi: detail.cfi });
        ctrl.flashCfi(detail.cfi);
      } else if (detail.text) {
        // Search hit (no CFI): find + flash the matched phrase inside the chapter.
        const hit = ctrl.findAndFlash(detail.text, 0);
        if (!hit) ctrl.clearFlash();
      }
      // The facade moved its internal page; publish it so the chrome counter, savePos and
      // the heartbeat stay truthful after a panel jump.
      const reader = useReaderStore.getState();
      if (reader.mode !== 'scroll') {
        const page = safeCurrentPage(ctrl);
        lastAppliedPage.current = page;
        useReaderStore.setState({ pageCount: slot.pages });
        reader.setPage(page);
        reader.setPctWithinChapter(slot.pages > 1 ? page / (slot.pages - 1) : 0);
      } else {
        reader.setPctWithinChapter(safeProgress(ctrl));
      }
      const cfi = safeCurrentCfi(ctrl);
      if (cfi) reader.setLastCfi(cfi);
      reader.savePos();
    } catch (e) {
      console.warn('in-chapter find failed', e);
    }
  }, []);

  // ------------------------------------------------------------------- loader
  /**
   * Ensure `idx` is loaded and visible, positioned at `pos`. Warm slots skip the fetch
   * entirely (that is what makes prefetch pay off).
   */
  const showChapter = useCallback(async (
    idx: number,
    pos: Position | null,
    animate: PageTurnAnimation,
  ): Promise<void> => {
    if (!uid) return;
    const token = ++tokenRef.current;
    const i = slotFor(idx);

    // Warm hit: swap roles, no load.
    const warm = slots.current[i];
    if (warm.chapterIdx === idx && warm.controller) {
      currentRef.current = i;
      setCurrent(i);
      applyPosition(i, pos, animate);
      syncScrollHeight(i);
      consumePendingFind(i);
      publishOffset(i);
      return;
    }

    const iframe = iframeRefs.current[i];
    if (!iframe) return;

    let html: string;
    try {
      html = await fetchChapter(uid, idx);
    } catch (e) {
      console.error('chapter fetch failed', e);
      useUiStore.getState().toast('Chapter unavailable', 'error');
      return;
    }
    if (token !== tokenRef.current) return;   // superseded by newer navigation

    disposeSlot(i);
    iframe.srcdoc = buildSrcdoc(html, settings);

    let controller: ChapterController | null = null;
    try {
      controller = new ChapterController(iframe);
      await controller.ready();
    } catch (e) {
      // Engine absent (F0 stubs) or doc failed: keep the raw chapter readable.
      console.warn('chapter engine unavailable, showing unpaginated', e);
      controller = null;
    }
    if (token !== tokenRef.current) return;

    const slot: Slot = { chapterIdx: idx, controller, pages: 1 };
    slots.current[i] = slot;
    slot.unforwardKeys = wireKeyForwarding(iframe);

    if (controller) {
      try {
        const el = boxRef.current;
        controller.layout(layoutOptsFor(
          useSettingsStore.getState().settings,
          el ? { width: el.clientWidth, height: el.clientHeight } : box,
          useReaderStore.getState().mode,
        ));
        slot.pages = safePages(controller);
      } catch { slot.pages = 1; }
      wireController(controller, idx);
      paintHighlights(i);
    }

    currentRef.current = i;
    setCurrent(i);
    applyPosition(i, pos, animate);
    syncScrollHeight(i);
    consumePendingFind(i);
    publishOffset(i);
  }, [uid, settings, box, slotFor, disposeSlot, applyPosition, wireController, paintHighlights, syncScrollHeight, consumePendingFind, publishOffset]);

  // --------------------------------------------- initial open / restore (§7.2)
  useEffect(() => {
    if (!uid) return;
    lastAppliedPage.current = -1;
    lastSeq.current = pendingTarget?.seq ?? 0;
    const target: Position | null = pendingTarget
      ? { cfi: pendingTarget.cfi, pageIndex: pendingTarget.pageIndex, pct: pendingTarget.pct }
      : { pageIndex: 0, pct: 0 };
    void showChapter(useReaderStore.getState().chapterIdx, target, 'none');
    // Book open only — pendingTarget carries the restore position (§5.4).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  // ----------------------------------------- pendingTarget consumption (§5.4)
  useEffect(() => {
    if (!uid || !pendingTarget) return;
    if (pendingTarget.seq === lastSeq.current) return;
    lastSeq.current = pendingTarget.seq;
    void showChapter(
      pendingTarget.chapterIdx ?? useReaderStore.getState().chapterIdx,
      { cfi: pendingTarget.cfi, pageIndex: pendingTarget.pageIndex, pct: pendingTarget.pct },
      'none',
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingTarget?.seq]);

  // ------------------------------------- in-chapter page turn driven by store
  useEffect(() => {
    if (!uid || mode === 'scroll') return;
    const i = currentRef.current;
    const slot = slots.current[i];
    if (!slot.controller || slot.chapterIdx !== chapterIdx) return;
    if (pageIndex === lastAppliedPage.current) return;
    lastAppliedPage.current = pageIndex;

    safeSetPage(slot.controller, pageIndex, pageTurn);
    const reader = useReaderStore.getState();
    const cfi = safeCurrentCfi(slot.controller);
    if (cfi) reader.setLastCfi(cfi);
    reader.setPctWithinChapter(slot.pages > 1 ? pageIndex / (slot.pages - 1) : 0);
    reader.setSelection(null);
    // NOTE: no accruePage() here — readerStore.nextPage/prevPage already accrue the page
    // delta for the heartbeat, so doing it again would double-count (§7.3).
    reader.savePos();
  }, [pageIndex, uid, mode, chapterIdx, pageTurn]);

  // ------------------------------- settings / mode / resize → re-layout (§7.8)
  useEffect(() => {
    if (!uid) return;
    const i = currentRef.current;
    const slot = slots.current[i];
    const ctrl = slot.controller;
    if (!ctrl || slot.chapterIdx === null) return;

    const keepPage = safeCurrentPage(ctrl);
    try {
      ctrl.layout(layoutOptsFor(settings, box, mode));
      slot.pages = safePages(ctrl);
      useReaderStore.setState({ pageCount: slot.pages });
      if (mode !== 'scroll') {
        safeSetPage(ctrl, clamp(keepPage, 0, Math.max(0, slot.pages - 1)), 'none');
      }
      // Re-stamp the vars so typography/colour edits apply without a reload.
      const doc = ctrl.chapterRoot()?.ownerDocument;
      doc?.documentElement?.setAttribute('style', styleString(settings));
    } catch { /* engine not ready */ }
    // A mode switch changes the iframe sizing contract (§5.3), and a typography edit
    // changes the chapter's content height.
    syncScrollHeight(i);
    publishOffset(i);
  }, [settings, mode, box.width, box.height, uid, syncScrollHeight, publishOffset]);

  // ------------------------------------------- highlights array changed (§5.4)
  useEffect(() => {
    if (!uid) return;
    paintHighlights(currentRef.current);
  }, [highlights, uid, paintHighlights]);

  // --------------------------------- in-chapter find+flash (F5 `vellum:find` seam)
  useEffect(() => {
    if (!uid) return;
    const onFind = (e: Event): void => {
      const detail = (e as CustomEvent<FindDetail>).detail;
      if (!detail || typeof detail.chapterIdx !== 'number') return;
      pendingFind.current = detail;
      // If the target chapter is already loaded and visible, run it now; otherwise
      // showChapter consumes it once layout lands (the load is async).
      const i = currentRef.current;
      if (slots.current[i].chapterIdx === detail.chapterIdx) consumePendingFind(i);
    };
    window.addEventListener(FIND_EVENT, onFind);
    return () => {
      window.removeEventListener(FIND_EVENT, onFind);
      pendingFind.current = null;
    };
  }, [uid, consumePendingFind]);

  // -------------------------------------------------- prefetch neighbours (§5.4)
  useEffect(() => {
    if (!uid || !prefetch) return;
    const total = useReaderStore.getState().book?.book.chapters.length ?? 0;
    for (const d of [1, -1]) {
      const n = chapterIdx + d;
      if (n >= 0 && n < total) void fetchChapter(uid, n).catch(() => {});
    }
  }, [chapterIdx, uid, prefetch]);

  // --------------------------------------------------- frame offset on resize
  useEffect(() => {
    publishOffset(current);
    const update = (): void => publishOffset(currentRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [current, box.width, box.height]);

  // -------------------------------------------------------------------- render
  const isScroll = mode === 'scroll';
  return (
    <div
      ref={boxRef}
      data-testid="chapter-frame"
      data-mode={mode}
      className={cn(
        'absolute inset-0 bg-[var(--v-page-bg)]',
        // Scroll mode grows the iframe to the chapter height and scrolls natively (§5.3);
        // paginated mode clips so the column strip never scrolls vertically.
        isScroll ? 'overflow-x-hidden overflow-y-auto' : 'overflow-hidden',
      )}
    >
      {Array.from({ length: POOL_SIZE }, (_, i) => {
        const isCurrent = i === current;
        return (
          <iframe
            key={i}
            ref={(el) => { iframeRefs.current[i] = el; }}
            data-testid={`frame-${i}`}
            data-role={isCurrent ? 'current' : 'warm'}
            title="Chapter"
            className={cn(
              'border-0',
              // The current scroll-mode frame must stay in flow so the container gets a
              // scrollHeight; warm frames are stacked and hidden.
              isScroll && isCurrent ? 'relative block w-full' : 'absolute inset-0 h-full w-full',
            )}
            style={{
              // Warm frames stay painted but hidden and click-through (§5.4).
              visibility: isCurrent ? 'visible' : 'hidden',
              pointerEvents: isCurrent ? 'auto' : 'none',
              background: 'var(--v-page-bg)',
            }}
          />
        );
      })}
    </div>
  );
}

/** Exported for unit tests: srcdoc assembly, layout math and the LRU cache. */
export const __test__ = { buildSrcdoc, layoutOptsFor, htmlCache, fetchChapter, GAP_PX, TURN_CSS };
