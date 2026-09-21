/**
 * §8 F0 — scroll mode: undoing the column wrapper, centered max-width layout, CFI scrolling
 * and the scroll-percentage helpers.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  applyScroll,
  pctFromScroll,
  scrollContentHeight,
  scrollToCfi,
  scrollToPct,
} from './scrollmode';
import { applyLayout, clearLayoutCache, getWrap } from './pagination';
import { COMPACT_CHAPTER, mountChapter, RU_PARAGRAPH } from './__fixtures__/chapterDom';

const PAGINATED = {
  pageWidthPx: 300,
  gapPx: 20,
  heightPx: 500,
  typography: {
    '--v-margin-top': '8px',
    '--v-margin-right': '16px',
    '--v-margin-bottom': '8px',
    '--v-margin-left': '16px',
  },
};

let doc: Document;
let body: HTMLElement;

beforeEach(() => {
  doc = document;
  doc.body.innerHTML = '';
  body = mountChapter(doc, COMPACT_CHAPTER);
});

afterEach(() => {
  clearLayoutCache(doc);
  vi.restoreAllMocks();
});

describe('applyScroll', () => {
  it('centers the body at the requested max width', () => {
    applyScroll(doc, 720, PAGINATED.typography);
    expect(body.style.maxWidth).toBe('720px');
    expect(body.style.margin).toBe('0px auto');
    expect(body.style.width).toBe('100%');
    expect(body.style.boxSizing).toBe('border-box');
  });

  it('applies the typography margins as body padding', () => {
    applyScroll(doc, 720, PAGINATED.typography);
    expect(body.style.paddingTop).toBe('8px');
    expect(body.style.paddingLeft).toBe('16px');
    expect(body.style.paddingRight).toBe('16px');
    expect(body.style.paddingBottom).toBe('8px');
  });

  it('writes typography vars onto <html>', () => {
    applyScroll(doc, 720, { '--v-line-height': '1.7' });
    expect(doc.documentElement!.style.getPropertyValue('--v-line-height')).toBe('1.7');
  });

  it('releases the fixed page height so the document can scroll', () => {
    applyScroll(doc, 720, PAGINATED.typography);
    expect(body.style.height).toBe('auto');
    expect(body.style.overflow).toBe('');
    expect(doc.documentElement!.style.height).toBe('auto');
  });

  it('unwraps a column layout back onto <body>', () => {
    applyLayout(doc, PAGINATED);
    const wrap = getWrap(doc)!;
    expect(wrap).not.toBeNull();
    expect(body.children.length).toBe(1);
    const childCount = wrap.children.length;

    applyScroll(doc, 720, PAGINATED.typography);

    expect(getWrap(doc)).toBeNull();
    expect(body.children.length).toBe(childCount);
    // Content survived the move intact.
    expect(body.querySelector('#p2')!.textContent).toBe(RU_PARAGRAPH);
    expect(body.querySelector('h1')!.textContent).toBe('Chapter One');
  });

  it('clears paginated-only inline styles left on the body', () => {
    applyLayout(doc, PAGINATED);
    applyScroll(doc, 720, PAGINATED.typography);
    expect(body.style.transform).toBe('');
    expect(body.style.willChange).toBe('');
    expect(body.style.columnWidth).toBe('');
  });

  it('is a no-op-safe when no wrapper exists', () => {
    expect(() => applyScroll(doc, 720, {})).not.toThrow();
    expect(getWrap(doc)).toBeNull();
    expect(body.children.length).toBe(5);
  });

  it('round-trips paginated → scroll → paginated without losing children', () => {
    const original = body.children.length;
    applyLayout(doc, PAGINATED);
    applyScroll(doc, 720, PAGINATED.typography);
    applyLayout(doc, PAGINATED);
    expect(getWrap(doc)!.children.length).toBe(original);
    expect(body.children.length).toBe(1);
    applyScroll(doc, 720, PAGINATED.typography);
    expect(body.children.length).toBe(original);
  });

  it('clamps a nonsensical max width', () => {
    applyScroll(doc, 0, {});
    expect(body.style.maxWidth).toBe('1px');
  });

  it('tolerates a null document', () => {
    expect(() => applyScroll(null as unknown as Document, 720, {})).not.toThrow();
  });
});

describe('scrollToCfi', () => {
  /**
   * jsdom has no scrollIntoView, so install one for the duration of a single test. The
   * afterEach `restoreAllMocks` cannot undo a raw prototype write, so the original is saved
   * and restored here explicitly — a leaked stub would change what later tests exercise.
   */
  const proto = Element.prototype as unknown as { scrollIntoView?: unknown };
  const original = proto.scrollIntoView;
  afterEach(() => {
    proto.scrollIntoView = original;
  });

  function stubScrollIntoView(): ReturnType<typeof vi.fn> {
    const spy = vi.fn();
    proto.scrollIntoView = spy;
    return spy;
  }

  it('scrolls the resolved element into view, centered', () => {
    const spy = stubScrollIntoView();

    const ok = scrollToCfi(doc, 'epubcfi(/10/1:0)', 'smooth');
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ block: 'center', behavior: 'smooth' });
  });

  it('passes the behavior through', () => {
    const spy = stubScrollIntoView();
    scrollToCfi(doc, 'epubcfi(/4/1:0)', 'auto');
    expect(spy.mock.calls[0]![0]).toMatchObject({ behavior: 'auto' });
  });

  it('returns false for an unresolvable CFI', () => {
    expect(scrollToCfi(doc, 'epubcfi(/99/1:0)', 'smooth')).toBe(false);
    expect(scrollToCfi(doc, 'garbage', 'smooth')).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(scrollToCfi(doc, '', 'smooth')).toBe(false);
    expect(scrollToCfi(null as unknown as Document, 'epubcfi(/4/1:0)', 'smooth')).toBe(false);
  });

  it('falls back to scrollTop when scrollIntoView is unavailable', () => {
    // Simulate a target element without scrollIntoView: a text node's parentElement is fine,
    // so instead stub it to throw and give the range a rect.
    const el = body.querySelector('#p3')!;
    (el as unknown as { scrollIntoView: unknown }).scrollIntoView = () => {
      throw new Error('not implemented');
    };
    const scroller = doc.scrollingElement ?? doc.documentElement!;
    Object.defineProperty(scroller!, 'scrollTop', { value: 0, writable: true, configurable: true });

    // getBoundingClientRect returns zeros under jsdom, so the fallback still returns true
    // (a zero rect is a valid "top of document" position).
    expect(scrollToCfi(doc, 'epubcfi(/10/1:0)', 'smooth')).toBe(true);
  });
});

