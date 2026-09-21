/**
 * §8 F0 — ChapterController: link interception, layout dispatch, navigation, and the
 * "never throws after dispose" contract that F2's iframe pool relies on.
 *
 * jsdom does not parse `srcdoc`, but an attached iframe's contentDocument is already
 * `complete` and accepts document.write(), so fixtures are written directly into the frame.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { ChapterController, NO_CHAPTER_IDX, type LinkClick } from './controller';
import type { ControllerLayoutOpts } from './controller';
import { clearLayoutCache, setLayoutMetrics, getWrap, type LayoutMetrics } from './pagination';
import { LINK_CHAPTER, COMPACT_CHAPTER } from './__fixtures__/chapterDom';

let hostDoc: Document;
let iframe: HTMLIFrameElement;
let ctrl: ChapterController;

/** Geometry so pagination/pageForCfi have something to work with under jsdom. */
const GEOMETRY: LayoutMetrics = {
  wrapScrollWidth: () => 1600,
  rangeRect: () => null,
  elementRect: (el) =>
    el.id === 'vellum-wrap'
      ? { x: 0, y: 0, width: 300, height: 500 }
      : { x: 0, y: 0, width: 10, height: 10 },
  caretAt: () => null,
};

const OPTS: ControllerLayoutOpts = {
  mode: 'paginated',
  pageWidthPx: 300,
  gapPx: 20,
  heightPx: 500,
  maxWidthPx: 720,
  typography: { '--v-font-size': '19px' },
};

function frameDoc(): Document {
  return iframe.contentDocument as Document;
}

/** Mount an iframe with `html` as its document body and return a ready controller. */
async function mount(html: string): Promise<ChapterController> {
  iframe = hostDoc.createElement('iframe');
  hostDoc.body.appendChild(iframe);
  const d = frameDoc();
  d.open();
  d.write(`<!doctype html><html><head></head><body>${html}</body></html>`);
  d.close();
  const c = new ChapterController(iframe);
  await c.ready();
  return c;
}

function click(el: Element): MouseEvent {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  hostDoc = document;
  hostDoc.body.innerHTML = '';
});

afterEach(() => {
  try {
    ctrl?.dispose();
  } catch {
    // dispose must never throw, but the harness should not fail on a double-dispose
  }
  if (iframe) {
    // A deliberately detached frame has no contentDocument.
    const d = iframe.contentDocument;
    if (d) clearLayoutCache(d);
    iframe.remove();
  }
});

// ---------------------------------------------------------------------------
// ready / chapterRoot
// ---------------------------------------------------------------------------

