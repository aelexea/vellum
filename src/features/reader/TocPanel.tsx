/**
 * TocPanel — [F2] per ARCHITECTURE.md §5.4/§5.6.
 * Left drawer rendered by App.tsx when `uiStore.overlay === 'toc'`.
 *
 * Header: the shared components/DrawerTabs ("Contents | Search | Notes") — the same
 * component SearchPanel/AnnotationsPanel mount, so switching between the three drawers
 * does not visually jump. Below it: the TOC tree — indentation by level, level-1 semibold,
 * the current chapter highlighted (accent tint + 2 px accent bar), scrolled into view on
 * open. Click → gotoCfi (entry carries a cfi) else gotoChapter, then the drawer closes.
 *
 * Styling note (F5's cascade trap): base.css's unlayered `button`/`input` resets outrank
 * Tailwind's `@layer utilities`, so interactive elements are styled by the scoped <style>
 * block below.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Icon } from '@/components/icons';
import { DrawerTabs } from '@/components/DrawerTabs';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';

const TOC_CSS = `
.vel-tp{
  position:fixed; top:0; left:0; bottom:0; z-index:30;
  display:flex; flex-direction:column;
  width:var(--drawer-w); max-width:88vw;
  background:var(--v-bg-alt); border-right:1px solid var(--v-border);
  box-shadow:var(--v-shadow);
  animation:vellum-slide-in-left var(--dur-med) var(--ease);
}
.vel-tp-close{
  position:absolute; top:6px; right:6px;
  display:flex; align-items:center; justify-content:center;
  width:28px; height:28px; padding:0; border:0; border-radius:var(--radius-sm);
  background:none; color:var(--v-fg-muted); cursor:pointer;
  transition:background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.vel-tp-close:hover{ background:color-mix(in srgb, var(--v-fg) 8%, transparent); color:var(--v-fg); }
.vel-tp-body{ flex:1; min-height:0; overflow-y:auto; padding:4px 8px 16px; }
.vel-tp-empty{ padding:16px 8px; font-size:12px; color:var(--v-fg-muted); }
.vel-tp-entry{
  position:relative; display:block; width:100%; padding:7px 10px 7px 12px;
  margin-bottom:1px; text-align:left; border:0; border-radius:var(--radius-sm);
  background:none; cursor:pointer; color:var(--v-fg-muted);
  font-size:13px; line-height:1.35;
  transition:background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.vel-tp-entry:hover{ background:color-mix(in srgb, var(--v-fg) 5%, transparent); color:var(--v-fg); }
.vel-tp-entry[data-active="true"]{
  color:var(--v-fg);
  background:color-mix(in srgb, var(--v-accent) 12%, transparent);
}
.vel-tp-entry[data-active="true"]::before{
  content:""; position:absolute; left:0; top:4px; bottom:4px; width:2px;
  background:var(--v-accent); border-radius:2px;
}
.vel-tp-entry[data-level="1"]{ font-weight:600; }
.vel-tp-entry span{
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
}
`;

export default function TocPanel() {
  const book = useReaderStore((s) => s.book);
  const chapterIdx = useReaderStore((s) => s.chapterIdx);
  const gotoCfi = useReaderStore((s) => s.gotoCfi);
  const gotoChapter = useReaderStore((s) => s.gotoChapter);
  const closeOverlay = useUiStore((s) => s.closeOverlay);

  const toc = useMemo(() => book?.book.toc ?? [], [book]);

  // Scroll the active entry into view when the drawer opens (or the head moves).
  const activeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [chapterIdx, toc]);

  const firstActiveIdx = useMemo(
    () => toc.findIndex((e) => e.chapterIdx === chapterIdx),
    [toc, chapterIdx],
  );

  const onPick = (entry: { cfi: string | null; chapterIdx: number }): void => {
    if (entry.cfi) gotoCfi(entry.cfi, entry.chapterIdx);
    else gotoChapter(entry.chapterIdx);
    closeOverlay();
  };

  return (
    <div className="vel-tp" data-testid="toc-panel" aria-label="Contents">
      <style>{TOC_CSS}</style>
      <DrawerTabs active="toc" />
      <button
        type="button"
        className="vel-tp-close"
        aria-label="Close"
        onClick={closeOverlay}
      >
        <Icon name="close" size={15} />
      </button>

      <div className="vel-tp-body">
        {toc.length === 0 ? (
          <p className="vel-tp-empty">Contents are empty</p>
        ) : (
          toc.map((entry, i) => {
            // Several entries may belong to one chapter (sub-sections) — highlight them
            // all, but scroll only the first into view.
            const active = entry.chapterIdx === chapterIdx;
            const indent = (Math.max(1, entry.level) - 1) * 16;
            return (
              <button
                key={`${entry.chapterIdx}-${i}`}
                ref={i === firstActiveIdx ? activeRef : undefined}
                type="button"
                data-testid="toc-entry"
                data-active={active}
                data-level={entry.level}
                onClick={() => onPick(entry)}
                className="vel-tp-entry"
                style={{ paddingLeft: `${12 + indent}px` }}
              >
                <span>{entry.title || `chapter ${entry.chapterIdx + 1}`}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
