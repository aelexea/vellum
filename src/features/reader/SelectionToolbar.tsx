/**
 * SelectionToolbar — [F2] per ARCHITECTURE.md §5.4/§7.4.
 * Rendered by ReaderView; subscribes to `readerStore.selection`.
 *
 * Floating row above the selection rect (iframe-local coords + the frame offset published
 * by ChapterFrame), clamped 8 px inside the viewport; flips below the selection when there
 * is no room above. Actions: Translate · Dictionary · Highlight ▾ (6 colours + remove) ·
 * Note · Add to vocabulary · Copy.
 *
 * Translate/Dictionary/Add to vocabulary run through `dispatchAction`, so the button and
 * the shortcut share exactly one code path.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Ref } from 'react';
import { Icon } from '@/components/icons';
import type { IconName } from '@/components/icons';
import { Modal } from '@/components/Modal';
import { Popover } from '@/components/Popover';
import { HIGHLIGHT_COLORS } from '@/lib/themes';
import { copyText } from '@/lib/utils';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';
import { getFrameOffset } from '@/features/reader/ChapterFrame';
import { dispatchAction } from '@/features/reader/Shortcuts';

/** Minimum gap kept from the viewport edge (§5.4). */
const VIEWPORT_INSET = 8;
/** Space the toolbar needs above the selection before it flips below. */
const TOOLBAR_H = 40;
const ROW_GAP = 8;

/** Copy for the note dialog (§6.9). */
const NOTE_TITLE = 'Note';
const COPIED_TOAST = 'Copied';

/**
 * Scoped CSS for every interactive element here. base.css's unlayered `button`/`textarea`
 * resets (including `font: inherit`) outrank Tailwind's `@layer utilities`, so utilities for
 * colour/padding/font/background would silently lose — a class selector wins on specificity.
 */
const TOOLBAR_CSS = `
.vel-st-btn{
  display:inline-flex; align-items:center; gap:4px; height:32px; padding:0 8px;
  border:0; border-radius:var(--radius-sm); background:none;
  color:var(--v-fg); font-size:12px; font-family:inherit; line-height:1; cursor:pointer;
  transition:background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.vel-st-btn:hover{ background:color-mix(in srgb, var(--v-border) 40%, transparent); }
.vel-st-btn[data-on="true"]{ color:var(--v-accent); }
.vel-st-caret{ font-size:9px; opacity:.7; }
.vel-st-sep{ width:1px; height:20px; margin:0 2px; background:var(--v-border); flex:none; }
.vel-st-dot{
  width:24px; height:24px; flex:none; padding:0; border-radius:50%; cursor:pointer;
  border:1px solid var(--v-border);
  transition:transform var(--dur-fast) var(--ease);
}
.vel-st-dot:hover{ transform:scale(1.12); }
.vel-st-remove{
  display:flex; align-items:center; gap:6px; width:100%; margin-top:8px; padding:6px 8px;
  border:0; border-radius:var(--radius-sm); background:none; cursor:pointer;
  color:var(--v-fg-muted); font-size:12px; font-family:inherit;
  transition:background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.vel-st-remove:hover{
  background:color-mix(in srgb, var(--v-border) 40%, transparent); color:var(--v-fg);
}
.vel-st-quote{
  margin:0 0 8px; padding-left:8px; border-left:2px solid var(--v-accent);
  font-size:12px; font-style:italic; color:var(--v-fg-muted);
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden;
}
.vel-st-note{
  width:100%; box-sizing:border-box; resize:vertical;
  font-size:13px; font-family:inherit; line-height:1.5;
}
.vel-st-meta{ margin:6px 0 0; font-size:11px; color:var(--v-fg-muted); }
`;

interface ToolbarButtonProps {
  icon: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
  /** Render a caret next to the label (popover trigger). */
  caret?: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
}

function ToolbarButton({ icon, label, onClick, active, caret, buttonRef }: ToolbarButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="vel-st-btn"
      aria-label={label}
      title={label}
      aria-pressed={active ?? undefined}
      data-on={active || undefined}
      onClick={onClick}
    >
      <Icon name={icon} size={15} />
      {caret && <span className="vel-st-caret" aria-hidden>▾</span>}
    </button>
  );
}

