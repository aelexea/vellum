/**
 * SearchPanel [F5] — §5.6: left-drawer search with the shared "Contents | Search | Notes"
 * tab header (App renders this panel standalone, so it mounts components/DrawerTabs), a 150 ms debounced
 * `search_in_book` with a request-race guard, live index progress, recent searches and
 * snippet results that jump into the reader through jump.ts.
 *
 * Styling note: base.css resets (`button`, `input`, `.vellum-*`) are unlayered and therefore
 * outrank Tailwind's `@layer utilities` rules. Every button/input here is styled by the scoped
 * <style> block below — a class selector wins on specificity over those element resets, whereas
 * a font/colour/padding utility would silently lose.
 */
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { SearchHit } from '@/lib/types';
import { DrawerTabs } from '@/components/DrawerTabs';
import { getIndexStatus, onEvent, reindexBook, searchInBook } from '@/lib/tauri';
import { cn, errMsg } from '@/lib/utils';
import { Spinner } from '@/components/Spinner';
import { Icon } from '@/components/icons';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';
import { jumpToHit } from '@/features/search/jump';

const SEARCH_CSS = `
.vel-sp{
  position:fixed; top:0; left:0; bottom:0; z-index:30;
  display:flex; flex-direction:column;
  width:var(--drawer-w); max-width:88vw;
  background:var(--v-bg-alt); border-right:1px solid var(--v-border);
  box-shadow:var(--v-shadow);
}
.vel-sp-field{ position:relative; flex:none; padding:10px 12px 8px; }
.vel-sp-input{
  width:100%; height:32px; padding:0 28px 0 30px; box-sizing:border-box;
  background:var(--v-bg); border:1px solid var(--v-border); border-radius:var(--radius-sm);
  font-size:13px; color:var(--v-fg);
  transition:border-color var(--dur-fast) var(--ease);
}
.vel-sp-input:focus{ border-color:var(--v-accent); outline:none; }
.vel-sp-input::placeholder{ color:var(--v-fg-muted); }
.vel-sp-glass{
  position:absolute; left:21px; top:19px; display:flex; pointer-events:none;
  color:var(--v-fg-muted);
}
.vel-sp-clear{
  position:absolute; right:17px; top:14px; display:flex; align-items:center; justify-content:center;
  width:22px; height:22px; padding:0; border:0; border-radius:var(--radius-sm);
  background:none; color:var(--v-fg-muted); cursor:pointer;
  transition:background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease);
}
.vel-sp-clear:hover{ background:color-mix(in srgb, var(--v-fg) 10%, transparent); color:var(--v-fg); }
.vel-sp-body{ flex:1; min-height:0; overflow-y:auto; padding:4px 8px 16px; }
.vel-sp-count{ padding:2px 6px 8px; font-size:11px; color:var(--v-fg-muted); }
.vel-sp-hit{
  display:block; width:100%; padding:7px 8px; margin-bottom:2px; text-align:left;
  border:0; border-radius:var(--radius-sm); background:none; cursor:pointer;
  color:var(--v-fg); font-size:13px; line-height:1.45;
  transition:background var(--dur-fast) var(--ease);
}
.vel-sp-hit:hover{ background:color-mix(in srgb, var(--v-border) 30%, transparent); }
.vel-sp-hit-title{
  display:block; margin-bottom:2px; font-size:11px; letter-spacing:.04em; text-transform:uppercase;
  color:var(--v-fg-muted);
}
.vel-sp-snippet{
  display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden;
  color:var(--v-fg);
}
.vel-sp-snippet mark{
  background:color-mix(in srgb, var(--v-accent) 30%, transparent);
  color:inherit; border-radius:2px; padding:0 1px;
}
.vel-sp-chips{ display:flex; flex-wrap:wrap; gap:6px; padding:2px 4px; }
.vel-sp-chip{ display:inline-flex; align-items:center; gap:5px; }
.vel-sp-chip-btn{
  display:inline-flex; align-items:center; max-width:210px;
  padding:3px 9px; border:1px solid var(--v-border); border-radius:999px;
  background:var(--v-bg); color:var(--v-fg-muted);
  font-size:12px; line-height:1.4; cursor:pointer;
  transition:color var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.vel-sp-chip-btn:hover{
  color:var(--v-fg);
  border-color:color-mix(in srgb, var(--v-fg) 25%, var(--v-border));
}
.vel-sp-chip-btn > span{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.vel-sp-chip-x{
  display:flex; align-items:center; justify-content:center; width:16px; height:16px; padding:0;
  border:0; border-radius:50%; background:none; color:inherit; opacity:.55; cursor:pointer;
  transition:opacity var(--dur-fast) var(--ease);
}
.vel-sp-chip-x:hover{ opacity:1; }
.vel-sp-btn{
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  height:30px; padding:0 12px; border:1px solid var(--v-border); border-radius:var(--radius-sm);
  background:var(--v-bg); color:var(--v-fg); font-size:13px; cursor:pointer;
  transition:background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
}
.vel-sp-btn:hover{
  background:var(--v-bg-raise);
  border-color:color-mix(in srgb, var(--v-fg) 25%, var(--v-border));
}
.vel-sp-center{
  flex:1; min-height:0; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:10px; padding:16px; text-align:center;
}
.vel-sp-hint{ padding:6px 6px 10px; font-size:12px; color:var(--v-fg-muted); }
.vel-sp-state{ font-size:13px; color:var(--v-fg-muted); }
.vel-sp-progress{
  flex:1; min-height:0; display:flex; align-items:center; gap:8px; padding:16px 12px;
  font-size:13px; color:var(--v-fg-muted);
}
.vel-sp-label{
  padding:8px 6px 6px; font-size:11px; letter-spacing:.04em; text-transform:uppercase;
  color:var(--v-fg-muted);
}
.vel-sp-foot{ flex:none; padding:0 14px 10px; font-size:11px; color:var(--v-fg-muted); opacity:.75; }
`;

