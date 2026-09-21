/**
 * §8 F0 — whitespace-normalized findText across node boundaries, occurrence counting,
 * and the flash mark lifecycle.
 */
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import {
  clearFlashes,
  countOccurrences,
  findText,
  findTextRange,
  flashCfi,
  flashRange,
} from './findtext';
import { mountChapter } from './__fixtures__/chapterDom';
import { decodeCfi } from './cfi';

let doc: Document;
let body: HTMLElement;

beforeEach(() => {
  doc = document;
  doc.body.innerHTML = '';
});

/** The spec's example shape: a phrase split across an inline element. */
function mountSplit(): void {
  body = mountChapter(doc, '<p id="s">one <b>two</b> three</p>');
}

describe('findText — cross-node normalized matching', () => {
  beforeEach(mountSplit);

  it('finds a phrase split across an inline element', () => {
    const hit = findText(doc, 'one two');
    expect(hit).not.toBeNull();
    expect(hit!.cfi).not.toBe('');
  });

  it('returns a Range covering exactly the matched characters', () => {
    const hit = findTextRange(doc, 'one two');
    expect(hit).not.toBeNull();
    expect(hit!.range.toString()).toBe('one two');
  });

  it('finds a match spanning two inline elements', () => {
    const r = findTextRange(doc, 'two three');
    expect(r).not.toBeNull();
    expect(r!.range.toString()).toBe('two three');
  });

  it('finds the whole paragraph text across all boundaries', () => {
    const r = findTextRange(doc, 'one two three');
    expect(r!.range.toString()).toBe('one two three');
  });

  it('collapses whitespace runs in both needle and haystack', () => {
    body = mountChapter(doc, '<p>a \n  spaced\t\tout   phrase</p>');
    const r = findTextRange(doc, 'spaced out phrase');
    expect(r).not.toBeNull();
    expect(r!.range.toString().replace(/\s+/g, ' ')).toBe('spaced out phrase');
  });

  it('is case-insensitive by default (FTS5 snippet re-entry, §7.5)', () => {
    expect(findText(doc, 'ONE TWO')).not.toBeNull();
    expect(findText(doc, 'One Two')).not.toBeNull();
  });

  it('honors caseSensitive when asked', () => {
    expect(findTextRange(doc, 'ONE TWO', 0, { caseSensitive: true })).toBeNull();
    expect(findTextRange(doc, 'one two', 0, { caseSensitive: true })).not.toBeNull();
  });

  it('produces a CFI that decodes back to the same text', () => {
    const hit = findTextRange(doc, 'two three')!;
    const back = decodeCfi(hit.cfi, body);
    expect(back).not.toBeNull();
    expect(back!.startContainer).toBe(hit.range.startContainer);
    expect(back!.startOffset).toBe(hit.range.startOffset);
  });
});

describe('findText — occurrences', () => {
  beforeEach(() => {
    body = mountChapter(doc, '<p>cat cat cat</p><p>dog cat</p>');
  });

  it('finds the first occurrence by default', () => {
    const first = findTextRange(doc, 'cat', 0)!;
    const second = findTextRange(doc, 'cat', 1)!;
    expect(first.range.startOffset).toBeLessThan(second.range.startOffset);
  });

  it('occurrence=1 skips the first match', () => {
    const r0 = findTextRange(doc, 'cat', 0)!;
    const r1 = findTextRange(doc, 'cat', 1)!;
    expect(r0.range.toString()).toBe('cat');
    expect(r1.range.toString()).toBe('cat');
    expect(r1.range.startContainer === r0.range.startContainer && r1.range.startOffset > r0.range.startOffset)
      .toBe(true);
  });

  it('returns null past the last occurrence', () => {
    // "cat cat cat" + "dog cat" = 4 matches, so indices 0..3 resolve and 4 does not.
    expect(findText(doc, 'cat', 3)).not.toBeNull();
    expect(findText(doc, 'cat', 4)).toBeNull();
  });

  it('counts occurrences across paragraphs', () => {
    expect(countOccurrences(doc, 'cat')).toBe(4);
    expect(countOccurrences(doc, 'dog')).toBe(1);
    expect(countOccurrences(doc, 'zebra')).toBe(0);
  });

  it('returns null for no match', () => {
    expect(findText(doc, 'unicorn')).toBeNull();
  });

  it('returns null for an empty or whitespace-only needle', () => {
    expect(findText(doc, '')).toBeNull();
    expect(findText(doc, '   ')).toBeNull();
  });
});

describe('findText — content skipping', () => {
  it('ignores script/style/title text', () => {
    body = mountChapter(doc, '<style>.x{color:red}</style><script>var secret=1;</script><p>visible secret</p>');
    const hit = findTextRange(doc, 'secret');
    expect(hit).not.toBeNull();
    expect(hit!.range.toString()).toBe('secret');
    expect((hit!.range.startContainer as Text).parentNode!.nodeName).not.toBe('SCRIPT');
  });

  it('counts text inside highlight marks exactly once', () => {
    body = mountChapter(doc, '<p>a <mark class="vellum-hl">b c</mark> d</p>');
    expect(countOccurrences(doc, 'b c')).toBe(1);
    expect(findTextRange(doc, 'a b c d')!.range.toString()).toBe('a b c d');
  });
});

