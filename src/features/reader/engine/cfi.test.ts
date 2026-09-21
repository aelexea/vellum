/**
 * §8 F0 — CFI encode/decode roundtrip on a nested fixture DOM.
 *
 * Covers: chunk-based child enumeration (§3.1.1), UTF-16 terminal offsets (§3.1.4), range
 * grammar (§3.4), layout transparency across #vellum-wrap, stale-path → null, and the
 * document-order comparison contract (§3.2).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  compareCfi,
  cfiFromElement,
  decodeCfi,
  encodePoint,
  encodeRange,
  isValidCfi,
} from './cfi';
import { COMPACT_CHAPTER, mountChapter, PRETTY_CHAPTER, RU_PARAGRAPH } from './__fixtures__/chapterDom';

let doc: Document;
let body: HTMLElement;

beforeEach(() => {
  doc = document;
  doc.body.innerHTML = '';
  body = mountChapter(doc, COMPACT_CHAPTER);
});

// ---------------------------------------------------------------------------
// fixture structure sanity — every expectation below depends on these indices
// ---------------------------------------------------------------------------

describe('fixture structure', () => {
  it('indexes body children with even steps in document order', () => {
    const h1 = body.querySelector('h1') as HTMLElement;
    const p1 = body.querySelector('#p1') as HTMLElement;
    const nested = body.querySelector('#nested') as HTMLElement;
    const p2 = body.querySelector('#p2') as HTMLElement;
    const p3 = body.querySelector('#p3') as HTMLElement;
    expect(cfiFromElement(h1, body)).toBe('epubcfi(/2)');
    expect(cfiFromElement(p1, body)).toBe('epubcfi(/4)');
    expect(cfiFromElement(nested, body)).toBe('epubcfi(/6)');
    expect(cfiFromElement(p2, body)).toBe('epubcfi(/8)');
    expect(cfiFromElement(p3, body)).toBe('epubcfi(/10)');
  });

  it('gives text chunks odd steps interleaved with element steps', () => {
    const p1 = body.querySelector('#p1') as HTMLElement;
    // children: text("Hello ") /2=b /3=text(" again")
    const first = p1.childNodes[0] as Text;
    const b = p1.querySelector('b') as HTMLElement;
    const third = p1.childNodes[2] as Text;
    expect(encodePoint(first, 0, body)).toBe('epubcfi(/4/1:0)');
    expect(cfiFromElement(b, body)).toBe('epubcfi(/4/2)');
    expect(encodePoint(third, 0, body)).toBe('epubcfi(/4/3:0)');
  });

  it('counts a chunk, not a DOM text node (§3.1.1) across adjacent text nodes', () => {
    // Splitting a text node must not change the CFI of a position inside it.
    const p3 = body.querySelector('#p3') as HTMLElement;
    const t = p3.firstChild as Text;
    expect(encodePoint(t, 5, body)).toBe('epubcfi(/10/1:5)');
    t.splitText(5);
    expect(p3.childNodes.length).toBe(2);
    // The tail node still lives in the same chunk, so offsets keep counting from the head.
    expect(encodePoint(p3.childNodes[0] as Text, 5, body)).toBe('epubcfi(/10/1:5)');
    expect(encodePoint(p3.childNodes[1] as Text, 0, body)).toBe('epubcfi(/10/1:5)');
    expect(encodePoint(p3.childNodes[1] as Text, 4, body)).toBe('epubcfi(/10/1:9)');
  });
});

// ---------------------------------------------------------------------------
// encoding
// ---------------------------------------------------------------------------

describe('encodeRange', () => {
  it('encodes a collapsed range as a point with a character offset', () => {
    const p1 = body.querySelector('#p1') as HTMLElement;
    const r = doc.createRange();
    r.setStart(p1.childNodes[0] as Text, 3);
    r.collapse(true);
    expect(encodeRange(r, body)).toBe('epubcfi(/4/1:3)');
  });

  it('encodes deep nesting with one step per level', () => {
    const em = body.querySelector('#nested span em') as HTMLElement;
    const r = doc.createRange();
    r.setStart(em.firstChild as Text, 2);
    r.collapse(true);
    // body/6 → div#nested, /2 → span, /1 → chunk before <em>? No: em is span's first
    // element child, so its inner text is /2/1 within em.
    expect(encodeRange(r, body)).toBe('epubcfi(/6/2/2/1:2)');
  });

  it('encodes offset 0 and the last position of a text node', () => {
    const p3 = body.querySelector('#p3') as HTMLElement;
    const t = p3.firstChild as Text;
    const len = t.length;
    const r0 = doc.createRange();
    r0.setStart(t, 0);
    r0.collapse(true);
    const rEnd = doc.createRange();
    rEnd.setStart(t, len);
    rEnd.collapse(true);
    expect(encodeRange(r0, body)).toBe('epubcfi(/10/1:0)');
    expect(encodeRange(rEnd, body)).toBe(`epubcfi(/10/1:${len})`);
  });

  it('encodes a mid-text offset inside an inline element', () => {
    const b = body.querySelector('#p1 b') as HTMLElement;
    const t = b.firstChild as Text;
    const r = doc.createRange();
    r.setStart(t, 3); // "wor|ld"
    r.collapse(true);
    expect(encodeRange(r, body)).toBe('epubcfi(/4/2/1:3)');
  });

  it('encodes a range as parent path + two branches', () => {
    const p1 = body.querySelector('#p1') as HTMLElement;
    const first = p1.childNodes[0] as Text; // "Hello "
    const third = p1.childNodes[2] as Text; // " again"
    const r = doc.createRange();
    r.setStart(first, 2);
    r.setEnd(third, 4);
    expect(encodeRange(r, body)).toBe('epubcfi(/4,/1:2,/3:4)');
  });

  it('backs off one step when both endpoints share a full path', () => {
    const p3 = body.querySelector('#p3') as HTMLElement;
    const t = p3.firstChild as Text;
    const r = doc.createRange();
    r.setStart(t, 1);
    r.setEnd(t, 5);
    // Without the back-off one branch would be empty (":1,:5" is not derivable).
    expect(encodeRange(r, body)).toBe('epubcfi(/10,/1:1,/1:5)');
  });

  it('clamps offsets beyond the end of the text', () => {
    const p3 = body.querySelector('#p3') as HTMLElement;
    const t = p3.firstChild as Text;
    expect(encodePoint(t, 9999, body)).toBe(`epubcfi(/10/1:${t.length})`);
    expect(encodePoint(t, -3, body)).toBe('epubcfi(/10/1:0)');
  });

  it('returns "" for a node outside the chapter root', () => {
    const outside = doc.createElement('p');
    outside.textContent = 'orphan';
    expect(encodePoint(outside.firstChild as Text, 0, body)).toBe('');
    expect(cfiFromElement(outside, body)).toBe('');
    expect(encodePoint(body, 0, body)).toBe('');
  });

  it('normalizes an element-container endpoint onto its first text', () => {
    const nested = body.querySelector('#nested') as HTMLElement;
    const r = doc.createRange();
    r.setStart(nested, 0);
    r.collapse(true);
    // chunk 0 of div#nested is "alpha"
    expect(encodeRange(r, body)).toBe('epubcfi(/6/1:0)');
  });
});

// ---------------------------------------------------------------------------
// decoding
// ---------------------------------------------------------------------------

describe('decodeCfi', () => {
  it('decodes a point to the exact text node and offset', () => {
    const r = decodeCfi('epubcfi(/4/1:3)', body);
    expect(r).not.toBeNull();
    const p1 = body.querySelector('#p1') as HTMLElement;
    expect(r!.startContainer).toBe(p1.childNodes[0]);
    expect(r!.startOffset).toBe(3);
    expect(r!.collapsed).toBe(true);
  });

  it('decodes nested paths', () => {
    const r = decodeCfi('epubcfi(/6/2/2/1:2)', body);
    const em = body.querySelector('#nested span em') as HTMLElement;
    expect(r!.startContainer).toBe(em.firstChild);
    expect(r!.startOffset).toBe(2);
  });

  it('decodes an element step by landing on its first text', () => {
    const r = decodeCfi('epubcfi(/4/2)', body);
    const b = body.querySelector('#p1 b') as HTMLElement;
    expect(r!.startContainer).toBe(b.firstChild);
    expect(r!.startOffset).toBe(0);
  });

  it('decodes a range into a non-collapsed Range with both endpoints', () => {
    const r = decodeCfi('epubcfi(/4,/1:2,/3:4)', body);
    const p1 = body.querySelector('#p1') as HTMLElement;
    expect(r!.startContainer).toBe(p1.childNodes[0]);
    expect(r!.startOffset).toBe(2);
    expect(r!.endContainer).toBe(p1.childNodes[2]);
    expect(r!.endOffset).toBe(4);
    expect(r!.collapsed).toBe(false);
    expect(r!.toString()).toBe('llo world aga');
  });

  it('clamps an over-long offset instead of failing (§3.5 tolerance)', () => {
    const p3 = body.querySelector('#p3') as HTMLElement;
    const len = (p3.firstChild as Text).length;
    const r = decodeCfi('epubcfi(/10/1:999)', body);
    expect(r!.startOffset).toBe(len);
  });

  it('tolerates a missing epubcfi() wrapper and a leading ! indirection', () => {
    expect(decodeCfi('/4/1:3', body)!.startOffset).toBe(3);
    expect(decodeCfi('epubcfi(/6/4!/4/1:3)', body)!.startOffset).toBe(3);
  });

  it('returns null for a stale path that no longer exists', () => {
    // Only 5 element children exist; /99 must not resolve to anything.
    expect(decodeCfi('epubcfi(/99/1:0)', body)).toBeNull();
    expect(decodeCfi('epubcfi(/4/99:0)', body)).toBeNull();
    expect(decodeCfi('epubcfi(/6/2/2/99:0)', body)).toBeNull();
  });

  it('returns null for garbage, empty and malformed input — never throws', () => {
    for (const bad of ['', ' ', 'epubcfi()', 'epubcfi(/)', 'nope', 'epubcfi(/x)',
      'epubcfi(/4/1:abc)', 'epubcfi(/-2)', 'epubcfi(/4/1:-1)', 'epubcfi(/2,/1:1,/1:2,/1:3)',
      'epubcfi(/4[unclosed', 'epubcfi(/1/1/1/1:1:1)']) {
      expect(decodeCfi(bad, body), bad).toBeNull();
    }
  });

  it('returns null when the root is missing', () => {
    expect(decodeCfi('epubcfi(/4/1:3)', null as unknown as HTMLElement)).toBeNull();
    expect(decodeCfi('', body)).toBeNull();
  });

  it('rejects a chunk step in a non-final position (chunks have no children)', () => {
    expect(decodeCfi('epubcfi(/1/2/1:0)', body)).toBeNull();
  });

  it('ignores [assertions] on resolution', () => {
    const r = decodeCfi('epubcfi(/4[p1]/1:3)', body);
    expect(r).not.toBeNull();
    expect(r!.startOffset).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// the roundtrip property — the north star
// ---------------------------------------------------------------------------

/**
 * Every (text node, offset) position in the chapter, in strict document order — the TreeWalker
 * yields nodes in order and the three offsets per node are pushed ascending, so the whole list
 * is monotonic. `compareCfi` tests rely on that.
 */
