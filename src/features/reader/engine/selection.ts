/**
 * Text selection tracking — signatures FROZEN per ARCHITECTURE.md §5.3; bodies owned by [F0].
 *
 * Emits a {@link SelectionInfo} (or null to clear) whenever the chapter's selection settles,
 * debounced 80 ms across `selectionchange` (the authoritative event) plus `mouseup`/`keyup`
 * (which fire before selectionchange in some WebKit builds, and also cover the case where the
 * selection was cleared by a plain click).
 *
 * The sentence field expands the selection to the enclosing sentence of the paragraph it lives
 * in — that is what the translate popup shows and what gets stored as a vocabulary example, so
 * it must be a whole, readable sentence: Russian «…» quotes, guillemets, trailing punctuation
 * and closing brackets all stay inside the sentence, and a selection mid-sentence grows to
 * cover it.
 */
import { encodeRange } from './cfi';
import { firstClientRect, zeroDomRect } from './pagination';

export interface SelectionInfo {
  text: string;
  cfiStart: string;
  cfiEnd: string;
  /** Viewport px rect within the iframe. */
  rect: DOMRect;
  /** Enclosing sentence, ≤ 240 chars. */
  sentence: string;
  /** The selected token when the selection is a single word. */
  word: string | undefined;
}

/** Hard caps from §5.3. */
const MAX_TEXT = 5000;
const MAX_SENTENCE = 240;
const DEBOUNCE_MS = 80;

/** A single word: letters/marks plus intra-word apostrophes, hyphens and soft hyphens. */
const WORD_RE = /^[\p{L}\p{M}'’ʼ-]+$/u;

/** Closing punctuation that must stay attached to the sentence it terminates. */
const CLOSERS = '»”"\'’)\\]}›—–-';
/**
 * One sentence terminator. A period does NOT terminate when a digit follows, so decimals and
 * measurements ("3.14", "1.5 см") never split a sentence. Newlines terminate too, so
 * hard-wrapped source cannot yield a 4000-char "sentence".
 */
const TERMINATOR = '(?:\\.(?!\\d)|[!?…\\n])';
/** Terminators plus any closing quotes/brackets and the whitespace up to the next sentence. */
const SENTENCE_END = new RegExp(`${TERMINATOR}+[${CLOSERS}]*\\s*`, 'g');
/**
 * A dash leading the text after a terminator means the sentence continues: the Russian
 * attribution construction «Правда?» — спросила она… is one orthographic sentence, and dropping
 * the quote would hand the translator a fragment.
 */
const DASH_LEAD = /^[—–-]\s/;

export function extractWord(text: string): string | undefined {
  const t = (text ?? '').trim();
  if (t.length === 0 || t.length > 80) return undefined;
  // Multiple tokens (including any internal space) → not a single word.
  if (/\s/.test(t)) return undefined;
  if (!WORD_RE.test(t)) return undefined;
  // WORD_RE allows intra-word apostrophes/hyphens, so a bare "'" or "-" would pass; a word has
  // to contain at least one letter or combining mark, otherwise "В словарь" would get a
  // punctuation-only token.
  return /[\p{L}\p{M}]/u.test(t) ? t : undefined;
}

/**
 * Expand `selText` to the sentence(s) around it inside `context`.
 * Pure string function — exported so it can be unit-tested without a selection.
 *
 * Strategy: find the selection inside the context (exact, then whitespace-insensitive), then
 * walk backwards to the previous terminator and forwards to the next one, keeping closing
 * punctuation attached. Always returns a non-empty string (falls back to the selection).
 */
export function extractSentence(selText: string, context: string): string {
  const sel = (selText ?? '').trim();
  const ctx = context ?? '';
  if (sel.length === 0) return '';
  if (ctx.length === 0) return cap(sel);

  const span = locateSpan(sel, ctx);
  // The selection is not in the context at all (stale paragraph, or the caller passed a
  // different root): the selection itself is the best sentence available.
  if (span === null) return cap(sel);

  const bounds = sentenceBoundaries(ctx);
  const start = sentenceStart(ctx, span[0], bounds);
  const end = sentenceEnd(ctx, span[1], bounds);
  const out = ctx.slice(start, end).trim();
  return cap(out.length > 0 ? out : sel);
}

/** Collapse a whitespace run to a single space, for tolerant matching. */
function squash(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/** [start, end) of `sel` inside `ctx`, tolerant of whitespace differences. */
function locateSpan(sel: string, ctx: string): [number, number] | null {
  const exact = ctx.indexOf(sel);
  if (exact !== -1) return [exact, exact + sel.length];

  const flat = squash(sel);
  if (flat.length === 0) return null;
  // Character-wise scan mapping normalized positions back to raw offsets.
  const rawOf: number[] = [];
  let norm = '';
  let lastWasSpace = true;
  for (let i = 0; i < ctx.length; i += 1) {
    const ch = ctx[i] as string;
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        norm += ' ';
        rawOf.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    lastWasSpace = false;
    norm += ch;
    rawOf.push(i);
  }
  const at = norm.indexOf(flat);
  if (at === -1) return null;
  const firstRaw = rawOf[at] ?? 0;
  const lastIdx = at + flat.length - 1;
  const lastRaw = rawOf[lastIdx] ?? firstRaw;
  return [firstRaw, Math.min(ctx.length, lastRaw + 1)];
}

/**
 * Every position in `ctx` where a sentence genuinely ends — i.e. just after a terminator plus
 * its closing quotes and trailing whitespace. A terminator followed by a dash is skipped: that
 * is the Russian attribution construction, still one sentence.
 *
 * One shared list serves both directions, so expanding a selection outwards is consistent with
 * walking back from it, and a boundary exactly at the selection edge is honored (the common
 * case when the user selects a whole sentence).
 */
function sentenceBoundaries(ctx: string): number[] {
  const out: number[] = [];
  const re = new RegExp(SENTENCE_END.source, 'g');
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(ctx)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex += 1; // never spin on a zero-length match
      continue;
    }
    const end = m.index + m[0].length;
    if (!DASH_LEAD.test(ctx.slice(end))) out.push(end);
  }
  return out;
}