describe('findText — CFI accuracy', () => {
  beforeEach(mountSplit);

  it('gives the start of the match a stable point CFI', () => {
    const hit = findTextRange(doc, 'two')!;
    expect(hit.cfi).toMatch(/^epubcfi\(/);
    // "two" lives in the <b> at /2 of the <p> at /2 of body.
    expect(hit.cfi).toContain('/2/2/1');
  });

  it('returns a zero rect under jsdom (no layout) without throwing', () => {
    const hit = findText(doc, 'one two')!;
    expect(hit.rect).toBeDefined();
    expect(hit.rect.x).toBe(0);
  });
});

describe('flashRange', () => {
  beforeEach(mountSplit);

  it('wraps the matched slice in a mark.vellum-flash', () => {
    const hit = findTextRange(doc, 'two')!;
    flashRange(doc, hit.range, 1200);
    expect(doc.querySelectorAll('mark.vellum-flash').length).toBeGreaterThan(0);
  });

  it('removes the flash after the timeout', () => {
    vi.useFakeTimers();
    try {
      const hit = findTextRange(doc, 'one two')!;
      flashRange(doc, hit.range, 1000);
      expect(doc.querySelectorAll('mark.vellum-flash').length).toBeGreaterThan(0);
      vi.advanceTimersByTime(1001);
      expect(doc.querySelectorAll('mark.vellum-flash').length).toBe(0);
      // The underlying text is untouched.
      expect(doc.querySelector('#s')!.textContent).toBe('one two three');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearFlashes removes marks immediately and restores text', () => {
    const hit = findTextRange(doc, 'one two')!;
    flashRange(doc, hit.range, 60000);
    expect(doc.querySelectorAll('mark.vellum-flash').length).toBeGreaterThan(0);
    clearFlashes(doc);
    expect(doc.querySelectorAll('mark.vellum-flash').length).toBe(0);
    expect(doc.querySelector('#s')!.textContent).toBe('one two three');
  });

  it('a zero duration clears instead of scheduling', () => {
    const hit = findTextRange(doc, 'two')!;
    flashRange(doc, hit.range, 0);
    expect(doc.querySelectorAll('mark.vellum-flash').length).toBe(0);
  });

  it('tolerates a null range without throwing', () => {
    expect(() => flashRange(doc, null as unknown as Range)).not.toThrow();
  });
});

afterEach(() => {
  clearFlashes(doc);
});

describe('flashCfi', () => {
  beforeEach(mountSplit);

  it('flashes the text covered by a resolvable range CFI', () => {
    // "one " — the <p>'s leading chunk.
    expect(flashCfi(doc, 'epubcfi(/2,/1:0,/1:4)', 1200)).toBe(true);
    const marks = Array.from(doc.querySelectorAll('mark.vellum-flash'));
    expect(marks.map((m) => m.textContent).join('')).toBe('one ');
  });

  it('flashes a range spanning an element boundary', () => {
    // From the <p>'s leading chunk into the <b>, i.e. "one two".
    expect(flashCfi(doc, 'epubcfi(/2,/1:0,/2/1:3)')).toBe(true);
    const marks = Array.from(doc.querySelectorAll('mark.vellum-flash'));
    expect(marks.map((m) => m.textContent).join('')).toBe('one two');
  });

  it('returns false for an unresolvable CFI and leaves the DOM alone', () => {
    expect(flashCfi(doc, 'epubcfi(/99/1:0)')).toBe(false);
    expect(doc.querySelectorAll('mark.vellum-flash').length).toBe(0);
  });

  it('returns false for empty input and a null document', () => {
    expect(flashCfi(doc, '')).toBe(false);
    expect(flashCfi(null as unknown as Document, 'epubcfi(/2/1:0)')).toBe(false);
  });

  it('expands a collapsed point CFI so a bookmark jump flashes something', () => {
    // Bookmark.cfi is a point CFI (§4.1), which addresses zero characters. Expanding it to the
    // end of its sentence is what makes a bookmark jump visibly confirm itself.
    body = mountChapter(doc, '<p id="s">One sentence here. Then another.</p>');
    expect(flashCfi(doc, 'epubcfi(/2/1:1)')).toBe(true);
    const marks = Array.from(doc.querySelectorAll('mark.vellum-flash'));
    // From offset 1 of "One sentence here. " to the terminator: "ne sentence here."
    expect(marks.map((m) => m.textContent).join('')).toBe('ne sentence here.');
  });

  it('expands across an inline element inside the same sentence', () => {
    expect(flashCfi(doc, 'epubcfi(/2/1:1)')).toBe(true);
    const marks = Array.from(doc.querySelectorAll('mark.vellum-flash'));
    // "one <b>two</b> three" has no terminator, so the expansion runs to the end of the block.
    expect(marks.map((m) => m.textContent).join('')).toBe('ne two three');
  });

  it('returns false when a point CFI cannot be expanded', () => {
    body = mountChapter(doc, '<p id="s"></p>');
    expect(flashCfi(doc, 'epubcfi(/2)')).toBe(false);
    expect(doc.querySelectorAll('mark.vellum-flash').length).toBe(0);
  });

  it('the flash is removable via clearFlashes, restoring text', () => {
    flashCfi(doc, 'epubcfi(/2,/1:0,/1:4)', 60000);
    clearFlashes(doc);
    expect(doc.querySelectorAll('mark.vellum-flash').length).toBe(0);
    expect(doc.querySelector('#s')!.textContent).toBe('one two three');
  });

  it('times out on its own', () => {
    vi.useFakeTimers();
    try {
      flashCfi(doc, 'epubcfi(/2,/1:0,/1:4)', 500);
      expect(doc.querySelectorAll('mark.vellum-flash').length).toBeGreaterThan(0);
      vi.advanceTimersByTime(501);
      expect(doc.querySelectorAll('mark.vellum-flash').length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