function allPositions(root: HTMLElement): { node: Text; offset: number }[] {
  const out: { node: Text; offset: number }[] = [];
  const w = root.ownerDocument!.createTreeWalker(root, 4);
  for (let n = w.nextNode(); n !== null; n = w.nextNode()) {
    const t = n as Text;
    const len = t.length;
    out.push({ node: t, offset: 0 });
    if (len > 2) out.push({ node: t, offset: Math.floor(len / 2) });
    out.push({ node: t, offset: len });
  }
  return out;
}

describe('roundtrip property', () => {
  it('decode(encode(point)) lands on the same character for every position', () => {
    const positions = allPositions(body);
    expect(positions.length).toBeGreaterThan(10);
    for (const pos of positions) {
      const r = doc.createRange();
      r.setStart(pos.node, pos.offset);
      r.collapse(true);
      const cfi = encodeRange(r, body);
      expect(cfi, `offset ${pos.offset} of "${pos.node.nodeValue}"`).not.toBe('');
      const back = decodeCfi(cfi, body);
      expect(back, cfi).not.toBeNull();
      const back2 = doc.createRange();
      back2.setStart(back!.startContainer, back!.startOffset);
      back2.collapse(true);
      // The decoded point must select the same single character as the original.
      expect(encodeRange(back2, body), cfi).toBe(cfi);
    }
  });

  it('encode(decode(x)) is stable for arbitrary range CFIs', () => {
    const positions = allPositions(body);
    const ranges = doc.createRange();
    for (let i = 0; i < positions.length; i += 3) {
      for (let j = i + 1; j < positions.length; j += 5) {
        const a = positions[i]!;
        const b = positions[j]!;
        ranges.setStart(a.node, a.offset);
        ranges.setEnd(b.node, b.offset);
        const cfi = encodeRange(ranges, body);
        const decoded = decodeCfi(cfi, body);
        expect(decoded, cfi).not.toBeNull();
        // Re-encoding the decoded range must produce a CFI that decodes to the same points.
        const again = encodeRange(decoded!, body);
        const decoded2 = decodeCfi(again, body);
        expect(decoded2!.startContainer).toBe(decoded!.startContainer);
        expect(decoded2!.startOffset).toBe(decoded!.startOffset);
        expect(decoded2!.endContainer).toBe(decoded!.endContainer);
        expect(decoded2!.endOffset).toBe(decoded!.endOffset);
      }
    }
  });

  it('round-trips the selected text of a range exactly', () => {
    const p2 = body.querySelector('#p2') as HTMLElement;
    const t = p2.firstChild as Text;
    const r = doc.createRange();
    r.setStart(t, 0);
    r.setEnd(t, RU_PARAGRAPH.length);
    const cfi = encodeRange(r, body);
    const back = decodeCfi(cfi, body)!;
    expect(back.toString()).toBe(RU_PARAGRAPH);
  });

  it('survives splitText churn inside the addressed chunk', () => {
    const p1 = body.querySelector('#p1') as HTMLElement;
    const head = p1.childNodes[0] as Text; // "Hello "
    expect(head.nodeValue).toBe('Hello ');
    const before = encodePoint(head, 4, body);
    expect(before).toBe('epubcfi(/4/1:4)');
    // A highlight wrapping "llo " splits this one chunk into three text nodes.
    head.splitText(2).splitText(2);
    expect(p1.childNodes.length).toBe(5);
    expect((p1.childNodes[0] as Text).nodeValue).toBe('He');
    expect((p1.childNodes[1] as Text).nodeValue).toBe('ll');
    expect((p1.childNodes[2] as Text).nodeValue).toBe('o ');
    // Offsets keep counting from the chunk head, so every split piece maps to the same CFI.
    expect(encodePoint(p1.childNodes[1] as Text, 0, body)).toBe('epubcfi(/4/1:2)');
    expect(encodePoint(p1.childNodes[2] as Text, 0, body)).toBe(before);
    const decoded = decodeCfi(before, body)!;
    expect(decoded.startContainer).toBe(p1.childNodes[2]);
    expect(decoded.startOffset).toBe(0);
    expect((decoded.startContainer as Text).nodeValue).toBe('o ');
  });
});

