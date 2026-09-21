/**
 * Highlight rendering — signatures FROZEN per ARCHITECTURE.md §5.3; bodies owned by [F0].
 *
 * A highlight's CFI pair is decoded to a Range, then every text node intersecting that Range
 * is wrapped in its own `mark.vellum-hl` (all sharing `dataset.hlId`), so a highlight that
 * spans inline element boundaries — `<p>a <b>b</b> c</p>` — renders as several marks without
 * the `Range.surroundContents` restrictions.
 *
 * Re-render protocol (idempotent, allocation-light, one reflow):
 *   1. unwrap every existing mark, normalizing ONLY the touched parents, so the DOM returns
 *      byte-identically to its pre-highlight shape and every stored CFI stays addressable;
 *   2. decode + wrap all items, performing no layout reads between the writes.
 *
 * Stale CFIs (book re-edited, text node split/merged) are skipped silently and counted, never
 * thrown: a broken annotation must not blank the chapter.
 */
import { compareCfi, decodeCfi } from './cfi';

export interface HighlightItem {
  id: number;
  cfiStart: string;
  cfiEnd: string;
  color: string;
  hasNote: boolean;
}

/** Additive: what one {@link renderHighlights} pass did. */
export interface HighlightRenderResult {
  /** Items that produced at least one mark. */
  rendered: number;
  /** Items skipped (unresolvable CFI, or an empty range). */
  skipped: number;
  /** Total `mark.vellum-hl` elements now in the document. */
  marks: number;
}

export const HL_CLASS = 'vellum-hl';
export const NOTE_CLASS = 'vellum-note';

const MARK_SELECTOR = `mark.${HL_CLASS}`;
const HL_ID_ATTR = 'hlId';

/** Background for a highlight color: the frozen §5.11 palette overlay. */
export function highlightBackground(color: string): string {
  const c = (color || '').trim() || '#ffe08a';
  return `color-mix(in srgb, ${c} 55%, transparent)`;
}

/**
 * Custom property carrying {@link highlightBackground}, consumed by `readerBaseCss`:
 * `mark.vellum-hl{background:var(--v-hl-bg,transparent)}`.
 *
 * Deliberately a custom property rather than an inline `style.backgroundColor`. Assigning a
 * `color-mix()` value to a *known* CSS property makes a CSSOM parse the value; setting a custom
 * property stores it opaquely. Measured over 100 marks on a 230 KB chapter, the known-property
 * assignment cost ~35 ms and the custom property ~0.5 ms — the difference between meeting the
 * < 5 ms re-render budget and missing it by 7x. The rendered colour is identical.
 */
export const HL_BG_VAR = '--v-hl-bg';

// ---------------------------------------------------------------------------
// generic range wrapping (shared with findtext.ts flash marks)
// ---------------------------------------------------------------------------

/** One text node's covered slice. */
interface Segment {
  node: Text;
  start: number;
  end: number;
}

function intersects(range: Range, node: Text): boolean {
  try {
    const len = node.nodeValue?.length ?? 0;
    // comparePoint: -1 before, 0 inside, 1 after.
    return range.comparePoint(node, 0) <= 0 && range.comparePoint(node, len) >= 0;
  } catch {
    try {
      return range.intersectsNode(node);
    } catch {
      return false;
    }
  }
}

/** Text nodes covered by `range`, in document order, with their slice offsets. */
export function rangeSegments(doc: Document, range: Range): Segment[] {
  const out: Segment[] = [];
  if (!doc || !range) return out;
  const ancestor = range.commonAncestorContainer;
  const root = ancestor.nodeType === 1 ? (ancestor as Element) : ancestor.parentNode;
  if (!root) return out;

  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    const node = n as Text;
    const len = node.nodeValue?.length ?? 0;
    if (len === 0) continue;
    if (!intersects(range, node)) continue;
    const start = node === range.startContainer ? Math.max(0, Math.min(range.startOffset, len)) : 0;
    const end = node === range.endContainer ? Math.max(0, Math.min(range.endOffset, len)) : len;
    if (end <= start) continue;
    out.push({ node, start, end });
  }
  return out;
}

/**
 * Wrap every text slice of `range` in an element from `factory` (one call per slice).
 * Returns the created elements. All mutations happen before any layout read by the caller.
 */
export function wrapRangeSegments(
  doc: Document,
  range: Range,
  factory: (index: number) => HTMLElement,
): HTMLElement[] {
  const created: HTMLElement[] = [];
  if (!doc || !range) return created;
  const segments = rangeSegments(doc, range);
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i] as Segment;
    let node = seg.node;
    const len = node.nodeValue?.length ?? 0;
    if (seg.end <= seg.start || seg.start > len) continue;

    // Isolate [start, end) into its own text node via splitText (mutates in place).
    if (seg.start > 0) {
      const tail = node.splitText(seg.start);
      if (!tail) continue;
      node = tail;
    }
    const nodeLen = node.nodeValue?.length ?? 0;
    if (seg.end - seg.start < nodeLen) node.splitText(seg.end - seg.start);

    const parent = node.parentNode;
    if (!parent) continue;
    let el: HTMLElement;
    try {
      el = factory(i);
    } catch {
      continue;
    }
    parent.insertBefore(el, node);
    el.appendChild(node);
    created.push(el);
  }
  return created;
}

