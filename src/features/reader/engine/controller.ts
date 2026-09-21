/**
 * ChapterController facade — signatures FROZEN per ARCHITECTURE.md §5.3/§6.3;
 * body owned by [F0]. Consumed by ChapterFrame.tsx [F2].
 *
 * Contract with the caller: every public method is safe to call at any time — before
 * `ready()` resolves, after `dispose()`, or with a dead iframe — and never throws. Methods
 * that need a document simply no-op (or return a neutral value). F2 drives an iframe pool of
 * three, so a controller may be re-pointed at a recycled frame whose document was replaced;
 * the controller re-reads `contentDocument` on every call rather than caching a stale ref.
 *
 * Link handling matches what B2's rewriter actually emits (src-tauri/src/epub/rewrite.rs):
 *   a[data-vellum-external]              → external URL (opener plugin; caller decides)
 *   a[href^="vellum-link://{zipPath}#f"] → internal chapter jump
 *   a[href^="#vellum-link:{idx}:{frag}"] → legacy §4.3 marker, same callback
 *   a[href^="#fragment"]                 → in-page anchor, smooth-scrolled here
 */
import type { LayoutOpts, PageTurnAnimation } from './pagination';
import type { HighlightItem } from './highlight';
import type { SelectionInfo } from './selection';
import {
  applyLayout,
  cfiAtPage,
  clearLayoutCache,
  currentPageOf,
  elementPage,
  measurePages,
  pageForCfi,
  pageForPoint,
  setPage as setPageAt,
} from './pagination';
import { applyScroll, pctFromScroll, scrollToCfi, scrollToPct } from './scrollmode';
import { onSelectionChange, suppressSelectionFlash } from './selection';
import { onMarkClick, renderHighlights } from './highlight';
import {
  findText, findTextRange, flashRange, clearFlashes, countOccurrences,
  // Aliased: the method below is also named flashCfi, and a bare call to a same-named import
  // inside it would be legal but needlessly hard to follow.
  flashCfi as flashCfiAt,
} from './findtext';

/** Internal (in-chapter) link click: `#vellum-link:{idx}:{fragment}` marker (§4.3). */
export interface InternalLinkClick {
  /**
   * Spine index, or `-1` when the link does not carry one. Only the legacy
   * `#vellum-link:{idx}:{fragment}` form has an index; B2's current scheme
   * (`vellum-link://{zipPath}`) reports `-1` and puts the target in `zipPath`, because only
   * readerStore knows the spine→zipPath mapping. The frozen `>= 0` guard in ChapterFrame
   * therefore already skips zip-path links instead of mis-navigating.
   */
  chapterIdx: number;
  fragment: string | null;
  /** Additive: B2's `vellum-link://{pct-encoded-zip-path}` target (null for the legacy form). */
  zipPath: string | null;
  /**
   * Additive: set when the clicked link leaves the book (`a[data-vellum-external]`, or an
   * http(s)/mailto/tel href B2 did not mark). The caller hands this to the opener plugin
   * instead of navigating. `null` for in-book links.
   */
  external: string | null;
  /** Additive: the raw href, for logging / fallback resolution. */
  href: string;
}

/** Sentinel for `InternalLinkClick.chapterIdx`: no spine index available. */
export const NO_CHAPTER_IDX = -1;

/** Additive: a link the caller must handle outside the chapter. */
export type LinkClick =
  | { kind: 'external'; url: string }
  | { kind: 'internal'; link: InternalLinkClick }
  | { kind: 'inpage'; fragment: string };

export interface ControllerLayoutOpts extends LayoutOpts {
  mode: 'paginated' | 'scroll';
  /** Scroll mode only: centered max width (§5.9 scrollMaxWidthPx). */
  maxWidthPx: number;
}

/** What `goto()` accepts. */
export type GotoTarget =
  | { page: number }
  | { cfi: string }
  | { pct: number }
  | number
  | string;