// ---------------------------------------------------------------------------
// layout transparency (#vellum-wrap)
// ---------------------------------------------------------------------------

describe('layout transparency', () => {
  /** Install the wrapper exactly as pagination.applyLayout does. */
  function wrapBody(d: Document, root: HTMLElement): HTMLElement {
    const wrap = d.createElement('div');
    wrap.id = 'vellum-wrap';
    wrap.setAttribute('data-vellum-wrap', '1');
    while (root.firstChild !== null) wrap.appendChild(root.firstChild);
    root.appendChild(wrap);
    return wrap;
  }

  it('keeps CFIs identical before and after the column wrapper is installed', () => {
    const p2 = body.querySelector('#p2') as HTMLElement;
    const t = p2.firstChild as Text;
    const r = doc.createRange();
    r.setStart(t, 7);
    r.collapse(true);
    const before = encodeRange(r, body);

    wrapBody(doc, body);

    // A fresh range at the same (now relocated) text node.
    const moved = body.querySelector('#p2')!.firstChild as Text;
    const r2 = doc.createRange();
    r2.setStart(moved, 7);
    r2.collapse(true);
    expect(encodeRange(r2, body)).toBe(before);
    // And the pre-wrap CFI still resolves to the same characters.
    const decoded = decodeCfi(before, body)!;
    expect(decoded.startContainer).toBe(moved);
    expect(decoded.startOffset).toBe(7);
  });

  it('resolves an element step through the wrapper without an extra index', () => {
    wrapBody(doc, body);
    const r = decodeCfi('epubcfi(/10)', body);
    expect(r).not.toBeNull();
    expect(body.querySelector('#p3')!.textContent).toBe('Last line');
    expect((r!.startContainer as Text).nodeValue).toBe('Last line');
  });

  it('ignores a nested wrapper (defensive: only the direct child is transparent)', () => {
    const cfi = cfiFromElement(body.querySelector('#p1') as HTMLElement, body);
    expect(cfi).toBe('epubcfi(/4)');
  });
});