describe('ready and chapterRoot', () => {
  it('resolves and exposes the chapter body', async () => {
    ctrl = await mount(LINK_CHAPTER);
    expect(ctrl.chapterRoot()).toBe(frameDoc().body);
    expect(ctrl.doc()).toBe(frameDoc());
  });

  it('resolves twice without re-attaching listeners', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    await ctrl.ready();
    await ctrl.ready();
    expect(ctrl.chapterRoot()).not.toBeNull();
  });

  it('resolves for a null iframe instead of hanging', async () => {
    ctrl = new ChapterController(null as unknown as HTMLIFrameElement);
    await expect(ctrl.ready()).resolves.toBeUndefined();
    expect(ctrl.chapterRoot()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// link interception
// ---------------------------------------------------------------------------

describe('onLinkClick — external links', () => {
  it('calls back with the external URL and preventDefaults', async () => {
    ctrl = await mount(LINK_CHAPTER);
    const cb = vi.fn();
    ctrl.onLinkClick(cb);

    const a = frameDoc().getElementById('ext') as HTMLAnchorElement;
    const ev = click(a);

    expect(ev.defaultPrevented).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    const link = cb.mock.calls[0]![0];
    expect(link.external).toBe('https://example.com/page');
    expect(link.chapterIdx).toBe(NO_CHAPTER_IDX);
  });

  it('treats an unmarked http(s) href as external so it never navigates the frame', async () => {
    ctrl = await mount(LINK_CHAPTER);
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    const ev = click(frameDoc().getElementById('http')!);
    expect(ev.defaultPrevented).toBe(true);
    expect(cb.mock.calls[0]![0].external).toBe('http://plain.example/');
  });

  it('treats mailto as external', async () => {
    ctrl = await mount(LINK_CHAPTER);
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    const ev = click(frameDoc().getElementById('mail')!);
    expect(ev.defaultPrevented).toBe(true);
    expect(cb.mock.calls[0]![0].external).toBe('mailto:a@b.c');
  });

  it('distinguishes external from internal via the onAnyLinkClick router', async () => {
    ctrl = await mount(LINK_CHAPTER);
    const seen: LinkClick[] = [];
    ctrl.onAnyLinkClick((l) => seen.push(l));
    click(frameDoc().getElementById('ext')!);
    click(frameDoc().getElementById('zip')!);
    expect(seen[0]).toEqual({ kind: 'external', url: 'https://example.com/page' });
    expect(seen[1]!.kind).toBe('internal');
  });
});

describe('onLinkClick — internal vellum-link:// links (B2 scheme)', () => {
  it('reports the decoded zipPath and fragment', async () => {
    ctrl = await mount(LINK_CHAPTER);
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    const ev = click(frameDoc().getElementById('zip')!);

    expect(ev.defaultPrevented).toBe(true);
    const link = cb.mock.calls[0]![0];
    expect(link.zipPath).toBe('OPS/text/ch2.xhtml');
    expect(link.fragment).toBe('sec1');
    expect(link.chapterIdx).toBe(NO_CHAPTER_IDX);
    expect(link.external).toBeNull();
  });

  it('handles a link with no fragment', async () => {
    const html = '<a id="z" href="vellum-link://OPS/text/ch3.xhtml">next</a>';
    ctrl = await mount(html);
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    click(frameDoc().getElementById('z')!);
    expect(cb.mock.calls[0]![0]).toMatchObject({ zipPath: 'OPS/text/ch3.xhtml', fragment: null });
  });

  it('percent-decodes the zip path', async () => {
    const html = '<a id="z" href="vellum-link://OPS/%D0%BA%D0%BD%D0%B8%D0%B3%D0%B0.xhtml">ru</a>';
    ctrl = await mount(html);
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    click(frameDoc().getElementById('z')!);
    expect(cb.mock.calls[0]![0].zipPath).toBe('OPS/книга.xhtml');
  });

  it('keeps a malformed percent escape verbatim rather than dropping the link', async () => {
    const html = '<a id="z" href="vellum-link://OPS/100%.xhtml">bad</a>';
    ctrl = await mount(html);
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    click(frameDoc().getElementById('z')!);
    expect(cb.mock.calls[0]![0].zipPath).toBe('OPS/100%.xhtml');
  });
});

describe('onLinkClick — legacy #vellum-link markers (§4.3)', () => {
  it('reports chapterIdx and fragment', async () => {
    ctrl = await mount(LINK_CHAPTER);
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    const ev = click(frameDoc().getElementById('legacy')!);
    expect(ev.defaultPrevented).toBe(true);
    const link = cb.mock.calls[0]![0];
    expect(link.chapterIdx).toBe(3);
    expect(link.fragment).toBe('frag9');
    expect(link.zipPath).toBeNull();
  });

  it('handles a marker with no fragment', async () => {
    ctrl = await mount('<a id="l" href="#vellum-link:7">go</a>');
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    click(frameDoc().getElementById('l')!);
    expect(cb.mock.calls[0]![0].chapterIdx).toBe(7);
    expect(cb.mock.calls[0]![0].fragment).toBeNull();
  });

  it('ignores a marker with a non-numeric index', async () => {
    ctrl = await mount('<a id="l" href="#vellum-link:abc:x">go</a>');
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    click(frameDoc().getElementById('l')!);
    expect(cb).not.toHaveBeenCalled();
  });

  it('satisfies F2 frozen guard: chapterIdx >= 0 only for the legacy form', async () => {
    ctrl = await mount(LINK_CHAPTER);
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    click(frameDoc().getElementById('zip')!);
    // ChapterFrame.tsx does `if (link.chapterIdx >= 0) gotoChapter(...)` — a zip-path link
    // must NOT satisfy that, or it would jump to a bogus chapter.
    expect(cb.mock.calls[0]![0].chapterIdx >= 0).toBe(false);
    click(frameDoc().getElementById('legacy')!);
    expect(cb.mock.calls[1]![0].chapterIdx >= 0).toBe(true);
  });
});

describe('onLinkClick — in-page anchors', () => {
  it('does not hand a #fragment to the caller as a navigation', async () => {
    ctrl = await mount(LINK_CHAPTER);
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    const ev = click(frameDoc().getElementById('frag')!);
    expect(ev.defaultPrevented).toBe(true);
    expect(cb).not.toHaveBeenCalled();
  });

  it('routes a #fragment through onAnyLinkClick as inpage', async () => {
    ctrl = await mount(LINK_CHAPTER);
    const cb = vi.fn();
    ctrl.onAnyLinkClick(cb);
    click(frameDoc().getElementById('frag')!);
    expect(cb.mock.calls[0]![0]).toEqual({ kind: 'inpage', fragment: 'r2' });
  });
});

describe('onImageClick', () => {
  it('reports the src of a clicked image', async () => {
    ctrl = await mount(LINK_CHAPTER);
    const cb = vi.fn();
    ctrl.onImageClick(cb);
    click(frameDoc().getElementById('img1')!);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toBe('vellum://book/x/asset/a.png');
  });

  it('reports the nested img src when a figure is clicked', async () => {
    ctrl = await mount('<figure id="f"><img id="i" src="vellum://book/x/asset/b.png" /></figure>');
    const cb = vi.fn();
    ctrl.onImageClick(cb);
    click(frameDoc().getElementById('f')!);
    expect(cb.mock.calls[0]![0]).toBe('vellum://book/x/asset/b.png');
  });
});

// ---------------------------------------------------------------------------
// layout / navigation
// ---------------------------------------------------------------------------

describe('layout and navigation', () => {
  // Each test installs GEOMETRY right after mount(): the frame document only exists once
  // mount() has created and attached the iframe.

  it('installs the column wrapper in paginated mode', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    setLayoutMetrics(frameDoc(), GEOMETRY);
    ctrl.layout(OPTS);
    const wrap = getWrap(frameDoc());
    expect(wrap).not.toBeNull();
    expect(wrap!.style.columnWidth).toBe('300px');
    expect(ctrl.pages()).toBe(5); // 1600 / 320
  });

  it('removes the column wrapper in scroll mode and centers the body', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    setLayoutMetrics(frameDoc(), GEOMETRY);
    ctrl.layout(OPTS);
    expect(getWrap(frameDoc())).not.toBeNull();

    ctrl.layout({ ...OPTS, mode: 'scroll' });
    expect(getWrap(frameDoc())).toBeNull();
    expect(frameDoc().body.style.maxWidth).toBe('720px');
    expect(frameDoc().body.style.margin).toBe('0px auto');
    expect(ctrl.pages()).toBe(1);
  });

  it('writes typography vars onto the chapter <html>', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    ctrl.layout(OPTS);
    expect(frameDoc().documentElement!.style.getPropertyValue('--v-font-size')).toBe('19px');
  });

  it('goto accepts a page index, a CFI string and a percent', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    setLayoutMetrics(frameDoc(), GEOMETRY);
    ctrl.layout(OPTS);

    // A whole number is a page index.
    ctrl.goto(2);
    expect(ctrl.currentPage()).toBe(2);

    ctrl.goto({ page: 1 });
    expect(ctrl.currentPage()).toBe(1);

    // A fractional number is a percent (a page index is always an integer).
    ctrl.goto(0.5);
    expect(ctrl.currentPage()).toBe(2); // round(0.5 * 4)

    // Per the frozen docstring a non-CFI string is a percent, so '0.5' → middle page.
    ctrl.goto('0.5');
    expect(ctrl.currentPage()).toBe(2);

    // '1' means 100%, i.e. the last page — not page 1.
    ctrl.goto('1');
    expect(ctrl.currentPage()).toBe(4);
    expect(ctrl.pages()).toBe(5);
  });

  it('clamps page navigation to the measured range', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    setLayoutMetrics(frameDoc(), GEOMETRY);
    ctrl.layout(OPTS);
    ctrl.goto(999);
    expect(ctrl.currentPage()).toBe(4);
    ctrl.goto(-5);
    expect(ctrl.currentPage()).toBe(0);
  });

  it('goto(cfi) stays put when the CFI is unresolvable', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    setLayoutMetrics(frameDoc(), GEOMETRY);
    ctrl.layout(OPTS);
    ctrl.goto(2);
    // No rect geometry → pageForCfi returns null → no jump.
    expect(ctrl.gotoCfi('epubcfi(/4/1:0)')).toBe(false);
    expect(ctrl.currentPage()).toBe(2);
  });

  it('gotoCfi resolves a #fragment anchor (TOC mid-chapter entry)', async () => {
    ctrl = await mount(LINK_CHAPTER);
    setLayoutMetrics(frameDoc(), GEOMETRY);
    ctrl.layout(OPTS);
    expect(ctrl.gotoCfi('#r2')).toBe(true);
    // An absent id resolves nowhere → stay put, same as an unresolvable epubcfi.
    expect(ctrl.gotoCfi('#nope')).toBe(false);
    expect(() => ctrl.goto('#r2')).not.toThrow();
    expect(() => ctrl.goto({ cfi: '#r2' })).not.toThrow();
  });

  it('turn() moves one page and canTurn() reports the edges', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    setLayoutMetrics(frameDoc(), GEOMETRY);
    ctrl.layout(OPTS);
    expect(ctrl.canTurn(-1)).toBe(false);
    expect(ctrl.canTurn(1)).toBe(true);
    expect(ctrl.turn(1)).toBe(1);
    ctrl.goto(4);
    expect(ctrl.canTurn(1)).toBe(false);
  });

  it('reports progress as a 0..1 fraction', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    setLayoutMetrics(frameDoc(), GEOMETRY);
    ctrl.layout(OPTS);
    expect(ctrl.progress()).toBe(0);
    ctrl.goto(2);
    expect(ctrl.progress()).toBeCloseTo(0.5, 5);
    ctrl.goto(4);
    expect(ctrl.progress()).toBe(1);
  });

  it('setHighlights renders marks in the chapter document', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    ctrl.setHighlights([{
      id: 1, cfiStart: 'epubcfi(/10/1:0)', cfiEnd: 'epubcfi(/10/1:4)',
      color: '#ffe08a', hasNote: false,
    }]);
    expect(frameDoc().querySelectorAll('mark.vellum-hl').length).toBe(1);
  });

  it('find() returns a CFI for text in the chapter', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    const hit = ctrl.find('Last line');
    expect(hit).not.toBeNull();
    expect(hit!.cfi).toContain('epubcfi(');
  });

  it('countMatches counts occurrences', async () => {
    ctrl = await mount('<p>cat cat cat</p>');
    expect(ctrl.countMatches('cat')).toBe(3);
  });

  it('findAndFlash wraps the hit and clearFlash removes it', async () => {
    ctrl = await mount('<p id="f">find me here</p>');
    const hit = ctrl.findAndFlash('find me');
    expect(hit).not.toBeNull();
    expect(frameDoc().querySelectorAll('mark.vellum-flash').length).toBeGreaterThan(0);
    ctrl.clearFlash();
    expect(frameDoc().querySelectorAll('mark.vellum-flash').length).toBe(0);
    expect(frameDoc().getElementById('f')!.textContent).toBe('find me here');
  });

  it('flashCfi flashes a range CFI in the chapter', async () => {
    ctrl = await mount('<p id="f">bookmark target here. Next.</p>');
    expect(ctrl.flashCfi('epubcfi(/2,/1:0,/1:9)')).toBe(true);
    expect(frameDoc().querySelectorAll('mark.vellum-flash').length).toBeGreaterThan(0);
    ctrl.clearFlash();
    expect(frameDoc().getElementById('f')!.textContent).toBe('bookmark target here. Next.');
  });

  it('flashCfi expands a point CFI (bookmark form) instead of doing nothing', async () => {
    ctrl = await mount('<p id="f">bookmark target here. Next.</p>');
    expect(ctrl.flashCfi('epubcfi(/2/1:2)')).toBe(true);
    const marks = Array.from(frameDoc().querySelectorAll('mark.vellum-flash'));
    expect(marks.map((m) => m.textContent).join('')).toBe('okmark target here.');
  });

  it('flashCfi returns false for an unresolvable CFI and after dispose', async () => {
    ctrl = await mount('<p id="f">text</p>');
    expect(ctrl.flashCfi('epubcfi(/99/1:0)')).toBe(false);
    expect(ctrl.flashCfi('')).toBe(false);
    ctrl.dispose();
    expect(ctrl.flashCfi('epubcfi(/2/1:0)')).toBe(false);
  });

  it('contentHeight returns a number without throwing', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    expect(typeof ctrl.contentHeight()).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// selection wiring
// ---------------------------------------------------------------------------

describe('onSelect', () => {
  it('forwards a debounced selection to the callback', async () => {
    vi.useFakeTimers();
    try {
      ctrl = await mount(COMPACT_CHAPTER);
      const cb = vi.fn();
      ctrl.onSelect(cb);

      const d = frameDoc();
      const sel = d.getSelection()!;
      const r = d.createRange();
      const t = d.querySelector('#p3')!.firstChild as Text;
      r.setStart(t, 5);
      r.setEnd(t, 9);
      sel.removeAllRanges();
      sel.addRange(r);
      d.dispatchEvent(new Event('selectionchange'));

      expect(cb).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(cb.mock.calls[0]![0].text).toBe('line');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards null when the selection collapses', async () => {
    vi.useFakeTimers();
    try {
      ctrl = await mount(COMPACT_CHAPTER);
      const cb = vi.fn();
      ctrl.onSelect(cb);
      const d = frameDoc();
      d.getSelection()!.removeAllRanges();
      d.dispatchEvent(new MouseEvent('mouseup'));
      vi.advanceTimersByTime(100);
      expect(cb).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops forwarding after dispose', async () => {
    vi.useFakeTimers();
    try {
      ctrl = await mount(COMPACT_CHAPTER);
      const cb = vi.fn();
      ctrl.onSelect(cb);
      const d = frameDoc();
      d.dispatchEvent(new Event('selectionchange'));
      ctrl.dispose();
      vi.advanceTimersByTime(200);
      expect(cb).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// dispose / forgiveness
// ---------------------------------------------------------------------------

describe('dispose', () => {
  it('is idempotent', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    ctrl.dispose();
    expect(() => ctrl.dispose()).not.toThrow();
  });

  it('makes every method a safe no-op afterwards', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    ctrl.layout(OPTS);
    ctrl.dispose();

    expect(ctrl.doc()).toBeNull();
    expect(ctrl.chapterRoot()).toBeNull();
    expect(ctrl.pages()).toBe(0);
    expect(ctrl.currentPage()).toBe(0);
    expect(ctrl.progress()).toBe(0);
    expect(ctrl.currentCfi()).toBeNull();
    expect(ctrl.contentHeight()).toBe(0);
    expect(ctrl.find('Last')).toBeNull();
    expect(ctrl.findAndFlash('Last')).toBeNull();
    expect(ctrl.countMatches('Last')).toBe(0);
    expect(ctrl.gotoCfi('epubcfi(/4/1:0)')).toBe(false);
    expect(() => ctrl.goto(3)).not.toThrow();
    expect(() => ctrl.goto({ cfi: 'epubcfi(/4/1:0)' })).not.toThrow();
    expect(() => ctrl.goto(0.5)).not.toThrow();
    expect(() => ctrl.setPage(1, 'slide')).not.toThrow();
    expect(() => ctrl.turn(1)).not.toThrow();
    expect(() => ctrl.canTurn(1)).not.toThrow();
    expect(() => ctrl.pageAtPoint(100)).not.toThrow();
    expect(() => ctrl.layout(OPTS)).not.toThrow();
    expect(() => ctrl.setHighlights([])).not.toThrow();
    expect(() => ctrl.clearFlash()).not.toThrow();
    expect(() => ctrl.onSelect(() => {})).not.toThrow();
    expect(() => ctrl.onLinkClick(() => {})).not.toThrow();
    expect(() => ctrl.onAnyLinkClick(() => {})).not.toThrow();
    expect(() => ctrl.onImageClick(() => {})).not.toThrow();
    expect(() => ctrl.onHighlightClick(() => {})).not.toThrow();
    await expect(ctrl.ready()).resolves.toBeUndefined();
  });

  it('ignores clicks after dispose', async () => {
    ctrl = await mount(LINK_CHAPTER);
    const cb = vi.fn();
    ctrl.onLinkClick(cb);
    const a = frameDoc().getElementById('ext')!;
    ctrl.dispose();
    click(a);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('forgiving construction', () => {
  it('survives being used before ready() resolves', () => {
    iframe = hostDoc.createElement('iframe');
    // Deliberately NOT appended: contentDocument is null for a detached frame.
    ctrl = new ChapterController(iframe);
    expect(ctrl.doc()).toBeNull();
    expect(ctrl.chapterRoot()).toBeNull();
    expect(() => ctrl.layout(OPTS)).not.toThrow();
    expect(() => ctrl.goto(1)).not.toThrow();
    expect(() => ctrl.setHighlights([])).not.toThrow();
    // Before layout a chapter is still one page long, so the slider math stays sane.
    expect(ctrl.pages()).toBe(1);
    expect(ctrl.find('x')).toBeNull();
  });

  it('survives a null callback for every subscription', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    expect(() => ctrl.onSelect(null as unknown as () => void)).not.toThrow();
    expect(() => ctrl.onLinkClick(null as unknown as () => void)).not.toThrow();
    expect(() => ctrl.onImageClick(null as unknown as () => void)).not.toThrow();
  });

  it('survives garbage goto targets', async () => {
    ctrl = await mount(COMPACT_CHAPTER);
    setLayoutMetrics(frameDoc(), GEOMETRY);
    ctrl.layout(OPTS);
    for (const bad of ['', '   ', 'nonsense', Number.NaN, {}, null, undefined]) {
      expect(() => ctrl.goto(bad as never)).not.toThrow();
    }
  });
});
