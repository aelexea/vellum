/**
 * AnnotationsPanel [F5] — §5.6: left-drawer "Highlights | Notes | Bookmarks" for the CURRENT
 * book, grouped by chapter, with hover actions (recolor, edit note, delete) and click-to-jump
 * through features/search/jump.ts. Mounts the shared components/DrawerTabs header because App
 * renders this panel standalone (TocPanel/SearchPanel/AnnotationsPanel are mutually exclusive).
 *
 * Styling note: base.css resets (`button`, `input`, `.vellum-*`) are unlayered and therefore
 * outrank Tailwind's `@layer utilities` rules, so buttons/inputs/textareas are styled by the
 * scoped <style> block below — class selectors win on specificity over those element resets.
 *
 * Data note: `Highlight` (§4.1) has no text field, only CFIs. The quoted line of a highlight
 * row is therefore taken from a `Note` covering the same range (see FROZEN-CHANGE-REQUEST).
 */
import { useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Bookmark, Highlight, Note } from '@/lib/types';
import { HIGHLIGHT_COLORS } from '@/lib/themes';
import { cn, fmtDate, fmtRelative } from '@/lib/utils';
import { Icon } from '@/components/icons';
import { DrawerTabs } from '@/components/DrawerTabs';
import { Modal } from '@/components/Modal';
import { Popover } from '@/components/Popover';
import { Segmented } from '@/components/Segmented';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';
import { compareCfi } from '@/features/reader/engine/cfi';
import { jumpToCfiTarget } from '@/features/search/jump';

const ANNOT_CSS = `
.vel-ap{
  position:fixed; top:0; left:0; bottom:0; z-index:30;
  display:flex; flex-direction:column;
  width:var(--drawer-w); max-width:88vw;
  background:var(--v-bg-alt); border-right:1px solid var(--v-border);
  box-shadow:var(--v-shadow);
}
.vel-ap-seg{ flex:none; padding:10px 12px 8px; }
.vel-ap-body{ flex:1; min-height:0; overflow-y:auto; padding:0 8px 16px; }
.vel-ap-group{
  position:sticky; top:0; z-index:1;
  padding:7px 8px 5px; margin-bottom:2px;
  background:var(--v-bg-alt);
  font-size:11px; letter-spacing:.03em; text-transform:uppercase;
  color:var(--v-fg-muted);
}
.vel-ap-row{
  position:relative; display:flex; gap:9px; width:100%;
  padding:7px 8px 7px 11px; margin-bottom:2px;
  border-radius:var(--radius-sm); cursor:pointer;
  transition:background var(--dur-fast) var(--ease);
}
.vel-ap-row:hover{ background:color-mix(in srgb, var(--v-border) 30%, transparent); }
.vel-ap-row:focus-visible{ outline:2px solid var(--v-accent); outline-offset:-2px; }
.vel-ap-bar{ flex:none; width:3px; border-radius:2px; align-self:stretch; min-height:30px; }
.vel-ap-main{ flex:1; min-width:0; }
.vel-ap-quote{
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
  font-size:13px; line-height:1.45; color:var(--v-fg);
}
.vel-ap-quote[data-empty="true"]{ color:var(--v-fg-muted); font-style:italic; }
.vel-ap-note{
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
  margin-top:2px; font-size:13px; line-height:1.4; color:var(--v-fg);
}
.vel-ap-src{
  display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical; overflow:hidden;
  font-size:12px; font-style:italic; color:var(--v-fg-muted);
}
.vel-ap-meta{
  display:flex; align-items:center; gap:6px; margin-top:3px;
  font-size:11px; color:var(--v-fg-muted);
}
.vel-ap-title{
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  font-size:13px; color:var(--v-fg);
}
.vel-ap-actions{
  flex:none; display:flex; align-items:center; gap:2px;
  opacity:0; transition:opacity var(--dur-fast) var(--ease);
}
.vel-ap-row:hover .vel-ap-actions,
.vel-ap-row:focus-within .vel-ap-actions{ opacity:1; }
.vel-ap-act{
  display:flex; align-items:center; justify-content:center;
  width:22px; height:22px; padding:0; border:0; border-radius:var(--radius-sm);
  background:none; color:var(--v-fg-muted); cursor:pointer;
  transition:background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.vel-ap-act:hover{ background:color-mix(in srgb, var(--v-fg) 10%, transparent); color:var(--v-fg); }
.vel-ap-act[data-active="true"]{ color:var(--v-accent); }
.vel-ap-dots{ display:flex; align-items:center; gap:6px; padding:9px 11px; }
.vel-ap-dot{
  width:16px; height:16px; padding:0; border-radius:50%; cursor:pointer;
  border:2px solid transparent;
  transition:transform var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.vel-ap-dot:hover{ transform:scale(1.15); }
.vel-ap-dot[data-active="true"]{ border-color:var(--v-fg); }
.vel-ap-empty{
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px;
  height:100%; min-height:160px; padding:16px; text-align:center;
}
.vel-ap-empty-title{ font-size:13px; color:var(--v-fg-muted); }
.vel-ap-empty-hint{ font-size:12px; color:var(--v-fg-muted); opacity:.75; }
.vel-ap-ta{
  width:100%; min-height:110px; box-sizing:border-box; resize:vertical;
  font-size:13px; line-height:1.5; color:var(--v-fg);
  background:var(--v-bg); border:1px solid var(--v-border); border-radius:var(--radius-sm);
  padding:7px 9px;
}
.vel-ap-ta:focus{ border-color:var(--v-accent); outline:none; }
.vel-ap-btn{
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  height:30px; padding:0 12px; border:1px solid var(--v-border); border-radius:var(--radius-sm);
  background:var(--v-bg); color:var(--v-fg); font-size:13px; cursor:pointer;
  transition:background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.vel-ap-btn:hover{
  background:var(--v-bg-raise);
  border-color:color-mix(in srgb, var(--v-fg) 25%, var(--v-border));
}
.vel-ap-btn-accent{ background:var(--v-accent); border-color:var(--v-accent); color:var(--v-accent-fg); }
.vel-ap-btn-accent:hover{
  background:color-mix(in srgb, var(--v-accent) 88%, var(--v-fg));
  border-color:transparent;
}
.vel-ap-btn:disabled{ opacity:.45; cursor:default; }
`;