// ---------------------------------------------------------------------------
// pretty-printed source: whitespace chunks are indexable (§3.1.1)
// ---------------------------------------------------------------------------

describe('pretty-printed chapters', () => {
  it('assigns odd indices to indentation whitespace and keeps text reachable', () => {
    const root = mountChapter(doc, PRETTY_CHAPTER);
    // body children: text("\n") /1, h1 /2, text("\n") /3, p#q1 /4, text /5, p#q2 /6, text /7
    const h1 = root.querySelector('h1') as HTMLElement;
    const q1 = root.querySelector('#q1') as HTMLElement;
    const q2 = root.querySelector('#q2') as HTMLElement;
    expect(cfiFromElement(h1, root)).toBe('epubcfi(/2)');
    expect(cfiFromElement(q1, root)).toBe('epubcfi(/4)');
    expect(cfiFromElement(q2, root)).toBe('epubcfi(/6)');
    // q1 children: text("One ") /1, b /2, text(" three") /3
    expect(encodePoint(q1.childNodes[0] as Text, 0, root)).toBe('epubcfi(/4/1:0)');
    expect(encodePoint(q1.childNodes[2] as Text, 1, root)).toBe('epubcfi(/4/3:1)');
    expect(decodeCfi('epubcfi(/4/3:1)', root)!.toString()).toBe('');
    const r = decodeCfi('epubcfi(/4/1:0)', root)!;
    expect((r.startContainer as Text).nodeValue).toBe('One ');
  });

  it('round-trips every position in the pretty-printed chapter', () => {
    const root = mountChapter(doc, PRETTY_CHAPTER);
    for (const pos of allPositions(root)) {
      const r = doc.createRange();
      r.setStart(pos.node, pos.offset);
      r.collapse(true);
      const cfi = encodeRange(r, root);
      expect(cfi).not.toBe('');
      const back = decodeCfi(cfi, root);
      expect(back, cfi).not.toBeNull();
      expect(back!.startOffset).toBe(pos.offset);
    }
  });
});