/** Index just after the terminator that ends the previous sentence. */
function sentenceStart(ctx: string, from: number, bounds: number[]): number {
  const limit = Math.max(0, Math.min(from, ctx.length));
  let start = 0;
  for (const b of bounds) {
    if (b > limit) break;
    start = b;
  }
  return start;
}

/** Index just past the terminator that closes this sentence. */
function sentenceEnd(ctx: string, from: number, bounds: number[]): number {
  const at = Math.max(0, Math.min(from, ctx.length));
  for (const b of bounds) {
    if (b >= at) return b;
  }
  return ctx.length;
}

function cap(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= MAX_SENTENCE) return t;
  // Cut on a word boundary when possible so the cap never lands mid-word.
  const cut = t.slice(0, MAX_SENTENCE);
  const lastSpace = cut.lastIndexOf(' ');
  const head = lastSpace > MAX_SENTENCE * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

/** Plain text of the block containing `node`, used as the sentence context. */
function sentenceContext(node: Node, doc: Document): string {
  let el: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
  const BLOCK = /^(p|div|li|blockquote|h[1-6]|section|article|td|th|dt|dd|figcaption|pre|figure)$/;
  // Climb to the nearest block, but never above body, so a <span> inside a <p> yields the
  // paragraph text (not the whole chapter).
  while (el && el !== doc.body && !BLOCK.test(el.tagName.toLowerCase())) {
    el = el.parentElement;
  }
  const host: Node | null = el ?? doc.body ?? node;
  try {
    return host.textContent ?? '';
  } catch {
    return '';
  }
}

/**
 * The selection's rect in iframe viewport px. jsdom has no layout (and no
 * `Range.getClientRects`), so this legitimately yields a zero rect under test; F2 clamps a
 * zero-size rect to a sensible default when anchoring the toolbar.
 */
