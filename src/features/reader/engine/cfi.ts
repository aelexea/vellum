/**
 * EPUB CFI subset — signatures FROZEN per ARCHITECTURE.md §5.3; bodies owned by [F0].
 *
 * Implemented against EPUB Canonical Fragment Identifiers 1.1 (IDPF, 2017-01-05), restricted
 * to what Vellum stores and resolves:
 *
 *   epubcfi(/2/4/2:17)          — single path, terminal character offset
 *   epubcfi(/2/4,/1:5,/1:20)    — range: parent path P + start S + end E (§3.4)
 *   epubcfi(/6/4!/2/1:0)        — a leading "!" indirection is tolerated and dropped; Vellum
 *                                  CFIs are chapter-local, so no cross-document resolution
 *   [assertion] steps are parsed and IGNORED, never emitted (§3.2 rule 2: assertions do not
 *                                  participate in comparison or resolution)
 *
 * Child enumeration (§3.1.1): within a parent, ELEMENT children take even indices 2,4,6… in
 * 1-based document order among element children only; character data takes odd indices
 * 1,3,5…. The odd-indexed unit is NOT a DOM text node but a **chunk of contiguous character
 * data**: one chunk before the first child element, one after the last, one between each pair
 * of child elements. Adjacent text nodes therefore merge into a single chunk and their
 * lengths accumulate into the character offset. This is what Readium and epub.js both do, and
 * it is what makes a CFI survive DOM churn: highlight wrapping calls `Text.splitText`, so a
 * chunk-based encoder still yields the CFI of the original unsplit document.
 *
 * Comments and processing instructions are not addressable and contribute nothing — not an
 * index, not characters (§3.1.1: "XML content other than element and character data is
 * ignored"). CDATA (nodeType 4) counts as character data and merges into its chunk.
 *
 * The terminal ":N" is a zero-based UTF-16 code-unit offset (§3.1.4), the same unit `Range`
 * offsets use, so encode/decode are exact.
 *
 * Layout transparency: pagination.ts moves every body child into `div#vellum-wrap` to build
 * the CSS columns. That wrapper is TRANSPARENT here — skipped while walking up, substituted
 * while walking down — so a CFI written in scroll mode resolves identically in paginated mode
 * and stored highlights/positions keep working across mode switches.
 *
 * Robustness: nothing throws. Unresolvable input yields null (decode) or '' (encode). Offsets
 * past the end of a still-valid chunk are clamped rather than rejected, so a CFI written
 * before a re-split of the same text stays usable (§3.5 spirit).
 */

/** Attribute/id pagination.ts puts on the column wrapper; treated as transparent here. */
export const WRAP_ID = 'vellum-wrap';
export const WRAP_ATTR = 'data-vellum-wrap';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_NODE = 4;
const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT

/** A resolved location: a node plus an offset meaningful for that node kind. */
export interface CfiPosition {
  node: Node;
  /** Character offset for text nodes, child index for elements. */
  offset: number;
}

interface CfiStep {
  index: number;
  /** `[assertion]` content, parsed but never verified (null when absent). */
  assertion: string | null;
}

interface CfiPathExpr {
  steps: CfiStep[];
  /** Terminal character offset, null when the path addresses an element. */
  offset: number | null;
}

type ParsedCfi =
  | { kind: 'point'; path: CfiPathExpr }
  | { kind: 'range'; local: CfiPathExpr; start: CfiPathExpr; end: CfiPathExpr };

// ---------------------------------------------------------------------------
// node helpers
// ---------------------------------------------------------------------------

function isElementNode(n: Node | null): n is Element {
  return n !== null && n.nodeType === ELEMENT_NODE;
}

function isTextLike(n: Node | null): boolean {
  return n !== null && (n.nodeType === TEXT_NODE || n.nodeType === CDATA_NODE);
}

function isWrap(n: Node | null): boolean {
  return isElementNode(n) && n.hasAttribute(WRAP_ATTR);
}

/**
 * The column wrapper directly inside `parent`, if pagination installed one.
 *
 * `ensureWrap` moves every body child into the wrapper and appends it, so the wrapper is
 * always the parent's FIRST and only child. Testing just the first child keeps this O(1)
 * instead of a sibling walk — which matters because it runs for every step of every CFI, and
 * a chapter can have hundreds of top-level children.
 */
