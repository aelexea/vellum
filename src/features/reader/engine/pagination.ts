/**
 * Paginated (CSS multi-column) layout — signatures FROZEN per ARCHITECTURE.md §5.3;
 * bodies owned by [F0].
 *
 * Structure after applyLayout():
 *   <html style="height:H; overflow:hidden">
 *     <body style="height:H; overflow:hidden; margin:0">
 *       <div id="vellum-wrap" data-vellum-wrap="1" style="column-width:W; column-gap:G;
 *            height:H; overflow:hidden; will-change:transform; transform:translateX(0)">
 *         …every original body child…
 *
 * One page turn = a single transform write. The caller (F2 ChapterFrame) owns the transition
 * class; `setPage` writes the transform instantly and records the page on `dataset.page`.
 *
 * jsdom has no layout engine, so every measurement goes through an injectable
 * {@link LayoutMetrics}. Production uses {@link realMetrics} (getBoundingClientRect /
 * caretRangeFromPoint); tests install a fake via {@link setLayoutMetrics}. Frozen signatures
 * stay `doc`-based — the provider is looked up per document.
 */
import { decodeCfi, encodeRange, WRAP_ATTR } from './cfi';

export interface LayoutOpts {
  pageWidthPx: number;
  gapPx: number;
  heightPx: number;
  /** css var name → value, injected into the iframe document. */
  typography: Record<string, string>;
}

export type PageTurnAnimation = 'slide' | 'fade' | 'none';

export const WRAP_ID = 'vellum-wrap';

/** A viewport-space box. Only these four fields are needed by the column math. */
export interface RectBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Injectable measurement surface. Implemented once for real DOM ({@link realMetrics});
 * tests substitute fakes. All members must be null-safe and side-effect free.
 */
export interface LayoutMetrics {
  /** Overflow width of the column container (content laid out across all pages). */
  wrapScrollWidth(wrap: HTMLElement): number;
  /** First client rect of a range in viewport px, or null when it has none. */
  rangeRect(range: Range): RectBox | null;
  /** Bounding box of an element in viewport px, or null. */
  elementRect(el: Element): RectBox | null;
  /** Caret (text node + offset) at viewport point, or null. */
  caretAt(doc: Document, x: number, y: number): { node: Node; offset: number } | null;
}

// ---------------------------------------------------------------------------
// per-document caches (kept off the hot path: no allocation on a page turn)
// ---------------------------------------------------------------------------

const metricsByDoc = new WeakMap<Document, LayoutMetrics>();
const optsByDoc = new WeakMap<Document, LayoutOpts>();
const wrapByDoc = new WeakMap<Document, HTMLElement>();
const pagesByDoc = new WeakMap<Document, number>();

/** Additive: install a metrics provider (tests / headless measurement). */
export function setLayoutMetrics(doc: Document, metrics: LayoutMetrics): void {
  metricsByDoc.set(doc, metrics);
  // A different geometry means a different page count.
  pagesByDoc.delete(doc);
}

function metricsFor(doc: Document): LayoutMetrics {
  return metricsByDoc.get(doc) ?? realMetrics;
}

/** Additive: the LayoutOpts last applied to this document, if any. */
export function currentLayoutOpts(doc: Document): LayoutOpts | null {
  return optsByDoc.get(doc) ?? null;
}

/** Additive: the column wrapper installed by {@link applyLayout} (cached reference). */
export function getWrap(doc: Document | null): HTMLElement | null {
  if (!doc) return null;
  const cached = wrapByDoc.get(doc);
  if (cached && cached.isConnected) return cached;
  const byId = doc.getElementById(WRAP_ID);
  if (byId) {
    wrapByDoc.set(doc, byId);
    return byId;
  }
  const byAttr = doc.querySelector<HTMLElement>(`[${WRAP_ATTR}]`);
  if (byAttr) {
    wrapByDoc.set(doc, byAttr);
    return byAttr;
  }
  wrapByDoc.delete(doc);
  return null;
}