function rectOf(range: Range, doc: Document): DOMRect {
  return firstClientRect(range) ?? zeroDomRect(doc);
}

/** Additive: compute the SelectionInfo for the document's current selection, or null. */
export function readSelection(doc: Document): SelectionInfo | null {
  if (!doc) return null;
  const win = doc.defaultView;
  const sel = win?.getSelection ? win.getSelection() : null;
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  let range: Range;
  try {
    range = sel.getRangeAt(0);
  } catch {
    return null;
  }
  const raw = sel.toString();
  if (!raw || raw.trim().length === 0) return null;

  const body = doc.body;
  if (!body) return null;

  // Rebuild the range as a collapsed pair so encodeRange yields stable point CFIs, and so a
  // range whose container is <body> itself still encodes.
  const startRange = doc.createRange();
  const endRange = doc.createRange();
  try {
    startRange.setStart(range.startContainer, range.startOffset);
    startRange.collapse(true);
    endRange.setStart(range.endContainer, range.endOffset);
    endRange.collapse(true);
  } catch {
    return null;
  }
  const cfiStart = encodeRange(startRange, body);
  const cfiEnd = encodeRange(endRange, body) || cfiStart;
  if (!cfiStart) return null;

  const text = raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}…` : raw;
  const sentence = extractSentence(raw, sentenceContext(range.startContainer, doc));

  return {
    text: text.trim(),
    cfiStart,
    cfiEnd,
    rect: rectOf(range, doc),
    sentence,
    word: extractWord(raw),
  };
}

/** Subscribe to selection changes (debounced 80 ms). Returns an unsubscribe fn. */
export function onSelectionChange(doc: Document, cb: (sel: SelectionInfo | null) => void): () => void {
  if (!doc || typeof cb !== 'function') return () => {};

  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const win = doc.defaultView;
  const setTimer = win?.setTimeout ?? setTimeout;
  const clearTimer = win?.clearTimeout ?? clearTimeout;

  const fire = (): void => {
    if (disposed) return;
    let info: SelectionInfo | null = null;
    try {
      info = readSelection(doc);
    } catch {
      info = null;
    }
    cb(info);
  };

  const schedule = (): void => {
    if (disposed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      fire();
    }, DEBOUNCE_MS);
  };

  const onSelChange = (): void => schedule();
  const onMouseUp = (): void => schedule();
  const onKeyUp = (): void => schedule();

  doc.addEventListener('selectionchange', onSelChange);
  doc.addEventListener('mouseup', onMouseUp);
  doc.addEventListener('keyup', onKeyUp);
  // WebKit also fires selectionchange on the window when focus moves into the frame. Both
  // paths funnel through the same debounce, so a doubled event costs nothing.
  if (win) win.addEventListener('selectionchange', onSelChange);

  return () => {
    if (disposed) return;
    disposed = true;
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    doc.removeEventListener('selectionchange', onSelChange);
    doc.removeEventListener('mouseup', onMouseUp);
    doc.removeEventListener('keyup', onKeyUp);
    if (win) win.removeEventListener('selectionchange', onSelChange);
  };
}

const FLASH_STYLE_ID = 'vellum-selection-style';

/** Inject ::selection colours from theme vars to avoid the default flash. */
export function suppressSelectionFlash(doc: Document): void {
  if (!doc) return;
  try {
    if (doc.getElementById(FLASH_STYLE_ID)) return;
    const head = doc.head ?? doc.documentElement;
    if (!head) return;
    const style = doc.createElement('style');
    style.id = FLASH_STYLE_ID;
    // A highlight under an active selection keeps its own colour instead of the selection tint.
    style.textContent =
      '::selection{background:var(--v-page-selection, rgba(194,102,45,.22));color:inherit}' +
      'mark.vellum-hl::selection{background:inherit}';
    head.appendChild(style);
  } catch {
    // Styling is best-effort; never block reading on it.
  }
}