function wrapChild(parent: Node): Element | null {
  const first = parent.nodeType === ELEMENT_NODE ? (parent as Element).firstElementChild : null;
  return isWrap(first) ? first : null;
}

/**
 * The node list a CFI child step indexes into: the transparent wrapper's children when the
 * CFI parent owns one, otherwise the parent itself.
 */
function stepContainer(parent: Node): Node {
  if (isWrap(parent)) return parent;
  return wrapChild(parent) ?? parent;
}

function textLength(node: Node): number {
  return node.nodeValue?.length ?? 0;
}

/**
 * Canonical even step index of an element child: 2 × (1-based position among element
 * siblings). Comments/PIs/text are skipped, per §3.1.1.
 */
function elementStepIndex(node: Node): number | null {
  if (!isElementNode(node) || isWrap(node)) return null;
  let i = 0;
  for (let s = node.previousSibling; s !== null; s = s.previousSibling) {
    if (isElementNode(s) && !isWrap(s)) i += 1;
  }
  return 2 * i + 2;
}

/**
 * Canonical odd step index of a character-data chunk: the chunk between element child k and
 * k+1 has index 2k+1, where k is the number of element siblings preceding `node`. All
 * adjacent text nodes share one index, so they share one chunk.
 */
function chunkStepIndex(node: Node): number | null {
  if (!isTextLike(node)) return null;
  let k = 0;
  for (let s = node.previousSibling; s !== null; s = s.previousSibling) {
    if (isElementNode(s) && !isWrap(s)) k += 1;
  }
  return 2 * k + 1;
}

/**
 * Offset of `offset` (within `node`) inside its whole chunk: add the lengths of every
 * adjacent text-like sibling that precedes it. Comments contribute nothing.
 */
function chunkOffsetOf(node: Node, offset: number): number {
  let extra = 0;
  for (let s = node.previousSibling; s !== null; s = s.previousSibling) {
    if (isElementNode(s)) break;
    if (isTextLike(s)) extra += textLength(s);
  }
  return offset + extra;
}

/** Canonical child step index of `node`, or null when it is not addressable. */
function childStepIndex(node: Node): number | null {
  if (isElementNode(node)) return elementStepIndex(node);
  if (isTextLike(node)) return chunkStepIndex(node);
  return null;
}

/** The (index/2)-th element child (1-based) of `container`, or null. */
function nthElementStep(container: Node, evenIndex: number): Node | null {
  if (evenIndex < 2 || evenIndex % 2 !== 0) return null;
  const want = evenIndex / 2; // 1-based position among element children
  // Fast path: `children` is an indexed HTMLCollection of element children only, which is
  // exactly the even-step domain, and lookup is O(1) rather than a sibling walk. A 500-step
  // path into a long chapter would otherwise be quadratic.
  // Fast path: `children` is an indexed HTMLCollection of element children only — exactly the
  // even-step domain — so lookup is O(1) rather than a sibling walk. Only valid when this
  // container has no transparent wrapper (see wrapChild), which is an O(1) first-child test.
  if (isElementNode(container) && wrapChild(container) === null) {
    const kids = container.children;
    return want - 1 < kids.length ? (kids[want - 1] as Element) : null;
  }
  let seen = 0;
  for (let c = container.firstChild; c !== null; c = c.nextSibling) {
    if (!isElementNode(c) || isWrap(c)) continue;
    seen += 1;
    if (seen === want) return c;
  }
  return null;
}

/**
 * The text-like nodes forming chunk `k` (0-based) of `container`, in document order.
 * Stops as soon as the chunk closes — i.e. once element k has been passed — so resolving a
 * leading text chunk costs a couple of node visits, not a walk of the whole parent.
 */
function chunkNodes(container: Node, k: number): Node[] {
  const out: Node[] = [];
  if (k < 0) return out;
  let elemSeen = 0;
  for (let c = container.firstChild; c !== null; c = c.nextSibling) {
    if (isElementNode(c)) {
      // The transparent wrapper holds the real children; step into it instead of counting it.
      if (isWrap(c)) {
        for (let w = c.firstChild; w !== null; w = w.nextSibling) {
          if (isElementNode(w)) elemSeen += 1;
          else if (isTextLike(w) && elemSeen === k) out.push(w);
        }
        if (elemSeen > k) break;
        continue;
      }
      elemSeen += 1;
      if (elemSeen > k) break; // chunk k is complete
      continue;
    }
    if (isTextLike(c) && elemSeen === k) out.push(c);
  }
  return out;
}

