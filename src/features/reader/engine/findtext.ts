/**
 * In-chapter text search — signatures FROZEN per ARCHITECTURE.md §5.3; bodies owned by [F0].
 *
 * The match is performed on a whitespace-normalized haystack built by walking text nodes in
 * document order, so a phrase split across inline elements (`one <b>two</b> three` → "one two
 * three") is found, and runs of spaces/newlines in the source never break a match. Each
 * haystack index is mapped back to (text node, raw offset) so the resulting Range is exact.
 *
 * Comparison is case-insensitive by default: §7.5 routes a SearchPanel hit (found by FTS5
 * porter/unicode61 matching, which is case-folded) back through findText, so the document's
 * original casing must not matter. Pass `{caseSensitive: true}` to opt out.
 *
 * Script/style/title/head text is skipped; existing highlight and flash marks are transparent
 * (their text nodes are ordinary content, counted once).
 */
import { decodeCfi, encodeRange } from './cfi';
import { wrapRangeSegments } from './highlight';
import { firstClientRect, zeroDomRect } from './pagination';

const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TITLE', 'HEAD', 'NOSCRIPT', 'TEMPLATE', 'META', 'LINK']);

export interface FindOptions {
  /** Default false — see module doc. */
  caseSensitive?: boolean;
}

export interface FindResult {
  range: Range;
  cfi: string;
  rect: DOMRect;
}

/** One text node's contribution to the haystack. */
interface HayNode {
  node: Text;
  /** Index in the haystack where this node's normalized text starts. */
  hayStart: number;
  /** hayStart-relative normalized index → raw offset inside the node. */
  rawOffsets: Int32Array;
}

interface Haystack {
  text: string;
  nodes: HayNode[];
  /** hayStart per node, for binary search. */
  starts: Int32Array;
}

/** Lowercase a single char without ever changing its length (keeps index maps exact). */
function foldChar(ch: string, caseSensitive: boolean): string {
  if (caseSensitive) return ch;
  const lower = ch.toLowerCase();
  return lower.length === 1 ? lower : ch;
}

function normalizeNeedle(text: string, caseSensitive: boolean): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (caseSensitive) return collapsed;
  let out = '';
  for (const ch of collapsed) out += foldChar(ch, false);
  return out;
}

/** Resolve a haystack index to (node, raw offset). */
function resolveIndex(hay: Haystack, index: number): { node: Text; offset: number } | null {
  const { nodes, starts } = hay;
  if (nodes.length === 0 || index < 0) return null;
  // Binary search for the last node with hayStart <= index.
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] as number) <= index) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (found === -1) return null;
  // Walk forward while the next node starts at or before the index (handles zero-length gaps).
  while (found + 1 < nodes.length && (starts[found + 1] as number) <= index) found += 1;

  const rec = nodes[found] as HayNode;
  const k = index - rec.hayStart;
  if (k < 0 || k >= rec.rawOffsets.length) return null;
  return { node: rec.node, offset: rec.rawOffsets[k] as number };
}

/** Additive: the nth match as a Range + CFI + rect, or null. */
export function findTextRange(
  doc: Document,
  text: string,
  occurrence = 0,
  opts?: FindOptions,
): FindResult | null {
  if (!doc || !text) return null;
  const body = doc.body;
  if (!body) return null;
  const caseSensitive = opts?.caseSensitive === true;
  const needle = normalizeNeedle(text, caseSensitive);
  if (needle.length === 0) return null;

  const hay = collectHaystack(doc, body, caseSensitive);
  if (hay.text.length === 0) return null;

  const nth = Math.max(0, Math.trunc(Number.isFinite(occurrence) ? occurrence : 0));
  let from = 0;
  let hit = -1;
  for (let i = 0; i <= nth; i += 1) {
    hit = hay.text.indexOf(needle, from);
    if (hit === -1) return null;
    from = hit + 1;
  }

  const start = resolveIndex(hay, hit);
  const end = resolveIndex(hay, hit + needle.length - 1);
  if (!start) return null;

  const range = doc.createRange();
  try {
    range.setStart(start.node, start.offset);
    if (end) {
      const endLen = end.node.nodeValue?.length ?? 0;
      range.setEnd(end.node, Math.min(endLen, end.offset + 1));
    } else {
      range.setEnd(start.node, Math.min(start.node.nodeValue?.length ?? 0, start.offset + needle.length));
    }
  } catch {
    return null;
  }

  const collapsed = doc.createRange();
  try {
    collapsed.setStart(range.startContainer, range.startOffset);
    collapsed.collapse(true);
  } catch {
    // keep `collapsed` unusable; encodeRange falls back to '' below
  }
  const cfi = encodeRange(collapsed, body) || encodeRange(range, body);

  // Under jsdom there is no layout, so a real rect may not exist; the CFI is still exact,
  // which is what the caller needs to jump to the hit.
  const rect = firstClientRect(range) ?? zeroDomRect(doc);
  return { range, cfi, rect };
}