type Tab = 'highlights' | 'notes' | 'bookmarks';

/** §5.6 group header: "Chapter {idx+1} · {tocTitle if any}". */
function chapterHeader(
  idx: number,
  tocTitle: string | null | undefined,
  chapterTitle: string | null | undefined,
): string {
  const title = (tocTitle ?? chapterTitle ?? '').trim();
  return title.length > 0 ? `Chapter ${idx + 1} · ${title}` : `Chapter ${idx + 1}`;
}

function rangeKey(cfiStart: string, cfiEnd: string): string {
  return `${cfiStart}\u0000${cfiEnd}`;
}

/** Reading order: chapter first, then CFI order, then creation time as a stable tiebreak. */
function byPosition<T extends { chapterIdx: number; cfiStart: string; createdAt: number }>(
  cfiOf: (item: T) => string,
): (a: T, b: T) => number {
  return (a, b) => {
    if (a.chapterIdx !== b.chapterIdx) return a.chapterIdx - b.chapterIdx;
    const cmp = compareCfi(cfiOf(a), cfiOf(b));
    if (cmp !== 0) return cmp;
    return a.createdAt - b.createdAt;
  };
}

interface Group<T> {
  chapterIdx: number;
  title: string;
  items: T[];
}

function groupByChapter<T extends { chapterIdx: number }>(
  items: T[],
  headerFor: (idx: number) => string,
): Group<T>[] {
  const map = new Map<number, T[]>();
  for (const item of items) {
    const list = map.get(item.chapterIdx);
    if (list) list.push(item);
    else map.set(item.chapterIdx, [item]);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([chapterIdx, groupItems]) => ({
      chapterIdx,
      title: headerFor(chapterIdx),
      items: groupItems,
    }));
}

