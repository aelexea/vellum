/**
 * §8 F0 — pagination column math.
 *
 * jsdom performs no layout, so every measurement is injected: the pure functions
 * (pagesForWidth / pageIndexForX / pageTranslateX) are tested directly, and the DOM-driven
 * ones (measurePages / setPage / pageForCfi / cfiAtPage / pageForPoint / elementPage) run
 * against a fake LayoutMetrics that reports a synthetic geometry.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  applyLayout,
  clearLayoutCache,
  currentPageOf,
  elementPage,
  getWrap,
  marginsFrom,
  measurePages,
  pageForCfi,
  pageForPoint,
  pagesForWidth,
  pageStride,
  pageTranslateX,
  pageIndexForX,
  remeasurePages,
  setPage,
  cfiAtPage,
  setLayoutMetrics,
  WRAP_ID,
  type LayoutMetrics,
  type LayoutOpts,
} from './pagination';
import { decodeCfi } from './cfi';
import { COMPACT_CHAPTER, mountChapter } from './__fixtures__/chapterDom';

const OPTS: LayoutOpts = {
  pageWidthPx: 300,
  gapPx: 20,
  heightPx: 500,
  typography: {
    '--v-font-size': '19px',
    '--v-margin-top': '10px',
    '--v-margin-right': '12px',
    '--v-margin-bottom': '10px',
    '--v-margin-left': '12px',
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
  setLayoutMetrics(doc, realGeometry());
});

// ---------------------------------------------------------------------------
// pure column math
// ---------------------------------------------------------------------------

describe('pagesForWidth', () => {
  it('divides by the page+gap stride', () => {
    expect(pageStride(OPTS)).toBe(320);
    expect(pagesForWidth(320, OPTS)).toBe(1);
    expect(pagesForWidth(321, OPTS)).toBe(2);
    expect(pagesForWidth(640, OPTS)).toBe(2);
    expect(pagesForWidth(641, OPTS)).toBe(3);
    expect(pagesForWidth(1600, OPTS)).toBe(5);
  });

  it('never reports fewer than one page', () => {
    expect(pagesForWidth(0, OPTS)).toBe(1);
    expect(pagesForWidth(-50, OPTS)).toBe(1);
    expect(pagesForWidth(Number.NaN, OPTS)).toBe(1);
  });

  it('rounds up exactly on a stride multiple', () => {
    expect(pagesForWidth(960, OPTS)).toBe(3);
    expect(pagesForWidth(959, OPTS)).toBe(3);
  });

  it('treats a zero gap as a pure page width', () => {
    const noGap: LayoutOpts = { ...OPTS, gapPx: 0 };
    expect(pageStride(noGap)).toBe(300);
    expect(pagesForWidth(900, noGap)).toBe(3);
    expect(pagesForWidth(901, noGap)).toBe(4);
  });

  it('clamps a non-positive page width to 1px instead of dividing by zero', () => {
    // A degenerate width must not produce Infinity/NaN page counts.
    expect(pageStride({ ...OPTS, pageWidthPx: 0 })).toBe(21); // 1px page + 20px gap
    expect(pagesForWidth(500, { ...OPTS, pageWidthPx: 0 })).toBe(Math.ceil(500 / 21));
    const zeroGap = { ...OPTS, pageWidthPx: 0, gapPx: 0 };
    expect(pageStride(zeroGap)).toBe(1);
    expect(pagesForWidth(500, zeroGap)).toBe(500);
    expect(Number.isFinite(pagesForWidth(500, zeroGap))).toBe(true);
  });
});

describe('pageTranslateX', () => {
  it('is minus index times stride', () => {
    expect(pageTranslateX(0, OPTS)).toBe(0);
    expect(pageTranslateX(1, OPTS)).toBe(-320);
    expect(pageTranslateX(4, OPTS)).toBe(-1280);
  });

  it('clamps a negative index to zero', () => {
    expect(pageTranslateX(-3, OPTS)).toBe(0);
  });
});

describe('pageIndexForX', () => {
  it('maps a wrap-local x to its page', () => {
    expect(pageIndexForX(0, OPTS)).toBe(0);
    expect(pageIndexForX(319, OPTS)).toBe(0);
    expect(pageIndexForX(320, OPTS)).toBe(1);
    expect(pageIndexForX(700, OPTS)).toBe(2);
  });

  it('clamps negative x to the first page', () => {
    expect(pageIndexForX(-100, OPTS)).toBe(0);
  });

  it('is the exact inverse of pageTranslateX', () => {
    for (let i = 0; i < 12; i += 1) {
      expect(pageIndexForX(-pageTranslateX(i, OPTS), OPTS)).toBe(i);
    }
  });
});

// ---------------------------------------------------------------------------
// applyLayout
// ---------------------------------------------------------------------------

describe('applyLayout', () => {
  it('wraps every body child into #vellum-wrap and preserves them', () => {
    const before = body.children.length;
    expect(before).toBe(5);
    applyLayout(doc, OPTS);
    const wrap = getWrap(doc);
    expect(wrap).not.toBeNull();
    expect(wrap!.id).toBe(WRAP_ID);
    expect(wrap!.parentNode).toBe(body);
    expect(wrap!.children.length).toBe(before);
    expect(body.children.length).toBe(1);
    expect(wrap!.querySelector('#p2')!.textContent).toContain('Он пошёл домой');
  });

  it('is idempotent — a second call reuses the same wrapper', () => {
    applyLayout(doc, OPTS);
    const first = getWrap(doc);
    applyLayout(doc, OPTS);
    const second = getWrap(doc);
    expect(second).toBe(first);
    expect(second!.children.length).toBe(5);
  });

  it('sizes html/body to the page height with hidden overflow', () => {
    applyLayout(doc, OPTS);
    expect(doc.documentElement!.style.height).toBe('500px');
    expect(doc.documentElement!.style.overflow).toBe('hidden');
    expect(body.style.height).toBe('500px');
    expect(body.style.overflow).toBe('hidden');
    expect(body.style.margin).toBe('0px');
  });

  it('sets the column properties the layout depends on', () => {
    applyLayout(doc, OPTS);
    const wrap = getWrap(doc)!;
    expect(wrap.style.columnWidth).toBe('300px');
    expect(wrap.style.columnGap).toBe('20px');
    expect(wrap.style.columnFill).toBe('auto');
    expect(wrap.style.height).toBe('500px');
    expect(wrap.style.overflow).toBe('hidden');
    expect(wrap.style.willChange).toBe('transform');
    expect(wrap.style.transform).toBe('translateX(0px)');
  });

  it('applies typography margins as wrap padding with border-box sizing', () => {
    applyLayout(doc, OPTS);
    const wrap = getWrap(doc)!;
    expect(wrap.style.paddingTop).toBe('10px');
    expect(wrap.style.paddingLeft).toBe('12px');
    expect(wrap.style.boxSizing).toBe('border-box');
  });

  it('writes typography vars onto <html>', () => {
    applyLayout(doc, OPTS);
    expect(doc.documentElement!.style.getPropertyValue('--v-font-size')).toBe('19px');
  });

  it('starts on page 0', () => {
    applyLayout(doc, OPTS);
    expect(currentPageOf(doc)).toBe(0);
  });
});

describe('marginsFrom', () => {
  it('reads the four --v-margin-* px values', () => {
    expect(marginsFrom(OPTS.typography)).toEqual({ top: 10, right: 12, bottom: 10, left: 12 });
  });

  it('falls back to zero on missing or malformed entries', () => {
    expect(marginsFrom(undefined)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(marginsFrom({})).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
    expect(marginsFrom({ '--v-margin-top': 'abc', '--v-margin-left': '-5px' }))
      .toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });

  it('accepts the --v-page-margin-* aliases', () => {
    expect(marginsFrom({ '--v-page-margin-top': '24px' }).top).toBe(24);
  });
});

// ---------------------------------------------------------------------------
// DOM-driven functions, with injected geometry
// ---------------------------------------------------------------------------

/** A no-geometry provider, installed on teardown so no fake leaks into the next file. */
function realGeometry(): LayoutMetrics {
  return {
    wrapScrollWidth: () => 0,
    rangeRect: () => null,
    elementRect: () => null,
    caretAt: () => null,
  };
}