/** Walk text nodes once, producing the collapsed haystack and its index map. */
function collectHaystack(doc: Document, root: Node, caseSensitive: boolean): Haystack {
  const nodes: HayNode[] = [];
  const starts: number[] = [];
  let hay = '';
  // Whether the last emitted haystack char was a space (drives run collapsing).
  let prevSpace = true;

  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const textNode = n as Text;
    const raw = textNode.nodeValue;
    if (!raw || raw.length === 0) continue;
    const parent = textNode.parentElement;
    if (parent && SKIP_TAGS.has(parent.tagName)) continue;

    const hayStart = hay.length;
    const offsets: number[] = [];
    let local = '';
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i] as string;
      if (/\s/.test(ch)) {
        if (!prevSpace) {
          offsets.push(i);
          local += ' ';
          prevSpace = true;
        }
        continue;
      }
      prevSpace = false;
      offsets.push(i);
      local += foldChar(ch, caseSensitive);
    }
    if (local.length === 0) continue;
    hay += local;
    nodes.push({ node: textNode, hayStart, rawOffsets: Int32Array.from(offsets) });
    starts.push(hayStart);
  }
  return { text: hay, nodes, starts: Int32Array.from(starts) };
}

/** Normalized-whitespace TreeWalker search; the nth occurrence (0-based). */
export function findText(
  doc: Document, text: string, occurrence?: number,
): { cfi: string; rect: DOMRect } | null {
  const found = findTextRange(doc, text, occurrence ?? 0);
  return found === null ? null : { cfi: found.cfi, rect: found.rect };
}

/** Additive: total number of matches (for "N of M" UI); 0 when nothing matches. */
export function countOccurrences(doc: Document, text: string, opts?: FindOptions): number {
  if (!doc || !text || !doc.body) return 0;
  const caseSensitive = opts?.caseSensitive === true;
  const needle = normalizeNeedle(text, caseSensitive);
  if (needle.length === 0) return 0;
  const hay = collectHaystack(doc, doc.body, caseSensitive);
  let count = 0;
  let from = 0;
  for (;;) {
    const hit = hay.text.indexOf(needle, from);
    if (hit === -1) break;
    count += 1;
    from = hit + 1;
    if (count > 100000) break; // pathological guard
  }
  return count;
}

const FLASH_CLASS = 'vellum-flash';

/**
 * Timer handles are `number` in the browser and `Timeout` under Node's types. Keeping the
 * union behind two small helpers avoids the union-of-call-signatures error you get from
 * `(win?.setTimeout ?? setTimeout)(…)`, and lets tests drive the iframe's own clock.
 */
type TimerHandle = number | ReturnType<typeof setTimeout>;

const flashTimers = new WeakMap<Document, TimerHandle[]>();

function startTimer(doc: Document, fn: () => void, ms: number): TimerHandle {
  const win = doc.defaultView;
  return win ? win.setTimeout(fn, ms) : setTimeout(fn, ms);
}

function stopTimer(doc: Document, id: TimerHandle): void {
  const win = doc.defaultView;
  if (win) win.clearTimeout(id as number);
  else clearTimeout(id);
}

/** Temporary .vellum-flash mark over a range (search hit feedback). */
export function flashRange(doc: Document, range: Range, ms = 1200): void {
  if (!doc || !range) return;
  try {
    wrapRangeSegments(doc, range, () => {
      const mark = doc.createElement('mark');
      mark.className = FLASH_CLASS;
      return mark;
    });
  } catch {
    return;
  }
  const duration = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (duration === 0) {
    clearFlashes(doc);
    return;
  }

  const timers = flashTimers.get(doc) ?? [];
  flashTimers.set(doc, timers);
  let handle: TimerHandle | null = null;
  handle = startTimer(doc, () => {
    clearFlashes(doc);
    if (handle !== null) {
      const list = flashTimers.get(doc);
      const at = list?.indexOf(handle) ?? -1;
      if (list && at !== -1) list.splice(at as number, 1);
    }
  }, duration);
  timers.push(handle);
}

/**
 * Additive: decode a CFI and flash the location it points at.
 *
 * This is the flash half of {@link findTextRange} without the text search: annotations-panel
 * jumps (§5.6, §7) carry an exact CFI but no reliably-findable text — the selected sentence may
 * repeat elsewhere in the chapter, or contain characters a search needle cannot reproduce — so
 * a CFI is the only trustworthy target there.
 *
 * Both CFI shapes the app stores are supported:
 *   - a range CFI (Highlight.cfiStart/cfiEnd, Note) flashes exactly the covered text;
 *   - a POINT CFI (Bookmark.cfi, cfiAtPage) addresses zero characters, so it is expanded to the
 *     end of its sentence first — otherwise a bookmark jump would navigate precisely and flash
 *     nothing at all.
 *
 * Returns false when the CFI does not resolve or nothing could be wrapped, leaving the document
 * untouched.
 */