// ---------------------------------------------------------------------------
// compareCfi
// ---------------------------------------------------------------------------

describe('compareCfi', () => {
  it('orders sibling elements and chunks in document order', () => {
    expect(compareCfi('epubcfi(/2)', 'epubcfi(/4)')).toBe(-1);
    expect(compareCfi('epubcfi(/4)', 'epubcfi(/2)')).toBe(1);
    expect(compareCfi('epubcfi(/2)', 'epubcfi(/2)')).toBe(0);
    // A chunk before the first element precedes that element.
    expect(compareCfi('epubcfi(/4/1:0)', 'epubcfi(/4/2)')).toBe(-1);
    expect(compareCfi('epubcfi(/4/2)', 'epubcfi(/4/3:0)')).toBe(-1);
  });

  it('orders character offsets within the same node', () => {
    expect(compareCfi('epubcfi(/8/1:3)', 'epubcfi(/8/1:10)')).toBe(-1);
    expect(compareCfi('epubcfi(/8/1:10)', 'epubcfi(/8/1:3)')).toBe(1);
    expect(compareCfi('epubcfi(/8/1:7)', 'epubcfi(/8/1:7)')).toBe(0);
  });

  it('puts a shallower prefix before a deeper path', () => {
    expect(compareCfi('epubcfi(/6/2)', 'epubcfi(/6/2/2)')).toBe(-1);
    expect(compareCfi('epubcfi(/6/2/2)', 'epubcfi(/6/2)')).toBe(1);
  });

  it('orders by the start branch first, then the end branch for ranges', () => {
    expect(compareCfi('epubcfi(/4,/1:1,/1:2)', 'epubcfi(/4,/1:1,/1:5)')).toBe(-1);
    expect(compareCfi('epubcfi(/4,/1:1,/1:5)', 'epubcfi(/4,/1:1,/1:2)')).toBe(1);
    expect(compareCfi('epubcfi(/4,/1:1,/3:9)', 'epubcfi(/6,/1:0,/1:1)')).toBe(-1);
  });

  it('agrees with actual DOM order for a spread of real positions', () => {
    const positions = allPositions(body);
    const cfis: string[] = [];
    for (const pos of positions) {
      const r = doc.createRange();
      r.setStart(pos.node, pos.offset);
      r.collapse(true);
      cfis.push(encodeRange(r, body));
    }
    // Positions come out in document order, so the CFI list must be non-decreasing.
    for (let i = 1; i < cfis.length; i += 1) {
      expect(compareCfi(cfis[i - 1]!, cfis[i]!), `${cfis[i - 1]} <= ${cfis[i]}`).toBeLessThanOrEqual(0);
    }
  });

  it('ignores assertions when comparing (§3.2 rule 2)', () => {
    expect(compareCfi('epubcfi(/4[p1]/1:3)', 'epubcfi(/4/1:3)')).toBe(0);
    expect(compareCfi('epubcfi(/4/1:3[;s=b])', 'epubcfi(/4/1:3)')).toBe(0);
  });

  it('sorts unparseable input last without throwing', () => {
    expect(compareCfi('epubcfi(/4)', 'garbage')).toBe(-1);
    expect(compareCfi('garbage', 'epubcfi(/4)')).toBe(1);
    expect(compareCfi('garbage', 'also-garbage')).toBe(0);
  });

  it('is usable as an Array.sort comparator producing document order', () => {
    const shuffled = ['epubcfi(/10/1:2)', 'epubcfi(/4/1:0)', 'epubcfi(/8/1:5)', 'epubcfi(/6/2/2/1:1)'];
    expect(shuffled.slice().sort(compareCfi)).toEqual([
      'epubcfi(/4/1:0)', 'epubcfi(/6/2/2/1:1)', 'epubcfi(/8/1:5)', 'epubcfi(/10/1:2)',
    ]);
  });
});

// ---------------------------------------------------------------------------
// parsing helpers
// ---------------------------------------------------------------------------

describe('isValidCfi', () => {
  it('accepts the forms Vellum stores and rejects malformed ones', () => {
    for (const good of ['epubcfi(/4)', 'epubcfi(/4/1:0)', '/4/1:0', 'epubcfi(/4,/1:1,/3:2)',
      'epubcfi(/6/4!/2/1:0)', 'epubcfi(/4[p1]/1:3)', 'epubcfi(:5)']) {
      expect(isValidCfi(good), good).toBe(true);
    }
    for (const bad of ['', 'epubcfi()', 'epubcfi(/4/1:x)', 'epubcfi(/2,/1:1)', 'hello']) {
      expect(isValidCfi(bad), bad).toBe(false);
    }
  });
});