/** Additive: forget cached references for a document (after srcdoc swap / dispose). */
export function clearLayoutCache(doc: Document): void {
  optsByDoc.delete(doc);
  wrapByDoc.delete(doc);
  pagesByDoc.delete(doc);
}

// ---------------------------------------------------------------------------
// real (production) metrics
// ---------------------------------------------------------------------------

function domRectToBox(r: DOMRect): RectBox {
  return { x: r.x ?? r.left, y: r.y ?? r.top, width: r.width, height: r.height };
}

function isMeaningfulRect(b: DOMRect | undefined | null): b is DOMRect {
  return !!b && (b.width !== 0 || b.height !== 0 || b.x !== 0 || b.y !== 0);
}

/**
 * The first client rect of a range, or null when there is none.
 *
 * jsdom implements no layout: its `Range` has no `getClientRects` at all (calling it throws),
 * and `getBoundingClientRect` returns a zero rect. Every call is therefore feature-detected
 * rather than assumed, and "no geometry" collapses to null so callers take their documented
 * fallback instead of positioning a toolbar at (0,0).
 */
export function firstClientRect(range: Range): DOMRect | null {
  if (!range) return null;
  const r = range as Range & { getClientRects?: () => DOMRectList };
  try {
    if (typeof r.getClientRects === 'function') {
      const rects = r.getClientRects();
      if (rects && rects.length > 0) return rects[0] as DOMRect;
    }
    if (typeof range.getBoundingClientRect === 'function') {
      const b = range.getBoundingClientRect();
      if (isMeaningfulRect(b)) return b;
    }
  } catch {
    return null;
  }
  return null;
}

/** Additive: bounding box of an element, or null when the environment has no layout. */
export function elementBox(el: Element): RectBox | null {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  try {
    const b = el.getBoundingClientRect();
    return b ? domRectToBox(b) : null;
  } catch {
    return null;
  }
}

/** A structurally valid zero rect, for environments without a usable DOMRect. */
export function zeroDomRect(doc: Document | null): DOMRect {
  try {
    const Ctor = doc?.defaultView?.DOMRect;
    if (Ctor) return new Ctor(0, 0, 0, 0);
    return new DOMRect(0, 0, 0, 0);
  } catch {
    return {
      x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0,
      toJSON: () => ({}),
    } as DOMRect;
  }
}