export default function AnnotationsPanel() {
  const book = useReaderStore((s) => s.book);
  const [tab, setTab] = useState<Tab>('highlights');
  const [editing, setEditing] = useState<Note | null>(null);
  const [draft, setDraft] = useState('');
  const [paletteFor, setPaletteFor] = useState<{ id: number; anchor: HTMLElement } | null>(null);

  const uid = book?.book.uid ?? null;

  // Panels show the CURRENT book only — notes/bookmarks may be cross-book when uid is null.
  const highlights = useMemo(
    () => (book?.highlights ?? [])
      .filter((h) => h.bookUid === uid)
      .sort(byPosition<Highlight>((h) => h.cfiStart)),
    [book, uid],
  );
  const notes = useMemo(
    () => (book?.notes ?? [])
      .filter((n) => n.bookUid === uid)
      .sort(byPosition<Note>((n) => n.cfiStart)),
    [book, uid],
  );
  const bookmarks = useMemo(
    () => (book?.bookmarks ?? [])
      .filter((b) => b.bookUid === uid)
      .sort((a, b) => (a.chapterIdx !== b.chapterIdx
        ? a.chapterIdx - b.chapterIdx
        : compareCfi(a.cfi, b.cfi) || a.createdAt - b.createdAt)),
    [book, uid],
  );

  /** Highlight → the note covering the same range (source of its quoted text). */
  const noteByRange = useMemo(() => {
    const map = new Map<string, Note>();
    for (const n of notes) map.set(rangeKey(n.cfiStart, n.cfiEnd), n);
    return map;
  }, [notes]);

  const headerFor = useMemo(() => {
    const tocByChapter = new Map<number, string>();
    for (const entry of book?.book.toc ?? []) {
      if (entry.chapterIdx >= 0 && !tocByChapter.has(entry.chapterIdx)) {
        tocByChapter.set(entry.chapterIdx, entry.title);
      }
    }
    return (idx: number): string => chapterHeader(
      idx, tocByChapter.get(idx), book?.book.chapters[idx]?.title,
    );
  }, [book]);

  const jump = (chapterIdx: number, cfi: string, text?: string) => {
    jumpToCfiTarget(chapterIdx, cfi, text);
    useUiStore.getState().setOverlay(null);
  };

  const openNoteEditor = (note: Note, e: ReactMouseEvent) => {
    e.stopPropagation();
    setDraft(note.noteText);
    setEditing(note);
  };

  const saveNote = async () => {
    const note = editing;
    if (!note) return;
    const text = draft.trim();
    setEditing(null);
    await useReaderStore.getState().updateNote(note.id, text);
  };

  const deleteNote = async (note: Note, e: ReactMouseEvent) => {
    e.stopPropagation();
    const ok = await useUiStore.getState().confirm({
      title: 'Delete note?',
      message: note.selectedText.trim() || note.noteText.trim().slice(0, 80),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) await useReaderStore.getState().removeNote(note.id);
  };

  const recolor = async (id: number, color: string) => {
    setPaletteFor(null);
    await useReaderStore.getState().updateHighlight(id, color);
  };

  const segmentOptions = [
    { value: 'highlights' as const, label: 'Highlights', count: highlights.length },
    { value: 'notes' as const, label: 'Notes', count: notes.length },
    { value: 'bookmarks' as const, label: 'Bookmarks', count: bookmarks.length },
  ];

  const body = (() => {
    if (tab === 'highlights') {
      if (highlights.length === 0) {
        return (
          <div className="vel-ap-empty">
            <p className="vel-ap-empty-title">No highlights</p>
            <p className="vel-ap-empty-hint">Select text while reading</p>
          </div>
        );
      }
      return (
        <div className="vel-ap-body">
          {groupByChapter(highlights, headerFor).map((group) => (
            <div key={group.chapterIdx} data-testid="chapter-group">
              <p className="vel-ap-group">{group.title}</p>
              {group.items.map((hl) => {
                const note = noteByRange.get(rangeKey(hl.cfiStart, hl.cfiEnd));
                const text = note?.selectedText?.trim() ?? '';
                return (
                  <div
                    key={hl.id}
                    className="vel-ap-row"
                    role="button"
                    tabIndex={0}
                    data-testid="highlight-row"
                    onClick={() => jump(hl.chapterIdx, hl.cfiStart, text || undefined)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.preventDefault();
                      jump(hl.chapterIdx, hl.cfiStart, text || undefined);
                    }}
                  >
                    <span
                      className="vel-ap-bar"
                      style={{ background: hl.color }}
                      data-testid="highlight-bar"
                      aria-hidden
                    />
                    <span className="vel-ap-main">
                      <span className="vel-ap-quote" data-empty={text.length === 0}>
                        {text.length > 0 ? `“${text}”` : 'Highlight'}
                      </span>
                      <span className="vel-ap-meta">
                        <span className="vellum-num">{fmtDate(hl.createdAt)}</span>
                        {hl.hasNote && <Icon name="notes" size={11} />}
                      </span>
                    </span>
                    <span className="vel-ap-actions">
                      {note && (
                        <button
                          type="button"
                          className="vel-ap-act"
                          aria-label="Note"
                          title="Note"
                          onClick={(e) => openNoteEditor(note, e)}
                        >
                          <Icon name="edit" size={13} />
                        </button>
                      )}
                      <button
                        type="button"
                        className={cn('vel-ap-act')}
                        data-active={paletteFor?.id === hl.id}
                        aria-label="Highlight color"
                        title="Highlight color"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPaletteFor(paletteFor?.id === hl.id
                            ? null
                            : { id: hl.id, anchor: e.currentTarget });
                        }}
                      >
                        <Icon name="layers" size={13} />
                      </button>
                      <button
                        type="button"
                        className="vel-ap-act"
                        aria-label="Delete"
                        title="Delete"
                        onClick={(e) => {
                          e.stopPropagation();
                          void useReaderStore.getState().removeHighlight(hl.id);
                        }}
                      >
                        <Icon name="close" size={13} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      );
    }

    if (tab === 'notes') {
      if (notes.length === 0) {
        return (
          <div className="vel-ap-empty">
            <p className="vel-ap-empty-title">No notes</p>
            <p className="vel-ap-empty-hint">Select text and tap Note</p>
          </div>
        );
      }
      return (
        <div className="vel-ap-body">
          {groupByChapter(notes, headerFor).map((group) => (
            <div key={group.chapterIdx} data-testid="chapter-group">
              <p className="vel-ap-group">{group.title}</p>
              {group.items.map((note) => (
                <div
                  key={note.id}
                  className="vel-ap-row"
                  role="button"
                  tabIndex={0}
                  data-testid="note-row"
                  onClick={() => jump(note.chapterIdx, note.cfiStart, note.selectedText)}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    jump(note.chapterIdx, note.cfiStart, note.selectedText);
                  }}
                >
                  <span className="vel-ap-main">
                    {note.selectedText.trim().length > 0 && (
                      <span className="vel-ap-src">{`“${note.selectedText}”`}</span>
                    )}
                    <span className="vel-ap-note">{note.noteText}</span>
                    <span className="vel-ap-meta">
                      <span className="vellum-num">{fmtDate(note.updatedAt)}</span>
                    </span>
                  </span>
                  <span className="vel-ap-actions">
                    <button
                      type="button"
                      className="vel-ap-act"
                      aria-label="Edit note"
                      title="Edit"
                      onClick={(e) => openNoteEditor(note, e)}
                    >
                      <Icon name="edit" size={13} />
                    </button>
                    <button
                      type="button"
                      className="vel-ap-act"
                      aria-label="Delete note"
                      title="Delete"
                      onClick={(e) => void deleteNote(note, e)}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      );
    }

    if (bookmarks.length === 0) {
      return (
        <div className="vel-ap-empty">
          <p className="vel-ap-empty-title">No bookmarks</p>
          <p className="vel-ap-empty-hint">Ctrl+D</p>
        </div>
      );
    }
    return (
      <div className="vel-ap-body">
        {groupByChapter(bookmarks, headerFor).map((group) => (
          <div key={group.chapterIdx} data-testid="chapter-group">
            <p className="vel-ap-group">{group.title}</p>
            {group.items.map((bm: Bookmark) => (
              <div
                key={bm.id}
                className="vel-ap-row"
                role="button"
                tabIndex={0}
                data-testid="bookmark-row"
                onClick={() => jump(bm.chapterIdx, bm.cfi)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  jump(bm.chapterIdx, bm.cfi);
                }}
              >
                <span className="vel-ap-bar" style={{ background: 'var(--v-accent)' }} aria-hidden />
                <span className="vel-ap-main">
                  <span className="vel-ap-title">{bm.label?.trim() || 'Bookmark'}</span>
                  <span className="vel-ap-meta">
                    <span className="vellum-num">{fmtRelative(bm.createdAt)}</span>
                  </span>
                </span>
                <span className="vel-ap-actions">
                  <button
                    type="button"
                    className="vel-ap-act"
                    aria-label="Delete bookmark"
                    title="Delete"
                    onClick={(e) => {
                      e.stopPropagation();
                      void useReaderStore.getState().removeBookmark(bm.id);
                    }}
                  >
                    <Icon name="close" size={13} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  })();

  return (
    <div className="vel-ap" data-testid="annotations-panel">
      <style>{ANNOT_CSS}</style>
      <DrawerTabs active="annotations" />
      <div className="vel-ap-seg">
        <Segmented
          options={segmentOptions}
          value={tab}
          onChange={setTab}
          ariaLabel="Annotation types"
          size="sm"
        />
      </div>
      {body}

      <Popover
        open={paletteFor !== null}
        anchorEl={paletteFor?.anchor ?? null}
        placement="bottom-end"
        onClose={() => setPaletteFor(null)}
      >
        <div className="vel-ap-dots">
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className="vel-ap-dot"
              style={{ background: color }}
              aria-label={`Color ${color}`}
              data-active={highlights.find((h) => h.id === paletteFor?.id)?.color === color}
              onClick={() => paletteFor && void recolor(paletteFor.id, color)}
            />
          ))}
        </div>
      </Popover>

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title="Note"
        widthClass="max-w-md"
        footer={(
          <>
            <button type="button" className="vel-ap-btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="vel-ap-btn vel-ap-btn-accent"
              onClick={() => void saveNote()}
            >
              Save
            </button>
          </>
        )}
      >
        {editing && editing.selectedText.trim().length > 0 && (
          <p className="vel-ap-src" style={{ marginBottom: 8 }}>{`“${editing.selectedText}”`}</p>
        )}
        <textarea
          className="vel-ap-ta"
          value={draft}
          autoFocus
          placeholder="Note text"
          aria-label="Note text"
          onChange={(e) => setDraft(e.target.value)}
        />
      </Modal>
    </div>
  );
}