/**
 * A synthetic layout: `nPages` of content laid out left-to-right inside the wrapper, whose own
 * box sits at viewport x = WRAP_X. Each text node is given a fixed ADVANCE px, so node k sits
 * at wrap-local x = k * ADVANCE and lands on page floor(k * ADVANCE / stride).
 */
function fakeMetrics(nPages: number): LayoutMetrics {
  const WRAP_X = 40;
  const ADVANCE = 40;
  return {
    wrapScrollWidth: () => nPages * pageStride(OPTS),
    elementRect: (el) => {
      if (el.id === WRAP_ID) {
        return { x: WRAP_X, y: 0, width: OPTS.pageWidthPx, height: OPTS.heightPx };
      }
      return { x: WRAP_X, y: 0, width: 10, height: 10 };
    },
    rangeRect: (range) => {
      const all = textNodesOf(doc);
      const idx = all.indexOf(range.startContainer as Text);
      if (idx === -1) return null;
      return { x: WRAP_X + idx * ADVANCE, y: 0, width: ADVANCE, height: 16 };
    },
    caretAt: () => null,
  };
}

function textNodesOf(root: Document | HTMLElement): Text[] {
  const owner: Document = 'ownerDocument' in root && root.ownerDocument ? root.ownerDocument : (root as Document);
  const out: Text[] = [];
  const w = owner.createTreeWalker(root as unknown as Node, 4);
  for (let n = w.nextNode(); n !== null; n = w.nextNode()) out.push(n as Text);
  return out;
}