export const realMetrics: LayoutMetrics = {
  wrapScrollWidth(wrap) {
    // scrollWidth is the laid-out overflow width of all columns.
    return wrap.scrollWidth || 0;
  },
  rangeRect(range) {
    const b = firstClientRect(range);
    return b === null ? null : domRectToBox(b);
  },
  elementRect(el) {
    return elementBox(el);
  },
  caretAt(doc, x, y) {
    const d = doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    try {
      if (typeof d.caretPositionFromPoint === 'function') {
        const pos = d.caretPositionFromPoint(x, y);
        if (pos && pos.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
      }
      if (typeof d.caretRangeFromPoint === 'function') {
        const r = d.caretRangeFromPoint(x, y);
        if (r && r.startContainer) return { node: r.startContainer, offset: r.startOffset };
      }
    } catch {
      // fall through to the hit-test below
    }
    const el = doc.elementFromPoint(x, y);
    if (!el) return null;
    return { node: el, offset: 0 };
  },
};

// ---------------------------------------------------------------------------
// typography vars
// ---------------------------------------------------------------------------

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

const MARGIN_KEYS: Record<keyof Margins, string[]> = {
  top: ['--v-margin-top', '--v-page-margin-top'],
  right: ['--v-margin-right', '--v-page-margin-right'],
  bottom: ['--v-margin-bottom', '--v-page-margin-bottom'],
  left: ['--v-margin-left', '--v-page-margin-left'],
};

function pxNumber(v: string | undefined): number {
  if (!v) return 0;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Additive: page margins read out of the typography record (`--v-margin-*` px values).
 * Absent/invalid entries fall back to 0 — margins are optional, never fatal.
 */
export function marginsFrom(typography: Record<string, string> | undefined): Margins {
  const out = { top: 0, right: 0, bottom: 0, left: 0 };
  if (!typography) return out;
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    for (const key of MARGIN_KEYS[side]) {
      if (key in typography) {
        out[side] = pxNumber(typography[key]);
        break;
      }
    }
  }
  return out;
}

/** Additive: write every typography entry as a CSS custom property on <html>. */
export function applyTypography(doc: Document, typography: Record<string, string> | undefined): void {
  if (!doc || !typography) return;
  const root = doc.documentElement;
  if (!root) return;
  for (const key of Object.keys(typography)) {
    if (!key.startsWith('--')) continue;
    const value = typography[key];
    if (typeof value !== 'string') continue;
    root.style.setProperty(key, value);
  }
}

// ---------------------------------------------------------------------------
// column math (pure)
// ---------------------------------------------------------------------------

/** Additive: pages for a given content width — the pure core of {@link measurePages}. */
export function pagesForWidth(scrollWidth: number, opts: Pick<LayoutOpts, 'pageWidthPx' | 'gapPx'>): number {
  const stride = pageStride(opts);
  if (stride <= 0) return 1;
  const w = Number.isFinite(scrollWidth) ? Math.max(0, scrollWidth) : 0;
  return Math.max(1, Math.ceil(w / stride));
}

/** Additive: horizontal distance between the origins of two adjacent pages. */
export function pageStride(opts: Pick<LayoutOpts, 'pageWidthPx' | 'gapPx'>): number {
  const p = Number.isFinite(opts.pageWidthPx) ? Math.max(1, opts.pageWidthPx) : 1;
  const g = Number.isFinite(opts.gapPx) ? Math.max(0, opts.gapPx) : 0;
  return p + g;
}

/** Additive: translateX px that brings `pageIndex` into view. */
export function pageTranslateX(pageIndex: number, opts: Pick<LayoutOpts, 'pageWidthPx' | 'gapPx'>): number {
  const idx = Math.max(0, Math.trunc(pageIndex));
  const px = idx * pageStride(opts);
  // Adding zero first normalizes the sign of zero, so page 0 never renders as
  // "translateX(-0px)".
  return px === 0 ? 0 : -px;
}

/** Additive: the page index a wrap-local x offset falls into. */
export function pageIndexForX(wrapLocalX: number, opts: Pick<LayoutOpts, 'pageWidthPx' | 'gapPx'>): number {
  const stride = pageStride(opts);
  if (stride <= 0) return 0;
  const x = Number.isFinite(wrapLocalX) ? wrapLocalX : 0;
  return Math.max(0, Math.floor(x / stride));
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

function ensureWrap(doc: Document): HTMLElement | null {
  const body = doc.body;
  if (!body) return null;
  const existing = getWrap(doc);
  if (existing && existing.parentNode === body) return existing;

  const wrap = doc.createElement('div');
  wrap.id = WRAP_ID;
  wrap.setAttribute(WRAP_ATTR, '1');
  while (body.firstChild !== null) wrap.appendChild(body.firstChild);
  body.appendChild(wrap);
  wrapByDoc.set(doc, wrap);
  return wrap;
}

/** Wrap body into #vellum-wrap columns; size html/body for the paged viewport. */
export function applyLayout(doc: Document, opts: LayoutOpts): void {
  if (!doc || !opts) return;
  const wrap = ensureWrap(doc);
  if (!wrap) return;

  applyTypography(doc, opts.typography);
  optsByDoc.set(doc, opts);

  const h = `${Math.max(0, opts.heightPx)}px`;
  const de = doc.documentElement;
  if (de) {
    de.style.height = h;
    de.style.overflow = 'hidden';
    de.style.margin = '0';
  }
  const body = doc.body;
  if (body) {
    body.style.height = h;
    body.style.overflow = 'hidden';
    body.style.margin = '0';
    body.style.padding = '0';
  }

  const s = wrap.style;
  // Geometry is about to change, so the cached page count is stale. It is invalidated rather
  // than recomputed here: the next measurePages() call (made by the caller right after layout,
  // or by setPage) performs the one reflow that a fresh layout legitimately costs.
  pagesByDoc.delete(doc);
  s.columnWidth = `${Math.max(1, opts.pageWidthPx)}px`;
  s.columnGap = `${Math.max(0, opts.gapPx)}px`;
  s.columnFill = 'auto';
  s.height = h;
  s.overflow = 'hidden';
  s.willChange = 'transform';

  const m = marginsFrom(opts.typography);
  s.paddingTop = `${m.top}px`;
  s.paddingRight = `${m.right}px`;
  s.paddingBottom = `${m.bottom}px`;
  s.paddingLeft = `${m.left}px`;
  // border-box keeps the padded column exactly pageWidthPx wide.
  s.boxSizing = 'border-box';

  if (wrap.dataset.page === undefined) {
    wrap.dataset.page = '0';
    s.transform = 'translateX(0px)';
  }
}

/**
 * ceil(scrollWidth / (pageWidthPx + gapPx)).
 *
 * Reads `scrollWidth`, which forces a synchronous layout flush, so the result is cached per
 * document and reused until the layout actually changes. {@link applyLayout} (new geometry,
 * new content) and {@link remeasurePages} invalidate it; {@link setPage} and the CFI helpers
 * then read the cache instead of reflowing. That matters on the hot path: a page turn must be
 * a single transform write, not a flush of a 300 KB chapter.
 */
export function measurePages(doc: Document, opts: LayoutOpts): number {
  if (!doc || !opts) return 1;
  const cached = pagesByDoc.get(doc);
  if (cached !== undefined) return cached;
  return remeasurePages(doc, opts);
}

/** Additive: force a fresh measurement (e.g. after a font-size change), and cache it. */
export function remeasurePages(doc: Document, opts: LayoutOpts): number {
  if (!doc || !opts) return 1;
  const wrap = getWrap(doc);
  if (!wrap) return 1;
  const pages = pagesForWidth(metricsFor(doc).wrapScrollWidth(wrap), opts);
  pagesByDoc.set(doc, pages);
  return pages;
}

/** The page recorded on the wrapper (0 when layout was never applied). */
export function currentPageOf(doc: Document): number {
  const wrap = getWrap(doc);
  if (!wrap) return 0;
  const n = Number.parseInt(wrap.dataset.page ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** translateX the wrap to the page; animation class handled by caller. */
export function setPage(doc: Document, pageIndex: number, animate: PageTurnAnimation): void {
  if (!doc) return;
  const wrap = getWrap(doc);
  if (!wrap) return;
  const opts = optsByDoc.get(doc);
  if (!opts) return;

  const pages = measurePages(doc, opts);
  const idx = Math.min(Math.max(0, Math.trunc(Number.isFinite(pageIndex) ? pageIndex : 0)), pages - 1);
  wrap.dataset.page = String(idx);
  // Recorded for the caller: F2 reads it to pick the transition class. One style write below.
  wrap.dataset.anim = animate;
  wrap.style.transform = `translateX(${pageTranslateX(idx, opts)}px)`;
}

/** Page index for a CFI, or null when it cannot be placed. */
export function pageForCfi(doc: Document, cfi: string): number | null {
  if (!doc || !cfi) return null;
  const opts = optsByDoc.get(doc);
  const wrap = getWrap(doc);
  if (!opts || !wrap) return null;
  const body = doc.body;
  if (!body) return null;

  const range = decodeCfi(cfi, body);
  if (!range) return null;
  const m = metricsFor(doc);
  const box = m.rangeRect(range);
  const wrapBox = m.elementRect(wrap);
  if (!box || !wrapBox) return null;

  const pages = measurePages(doc, opts);
  // Apparent x already includes the current translateX, so convert back to wrap-local.
  const current = currentPageOf(doc);
  const stride = pageStride(opts);
  const localX = box.x - wrapBox.x + current * stride;
  return Math.min(Math.max(0, pageIndexForX(localX, opts)), pages - 1);
}

/** CFI of the first text node visible on the page (progress persistence). */
export function cfiAtPage(doc: Document, pageIndex: number): string | null {
  if (!doc) return null;
  const body = doc.body;
  const wrap = getWrap(doc);
  const opts = optsByDoc.get(doc);
  if (!body || !wrap || !opts) return null;

  const pages = measurePages(doc, opts);
  const idx = Math.min(Math.max(0, Math.trunc(Number.isFinite(pageIndex) ? pageIndex : 0)), pages - 1);
  const m = metricsFor(doc);
  const wrapBox = m.elementRect(wrap);
  if (!wrapBox) return null;

  const current = currentPageOf(doc);
  const stride = pageStride(opts);
  const padLeft = pxNumber(wrap.style.paddingLeft);
  // Left edge of page `idx` in viewport px, given the wrapper's current translateX.
  const left = wrapBox.x + padLeft + (idx - current) * stride + 8;
  const midY = wrapBox.y + (opts.heightPx || wrapBox.height) / 2;

  // Fast path: a real hit test at the page's top-left area.
  const caret = m.caretAt(doc, left, midY);
  if (caret) {
    const cfi = encodeAt(caret.node, caret.offset, doc, body);
    if (cfi) return cfi;
  }

  // Fallback: the first text node that lands on this page. Columns lay out in document order,
  // so page indices are monotonic — once we pass the target page we can stop.
  const walker = doc.createTreeWalker(wrap, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const value = n.nodeValue;
    if (!value || value.trim().length === 0) continue;
    const r = doc.createRange();
    try {
      r.setStart(n, 0);
      r.setEnd(n, Math.min(1, value.length));
    } catch {
      continue;
    }
    const box = m.rangeRect(r);
    if (!box) continue;
    const localX = box.x - wrapBox.x + current * stride;
    const page = pageIndexForX(localX, opts);
    if (page > idx) break;
    if (page !== idx) continue;
    const cfi = encodeAt(n, 0, doc, body);
    if (cfi) return cfi;
  }
  return null;
}

/** Encode (node, offset) as a CFI relative to the chapter root; '' when not addressable. */
function encodeAt(node: Node, offset: number, doc: Document, root: HTMLElement): string {
  if (node.nodeType === 3 || node.nodeType === 4) {
    const r = doc.createRange();
    try {
      const len = node.nodeValue?.length ?? 0;
      r.setStart(node, Math.max(0, Math.min(offset, len)));
    } catch {
      return '';
    }
    r.collapse(true);
    return encodeRange(r, root);
  }
  if (node.nodeType === 1) {
    // elementFromPoint fallback: address the element's first text node.
    const inner = doc.createTreeWalker(node, 4).nextNode();
    if (!inner) return '';
    return encodeAt(inner, 0, doc, root);
  }
  return '';
}

/** Page at a horizontal viewport offset (click zones). */
export function pageForPoint(doc: Document, xPx: number, opts: LayoutOpts): number {
  if (!doc || !opts) return 0;
  const wrap = getWrap(doc);
  const pages = wrap ? measurePages(doc, opts) : 1;
  const left = wrap ? (metricsFor(doc).elementRect(wrap)?.x ?? 0) : 0;
  const x = (Number.isFinite(xPx) ? xPx : 0) - left;
  return Math.min(Math.max(0, pageIndexForX(x, opts)), Math.max(0, pages - 1));
}

/** Page containing an element (in-page fragment jumps). */
export function elementPage(el: Element): number {
  if (!el) return 0;
  const doc = el.ownerDocument;
  if (!doc) return 0;
  const opts = optsByDoc.get(doc);
  const wrap = getWrap(doc);
  if (!opts || !wrap) return 0;

  const m = metricsFor(doc);
  const box = m.elementRect(el);
  const wrapBox = m.elementRect(wrap);
  if (!box || !wrapBox) return currentPageOf(doc);

  const pages = measurePages(doc, opts);
  const stride = pageStride(opts);
  const localX = box.x - wrapBox.x + currentPageOf(doc) * stride;
  return Math.min(Math.max(0, pageIndexForX(localX, opts)), pages - 1);
}
