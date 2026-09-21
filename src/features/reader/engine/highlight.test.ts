/**
 * §8 F0 — highlight wrapping across element boundaries, idempotent re-render, stale-CFI
 * skipping, note marks, and click routing.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  highlightBackground,
  markForId,
  onMarkClick,
  renderedIds,
  renderHighlights,
  removeHighlights,
  type HighlightItem,
} from './highlight';
import { decodeCfi, encodeRange } from './cfi';
import { COMPACT_CHAPTER, mountChapter } from './__fixtures__/chapterDom';

let doc: Document;
let body: HTMLElement;

function item(id: number, cfiStart: string, cfiEnd: string, color = '#ffe08a', hasNote = false): HighlightItem {
  return { id, cfiStart, cfiEnd, color, hasNote };
}

/** Encode a selection of `text` inside the chapter as a CFI pair. */
function cfiPairFor(text: string, from = 0): [string, string] {
  const hay = body.textContent!;
  const at = hay.indexOf(text, from);
  expect(at, `"${text}" must exist in the fixture`).toBeGreaterThanOrEqual(0);
  // Walk text nodes to (node, offset) for `at` and `at + text.length`.
  const map: { node: Text; start: number }[] = [];
  let pos = 0;
  const w = doc.createTreeWalker(body, 4);
  for (let n = w.nextNode(); n !== null; n = w.nextNode()) {
    const t = n as Text;
    map.push({ node: t, start: pos });
    pos += t.length;
  }
  const locate = (index: number): [Text, number] => {
    for (let i = map.length - 1; i >= 0; i -= 1) {
      const rec = map[i]!;
      if (index >= rec.start && index <= rec.start + rec.node.length) {
        return [rec.node, index - rec.start];
      }
    }
    throw new Error('index out of range');
  };
  const r = doc.createRange();
  const [sn, so] = locate(at);
  const [en, eo] = locate(at + text.length);
  r.setStart(sn, so);
  r.setEnd(en, eo);
  const start = doc.createRange();
  start.setStart(sn, so);
  start.collapse(true);
  const end = doc.createRange();
  end.setStart(en, eo);
  end.collapse(true);
  void r;
  return [encodeRange(start, body), encodeRange(end, body)];
}

beforeEach(() => {
  doc = document;
  doc.body.innerHTML = '';
  body = mountChapter(doc, COMPACT_CHAPTER);
});

describe('renderHighlights — wrapping across element boundaries', () => {
  it('wraps <p>a <b>b</b> c</p> selection of a..b in 2 marks with the same hlId', () => {
    const fresh = mountChapter(doc, '<p>a <b>b</b> c</p>');
    // "a " is chunk /1 of the p, "b" is /2/1 inside <b>.
    const [start, end] = ['epubcfi(/2/1:0)', 'epubcfi(/2/2/1:1)'];
    const res = renderHighlights(doc, fresh, [item(7, start, end)]);
    expect(res).toEqual({ rendered: 1, skipped: 0, marks: 2 });
    const marks = doc.querySelectorAll<HTMLElement>('mark.vellum-hl');
    expect(marks.length).toBe(2);
    expect(marks[0]!.dataset.hlId).toBe('7');
    expect(marks[1]!.dataset.hlId).toBe('7');
    expect(marks[0]!.textContent).toBe('a ');
    expect(marks[1]!.textContent).toBe('b');
    // The rest of the paragraph is untouched.
    expect(fresh.textContent).toBe('a b c');
  });

  it('wraps a mid-text partial slice with splitText', () => {
    const [start, end] = cfiPairFor('llo wo');
    const res = renderHighlights(doc, body, [item(1, start, end)]);
    expect(res.rendered).toBe(1);
    // "llo " sits in the <p>'s leading chunk and "wo" inside <b>, so two marks share the id.
    const marks = Array.from(doc.querySelectorAll<HTMLElement>('mark.vellum-hl'));
    expect(marks.length).toBe(2);
    expect(marks.map((m) => m.textContent).join('')).toBe('llo wo');
    expect(marks.every((m) => m.dataset.hlId === '1')).toBe(true);
    expect(body.querySelector('#p1')!.textContent).toBe('Hello world again');
  });

  it('handles a range inside a single text node as one mark', () => {
    const [start, end] = cfiPairFor('world');
    renderHighlights(doc, body, [item(2, start, end)]);
    expect(doc.querySelectorAll('mark.vellum-hl').length).toBe(1);
    expect(doc.querySelector('mark.vellum-hl')!.textContent).toBe('world');
  });

  it('renders multiple items in one pass without CFI drift', () => {
    // Both highlights live in the SAME paragraph chunk; item 2's CFI must still resolve after
    // item 1 wrapped text into a mark (the two-phase design).
    const [s1, e1] = cfiPairFor('Hello');
    const [s2, e2] = cfiPairFor('again');
    const res = renderHighlights(doc, body, [item(11, s1, e1), item(12, s2, e2)]);
    expect(res.rendered).toBe(2);
    expect(res.skipped).toBe(0);
    expect(renderedIds(doc).sort((a, b) => a - b)).toEqual([11, 12]);
    expect(doc.querySelector('#p1')!.textContent).toBe('Hello world again');
  });

  it('clips overlapping highlights instead of nesting marks', () => {
    const [s1, e1] = cfiPairFor('Hello wor');
    const [s2, e2] = cfiPairFor('o world ag');
    const res = renderHighlights(doc, body, [item(21, s1, e1), item(22, s2, e2)]);
    expect(res.rendered).toBe(2);
    const all = Array.from(doc.querySelectorAll('mark.vellum-hl'));
    for (const m of all) {
      expect(m.querySelector('mark.vellum-hl')).toBeNull();
    }
    // Text preserved exactly once.
    expect(body.querySelector('#p1')!.textContent).toBe('Hello world again');
    expect(all.map((m) => m.textContent).join('')).toBe('Hello world ag');
  });

  it('normalizes an inverted CFI pair', () => {
    const [start, end] = cfiPairFor('world');
    const res = renderHighlights(doc, body, [item(3, end, start)]);
    expect(res.rendered).toBe(1);
    expect(doc.querySelector('mark.vellum-hl')!.textContent).toBe('world');
  });
});