describe('pctFromScroll / scrollToPct', () => {
  /** A fake scroller with a fixed geometry. */
  function fakeScroller(scrollHeight: number, clientHeight: number, scrollTop = 0): HTMLElement {
    const el = doc.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    Object.defineProperty(el, 'scrollTop', {
      value: scrollTop, writable: true, configurable: true,
    });
    return el;
  }

  it('reports 0 at the top and 1 at the bottom', () => {
    expect(pctFromScroll(fakeScroller(1000, 500, 0))).toBe(0);
    expect(pctFromScroll(fakeScroller(1000, 500, 500))).toBe(1);
  });

  it('reports the fraction scrolled', () => {
    expect(pctFromScroll(fakeScroller(1000, 500, 250))).toBe(0.5);
    expect(pctFromScroll(fakeScroller(1000, 500, 125))).toBeCloseTo(0.25, 5);
  });

  it('returns 0 when there is nothing to scroll', () => {
    expect(pctFromScroll(fakeScroller(500, 500, 0))).toBe(0);
    expect(pctFromScroll(fakeScroller(100, 500, 0))).toBe(0);
  });

  it('clamps an over-scrolled element', () => {
    expect(pctFromScroll(fakeScroller(1000, 500, 9999))).toBe(1);
  });

  it('scrollToPct sets scrollTop to the matching fraction', () => {
    const el = fakeScroller(1000, 500);
    scrollToPct(el, 0.5);
    expect(el.scrollTop).toBe(250);
    scrollToPct(el, 1);
    expect(el.scrollTop).toBe(500);
    scrollToPct(el, 0);
    expect(el.scrollTop).toBe(0);
  });

  it('clamps out-of-range percentages', () => {
    const el = fakeScroller(1000, 500);
    scrollToPct(el, 5);
    expect(el.scrollTop).toBe(500);
    scrollToPct(el, -2);
    expect(el.scrollTop).toBe(0);
    scrollToPct(el, Number.NaN);
    expect(el.scrollTop).toBe(0);
  });

  it('does nothing when the element is not scrollable', () => {
    const el = fakeScroller(500, 500);
    scrollToPct(el, 0.5);
    expect(el.scrollTop).toBe(0);
  });

  it('round-trips scrollToPct → pctFromScroll', () => {
    const el = fakeScroller(2000, 500);
    for (const p of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
      scrollToPct(el, p);
      expect(pctFromScroll(el)).toBeCloseTo(p, 3);
    }
  });

  it('tolerates a null element', () => {
    expect(pctFromScroll(null as unknown as HTMLElement)).toBe(0);
    expect(() => scrollToPct(null as unknown as HTMLElement, 0.5)).not.toThrow();
  });
});

describe('scrollContentHeight', () => {
  it('returns a number for a document with content', () => {
    expect(typeof scrollContentHeight(doc)).toBe('number');
  });

  it('returns 0 for a null document', () => {
    expect(scrollContentHeight(null as unknown as Document)).toBe(0);
  });
});