const VELLUM_LINK = 'vellum-link://';
const LEGACY_LINK = '#vellum-link:';
/** Upper bound on ready(): a frame whose `load` never fires must not stall ChapterFrame. */
const READY_TIMEOUT_MS = 3000;

/**
 * Minimal escape for an attribute selector value. `CSS.escape` lives on the *host* window, not
 * inside the iframe realm, so EPUB fragment ids (which may contain quotes/backslashes) are
 * escaped here instead. Any id the escaper cannot represent simply fails the querySelector,
 * which the caller already tolerates.
 */
function escapeAttr(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Parse `vellum-link://OPS/text/ch2.xhtml#sec1` (B2's scheme, pct-encoded zip path). */
function parseVellumLink(href: string): InternalLinkClick | null {
  const at = href.indexOf(VELLUM_LINK);
  if (at === -1) return null;
  const rest = href.slice(at + VELLUM_LINK.length);
  const hash = rest.indexOf('#');
  const rawPath = hash === -1 ? rest : rest.slice(0, hash);
  const fragment = hash === -1 || hash === rest.length - 1 ? null : rest.slice(hash + 1);
  let zipPath = rawPath;
  try {
    zipPath = decodeURIComponent(rawPath);
  } catch {
    zipPath = rawPath; // a lone '%' in a path — keep it verbatim rather than dropping the link
  }
  if (zipPath.length === 0 && !fragment) return null;
  return { chapterIdx: NO_CHAPTER_IDX, fragment, zipPath, external: null, href };
}

/** Parse the legacy `#vellum-link:{idx}:{fragment}` marker from §4.3. */
function parseLegacyLink(href: string): InternalLinkClick | null {
  const trimmed = href.trim();
  if (!trimmed.startsWith(LEGACY_LINK)) return null;
  const rest = trimmed.slice(LEGACY_LINK.length);
  const colon = rest.indexOf(':');
  if (colon === -1) {
    const idx = Number.parseInt(rest, 10);
    if (!Number.isFinite(idx)) return null;
    return { chapterIdx: idx, fragment: null, zipPath: null, external: null, href };
  }
  const idx = Number.parseInt(rest.slice(0, colon), 10);
  const frag = rest.slice(colon + 1).replace(/^#/, '');
  if (!Number.isFinite(idx)) return null;
  return { chapterIdx: idx, fragment: frag.length > 0 ? frag : null, zipPath: null, external: null, href };
}

export class ChapterController {
  private frame: HTMLIFrameElement | null;
  private disposed = false;
  private unsubs: (() => void)[] = [];
  private mode: 'paginated' | 'scroll' = 'paginated';
  private opts: ControllerLayoutOpts | null = null;
  private page = 0;
  private pageCount = 1;
  private readyPromise: Promise<void> | null = null;
  private linkCb: ((link: LinkClick) => void) | null = null;
  private internalCb: ((link: InternalLinkClick) => void) | null = null;
  private imageCb: ((src: string) => void) | null = null;
  private markCb: ((id: number, ev: MouseEvent) => void) | null = null;
  private docAtAttach: Document | null = null;

  /** Caller sets `iframe.srcdoc` BEFORE constructing (§4.3). */
  constructor(iframe: HTMLIFrameElement) {
    this.frame = iframe ?? null;
  }

  /** Additive: the controller's iframe (null after dispose). */
  iframe(): HTMLIFrameElement | null {
    return this.frame;
  }

  /** The live chapter document, or null when the frame is gone/unloaded/disposed. */
  doc(): Document | null {
    if (this.disposed) return null;
    const frame = this.frame;
    if (!frame) return null;
    try {
      return frame.contentDocument ?? frame.contentWindow?.document ?? null;
    } catch {
      return null; // cross-origin (should not happen: srcdoc is same-origin per §4.3)
    }
  }

  /**
   * Resolves once the iframe document is loaded and the controller's listeners are attached.
   * Always resolves — never rejects, never hangs: a detached frame or a srcdoc that never
   * fires `load` settles via the 3 s safety timer so ChapterFrame can't stall the reader.
   */
  ready(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = new Promise<void>((resolve) => {
      const frame = this.frame;
      if (!frame) {
        resolve();
        return;
      }
      let settled = false;
      // Declared before `finish` closes over it: the already-complete path below calls
      // finish() synchronously, and a `const timer` initialized after that point would be a
      // temporal-dead-zone error.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        this.attach(this.doc());
        resolve();
      };

      const already = this.doc();
      if (already && already.readyState === 'complete') {
        finish();
        return;
      }
      // Safety net: `load` may never arrive for an unattached frame.
      timer = setTimeout(finish, READY_TIMEOUT_MS);
      frame.addEventListener('load', finish, { once: true });
      // The document can complete between the readyState read and the listener registration.
      if (this.doc()?.readyState === 'complete') finish();
    });
    return this.readyPromise;
  }

  /** Install document-level listeners. Idempotent per document; tolerates a null doc. */
  private attach(doc: Document | null): void {
    if (this.disposed || !doc || doc === this.docAtAttach) return;
    this.docAtAttach = doc;
    try {
      suppressSelectionFlash(doc);
    } catch {
      // cosmetic only
    }
    try {
      this.unsubs.push(
        onSelectionChange(doc, (sel) => {
          if (this.disposed) return;
          // readerStore owns the toolbar; the controller only forwards.
          this.selectCb?.(sel);
        }),
      );
    } catch {
      // selection tracking unavailable — reading still works
    }
    try {
      this.unsubs.push(
        onMarkClick(doc, (id, ev) => {
          if (this.disposed || !this.markCb) return;
          this.markCb(id, ev);
        }),
      );
    } catch {
      // highlight clicks unavailable
    }
    try {
      doc.addEventListener('click', this.onClick, true);
      this.unsubs.push(() => doc.removeEventListener('click', this.onClick, true));
    } catch {
      // link interception unavailable
    }
  }

  private selectCb: ((sel: SelectionInfo | null) => void) | null = null;

  /** Capture-phase click router: links first, then images. */
  private onClick = (ev: MouseEvent): void => {
    if (this.disposed) return;
    const target = ev.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;

    const anchor = target.closest('a') as HTMLAnchorElement | null;
    if (anchor) {
      const href = anchor.getAttribute('href') ?? '';
      // B2 marks real external http(s) anchors; anything that leaves the chapter is treated
      // identically so it can never navigate the iframe away from the book.
      const markedExternal = anchor.hasAttribute('data-vellum-external');
      const url = markedExternal ? (anchor.dataset.vellumExternalUrl ?? href) : href;
      if (markedExternal || /^(?:https?|mailto|tel|ftp):/i.test(href)) {
        ev.preventDefault();
        this.linkCb?.({ kind: 'external', url });
        this.internalCb?.({
          chapterIdx: NO_CHAPTER_IDX, fragment: null, zipPath: null, external: url, href: url,
        });
        return;
      }
      const link = parseVellumLink(href) ?? parseLegacyLink(href);
      if (link) {
        ev.preventDefault();
        this.linkCb?.({ kind: 'internal', link });
        this.internalCb?.(link);
        return;
      }
      if (href.startsWith('#') && href.length > 1) {
        // In-page anchor: scroll here, do not hand it to the caller as a navigation.
        ev.preventDefault();
        this.scrollToFragment(href.slice(1));
        this.linkCb?.({ kind: 'inpage', fragment: href.slice(1) });
        return;
      }
      return;
    }

    const img = target.closest('img, svg, video, figure') as HTMLElement | null;
    if (img && this.imageCb) {
      const src =
        (img.tagName === 'IMG' ? img.getAttribute('src') : null) ??
        img.querySelector('img')?.getAttribute('src') ??
        '';
      this.imageCb(src);
    }
  };

  /** Resolve an in-chapter anchor; false when the id is absent from the document. */
  private scrollToFragment(fragment: string): boolean {
    const doc = this.doc();
    if (!doc) return false;
    try {
      const el = doc.getElementById(fragment) ?? doc.querySelector(`[name="${escapeAttr(fragment)}"]`);
      if (!el) return false;
      if (this.mode === 'paginated') {
        this.setPage(elementPage(el), 'none');
      } else {
        el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
      return true;
    } catch {
      // an unresolvable anchor is not worth reporting
      return false;
    }
  }

  /** doc.body of the chapter document. */
  chapterRoot(): HTMLElement {
    return (this.doc()?.body ?? null) as HTMLElement;
  }

  /** (Re)apply layout — paginated columns or scroll mode. */
  layout(opts: ControllerLayoutOpts): void {
    if (this.disposed || !opts) return;
    const doc = this.doc();
    if (!doc || !doc.body) return;
    this.opts = opts;
    this.mode = opts.mode === 'scroll' ? 'scroll' : 'paginated';

    if (this.mode === 'scroll') {
      applyScroll(doc, opts.maxWidthPx, opts.typography);
      this.pageCount = 1;
      this.page = 0;
      return;
    }

    applyLayout(doc, opts);
    this.pageCount = measurePages(doc, opts);
    if (this.page > this.pageCount - 1) this.page = Math.max(0, this.pageCount - 1);
    setPageAt(doc, this.page, 'none');
  }

  /** Jump to a page index (number), a CFI ("epubcfi(…)" or a "#fragment" anchor) or a 0..1 percent. */
  goto(target: GotoTarget): void {
    if (this.disposed || target === null || target === undefined) return;
    const doc = this.doc();
    if (!doc || !doc.body) return;

    if (typeof target === 'string') {
      const s = target.trim();
      if (s.length === 0) return;
      if (/^epubcfi\(/i.test(s) || s.startsWith('/') || s.startsWith('#')) {
        this.gotoCfi(s);
        return;
      }
      const pct = Number.parseFloat(s);
      if (Number.isFinite(pct)) this.gotoPct(pct <= 1 ? pct : pct / 100);
      return;
    }
    if (typeof target === 'number' && Number.isFinite(target)) {
      // A bare number is a page index; a 0..1 fractional number is a percent.
      if (target > 0 && target < 1) this.gotoPct(target);
      else this.setPage(target, 'none');
      return;
    }
    if (typeof target === 'object') {
      if ('cfi' in target && target.cfi) this.gotoCfi(target.cfi);
      else if ('page' in target && Number.isFinite(target.page)) this.setPage(target.page, 'none');
      else if ('pct' in target && Number.isFinite(target.pct)) this.gotoPct(target.pct);
    }
  }

  /**
   * Additive: jump to a CFI (page mode → its page; scroll mode → smooth scroll). A TOC
   * mid-chapter entry carries `#fragment` instead of an epubcfi (ncx resolve keeps the
   * anchor) — resolved by id/name the same way an in-page link is.
   */
  gotoCfi(cfi: string): boolean {
    const doc = this.doc();
    if (this.disposed || !doc || !cfi) return false;
    if (cfi.startsWith('#')) return this.scrollToFragment(cfi.slice(1));
    if (this.mode === 'scroll') return scrollToCfi(doc, cfi, 'smooth');
    const page = pageForCfi(doc, cfi);
    if (page === null) {
      // Unresolvable CFI (stale after a re-edit) — stay put rather than jumping to page 0.
      return false;
    }
    this.setPage(page, 'none');
    return true;
  }

  /** Additive: jump to a 0..1 position within the chapter. */
  gotoPct(pct: number): void {
    const doc = this.doc();
    if (this.disposed || !doc) return;
    const p = Number.isFinite(pct) ? Math.min(1, Math.max(0, pct)) : 0;
    if (this.mode === 'scroll') {
      const scroller = (doc.scrollingElement ?? doc.documentElement) as HTMLElement | null;
      if (scroller) scrollToPct(scroller, p);
      return;
    }
    this.setPage(Math.round(p * Math.max(0, this.pageCount - 1)), 'none');
  }

  /** Additive: current reading progress 0..1 (page mode: page; scroll mode: scrollTop). */
  progress(): number {
    const doc = this.doc();
    if (this.disposed || !doc) return 0;
    if (this.mode === 'scroll') {
      const scroller = (doc.scrollingElement ?? doc.documentElement) as HTMLElement | null;
      return scroller ? pctFromScroll(scroller) : 0;
    }
    if (this.pageCount <= 1) return 0;
    return Math.min(1, Math.max(0, this.page / (this.pageCount - 1)));
  }

  /** Additive: CFI of the current page, for readerStore.savePos (§5.4). */
  currentCfi(): string | null {
    const doc = this.doc();
    if (this.disposed || !doc) return null;
    if (this.mode === 'scroll') {
      // Approximate the scroll position as a page-independent CFI via the visible top.
      return cfiAtPage(doc, this.page);
    }
    return cfiAtPage(doc, this.page);
  }

  pages(): number {
    if (this.disposed) return 0;
    if (this.mode === 'scroll') return 1;
    return this.pageCount;
  }

  currentPage(): number {
    if (this.disposed) return 0;
    if (this.mode === 'scroll') return 0;
    const doc = this.doc();
    return doc ? currentPageOf(doc) : this.page;
  }

  setPage(index: number, animate?: PageTurnAnimation): void {
    const doc = this.doc();
    if (this.disposed || !doc) return;
    const max = Math.max(0, this.pageCount - 1);
    const idx = Math.min(Math.max(0, Math.trunc(Number.isFinite(index) ? index : 0)), max);
    this.page = idx;
    setPageAt(doc, idx, animate ?? 'none');
  }

  /** Additive: one page forward/backward. Returns the resulting page index. */
  turn(delta: number, animate?: PageTurnAnimation): number {
    const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    this.setPage(this.currentPage() + d, animate ?? 'slide');
    return this.currentPage();
  }

  /** Additive: true when a further turn stays inside the chapter (F2's chapter-edge logic). */
  canTurn(delta: number): boolean {
    const next = this.currentPage() + (Number.isFinite(delta) ? Math.trunc(delta) : 0);
    return next >= 0 && next <= Math.max(0, this.pages() - 1);
  }

  /** Additive: page index for a viewport x (click zones, §5.4). */
  pageAtPoint(xPx: number): number {
    const doc = this.doc();
    if (this.disposed || !doc || !this.opts || this.mode !== 'paginated') return 0;
    return pageForPoint(doc, xPx, this.opts);
  }

  setHighlights(items: HighlightItem[]): void {
    if (this.disposed) return;
    const doc = this.doc();
    const root = doc?.body;
    if (!doc || !root) return;
    try {
      renderHighlights(doc, root, items ?? []);
    } catch {
      // A rendering failure must never blank the chapter.
    }
  }

  /** Additive: per-item render counts, for the annotations badge. */
  renderHighlightsReport(items: HighlightItem[]): { rendered: number; skipped: number; marks: number } {
    if (this.disposed) return { rendered: 0, skipped: items?.length ?? 0, marks: 0 };
    const doc = this.doc();
    const root = doc?.body;
    if (!doc || !root) return { rendered: 0, skipped: items?.length ?? 0, marks: 0 };
    try {
      return renderHighlights(doc, root, items ?? []);
    } catch {
      return { rendered: 0, skipped: items?.length ?? 0, marks: 0 };
    }
  }

  /** Selection changed (debounced); null clears the toolbar. */
  onSelect(cb: (sel: SelectionInfo | null) => void): void {
    this.selectCb = typeof cb === 'function' ? cb : null;
  }

  /** Internal spine link clicked → readerStore.gotoChapter/gotoCfi. */
  onLinkClick(cb: (link: InternalLinkClick) => void): void {
    this.internalCb = typeof cb === 'function' ? cb : null;
  }

  /**
   * Additive: the richer link router (external / internal / in-page). F2 may use either this
   * or {@link onLinkClick}; both fire for internal links, so pick one to avoid double handling.
   */
  onAnyLinkClick(cb: (link: LinkClick) => void): void {
    this.linkCb = typeof cb === 'function' ? cb : null;
  }

  /** Highlight mark tapped (annotations panel jump / recolor). */
  onHighlightClick(cb: (id: number, ev: MouseEvent) => void): void {
    this.markCb = typeof cb === 'function' ? cb : null;
  }

  /** Image tapped (fullscreen image viewer hook). */
  onImageClick(cb: (src: string) => void): void {
    this.imageCb = typeof cb === 'function' ? cb : null;
  }

  find(text: string, occurrence?: number): { cfi: string; rect: DOMRect } | null {
    if (this.disposed || !text) return null;
    const doc = this.doc();
    if (!doc) return null;
    const hit = findText(doc, text, occurrence ?? 0);
    if (hit && this.mode === 'paginated') {
      // Bring the hit onto the visible page (F5's SearchPanel click path, §7.5).
      const page = pageForCfi(doc, hit.cfi);
      if (page !== null) this.setPage(page, 'none');
    }
    return hit;
  }

  /** Additive: find + flash the hit; returns the same result shape as {@link find}. */
  findAndFlash(text: string, occurrence?: number, ms?: number): { cfi: string; rect: DOMRect } | null {
    if (this.disposed || !text) return null;
    const doc = this.doc();
    if (!doc) return null;
    const hit = findTextRange(doc, text, occurrence ?? 0);
    if (!hit) return null;
    if (this.mode === 'paginated') {
      const page = pageForCfi(doc, hit.cfi);
      if (page !== null) this.setPage(page, 'none');
    }
    flashRange(doc, hit.range, ms ?? 1200);
    return { cfi: hit.cfi, rect: hit.rect };
  }

  /**
   * Additive: flash an exact CFI location. For annotations-panel jumps (§5.6), which carry a
   * CFI but no reliably-findable text. Returns false when the CFI does not resolve.
   */
  flashCfi(cfi: string, ms?: number): boolean {
    if (this.disposed || !cfi) return false;
    const doc = this.doc();
    if (!doc) return false;
    if (this.mode === 'paginated') {
      const page = pageForCfi(doc, cfi);
      if (page !== null) this.setPage(page, 'none');
    }
    return flashCfiAt(doc, cfi, ms ?? 1200);
  }

  /** Additive: how many times `text` occurs in this chapter ("N of M" UI). */
  countMatches(text: string): number {
    if (this.disposed || !text) return 0;
    const doc = this.doc();
    return doc ? countOccurrences(doc, text) : 0;
  }

  /** Additive: drop flash marks immediately (e.g. when the search panel closes). */
  clearFlash(): void {
    const doc = this.doc();
    if (this.disposed || !doc) return;
    clearFlashes(doc);
  }

  /** Additive: content height in scroll mode, for the caller's iframe sizing. */
  contentHeight(): number {
    const doc = this.doc();
    if (!doc) return 0;
    return Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
  }

  dispose(): void {
    if (this.disposed) {
      this.frame = null;
      return;
    }
    this.disposed = true;
    for (const un of this.unsubs) {
      try {
        un();
      } catch {
        // a listener that already went away with its document is fine
      }
    }
    this.unsubs.length = 0;
    this.selectCb = null;
    this.linkCb = null;
    this.internalCb = null;
    this.imageCb = null;
    this.markCb = null;
    const doc = this.docAtAttach;
    this.docAtAttach = null;
    if (doc) {
      try {
        clearFlashes(doc);
      } catch {
        // nothing to clear
      }
      try {
        clearLayoutCache(doc);
      } catch {
        // cache is a WeakMap; a failure here cannot matter
      }
    }
    this.opts = null;
    this.readyPromise = null;
    this.frame = null;
  }
}

export default ChapterController;