describe('renderHighlights — styling', () => {
  it('sets the frozen color-mix background', () => {
    expect(highlightBackground('#ffe08a')).toBe('color-mix(in srgb, #ffe08a 55%, transparent)');
    const [start, end] = cfiPairFor('Last line');
    renderHighlights(doc, body, [item(4, start, end, '#a8e6a3')]);
    const mark = doc.querySelector<HTMLElement>('mark.vellum-hl')!;
    // The colour is delivered through a custom property (see HL_BG_VAR) rather than an inline
    // backgroundColor, because a CSSOM parse of color-mix() per mark blows the re-render budget.
    const bg = mark.style.getPropertyValue('--v-hl-bg');
    expect(bg).toContain('color-mix');
    expect(bg).toContain('#a8e6a3');
    expect(bg).toContain('55%');
  });

  it('adds the vellum-note class when hasNote', () => {
    const [start, end] = cfiPairFor('Last line');
    renderHighlights(doc, body, [item(5, start, end, '#ffe08a', true)]);
    const mark = doc.querySelector('mark.vellum-hl')!;
    expect(mark.classList.contains('vellum-note')).toBe(true);
  });

  it('omits the note class when hasNote is false', () => {
    const [start, end] = cfiPairFor('Last line');
    renderHighlights(doc, body, [item(6, start, end, '#ffe08a', false)]);
    expect(doc.querySelector('mark.vellum-hl')!.classList.contains('vellum-note')).toBe(false);
  });
});

describe('renderHighlights — stale CFIs', () => {
  it('skips unresolvable CFIs silently and counts them', () => {
    const [start, end] = cfiPairFor('world');
    const res = renderHighlights(doc, body, [
      item(31, 'epubcfi(/99/1:0)', 'epubcfi(/99/1:5)'),
      item(32, start, end),
      item(33, 'not-a-cfi', 'also-bad'),
    ]);
    expect(res).toEqual({ rendered: 1, skipped: 2, marks: 1 });
  });

  it('renders nothing but clears old marks when all CFIs are stale', () => {
    const [start, end] = cfiPairFor('world');
    renderHighlights(doc, body, [item(41, start, end)]);
    expect(doc.querySelectorAll('mark.vellum-hl').length).toBe(1);

    const res = renderHighlights(doc, body, [item(42, 'epubcfi(/77/1:0)', 'epubcfi(/77/1:2)')]);
    expect(res.rendered).toBe(0);
    expect(doc.querySelectorAll('mark.vellum-hl').length).toBe(0);
    // Original text intact for the next honest attempt.
    expect(body.querySelector('#p1')!.textContent).toBe('Hello world again');
  });

  it('survives a completely stale chapter (DOM replaced) without throwing', () => {
    const [start] = cfiPairFor('Hello');
    body.innerHTML = '<p>Completely different content</p>';
    expect(() => renderHighlights(doc, body, [item(43, start, 'epubcfi(/4/3:1)')])).not.toThrow();
  });
});