describe('measurePages with injected metrics', () => {
  it('reports ceil(scrollWidth / stride)', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => 1600,
      rangeRect: () => null,
      elementRect: () => null,
      caretAt: () => null,
    });
    expect(measurePages(doc, OPTS)).toBe(5);
  });

  it('returns 1 before layout is applied', () => {
    expect(measurePages(doc, OPTS)).toBe(1);
  });

  it('returns 1 when the metrics report zero width', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => 0, rangeRect: () => null, elementRect: () => null, caretAt: () => null,
    });
    expect(measurePages(doc, OPTS)).toBe(1);
  });
});

describe('setPage', () => {
  it('writes the translateX transform and records the page', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => 1600, rangeRect: () => null, elementRect: () => null, caretAt: () => null,
    });
    setPage(doc, 3, 'none');
    const wrap = getWrap(doc)!;
    expect(wrap.style.transform).toBe('translateX(-960px)');
    expect(wrap.dataset.page).toBe('3');
    expect(currentPageOf(doc)).toBe(3);
  });

  it('records the requested animation for the caller to apply', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => 1600, rangeRect: () => null, elementRect: () => null, caretAt: () => null,
    });
    setPage(doc, 1, 'slide');
    expect(getWrap(doc)!.dataset.anim).toBe('slide');
  });

  it('clamps past the last page and below zero', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => 960, rangeRect: () => null, elementRect: () => null, caretAt: () => null,
    });
    setPage(doc, 99, 'none');
    expect(currentPageOf(doc)).toBe(2);
    setPage(doc, -4, 'none');
    expect(currentPageOf(doc)).toBe(0);
  });

  it('is a single style write (no allocation, no reflow reads)', () => {
    applyLayout(doc, OPTS);
    let reads = 0;
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => { reads += 1; return 1600; },
      rangeRect: () => null,
      elementRect: () => null,
      caretAt: () => null,
    });
    reads = 0;
    setPage(doc, 2, 'none');
    // The first turn after a layout change pays one scrollWidth read to learn the page count.
    expect(reads).toBe(1);
  });

  it('forces no reflow on subsequent turns — the page count is cached', () => {
    applyLayout(doc, OPTS);
    let reads = 0;
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => { reads += 1; return 1600; },
      rangeRect: () => null,
      elementRect: () => null,
      caretAt: () => null,
    });
    setPage(doc, 1, 'none');
    reads = 0;
    // A page turn is the hottest path in the reader (§1.1: one paint frame). Reading
    // scrollWidth would force a synchronous layout flush of the whole chapter, so every turn
    // after the first must be pure style writes.
    for (let i = 0; i < 20; i += 1) setPage(doc, i % 5, 'slide');
    expect(reads).toBe(0);
    expect(currentPageOf(doc)).toBe(4);
  });

  it('re-measures when the layout changes again', () => {
    applyLayout(doc, OPTS);
    let width = 1600;
    let reads = 0;
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => { reads += 1; return width; },
      rangeRect: () => null,
      elementRect: () => null,
      caretAt: () => null,
    });
    expect(measurePages(doc, OPTS)).toBe(5);
    setPage(doc, 4, 'none');
    expect(currentPageOf(doc)).toBe(4);

    // A re-layout (e.g. the font-size slider) changes geometry and must invalidate the cache,
    // otherwise pages() would report a stale count and the clamping would strand the reader.
    width = 960;
    applyLayout(doc, OPTS);
    expect(measurePages(doc, OPTS)).toBe(3);
    setPage(doc, 4, 'none');
    expect(currentPageOf(doc)).toBe(2);
    expect(reads).toBeGreaterThan(1);
  });

  it('remeasurePages bypasses the cache on demand', () => {
    applyLayout(doc, OPTS);
    let width = 1600;
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => width, rangeRect: () => null, elementRect: () => null, caretAt: () => null,
    });
    expect(measurePages(doc, OPTS)).toBe(5);
    width = 640;
    expect(measurePages(doc, OPTS)).toBe(5); // cached
    expect(remeasurePages(doc, OPTS)).toBe(2); // forced
    expect(measurePages(doc, OPTS)).toBe(2); // and now cached
  });

  it('no-ops before layout is applied', () => {
    setPage(doc, 2, 'slide');
    expect(getWrap(doc)).toBeNull();
  });
});