export function flashCfi(doc: Document, cfi: string, ms = 1200): boolean {
  if (!doc || !cfi) return false;
  const body = doc.body;
  if (!body) return false;
  const range = decodeCfi(cfi, body);
  if (!range) return false;
  if (range.collapsed) expandToSentenceEnd(doc, range);
  if (range.collapsed) return false; // nothing to show even after expansion

  const before = flashMarkCount(doc);
  flashRange(doc, range, ms);
  return flashMarkCount(doc) > before;
}

/** Longest flash expansion for a point CFI, matching the selection sentence cap (§5.3). */
const FLASH_EXPAND_MAX = 240;
/** Sentence terminators; a following run of closing quotes/brackets stays inside. */
const FLASH_END = /[.!?…\n]+[»”"')\]}›]*/;

/**
 * Grow a collapsed range forward to the end of the sentence it sits in, so a point CFI has
 * something visible to flash. Scans text nodes inside the enclosing block (never the whole
 * chapter) and stops at a terminator, a block boundary or {@link FLASH_EXPAND_MAX} characters.
 * Mutates `range` in place; leaves it collapsed when no expansion is possible.
 */
export function expandToSentenceEnd(doc: Document, range: Range): void {
  if (!doc || !range || !range.collapsed) return;
  const startNode = range.startContainer;
  if (startNode.nodeType !== 3 && startNode.nodeType !== 4) return;

  const block = enclosingBlock(startNode, doc.body) ?? doc.body;
  if (!block) return;

  const startText = startNode as Text;
  const startOffset = Math.min(range.startOffset, startText.nodeValue?.length ?? 0);
  let budget = FLASH_EXPAND_MAX;
  let node: Text | null = startText;
  let offsetInNode = startOffset;

  const walker = doc.createTreeWalker(block, SHOW_TEXT);
  // Position the walker at the start node so we only scan forward.
  walker.currentNode = startText;

  for (;;) {
    const value = node.nodeValue ?? '';
    if (offsetInNode >= value.length) {
      const next = walker.nextNode() as Text | null;
      if (next === null) break;
      node = next;
      offsetInNode = 0;
      continue;
    }
    const remaining = Math.min(budget, value.length - offsetInNode);
    const slice = value.slice(offsetInNode, offsetInNode + remaining);
    const m = FLASH_END.exec(slice);
    if (m) {
      const endOffset = offsetInNode + m.index + m[0].length;
      try {
        range.setEnd(node, endOffset);
      } catch {
        // An unextendable range stays collapsed; the caller reports no flash.
      }
      return;
    }
    // No terminator in this slice: consume it and keep walking.
    try {
      range.setEnd(node, offsetInNode + remaining);
    } catch {
      return;
    }
    budget -= remaining;
    if (budget <= 0) return;
    offsetInNode += remaining;
  }
}

/** Nearest block-level ancestor of `node`, never above `limit`. */
function enclosingBlock(node: Node, limit: Node | null): Element | null {
  const BLOCK = /^(p|div|li|blockquote|h[1-6]|section|article|td|th|dt|dd|figcaption|pre|figure|body)$/;
  let el: Element | null = node.nodeType === 1 ? (node as Element) : node.parentElement;
  while (el && el !== limit && !BLOCK.test(el.tagName.toLowerCase())) {
    el = el.parentElement;
  }
  return el;
}

function flashMarkCount(doc: Document): number {
  try {
    return doc.querySelectorAll(`mark.${FLASH_CLASS}`).length;
  } catch {
    return 0;
  }
}

/** Additive: remove all flash marks immediately (and cancel pending timers). */
export function clearFlashes(doc: Document): void {
  if (!doc) return;
  const timers = flashTimers.get(doc);
  if (timers) {
    for (const id of timers) stopTimer(doc, id);
    timers.length = 0;
  }
  const marks = doc.querySelectorAll<HTMLElement>(`mark.${FLASH_CLASS}`);
  for (let i = 0; i < marks.length; i += 1) unwrapMark(marks[i] as HTMLElement);
  normalizeShallow(doc);
}

/** Replace a mark with its children, then merge adjacent text nodes locally. */
function unwrapMark(mark: HTMLElement): void {
  const parent = mark.parentNode;
  if (!parent) return;
  while (mark.firstChild !== null) parent.insertBefore(mark.firstChild, mark);
  parent.removeChild(mark);
  if (parent.nodeType === 1) (parent as Element).normalize();
}

/** Normalize only containers that held marks — avoids a whole-document normalize(). */
function normalizeShallow(doc: Document): void {
  const marks = doc.querySelectorAll<HTMLElement>(`mark.${FLASH_CLASS}`);
  for (let i = 0; i < marks.length; i += 1) {
    const parent = (marks[i] as HTMLElement).parentNode;
    if (parent && parent.nodeType === 1) (parent as Element).normalize();
  }
}
