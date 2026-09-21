/**
 * Scroll reading mode — signatures FROZEN per ARCHITECTURE.md §5.3; bodies owned by [F0].
 *
 * applyScroll() reverses what pagination.ts did: the column wrapper's children go back onto
 * <body> and the page becomes a plain, centered, naturally-scrolling document. The caller
 * (F2) sizes the iframe from `contentDocument.documentElement.scrollHeight` and watches it
 * with a ResizeObserver.
 *
 * CFIs are layout-agnostic by construction (see cfi.ts wrap transparency), so positions and
 * highlights written in one mode resolve in the other.
 */
import { decodeCfi, WRAP_ATTR } from './cfi';
import { applyTypography, marginsFrom } from './pagination';

/** No columns; centered max-width body. Caller syncs iframe height + ResizeObserver. */
export function applyScroll(doc: Document, maxWidthPx: number, typography: Record<string, string>): void {
  if (!doc) return;
  applyTypography(doc, typography);

  // Undo the column wrapper, if pagination installed one.
  const wrap = doc.getElementById('vellum-wrap') ?? doc.querySelector<HTMLElement>(`[${WRAP_ATTR}]`);
  const body = doc.body;
  if (wrap && body && wrap.parentNode === body) {
    while (wrap.firstChild !== null) body.insertBefore(wrap.firstChild, wrap);
    body.removeChild(wrap);
  }

  const de = doc.documentElement;
  if (de) {
    de.style.height = 'auto';
    de.style.overflow = '';
    de.style.margin = '0';
  }
  if (body) {
    body.style.height = 'auto';
    body.style.overflow = '';
    body.style.transform = '';
    body.style.willChange = '';
    body.style.columnWidth = '';
    body.style.columnGap = '';
    body.style.maxWidth = `${Math.max(1, maxWidthPx)}px`;
    body.style.margin = '0 auto';

    const m = marginsFrom(typography);
    body.style.paddingTop = `${m.top}px`;
    body.style.paddingRight = `${m.right}px`;
    body.style.paddingBottom = `${m.bottom}px`;
    body.style.paddingLeft = `${m.left}px`;
    body.style.boxSizing = 'border-box';
    body.style.width = '100%';
  }
}

/** Scroll to a CFI; false when it cannot be resolved. */
export function scrollToCfi(doc: Document, cfi: string, behavior: 'smooth' | 'auto'): boolean {
  if (!doc || !cfi) return false;
  const body = doc.body;
  if (!body) return false;
  const range = decodeCfi(cfi, body);
  if (!range) return false;

  // Prefer the element containing the caret: works for both text and element targets.
  const node = range.startContainer;
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (!el) return false;

  // scrollIntoView is the correct primitive, but it is optional in the DOM spec and absent in
  // jsdom, so it is feature-detected rather than wrapped in try/catch.
  if (typeof el.scrollIntoView === 'function') {
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior });
      return true;
    } catch {
      // fall through to manual scrollTop math
    }
  }

  // Fallback: measure the element (getBoundingClientRect is always present) and center it in
  // the scrolling element. Used when scrollIntoView is missing or threw.
  const scroller = doc.scrollingElement ?? doc.documentElement ?? body;
  if (!scroller || typeof el.getBoundingClientRect !== 'function') return false;
  try {
    const rect = el.getBoundingClientRect();
    const viewport = doc.defaultView?.innerHeight ?? 0;
    const target = scroller.scrollTop + rect.top - viewport / 2;
    scroller.scrollTop = Math.max(0, target);
  } catch {
    return false;
  }
  return true;
}

/** 0..1 scroll progress of a scrolling element. */
export function pctFromScroll(el: HTMLElement): number {
  if (!el) return 0;
  const max = el.scrollHeight - el.clientHeight;
  if (!Number.isFinite(max) || max <= 0) return 0;
  const pct = el.scrollTop / max;
  if (!Number.isFinite(pct)) return 0;
  return Math.min(1, Math.max(0, pct));
}

export function scrollToPct(el: HTMLElement, pct: number): void {
  if (!el) return;
  const max = el.scrollHeight - el.clientHeight;
  if (!Number.isFinite(max) || max <= 0) return;
  const p = Number.isFinite(pct) ? Math.min(1, Math.max(0, pct)) : 0;
  el.scrollTop = Math.round(p * max);
}

/**
 * Additive: the element the caller should read scrollHeight from to size the iframe.
 * Returns null when the document has no body yet.
 */
export function scrollContentHeight(doc: Document): number {
  if (!doc) return 0;
  const de = doc.documentElement;
  const body = doc.body;
  return Math.max(de?.scrollHeight ?? 0, body?.scrollHeight ?? 0);
}