/**
 * Distribute a chunk-relative offset onto a concrete (node, offset), clamping past the end.
 *
 * When the offset lands exactly on a boundary between two text nodes of the same chunk, the
 * START of the following node wins: a CFI denotes a position between characters, and resolving
 * to the next node's offset 0 (rather than the previous node's offset len) keeps a highlight
 * that starts there from producing a zero-length trailing mark on the previous node.
 */
function resolveChunkOffset(nodes: Node[], offset: number): CfiPosition | null {
  if (nodes.length === 0) return null;
  let remaining = Math.max(0, offset);
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i] as Node;
    const len = textLength(n);
    if (remaining < len) return { node: n, offset: remaining };
    remaining -= len;
  }
  const last = nodes[nodes.length - 1] as Node;
  return { node: last, offset: textLength(last) };
}

/** First descendant text node of `el` (or null). */
function firstTextNode(el: Node): Node | null {
  const doc = el.ownerDocument;
  if (!doc) return null;
  return doc.createTreeWalker(el, SHOW_TEXT).nextNode();
}

/** Last descendant text node of `el` (or null). */
function lastTextNode(el: Node): Node | null {
  const doc = el.ownerDocument;
  if (!doc) return null;
  const w = doc.createTreeWalker(el, SHOW_TEXT);
  let last: Node | null = null;
  for (let n = w.nextNode(); n !== null; n = w.nextNode()) last = n;
  return last;
}

function formatSteps(steps: number[]): string {
  let out = '';
  for (const s of steps) out += `/${s}`;
  return out;
}

// ---------------------------------------------------------------------------
// path walking (encoding)
// ---------------------------------------------------------------------------

/** Canonical child-step path from `root` (exclusive) down to `node`, or null. */
function pathTo(node: Node, root: Node): number[] | null {
  const steps: number[] = [];
  let cur: Node | null = node;
  while (cur !== null && cur !== root) {
    // The transparent column wrapper takes no step of its own.
    if (!isWrap(cur)) {
      const idx = childStepIndex(cur);
      if (idx === null) return null;
      steps.push(idx);
    }
    cur = cur.parentNode;
  }
  if (cur !== root) return null; // node is not a descendant of root
  steps.reverse();
  return steps;
}

/** Canonical single-location CFI, or '' when `node` is not addressable under `root`. */
function encodePosition(pos: CfiPosition, root: HTMLElement): string {
  const { node, offset } = pos;
  if (node === root) return '';

  if (isTextLike(node)) {
    const steps = pathTo(node, root);
    if (steps === null || steps.length === 0) return '';
    const inChunk = chunkOffsetOf(node, offset);
    const max = chunkLength(node);
    const clamped = Math.max(0, Math.min(inChunk, max));
    return `epubcfi(${formatSteps(steps)}:${clamped})`;
  }

  if (isElementNode(node)) {
    // Element container with a child offset: normalize onto the addressed child so that
    // encode/decode stay symmetric and always land on text when text exists.
    const children = node.childNodes;
    if (offset >= children.length) {
      const last = lastTextNode(node);
      if (last !== null) {
        return encodePosition({ node: last, offset: textLength(last) }, root);
      }
    } else {
      const child = children[offset] as Node;
      if (isTextLike(child)) return encodePosition({ node: child, offset: 0 }, root);
      const inner = firstTextNode(child);
      if (inner !== null) return encodePosition({ node: inner, offset: 0 }, root);
    }
    const steps = pathTo(node, root);
    if (steps === null || steps.length === 0) return '';
    return `epubcfi(${formatSteps(steps)})`;
  }
  return '';
}

/** Total UTF-16 length of the chunk containing `node`. */
function chunkLength(node: Node): number {
  let total = textLength(node);
  for (let s = node.previousSibling; s !== null; s = s.previousSibling) {
    if (isElementNode(s)) break;
    if (isTextLike(s)) total += textLength(s);
  }
  for (let s = node.nextSibling; s !== null; s = s.nextSibling) {
    if (isElementNode(s)) break;
    if (isTextLike(s)) total += textLength(s);
  }
  return total;
}

/** Additive: canonical CFI for an arbitrary (node, offset) location. */
export function encodePoint(node: Node, offset: number, chapterRoot: HTMLElement): string {
  return encodePosition({ node, offset }, chapterRoot);
}