export default function SelectionToolbar() {
  const selection = useReaderStore((s) => s.selection);
  const chapterIdx = useReaderStore((s) => s.chapterIdx);
  const highlights = useReaderStore((s) => (s.book ? s.book.highlights : null));
  const addHighlight = useReaderStore((s) => s.addHighlight);
  const removeHighlight = useReaderStore((s) => s.removeHighlight);
  const addNote = useReaderStore((s) => s.addNote);
  const setSelection = useReaderStore((s) => s.setSelection);
  const toast = useUiStore((s) => s.toast);

  const [colorOpen, setColorOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const colorBtnRef = useRef<HTMLButtonElement>(null);

  /** Highlight already covering this exact range → "Remove" becomes available. */
  const existing = highlights?.find(
    (h) => h.cfiStart === selection?.cfiStart && h.cfiEnd === selection?.cfiEnd,
  ) ?? null;

  // Close the dialogs when the selection goes away (page turn, click, chapter change).
  useEffect(() => {
    if (!selection) {
      setColorOpen(false);
      setNoteOpen(false);
      setPos(null);
    }
  }, [selection]);

  useEffect(() => {
    setNoteText('');
  }, [selection?.cfiStart, selection?.cfiEnd]);

  // ------------------------------------------------------------------ position
  useLayoutEffect(() => {
    if (!selection) return;
    const offset = getFrameOffset();
    const r = selection.rect;
    const rect = {
      left: offset.x + r.x,
      top: offset.y + r.y,
      width: r.width,
      height: r.height,
    };
    const toolbarW = rootRef.current?.offsetWidth ?? 280;

    // Centred on the selection, clamped inside the viewport.
    let left = rect.left + rect.width / 2 - toolbarW / 2;
    left = Math.max(
      VIEWPORT_INSET,
      Math.min(left, window.innerWidth - toolbarW - VIEWPORT_INSET),
    );

    // Prefer above; flip below when there is no room.
    let top = rect.top - TOOLBAR_H - ROW_GAP;
    if (top < VIEWPORT_INSET) top = rect.top + rect.height + ROW_GAP;
    top = Math.max(VIEWPORT_INSET, Math.min(top, window.innerHeight - TOOLBAR_H - VIEWPORT_INSET));

    setPos({ top, left });
  }, [selection]);

  // -------------------------------------------------------------------- actions
  const afterAction = (): void => {
    setColorOpen(false);
  };

  const onHighlight = async (color: string): Promise<void> => {
    if (!selection) return;
    // Contract v1.3: the 4th arg stores the selected text so the annotations panel can
    // quote the highlight (F5 FCR).
    await addHighlight(selection.cfiStart, selection.cfiEnd, color, selection.text);
    afterAction();
    setSelection(null);
  };

  const onRemoveHighlight = async (): Promise<void> => {
    if (!existing) return;
    await removeHighlight(existing.id);
    afterAction();
    setSelection(null);
  };

  const onSaveNote = async (): Promise<void> => {
    if (!selection) return;
    const text = noteText.trim();
    if (!text) { setNoteOpen(false); return; }
    await addNote(selection.cfiStart, selection.cfiEnd, selection.text, text);
    setNoteOpen(false);
    setNoteText('');
    setSelection(null);
  };

  const onCopy = async (): Promise<void> => {
    if (!selection) return;
    const ok = await copyText(selection.text);
    toast(ok ? COPIED_TOAST : "Couldn't copy", ok ? 'success' : 'error');
  };

  if (!selection) return null;

  return (
    <>
      <div
        ref={rootRef}
        data-testid="selection-toolbar"
        role="toolbar"
        aria-label="Selection actions"
        className="vellum-panel vellum-scale-in pointer-events-auto fixed z-30 flex items-center gap-0.5 p-1"
        style={{
          top: pos?.top ?? 0,
          left: pos?.left ?? 0,
          visibility: pos ? 'visible' : 'hidden',
          animationDuration: '160ms',
        }}
      >
        <style>{TOOLBAR_CSS}</style>
        <ToolbarButton
          icon="languages"
          label="Translate"
          onClick={() => { void dispatchAction('translate'); }}
        />
        <ToolbarButton
          icon="book"
          label="Dictionary"
          onClick={() => { void dispatchAction('dictionary'); }}
        />

        <span className="vel-st-sep" aria-hidden />

        <ToolbarButton
          icon="edit"
          label="Highlight"
          caret
          active={colorOpen || existing !== null}
          buttonRef={colorBtnRef}
          onClick={() => setColorOpen((v) => !v)}
        />
        <ToolbarButton
          icon="notes"
          label="Note"
          onClick={() => setNoteOpen(true)}
        />
        <ToolbarButton
          icon="plus"
          label="Add to vocabulary"
          // dispatchAction emits "Word added" itself (§5.4) — no second toast here.
          onClick={() => { void dispatchAction('addVocab'); }}
        />

        <span className="vel-st-sep" aria-hidden />

        <ToolbarButton icon="layers" label="Copy" onClick={() => { void onCopy(); }} />
      </div>

      {/* Colour picker — the 6 frozen palette colours + "Remove" (§5.11/§5.4). */}
      <Popover
        open={colorOpen}
        onClose={() => setColorOpen(false)}
        anchorEl={colorBtnRef.current}
        placement="bottom-start"
        className="p-2"
      >
        <style>{TOOLBAR_CSS}</style>
        <div className="flex items-center gap-2" data-testid="color-dots">
          {HIGHLIGHT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className="vel-st-dot"
              aria-label={`Highlight in ${color}`}
              title={color}
              onClick={() => { void onHighlight(color); }}
              style={{ background: color }}
            />
          ))}
        </div>
        {existing && (
          <button
            type="button"
            className="vel-st-remove"
            onClick={() => { void onRemoveHighlight(); }}
          >
            <Icon name="trash" size={14} />
            Remove
          </button>
        )}
      </Popover>

      {/* Note editor (§5.4: Modal with textarea, Save/Cancel). */}
      <Modal
        open={noteOpen}
        onClose={() => setNoteOpen(false)}
        title={NOTE_TITLE}
        widthClass="max-w-md"
        footer={(
          <>
            <button type="button" className="vellum-btn" onClick={() => setNoteOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="vellum-btn vellum-btn-accent"
              disabled={!noteText.trim()}
              onClick={() => { void onSaveNote(); }}
            >
              Save
            </button>
          </>
        )}
      >
        <style>{TOOLBAR_CSS}</style>
        <p className="vel-st-quote">{selection.text}</p>
        <textarea
          autoFocus
          data-testid="note-text"
          value={noteText}
          rows={4}
          aria-label={NOTE_TITLE}
          placeholder="Note text…"
          className="vellum-selectable vel-st-note"
          onChange={(e) => setNoteText(e.target.value)}
        />
        <p className="vel-st-meta">{`chapter ${chapterIdx + 1}`}</p>
      </Modal>
    </>
  );
}
