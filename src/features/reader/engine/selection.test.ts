/**
 * §8 F0 — selection sentence extraction and word detection.
 *
 * The sentence field feeds the translate popup and is stored as a vocabulary example (§4.1
 * VocabWord.context), so it has to be a whole, readable sentence for both English and Russian
 * prose — including «guillemet» quotes, the em-dash attribution that follows a quoted
 * question, and the ellipsis terminator.
 *
 * extractSentence/extractWord are pure string functions, which is how they are tested; the
 * DOM-facing readSelection path is exercised separately with a real jsdom Selection.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  extractSentence,
  extractWord,
  onSelectionChange,
  readSelection,
  suppressSelectionFlash,
} from './selection';
import { COMPACT_CHAPTER, mountChapter, RU_PARAGRAPH } from './__fixtures__/chapterDom';

// ---------------------------------------------------------------------------
// sentence extraction
// ---------------------------------------------------------------------------

describe('extractSentence — multi-sentence paragraph', () => {
  const para = 'He went home. She asked why. Nobody answered.';

  it('returns the whole sentence containing a mid-sentence selection', () => {
    expect(extractSentence('asked', para)).toBe('She asked why.');
  });

  it('returns the first sentence when the selection starts the paragraph', () => {
    expect(extractSentence('He went', para)).toBe('He went home.');
  });

  it('returns the last sentence when the selection ends the paragraph', () => {
    expect(extractSentence('Nobody answered', para)).toBe('Nobody answered.');
  });

  it('returns the whole paragraph when the selection spans all sentences', () => {
    expect(extractSentence(para, para)).toBe(para);
  });

  it('spans exactly the sentences a multi-sentence selection covers', () => {
    expect(extractSentence('home. She asked', para)).toBe('He went home. She asked why.');
  });

  it('keeps terminal punctuation attached to its sentence', () => {
    expect(extractSentence('why', para)).toBe('She asked why.');
    // A selection ending on the terminator bounds exactly that sentence.
    expect(extractSentence('She asked why.', para)).toBe('She asked why.');
    expect(extractSentence('B!', 'A. B!')).toBe('B!');
  });

  it('falls back to the selection when the context is empty', () => {
    expect(extractSentence('orphan', '')).toBe('orphan');
    expect(extractSentence('orphan', 'no match here')).toBe('orphan');
  });

  it('returns "" for an empty selection', () => {
    expect(extractSentence('', para)).toBe('');
    expect(extractSentence('   ', para)).toBe('');
  });
});

describe('extractSentence — Cyrillic and Russian punctuation', () => {
  it('handles the fixture paragraph', () => {
    expect(extractSentence('пошёл', RU_PARAGRAPH)).toBe('Он пошёл домой.');
  });

  it('keeps a guillemet quote inside its sentence', () => {
    expect(extractSentence('Правда', RU_PARAGRAPH)).toBe('«Правда?» — спросила она…');
  });

  it('treats the ellipsis as a terminator', () => {
    expect(extractSentence('спросила она', RU_PARAGRAPH)).toBe('«Правда?» — спросила она…');
  });

  it('handles a short exclamation', () => {
    expect(extractSentence('Да', RU_PARAGRAPH)).toBe('Да!');
  });

  it('finds the trailing sentence after the last terminator', () => {
    expect(extractSentence('всё стихло', RU_PARAGRAPH)).toBe('Потом всё стихло.');
  });

  it('matches a selection whose whitespace differs from the context', () => {
    const ctx = 'Первое предложение. Второе   предложение\nс переносом. Третье.';
    expect(extractSentence('Второе предложение с переносом.', ctx))
      .toBe('Второе предложение с переносом.');
  });
});

describe('extractSentence — caps and trimming', () => {
  it('caps the result at 240 chars with an ellipsis', () => {
    const long = `One ${'word '.repeat(120)}`.trim();
    const out = extractSentence('word', long);
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith('…')).toBe(true);
  });

  it('prefers a word boundary when capping', () => {
    const long = `A ${'слово '.repeat(120)}`.trim();
    const out = extractSentence('слово', long);
    expect(out.length).toBeLessThanOrEqual(240);
    // The cut must not land mid-word: the char before the ellipsis is a space-free word end.
    expect(out.slice(0, -1).endsWith(' ')).toBe(false);
  });

  it('leaves a sentence already under the cap untouched', () => {
    const s = 'Короткое предложение.';
    expect(extractSentence('Короткое', s)).toBe(s);
  });

  it('collapses internal whitespace runs', () => {
    expect(extractSentence('two', 'one    two\t\tthree.')).toBe('one two three.');
  });

  it('never returns an empty sentence for a non-empty selection', () => {
    expect(extractSentence('x', '....')).not.toBe('');
  });
});

describe('extractSentence — structural edge cases', () => {
  it('does not treat a decimal point as a terminator', () => {
    // "3.14" has no space after the dot, so the sentence continues.
    expect(extractSentence('pi', 'The value of pi is 3.14 exactly.')).toBe('The value of pi is 3.14 exactly.');
  });

  it('documents the abbreviation limitation (§5.3 bounds are regex-based)', () => {
    // The contract defines sentence bounds as a terminator class plus trailing quotes, with no
    // abbreviation lexicon, so "Dr." reads as a sentence end. A truncated fragment is
    // acceptable for the translate popup; guessing wrong on real sentence ends is not.
    expect(extractSentence('Dr', 'Dr. Smith arrived. He sat down.')).toBe('Dr.');
    // Unambiguous sentence starts still expand correctly.
    expect(extractSentence('Smith', 'Dr. Smith arrived. He sat down.')).toBe('Smith arrived.');
  });

  it('handles a single-sentence context with no terminator', () => {
    expect(extractSentence('punctuation', 'no punctuation at all')).toBe('no punctuation at all');
  });

  it('handles a newline-separated context', () => {
    expect(extractSentence('second', 'first line\nsecond line\nthird line')).toBe('second line');
  });

  it('is idempotent — re-extracting from its own output is stable', () => {
    const once = extractSentence('asked', 'He went home. She asked why. Nobody answered.');
    expect(extractSentence(once, once)).toBe(once);
  });
});

// ---------------------------------------------------------------------------
// word detection
// ---------------------------------------------------------------------------

describe('extractWord', () => {
  it('accepts a single Latin or Cyrillic token', () => {
    expect(extractWord('hello')).toBe('hello');
    expect(extractWord('слово')).toBe('слово');
    expect(extractWord('Ünïcödé')).toBe('Ünïcödé');
  });

  it('accepts intra-word apostrophes and hyphens', () => {
    expect(extractWord("don't")).toBe("don't");
    expect(extractWord('well-known')).toBe('well-known');
    expect(extractWord('тёмно-синий')).toBe('тёмно-синий');
  });

  it('trims surrounding whitespace before testing', () => {
    expect(extractWord('  word  ')).toBe('word');
    expect(extractWord('\nword\n')).toBe('word');
  });

  it('returns undefined for anything that is not one token', () => {
    expect(extractWord('two words')).toBeUndefined();
    expect(extractWord('a b c')).toBeUndefined();
    expect(extractWord('')).toBeUndefined();
    expect(extractWord('   ')).toBeUndefined();
  });

  it('returns undefined for punctuation-bearing selections', () => {
    expect(extractWord('word.')).toBeUndefined();
    expect(extractWord('(word)')).toBeUndefined();
    expect(extractWord('"quoted"')).toBeUndefined();
    expect(extractWord('word!')).toBeUndefined();
  });

  it('returns undefined for digits-only and absurdly long selections', () => {
    expect(extractWord('12345')).toBeUndefined();
    expect(extractWord('x'.repeat(81))).toBeUndefined();
    expect(extractWord('x'.repeat(80))).toBe('x'.repeat(80));
  });

  it('handles a leading/trailing apostrophe as non-word', () => {
    expect(extractWord("'")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// readSelection against a real jsdom Selection
// ---------------------------------------------------------------------------

describe('readSelection', () => {
  let body: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    body = mountChapter(document, COMPACT_CHAPTER);
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
  });

  it('returns null for a collapsed or absent selection', () => {
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    expect(readSelection(document)).toBeNull();

    const r = document.createRange();
    r.setStart(body.querySelector('#p3')!.firstChild!, 2);
    r.collapse(true);
    sel.addRange(r);
    expect(readSelection(document)).toBeNull();
  });

  it('produces text, CFIs, sentence and word for a single-word selection', () => {
    const sel = document.getSelection()!;
    const r = document.createRange();
    const t = body.querySelector('#p3')!.firstChild as Text; // "Last line"
    r.setStart(t, 5);
    r.setEnd(t, 9);
    sel.removeAllRanges();
    sel.addRange(r);

    const info = readSelection(document);
    expect(info).not.toBeNull();
    expect(info!.text).toBe('line');
    expect(info!.word).toBe('line');
    expect(info!.cfiStart).toBe('epubcfi(/10/1:5)');
    expect(info!.cfiEnd).toBe('epubcfi(/10/1:9)');
    expect(info!.sentence).toBe('Last line');
    expect(info!.rect).toBeDefined();
  });

  it('clears the word for a multi-token selection but keeps the sentence', () => {
    const sel = document.getSelection()!;
    const r = document.createRange();
    const t = body.querySelector('#p3')!.firstChild as Text;
    r.setStart(t, 0);
    r.setEnd(t, 9);
    sel.removeAllRanges();
    sel.addRange(r);

    const info = readSelection(document)!;
    expect(info.text).toBe('Last line');
    expect(info.word).toBeUndefined();
    expect(info.sentence).toBe('Last line');
  });

  it('uses the enclosing paragraph as the sentence context', () => {
    const sel = document.getSelection()!;
    const r = document.createRange();
    const t = body.querySelector('#p2')!.firstChild as Text;
    r.setStart(t, 3);
    r.setEnd(t, 8); // "пошёл"
    sel.removeAllRanges();
    sel.addRange(r);

    const info = readSelection(document)!;
    expect(info.text).toBe('пошёл');
    expect(info.sentence).toBe('Он пошёл домой.');
  });

  it('encodes a selection that spans an inline element boundary', () => {
    const sel = document.getSelection()!;
    const p1 = body.querySelector('#p1') as HTMLElement;
    const r = document.createRange();
    r.setStart(p1.childNodes[0] as Text, 2); // "ll|o "
    r.setEnd(p1.childNodes[2] as Text, 3); // " ag|ain"
    sel.removeAllRanges();
    sel.addRange(r);

    const info = readSelection(document)!;
    expect(info.text).toBe('llo world ag');
    expect(info.cfiStart).toBe('epubcfi(/4/1:2)');
    expect(info.cfiEnd).toBe('epubcfi(/4/3:3)');
    expect(info.word).toBeUndefined();
    // The whole selection lives in one <p>, so the sentence is that paragraph.
    expect(info.sentence).toBe('Hello world again');
  });

  it('caps a very large selection at 5000 chars', () => {
    const sel = document.getSelection()!;
    const p = document.createElement('p');
    p.textContent = 'x'.repeat(9000);
    body.appendChild(p);
    const r = document.createRange();
    r.setStart(p.firstChild as Text, 0);
    r.setEnd(p.firstChild as Text, 9000);
    sel.removeAllRanges();
    sel.addRange(r);

    const info = readSelection(document)!;
    expect(info.text.length).toBeLessThanOrEqual(5001);
    expect(info.text.endsWith('…')).toBe(true);
  });

  it('returns null when the body is missing', () => {
    expect(readSelection(null as unknown as Document)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onSelectionChange subscription
// ---------------------------------------------------------------------------

describe('onSelectionChange', () => {
  let body: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    body = mountChapter(document, COMPACT_CHAPTER);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.getSelection()?.removeAllRanges();
  });

  function selectWord(): void {
    const sel = document.getSelection()!;
    const r = document.createRange();
    const t = body.querySelector('#p3')!.firstChild as Text;
    r.setStart(t, 5);
    r.setEnd(t, 9);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  it('delivers the selection after the 80 ms debounce', () => {
    const cb = vi.fn();
    const off = onSelectionChange(document, cb);
    selectWord();
    document.dispatchEvent(new Event('selectionchange'));

    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(79);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]!.text).toBe('line');
    off();
  });

  it('collapses a burst of events into one callback', () => {
    const cb = vi.fn();
    const off = onSelectionChange(document, cb);
    selectWord();
    for (let i = 0; i < 5; i += 1) {
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(20);
    }
    document.dispatchEvent(new MouseEvent('mouseup'));
    document.dispatchEvent(new KeyboardEvent('keyup'));
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);
    off();
  });

  it('delivers null when the selection is cleared', () => {
    const cb = vi.fn();
    const off = onSelectionChange(document, cb);
    selectWord();
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'line' }));

    document.getSelection()!.removeAllRanges();
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenLastCalledWith(null);
    off();
  });

  it('stops firing after unsubscribe, including an already-queued event', () => {
    const cb = vi.fn();
    const off = onSelectionChange(document, cb);
    selectWord();
    document.dispatchEvent(new Event('selectionchange'));
    off();
    vi.advanceTimersByTime(200);
    expect(cb).not.toHaveBeenCalled();
  });

  it('is safe to unsubscribe twice and to subscribe with a bad callback', () => {
    const off = onSelectionChange(document, vi.fn());
    off();
    expect(() => off()).not.toThrow();
    expect(() => onSelectionChange(document, null as unknown as () => void)()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// suppressSelectionFlash
// ---------------------------------------------------------------------------

describe('suppressSelectionFlash', () => {
  beforeEach(() => {
    document.head.innerHTML = '';
  });

  it('injects a ::selection rule using the theme var', () => {
    suppressSelectionFlash(document);
    const style = document.getElementById('vellum-selection-style') as HTMLStyleElement | null;
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('::selection');
    expect(style!.textContent).toContain('--v-page-selection');
  });

  it('is idempotent', () => {
    suppressSelectionFlash(document);
    suppressSelectionFlash(document);
    expect(document.querySelectorAll('#vellum-selection-style').length).toBe(1);
  });

  it('tolerates a missing document', () => {
    expect(() => suppressSelectionFlash(null as unknown as Document)).not.toThrow();
  });
});