/** Encode a DOM Range as "epubcfi(/4/2/6/1:12)" relative to chapterRoot. */
export function encodeRange(range: Range, chapterRoot: HTMLElement): string {
  if (!chapterRoot || !range) return '';
  if (range.collapsed) {
    return encodePosition({ node: range.startContainer, offset: range.startOffset }, chapterRoot);
  }

  const startSteps = pathTo(range.startContainer, chapterRoot);
  const endSteps = pathTo(range.endContainer, chapterRoot);
  if (
    startSteps === null || endSteps === null ||
    startSteps.length === 0 || endSteps.length === 0
  ) {
    // An endpoint is not addressable (e.g. it is the root itself) — degrade to the start.
    return encodePosition({ node: range.startContainer, offset: range.startOffset }, chapterRoot);
  }

  const startOffset = chunkClampedOffset(range.startContainer, range.startOffset);
  const endOffset = chunkClampedOffset(range.endContainer, range.endOffset);

  // §3.4: P must end at a step common to both branches. Take the longest common prefix, then
  // back off one step when a branch would otherwise come out empty, so both S and E always
  // carry at least one step. (The spec permits an empty S when E lies inside S's subtree; the
  // non-empty form is equally valid, round-trips deterministically, and is what we emit.)
  let shared = 0;
  const max = Math.min(startSteps.length, endSteps.length);
  while (shared < max && startSteps[shared] === endSteps[shared]) shared += 1;
  if (shared === startSteps.length || shared === endSteps.length) {
    if (shared > 0) shared -= 1;
  }

  const local = formatSteps(startSteps.slice(0, shared));
  const startBranch = `${formatSteps(startSteps.slice(shared))}:${startOffset}`;
  const endBranch = `${formatSteps(endSteps.slice(shared))}:${endOffset}`;
  return `epubcfi(${local},${startBranch},${endBranch})`;
}

/** Chunk-relative, clamped offset for a range endpoint. */
function chunkClampedOffset(node: Node, offset: number): number {
  if (isTextLike(node)) {
    return Math.max(0, Math.min(chunkOffsetOf(node, offset), chunkLength(node)));
  }
  return Math.max(0, Math.min(offset, node.childNodes.length));
}

/** CFI pointing at the start of an element. */
export function cfiFromElement(el: Element, chapterRoot: HTMLElement): string {
  if (!el || !chapterRoot || el === chapterRoot) return '';
  const steps = pathTo(el, chapterRoot);
  if (steps === null || steps.length === 0) return '';
  return `epubcfi(${formatSteps(steps)})`;
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

/** Undo spec '^' escaping inside an assertion/id component (§2.2). */
function unescapeCfi(s: string): string {
  if (s.indexOf('^') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '^' && i + 1 < s.length) {
      out += s[i + 1] as string;
      i += 1;
    } else {
      out += s[i] as string;
    }
  }
  return out;
}

/** Split on `sep` at bracket depth 0, honoring '^' escapes (commas are legal inside `[...]`). */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (ch === '^' && i + 1 < s.length) {
      cur += ch + (s[i + 1] as string);
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/** Strip the `epubcfi( … )` wrapper (tolerated when absent); null when nothing is inside. */
function innerCfi(cfi: string): string | null {
  const s = cfi.trim();
  if (s.length === 0) return null;
  const m = /^epubcfi\((.*)\)$/i.exec(s);
  const inner = (m ? (m[1] as string) : s).trim();
  return inner.length === 0 ? null : inner;
}

/** Index of the ':' introducing the terminal offset (skips escaped and bracketed ones). */
function lastTopLevelColon(s: string): number {
  let depth = 0;
  let found = -1;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '^') {
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ':' && depth === 0) found = i;
  }
  return found;
}