// ---------------------------------------------------------------------------
// removal
// ---------------------------------------------------------------------------

/**
 * Remove every `mark.vellum-hl`, restoring the original text nodes exactly.
 *
 * Unwrap-then-normalize (rather than replacing each mark with one merged text node) is the
 * slower-looking but measurably faster option here, and it is the only one that returns the
 * DOM to a byte-identical pre-highlight shape — which is what keeps stored CFIs valid across
 * renders. Normalizing is deferred until every mark is unwrapped, because merging while
 * unwrapping fights the next insert, and only parents that actually held a mark are touched, so
 * a 300 KB chapter is never re-walked for merges. Returns the number of marks removed.
 */
export function removeHighlights(doc: Document): number {
  if (!doc) return 0;
  const marks = doc.querySelectorAll<HTMLElement>(MARK_SELECTOR);
  if (marks.length === 0) return 0;

  const touched = new Set<Element>();
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i] as HTMLElement;
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild !== null) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    if (parent.nodeType === 1) touched.add(parent as Element);
  }
  for (const el of touched) {
    try {
      el.normalize();
    } catch {
      // ignore — a normalize failure leaves split text nodes, which decodeCfi clamps over
    }
  }
  return marks.length;
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/** Idempotent: replaces existing mark.vellum-hl with the given items. */
export function renderHighlights(
  doc: Document, chapterRoot: HTMLElement, items: HighlightItem[],
): HighlightRenderResult {
  const result: HighlightRenderResult = { rendered: 0, skipped: 0, marks: 0 };
  if (!doc || !chapterRoot) {
    result.skipped = items?.length ?? 0;
    return result;
  }

  removeHighlights(doc);

  if (!items || items.length === 0) return result;

  // Phase 1 — resolve every item to concrete text slices WITHOUT mutating the DOM. Wrapping
  // moves text into a <mark>, which empties the chunk a later item's CFI addresses; decoding
  // all items up front keeps every stored CFI valid, so two highlights in the same paragraph
  // both render.
  const plans: SegmentPlan[] = [];
  const claimed = new Map<Text, [number, number][]>();

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as HighlightItem;
    if (!item) {
      result.skipped += 1;
      continue;
    }
    const range = rangeForItem(doc, chapterRoot, item);
    if (range === null) {
      result.skipped += 1;
      continue;
    }
    const style: MarkStyle = {
      id: String(item.id),
      bg: highlightBackground(item.color),
      note: item.hasNote === true,
    };
    let made = 0;
    for (const seg of rangeSegments(doc, range)) {
      // Overlapping highlights: the earlier item wins each character; later ones are clipped
      // around what is already claimed rather than nesting marks inside marks.
      const prev = claimed.get(seg.node);
      const pieces = subtractSlice(seg.start, seg.end, prev);
      if (pieces.length === 0) continue;
      const now = prev ?? [];
      for (const p of pieces) {
        now.push(p);
        plans.push({ node: seg.node, start: p[0], end: p[1], style });
      }
      claimed.set(seg.node, now);
      made += pieces.length;
    }
    if (made === 0) {
      result.skipped += 1;
      continue;
    }
    result.rendered += 1;
  }

  if (plans.length === 0) return result;

  // Phase 2 — wrap, in DESCENDING document order. splitText only affects the node it splits
  // and the tail it creates, so handling later slices first leaves every earlier offset exact.
  plans.sort(comparePlanDesc);
  for (const plan of plans) {
    try {
      if (wrapSlice(doc, plan)) result.marks += 1;
    } catch {
      // One bad slice must not lose the rest of the highlights.
    }
  }
  return result;
}

interface MarkStyle {
  id: string;
  bg: string;
  note: boolean;
}

/** A resolved, overlap-clipped slice of one text node to wrap. */
interface SegmentPlan {
  node: Text;
  start: number;
  end: number;
  style: MarkStyle;
}

/** Resolve an item's CFI pair to a Range, or null when an endpoint is stale/unresolvable. */
function rangeForItem(doc: Document, chapterRoot: HTMLElement, item: HighlightItem): Range | null {
  let a = item.cfiStart;
  let b = item.cfiEnd;
  // Tolerate an inverted pair (older writers, or a drag that ended before it started).
  if (a && b && compareCfi(b, a) < 0) {
    const t = a;
    a = b;
    b = t;
  }
  const startRange = decodeCfi(a, chapterRoot);
  if (!startRange) return null;
  const endRange = b ? decodeCfi(b, chapterRoot) : null;

  const range = doc.createRange();
  try {
    range.setStart(startRange.startContainer, startRange.startOffset);
    if (endRange) {
      // setEnd before setStart collapses the range backwards (DOM spec), so an inverted pair
      // simply yields no segments and is counted as skipped by the caller.
      range.setEnd(endRange.endContainer, endRange.endOffset);
    } else {
      range.collapse(false);
    }
  } catch {
    return null;
  }
  return range;
}