describe('renderHighlights — idempotency', () => {
  it('re-rendering the same items produces the identical DOM', () => {
    const [s1, e1] = cfiPairFor('Hello');
    const [s2, e2] = cfiPairFor('gamma');
    const items = [item(51, s1, e1), item(52, s2, e2, '#9ecbf5', true)];
    renderHighlights(doc, body, items);
    const firstHtml = body.innerHTML;
    const firstCount = doc.querySelectorAll('mark.vellum-hl').length;

    renderHighlights(doc, body, items);
    expect(body.innerHTML).toBe(firstHtml);
    expect(doc.querySelectorAll('mark.vellum-hl').length).toBe(firstCount);
  });

  it('re-rendering after removing one item drops only that item', () => {
    const [s1, e1] = cfiPairFor('Hello');
    const [s2, e2] = cfiPairFor('omega');
    renderHighlights(doc, body, [item(61, s1, e1), item(62, s2, e2)]);
    expect(renderedIds(doc)).toContain(61);
    renderHighlights(doc, body, [item(61, s1, e1)]);
    expect(renderedIds(doc)).toEqual([61]);
    // #nested is alpha + span(beta + em(gamma) + " delta") + omega.
    expect(body.querySelector('#nested')!.textContent).toBe('alphabeta gamma deltaomega');
  });

  it('rendering an empty list clears everything', () => {
    const [s1, e1] = cfiPairFor('Hello');
    renderHighlights(doc, body, [item(71, s1, e1)]);
    const res = renderHighlights(doc, body, []);
    expect(res).toEqual({ rendered: 0, skipped: 0, marks: 0 });
    expect(doc.querySelectorAll('mark.vellum-hl').length).toBe(0);
    expect(body.textContent).toContain('Hello world again');
  });

  it('removes text nodes cleanly — no stray empties after unwrap', () => {
    const [s1, e1] = cfiPairFor('llo wo');
    renderHighlights(doc, body, [item(81, s1, e1)]);
    renderHighlights(doc, body, []);
    const p1 = body.querySelector('#p1')!;
    // normalize() merged the splits back: exactly the original 3 children.
    expect(p1.childNodes.length).toBe(3);
    expect(p1.textContent).toBe('Hello world again');
  });

  it('removeHighlights is safe to call on a clean document', () => {
    expect(removeHighlights(doc)).toBe(0);
  });
});

describe('renderHighlights — CFIs stored against highlighted DOM', () => {
  it('a CFI computed while marks exist still encodes the original position', () => {
    // Chunk semantics: wrapping "wor" splits the chunk, but encodePoint counts from the
    // chunk head, so a selection made *after* highlighting still round-trips.
    const [s1, e1] = cfiPairFor('world');
    renderHighlights(doc, body, [item(91, s1, e1)]);
    const b = body.querySelector('#p1 b')!;
    const tail = b.nextSibling as Text; // " again" — untouched by the highlight
    const r = doc.createRange();
    r.setStart(tail, 1);
    r.collapse(true);
    expect(encodeRange(r, body)).toBe('epubcfi(/4/3:1)');
    // And decoding it lands back on the same node/offset.
    const back = decodeCfi('epubcfi(/4/3:1)', body)!;
    expect(back.startContainer).toBe(tail);
    expect(back.startOffset).toBe(1);
  });
});

describe('markForId / renderedIds', () => {
  it('finds the mark for a rendered id', () => {
    const [s1, e1] = cfiPairFor('Hello');
    renderHighlights(doc, body, [item(101, s1, e1)]);
    expect(markForId(doc, 101)).not.toBeNull();
    expect(markForId(doc, 102)).toBeNull();
  });

  it('lists rendered ids once each, in document order', () => {
    const [s1, e1] = cfiPairFor('Hello wor');
    renderHighlights(doc, body, [item(111, s1, e1)]); // two marks, one id
    expect(renderedIds(doc)).toEqual([111]);
  });
});

describe('onMarkClick', () => {
  it('routes a capture-phase click on a mark to the callback with its id', () => {
    const [s1, e1] = cfiPairFor('Hello');
    renderHighlights(doc, body, [item(121, s1, e1)]);
    const cb = vi.fn();
    const off = onMarkClick(doc, cb);

    const mark = doc.querySelector('mark.vellum-hl')!;
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toBe(121);

    // A click on a descendant of the mark reaches it via closest().
    const inner = doc.createElement('span');
    inner.textContent = 'x';
    mark.appendChild(inner);
    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cb).toHaveBeenCalledTimes(2);

    off();
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cb).toHaveBeenCalledTimes(2); // unsubscribed
  });

  it('ignores clicks outside marks', () => {
    const cb = vi.fn();
    const off = onMarkClick(doc, cb);
    body.querySelector('#p2')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cb).not.toHaveBeenCalled();
    off();
  });

  it('tolerates a bad callback argument', () => {
    expect(() => onMarkClick(doc, null as unknown as () => void)()).not.toThrow();
  });
});

describe('renderHighlights — guards', () => {
  it('counts every item skipped when the root is missing', () => {
    const res = renderHighlights(doc, null as unknown as HTMLElement, [
      item(131, 'epubcfi(/4/1:0)', 'epubcfi(/4/1:2)'),
    ]);
    expect(res).toEqual({ rendered: 0, skipped: 1, marks: 0 });
  });

  it('handles a collapsed (zero-length) range as skipped', () => {
    const res = renderHighlights(doc, body, [item(141, 'epubcfi(/4/1:3)', 'epubcfi(/4/1:3)')]);
    expect(res.rendered).toBe(0);
    expect(res.skipped).toBe(1);
  });
});