/** Parse "/2/4[x]/1:12" (or ":5", or "") into steps + terminal offset. */
function parsePath(path: string): CfiPathExpr | null {
  let p = path.trim();
  if (p.length === 0) return { steps: [], offset: null };
  // Indirection: chapter-local CFIs live after the last "!" (§3.1.3).
  const bang = p.lastIndexOf('!');
  if (bang !== -1) p = p.slice(bang + 1);

  let offset: number | null = null;
  const colon = lastTopLevelColon(p);
  if (colon !== -1) {
    let tail = p.slice(colon + 1);
    // §2.2: `offset = (":" integer | "@" number ":" number | "~" number …) ["[" assertion "]"]`
    // — the assertion (a text-location assertion or `;s=` side bias) comes AFTER the number,
    // so it must be dropped before the numeric parse. Ignored entirely per §3.2 rule 2.
    const br = tail.indexOf('[');
    if (br !== -1) tail = tail.slice(0, br);
    const n = Number(tail);
    if (!Number.isFinite(n) || n < 0) return null;
    offset = n;
    p = p.slice(0, colon);
  }

  const steps: CfiStep[] = [];
  for (const seg of splitTopLevel(p, '/')) {
    if (seg.length === 0) continue;
    const br = seg.indexOf('[');
    const numPart = br === -1 ? seg : seg.slice(0, br);
    const index = Number(numPart);
    if (!Number.isInteger(index) || index < 0) return null;
    let assertion: string | null = null;
    if (br !== -1) {
      const close = seg.lastIndexOf(']');
      if (close <= br) return null;
      assertion = unescapeCfi(seg.slice(br + 1, close));
    }
    steps.push({ index, assertion });
  }
  // An offset-only path (":5") is legal as a range branch; steps may then be empty.
  if (steps.length === 0 && offset === null) return null;
  return { steps, offset };
}

function parseCfi(cfi: string): ParsedCfi | null {
  const inner = innerCfi(cfi);
  if (inner === null) return null;
  const parts = splitTopLevel(inner, ',');
  if (parts.length === 1) {
    const path = parsePath(parts[0] as string);
    return path === null ? null : { kind: 'point', path };
  }
  if (parts.length !== 3) return null;
  const local = parsePath(parts[0] as string);
  const start = parsePath(parts[1] as string);
  const end = parsePath(parts[2] as string);
  if (local === null || start === null || end === null) return null;
  return { kind: 'range', local, start, end };
}