const DEBOUNCE_MS = 150;
const RECENT_KEY = 'vellum.search.recent';
const RECENT_MAX = 6;

/** §5.6/§6.9 copy: "chapter N" when the chapter has no title of its own. */
function chapterLabel(title: string, idx: number): string {
  const t = title.trim();
  return t.length > 0 ? t : `chapter ${idx + 1}`;
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function writeRecent(items: string[]): string[] {
  const next = items.slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* private mode */ }
  return next;
}

export default function SearchPanel() {
  const book = useReaderStore((s) => s.book);
  const liveStatus = useReaderStore((s) => s.indexStatus);
  const bookStatus = useReaderStore((s) => s.book?.indexStatus);
  const setIndexStatus = useReaderStore((s) => s.setIndexStatus);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => readRecent());
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [triedBuild, setTriedBuild] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const uidRef = useRef<string | null>(null);
  /** Request-race guard: only the newest request id may write state. */
  const reqIdRef = useRef(0);
  const lastRanRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef({ query, hits });
  stateRef.current = { query, hits };

  // readerStore.open() copies book.indexStatus into the live field that index events keep
  // current, so the live field wins; the snapshot only covers a store seeded without it.
  const indexStatus = liveStatus.state === 'none' && bookStatus && bookStatus.state !== 'none'
    ? bookStatus
    : liveStatus;
  const uid = book?.book.uid ?? null;
  uidRef.current = uid;

  /**
   * Run one search. `force` bypasses the same-query guard (used after "index-done" so the
   * query typed while indexing re-runs even though it was already attempted).
   */
  const runSearch = (q: string, force = false): void => {
    const target = uidRef.current;
    const trimmed = q.trim();
    if (!target) return;
    if (trimmed.length === 0) {
      reqIdRef.current += 1;      // invalidate any in-flight request
      setHits(null);
      setBusy(false);
      return;
    }
    if (!force && trimmed === lastRanRef.current) return;
    lastRanRef.current = trimmed;
    const id = ++reqIdRef.current;
    setBusy(true);
    void searchInBook(target, trimmed, null)
      .then((res) => {
        if (id !== reqIdRef.current) return;      // stale response
        setHits(res);
        setRecent((prev) => writeRecent([trimmed, ...prev.filter((r) => r !== trimmed)]));
      })
      .catch((e) => {
        if (id !== reqIdRef.current) return;
        setHits(null);
        useUiStore.getState().toast(errMsg(e), 'error');
      })
      .finally(() => {
        if (id === reqIdRef.current) setBusy(false);
      });
  };
  const runSearchRef = useRef(runSearch);
  runSearchRef.current = runSearch;

  // 150 ms debounce (§5.6); cancelled on unmount so a late timer can't fire.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => runSearchRef.current(query), DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, uid]);

  // Refresh the index status when the panel opens / the book changes.
  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    void getIndexStatus(uid)
      .then((st) => { if (!cancelled) setIndexStatus(st); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [uid, setIndexStatus]);

  // Live index events (§4.5): progress updates the counter, done re-runs the pending query.
  useEffect(() => {
    if (!uid) return;
    const unsubs: (() => void)[] = [];
    let disposed = false;
    const track = (p: Promise<() => void>) => {
      void p.then((un) => { if (disposed) un(); else unsubs.push(un); }).catch(() => {});
    };
    track(onEvent('index-progress', (ev) => {
      if (ev.bookUid !== uid) return;
      setProgress({ done: ev.done, total: ev.total });
      setIndexStatus({ state: 'indexing', chaptersDone: ev.done, chaptersTotal: ev.total });
    }));
    track(onEvent('index-done', (ev) => {
      if (ev.bookUid !== uid) return;
      setProgress(null);
      setIndexStatus({ state: 'ready', chaptersDone: 0, chaptersTotal: 0 });
      // Auto-run the query typed while the index was still building.
      const { query: q, hits: h } = stateRef.current;
      if (q.trim().length > 0 && h === null) runSearchRef.current(q, true);
    }));
    track(onEvent('index-error', (ev) => {
      if (ev.bookUid !== uid) return;
      setProgress(null);
      setIndexStatus({ state: 'error', chaptersDone: 0, chaptersTotal: 0 });
      useUiStore.getState().toast(errMsg(ev.message), 'error');
    }));
    return () => {
      disposed = true;
      for (const un of unsubs) un();
    };
  }, [uid, setIndexStatus]);

  // Esc clears the input first; a second Esc closes the drawer. App's window-level capture
  // handler closes the overlay unconditionally, so this one runs first (capture listeners fire
  // in registration order) and swallows the event while there is text to clear.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (stateRef.current.query.length === 0) return;
      e.stopPropagation();
      e.preventDefault();
      setQuery('');
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const onBuild = () => {
    if (!uid) return;
    setTriedBuild(true);
    setProgress(null);
    setIndexStatus({ state: 'indexing', chaptersDone: 0, chaptersTotal: 0 });
    void reindexBook(uid, true).catch((e) => {
      setIndexStatus({ state: 'error', chaptersDone: 0, chaptersTotal: 0 });
      useUiStore.getState().toast(errMsg(e), 'error');
    });
  };

  const onHit = (hit: SearchHit) => {
    jumpToHit(hit, query);
    useUiStore.getState().setOverlay(null);
  };

  const onChip = (r: string) => {
    setQuery(r);
    runSearch(r, true);
  };

  const onDropRecent = (r: string, e: ReactMouseEvent) => {
    e.stopPropagation();
    setRecent((prev) => writeRecent(prev.filter((item) => item !== r)));
  };

  const showRecent = query.trim().length === 0;
  const done = progress?.done ?? indexStatus.chaptersDone;
  const total = progress?.total ?? indexStatus.chaptersTotal;

  const body = (() => {
    if (indexStatus.state === 'indexing') {
      return (
        <div className="vel-sp-progress" data-testid="index-progress">
          <Spinner size={15} label="Indexing" />
          <span className="vellum-num">{`Indexing… ${done}/${total}`}</span>
        </div>
      );
    }
    if (indexStatus.state === 'none') {
      return (
        <div className="vel-sp-center">
          <p className="vel-sp-state">No index built</p>
          <button type="button" className="vel-sp-btn" onClick={onBuild}>
            Build index
          </button>
        </div>
      );
    }
    if (indexStatus.state === 'error') {
      return (
        <div className="vel-sp-center">
          <p className="vel-sp-state">Indexing error</p>
          <button type="button" className="vel-sp-btn" onClick={onBuild}>
            {triedBuild ? 'Retry' : 'Build index'}
          </button>
        </div>
      );
    }
    if (showRecent) {
      return (
        <div className="vel-sp-body">
          <p className="vel-sp-hint">Searches the whole book</p>
          {recent.length > 0 && (
            <>
              <p className="vel-sp-label">Recent searches</p>
              <div className="vel-sp-chips">
                {recent.map((r) => (
                  <span key={r} className="vel-sp-chip">
                    <button type="button" className="vel-sp-chip-btn" onClick={() => onChip(r)}>
                      <span>{r}</span>
                    </button>
                    <button
                      type="button"
                      className="vel-sp-chip-x"
                      aria-label={`Remove “${r}” from recents`}
                      onClick={(e) => onDropRecent(r, e)}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      );
    }
    if (busy && hits === null) {
      return (
        <div className="vel-sp-progress">
          <Spinner size={15} label="Search" />
        </div>
      );
    }
    if (hits === null) {
      return <div className="vel-sp-body" />;
    }
    if (hits.length === 0) {
      return (
        <div className="vel-sp-center">
          <p className="vel-sp-state">Nothing found</p>
        </div>
      );
    }
    return (
      <div className="vel-sp-body">
        <p className={cn('vel-sp-count', 'vellum-num')}>{`Found: ${hits.length}`}</p>
        <div role="list">
          {hits.map((hit, i) => (
            <button
              key={`${hit.chapterIdx}-${i}`}
              type="button"
              role="listitem"
              className="vel-sp-hit"
              onClick={() => onHit(hit)}
            >
              <span className="vel-sp-hit-title">
                {chapterLabel(hit.chapterTitle, hit.chapterIdx)}
              </span>
              {/* Backend escapes the text and injects <mark> only (§4.5). */}
              <span
                className="vel-sp-snippet"
                dangerouslySetInnerHTML={{ __html: hit.snippet }}
              />
            </button>
          ))}
        </div>
      </div>
    );
  })();

  return (
    <div className="vel-sp" data-testid="search-panel">
      <style>{SEARCH_CSS}</style>
      <DrawerTabs active="search" />
      <div className="vel-sp-field">
        <span className="vel-sp-glass" aria-hidden>
          <Icon name="search" size={14} />
        </span>
        <input
          ref={inputRef}
          className="vel-sp-input"
          type="search"
          value={query}
          placeholder="Search book"
          aria-label="Search book"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (timerRef.current) clearTimeout(timerRef.current);
            runSearch(query, true);
          }}
        />
        {query.length > 0 && (
          <button
            type="button"
            className="vel-sp-clear"
            aria-label="Clear"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus();
            }}
          >
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      {body}
      {showRecent && indexStatus.state === 'ready' && (
        <p className="vel-sp-foot">Esc clears the field · Ctrl+F searches again</p>
      )}
    </div>
  );
}