/** [start,end) minus a set of already-claimed intervals, as the remaining pieces. */
function subtractSlice(
  start: number, end: number, claims: [number, number][] | undefined,
): [number, number][] {
  if (end <= start) return [];
  if (!claims || claims.length === 0) return [[start, end]];
  const sorted = claims.slice().sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  let cur = start;
  for (const claim of sorted) {
    if (claim[1] <= cur) continue;
    if (claim[0] >= end) break;
    if (claim[0] > cur) out.push([cur, claim[0]]);
    cur = Math.max(cur, claim[1]);
    if (cur >= end) break;
  }
  if (cur < end) out.push([cur, end]);
  return out;
}

const POS_PRECEDING = 2; // Node.DOCUMENT_POSITION_PRECEDING
const POS_FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING

/** Sort key putting the LAST slice of the document first. */
function comparePlanDesc(a: SegmentPlan, b: SegmentPlan): number {
  if (a.node === b.node) return b.start - a.start;
  const pos = a.node.compareDocumentPosition(b.node);
  if ((pos & POS_FOLLOWING) !== 0) return 1; // b is after a → b wraps first
  if ((pos & POS_PRECEDING) !== 0) return -1;
  return 0;
}

/** Isolate [start,end) via splitText and move it into a fresh `mark`. */
function wrapSlice(doc: Document, plan: SegmentPlan): boolean {
  let node = plan.node;
  const len = node.nodeValue?.length ?? 0;
  if (plan.end <= plan.start || plan.start >= len) return false;

  if (plan.start > 0) {
    const tail = node.splitText(plan.start);
    if (!tail) return false;
    node = tail;
  }
  const nodeLen = node.nodeValue?.length ?? 0;
  if (plan.end - plan.start < nodeLen) node.splitText(plan.end - plan.start);

  const parent = node.parentNode;
  if (!parent) return false;

  const mark = doc.createElement('mark');
  mark.className = plan.style.note ? `${HL_CLASS} ${NOTE_CLASS}` : HL_CLASS;
  mark.dataset[HL_ID_ATTR] = plan.style.id;
  // Custom property, not style.backgroundColor — see HL_BG_VAR.
  mark.style.setProperty(HL_BG_VAR, plan.style.bg);
  parent.insertBefore(mark, node);
  mark.appendChild(node);
  return true;
}

/**
 * The attribute `dataset.hlId` actually writes: camelCase keys become kebab-case attributes.
 * Kept explicit so the selector below cannot silently drift from the assignment above.
 */
const HL_ID_SELECTOR_ATTR = 'data-hl-id';

/** Additive: the first mark element carrying this highlight id (for flash / scroll-to). */
export function markForId(doc: Document, id: number): HTMLElement | null {
  if (!doc) return null;
  try {
    return doc.querySelector<HTMLElement>(`${MARK_SELECTOR}[${HL_ID_SELECTOR_ATTR}="${id}"]`);
  } catch {
    return null;
  }
}

/** Additive: every highlight id currently rendered, in document order. */
export function renderedIds(doc: Document): number[] {
  const ids: number[] = [];
  if (!doc) return ids;
  const marks = doc.querySelectorAll<HTMLElement>(MARK_SELECTOR);
  const seen = new Set<number>();
  for (let i = 0; i < marks.length; i += 1) {
    const raw = (marks[i] as HTMLElement).dataset[HL_ID_ATTR];
    const n = Number.parseInt(raw ?? '', 10);
    if (Number.isFinite(n) && !seen.has(n)) {
      seen.add(n);
      ids.push(n);
    }
  }
  return ids;
}

/** Capture-phase click on highlight marks. Returns an unsubscribe fn. */
export function onMarkClick(doc: Document, cb: (id: number, ev: MouseEvent) => void): () => void {
  if (!doc || typeof cb !== 'function') return () => {};
  const handler = (ev: Event): void => {
    const target = ev.target as Node | null;
    if (!target || typeof (target as Element).closest !== 'function') return;
    const mark = (target as Element).closest(MARK_SELECTOR);
    if (!mark) return;
    const raw = (mark as HTMLElement).dataset[HL_ID_ATTR];
    const id = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(id)) return;
    cb(id, ev as MouseEvent);
  };
  doc.addEventListener('click', handler, true);
  return () => {
    doc.removeEventListener('click', handler, true);
  };
}