/** Additive: true when the string is at least grammatically a CFI. */
export function isValidCfi(cfi: string): boolean {
  try {
    return parseCfi(cfi) !== null;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// resolution (decoding)
// ---------------------------------------------------------------------------

/**
 * Resolve one path expression to a concrete position, or null.
 *
 * Only the FINAL step may be odd (a character-data chunk); intermediate steps must address
 * elements, since a chunk has no children.
 */
function resolvePath(path: CfiPathExpr, root: Node): CfiPosition | null {
  const steps = path.steps;

  if (steps.length === 0) {
    // Offset-only branch (":N") — applies to the root's own leading chunk.
    if (path.offset === null) return null;
    return resolveChunkOffset(chunkNodes(root, 0), path.offset);
  }

  let cur: Node = root;
  for (let i = 0; i < steps.length - 1; i += 1) {
    const idx = (steps[i] as CfiStep).index;
    if (idx % 2 !== 0) return null; // a chunk cannot contain steps
    const next = nthElementStep(stepContainer(cur), idx);
    if (next === null) return null;
    cur = next;
  }

  const last = steps[steps.length - 1] as CfiStep;
  const container = stepContainer(cur);

  if (last.index % 2 === 0) {
    const el = nthElementStep(container, last.index);
    if (el === null) return null;
    // An offset on an element addresses a child; §3.1.4 restricts it to <img alt>, but we
    // accept it leniently and normalize onto text so callers always get a usable caret.
    const children = el.childNodes;
    const offset = path.offset ?? 0;
    if (path.offset !== null) {
      if (offset >= children.length) {
        const lastText = lastTextNode(el);
        if (lastText !== null) return { node: lastText, offset: textLength(lastText) };
      } else {
        const child = children[offset] as Node;
        if (isTextLike(child)) return { node: child, offset: 0 };
        const inner = firstTextNode(child);
        if (inner !== null) return { node: inner, offset: 0 };
      }
    }
    const inner = firstTextNode(el);
    if (inner !== null) return { node: inner, offset: 0 };
    return { node: el, offset: Math.max(0, Math.min(offset, children.length)) };
  }

  const chunk = chunkNodes(container, (last.index - 1) / 2);
  return resolveChunkOffset(chunk, path.offset ?? 0);
}

function concatPaths(local: CfiPathExpr, branch: CfiPathExpr): CfiPathExpr {
  return { steps: local.steps.concat(branch.steps), offset: branch.offset };
}

/** Additive: decode to a raw position instead of a Range. */
export function decodePoint(cfi: string, chapterRoot: HTMLElement): CfiPosition | null {
  if (!cfi || !chapterRoot) return null;
  try {
    const parsed = parseCfi(cfi);
    if (parsed === null) return null;
    const path = parsed.kind === 'point' ? parsed.path : concatPaths(parsed.local, parsed.start);
    return resolvePath(path, chapterRoot);
  } catch {
    return null;
  }
}

function positionToRange(pos: CfiPosition, doc: Document): Range {
  const r = doc.createRange();
  if (isTextLike(pos.node)) {
    r.setStart(pos.node, pos.offset);
  } else if (isElementNode(pos.node)) {
    // Element target: collapse just before it so callers can scrollIntoView/measure.
    r.setStartBefore(pos.node);
  } else {
    r.setStart(pos.node, 0);
  }
  r.collapse(true);
  return r;
}

/** Decode a CFI back to a Range, or null when it cannot be resolved. */
export function decodeCfi(cfi: string, chapterRoot: HTMLElement): Range | null {
  if (!cfi || !chapterRoot) return null;
  const doc = chapterRoot.ownerDocument;
  if (!doc) return null;
  try {
    const parsed = parseCfi(cfi);
    if (parsed === null) return null;

    if (parsed.kind === 'point') {
      const pos = resolvePath(parsed.path, chapterRoot);
      return pos === null ? null : positionToRange(pos, doc);
    }

    const startPos = resolvePath(concatPaths(parsed.local, parsed.start), chapterRoot);
    const endPos = resolvePath(concatPaths(parsed.local, parsed.end), chapterRoot);
    if (startPos === null && endPos === null) return null;
    const start = startPos ?? (endPos as CfiPosition);
    const end = endPos ?? start;

    const r = positionToRange(start, doc);
    try {
      if (isTextLike(end.node)) r.setEnd(end.node, end.offset);
      else if (isElementNode(end.node)) r.setEndAfter(end.node);
      else r.setEnd(end.node, 0);
    } catch {
      // setEnd before setStart would throw — keep the collapsed start instead.
      r.collapse(true);
    }
    return r;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// comparison (§3.2)
// ---------------------------------------------------------------------------

/**
 * Sortable key: step indices (assertions stripped per §3.2 rule 2) then the terminal offset.
 * `kind` encodes §3.2 rule 6's component-type precedence at the divergence point:
 * a character offset (0) sorts before a child step (1).
 */
interface CompareKey {
  steps: number[];
  offset: number;
  /** Present for ranges: the end branch, used only as a tiebreaker after the start branch. */
  endSteps?: number[];
  endOffset?: number;
}

function pathKey(path: CfiPathExpr): { steps: number[]; offset: number } {
  return { steps: path.steps.map((s) => s.index), offset: path.offset ?? -1 };
}

function compareKey(cfi: string): CompareKey | null {
  const parsed = parseCfi(cfi);
  if (parsed === null) return null;
  if (parsed.kind === 'point') {
    const k = pathKey(parsed.path);
    return { steps: k.steps, offset: k.offset };
  }
  const s = pathKey(concatPaths(parsed.local, parsed.start));
  const e = pathKey(concatPaths(parsed.local, parsed.end));
  return { steps: s.steps, offset: s.offset, endSteps: e.steps, endOffset: e.offset };
}

/** Compare two step sequences with prefix-shortest-first semantics. */
function compareSteps(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  return 0;
}

/** Document-order comparison: -1 | 0 | 1. */
export function compareCfi(a: string, b: string): number {
  const ka = compareKey(a);
  const kb = compareKey(b);
  if (ka === null || kb === null) {
    if (ka === null && kb === null) return 0;
    // Unparseable input sorts after valid CFIs, deterministically.
    return ka === null ? 1 : -1;
  }

  const stepCmp = compareSteps(ka.steps, kb.steps);
  if (stepCmp !== 0) return stepCmp;
  // Same node: an element target (offset -1) precedes any character offset inside it.
  if (ka.offset !== kb.offset) return ka.offset < kb.offset ? -1 : 1;

  // Ranges: the spec compares PS, then PE.
  if (ka.endSteps && kb.endSteps) {
    const endCmp = compareSteps(ka.endSteps, kb.endSteps);
    if (endCmp !== 0) return endCmp;
    const ea = ka.endOffset ?? -1;
    const eb = kb.endOffset ?? -1;
    if (ea !== eb) return ea < eb ? -1 : 1;
  } else if (ka.endSteps || kb.endSteps) {
    // A point and a range with an identical start: the point sorts first.
    return ka.endSteps ? 1 : -1;
  }
  return 0;
}