describe('pageForCfi', () => {
  it('maps a CFI to the page its rect falls on', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, fakeMetrics(5));
    // fakeMetrics puts text node k at wrap-local x = k * 40, so the page is floor(k*40/320).
    const idx = textNodesOf(doc).indexOf(body.querySelector('#p3')!.firstChild as Text);
    expect(idx).toBeGreaterThan(0);
    const expected = Math.min(4, Math.floor((idx * 40) / pageStride(OPTS)));
    expect(pageForCfi(doc, 'epubcfi(/10/1:0)')).toBe(expected);
  });

  it('maps the first text node of the chapter to page 0', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, fakeMetrics(5));
    expect(pageForCfi(doc, 'epubcfi(/2/1:0)')).toBe(0);
  });

  it('returns null for an unresolvable CFI', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, fakeMetrics(5));
    expect(pageForCfi(doc, 'epubcfi(/99/1:0)')).toBeNull();
    expect(pageForCfi(doc, 'garbage')).toBeNull();
  });

  it('returns null when no rect geometry is available', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => 1600, rangeRect: () => null, elementRect: () => null, caretAt: () => null,
    });
    expect(pageForCfi(doc, 'epubcfi(/4/1:0)')).toBeNull();
  });

  it('round-trips with cfiAtPage', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, fakeMetrics(5));
    const page = pageForCfi(doc, 'epubcfi(/8/1:0)');
    expect(page).not.toBeNull();
    const cfi = cfiAtPage(doc, page!);
    expect(cfi).not.toBeNull();
    expect(pageForCfi(doc, cfi!)).toBe(page);
  });
});

describe('cfiAtPage', () => {
  it('returns the CFI of the first text node on the page', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, fakeMetrics(5));
    const cfi = cfiAtPage(doc, 0);
    expect(cfi).not.toBeNull();
    expect(cfi!.startsWith('epubcfi(')).toBe(true);
    // Page 0 must be the very first text node in the chapter.
    const range = decodeCfi(cfi!, body);
    expect(range!.startContainer).toBe(textNodesOf(doc)[0]);
  });

  it('advances to a later node on a later page', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, fakeMetrics(5));
    const first = cfiAtPage(doc, 0);
    const later = cfiAtPage(doc, 2);
    expect(later).not.toBe(first);
  });

  it('returns null before layout', () => {
    expect(cfiAtPage(doc, 0)).toBeNull();
  });
});

describe('pageForPoint', () => {
  it('maps a viewport x inside the wrap to its page', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, fakeMetrics(5));
    // wrap starts at viewport x=40; one stride is 320.
    expect(pageForPoint(doc, 40, OPTS)).toBe(0);
    expect(pageForPoint(doc, 360, OPTS)).toBe(1);
    expect(pageForPoint(doc, 680, OPTS)).toBe(2);
  });

  it('clamps to the last page', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => 960, rangeRect: () => null,
      elementRect: () => ({ x: 40, y: 0, width: 300, height: 500 }),
      caretAt: () => null,
    });
    expect(pageForPoint(doc, 100000, OPTS)).toBe(2);
    expect(pageForPoint(doc, -100, OPTS)).toBe(0);
  });
});

describe('elementPage', () => {
  it('reports the page an element sits on', () => {
    applyLayout(doc, OPTS);
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => 1600, rangeRect: () => null,
      elementRect: (el) => ({
        x: 40 + (el.id === 'p3' ? 2 * pageStride(OPTS) : 0),
        y: 0, width: 20, height: 20,
      }),
      caretAt: () => null,
    });
    expect(elementPage(body.querySelector('#p3') as Element)).toBe(2);
  });

  it('returns the current page when geometry is unavailable', () => {
    applyLayout(doc, OPTS);
    // Install a multi-page width BEFORE setPage, which clamps to the measured page count.
    setLayoutMetrics(doc, {
      wrapScrollWidth: () => 1600, rangeRect: () => null, elementRect: () => null, caretAt: () => null,
    });
    setPage(doc, 1, 'none');
    expect(currentPageOf(doc)).toBe(1);
    expect(elementPage(body.querySelector('#p3') as Element)).toBe(1);
  });
});

describe('getWrap / clearLayoutCache', () => {
  it('finds the wrapper by id and by attribute', () => {
    applyLayout(doc, OPTS);
    expect(getWrap(doc)).not.toBeNull();
    clearLayoutCache(doc);
    // Still found after the cache is dropped, by DOM query.
    expect(getWrap(doc)).not.toBeNull();
  });

  it('returns null for an unrelated document', () => {
    expect(getWrap(doc)).toBeNull();
  });
});
