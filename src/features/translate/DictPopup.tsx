/**
 * DictPopup — anchored dictionary card (§5.7). Owned by [F6].
 * Self-wiring: App mounts it when uiStore.overlay === 'dict'. One lookupWord call per
 * word (via vocabStore.lookup, which also propagates `suggest` for SuggestChip);
 * synonym chips re-run the lookup for the synonym. z-50 = frozen overlay tier.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LookupResult } from '@/lib/types';
import { clamp, cn } from '@/lib/utils';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';

const POPUP_W = 420;
const EST_H = 300;
const MARGIN = 12;

function Skeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2">
      {[100, 70, 90, 55].map((w, i) => (
        <span
          key={i}
          className="vellum-pulse block h-3 rounded-[var(--radius-sm)]"
          style={{ width: `${w}%`, background: 'color-mix(in srgb, var(--v-fg) 10%, transparent)' }}
        />
      ))}
      <style>{`
        .vellum-pulse { animation: vellum-pulse 1.2s var(--ease) infinite; }
        @keyframes vellum-pulse { 0%,100% { opacity:1; } 50% { opacity:.45; } }
      `}</style>
    </div>
  );
}

export default function DictPopup() {
  const selection = useReaderStore((s) => s.selection);
  const book = useReaderStore((s) => s.book);
  const chapterIdx = useReaderStore((s) => s.chapterIdx);
  const setOverlay = useUiStore((s) => s.setOverlay);
  const lookup = useVocabStore((s) => s.lookup);
  const addWord = useVocabStore((s) => s.add);

  const [result, setResult] = useState<LookupResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [word, setWord] = useState<string>(() => selection?.word ?? selection?.text ?? '');
  const [nonce, setNonce] = useState(0);

  const cardRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!word) { setLoading(false); return; }
    const id = ++reqId.current;
    setLoading(true);
    setError(false);
    const ctx = book
      ? {
        bookUid: book.book.uid,
        chapterIdx,
        sentence: selection?.sentence ?? '',
        cfi: selection?.cfiStart ?? '',
      }
      : null;
    lookup(word, ctx)
      .then((r) => {
        if (id !== reqId.current) return;
        if (r && (r.dictionary || r.translation)) setResult(r);
        else { setResult(null); setError(true); }
        setLoading(false);
      })
      .catch(() => {
        if (id === reqId.current) { setResult(null); setError(true); setLoading(false); }
      });
  }, [word, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) setOverlay(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOverlay(null); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [setOverlay]);

  const pos = useMemo(() => {
    const rect = selection?.rect;
    if (!rect) return { left: MARGIN, top: MARGIN };
    const left = clamp(rect.x, MARGIN, Math.max(MARGIN, window.innerWidth - POPUP_W - MARGIN));
    let top = rect.y + rect.height + 8;
    if (top + EST_H > window.innerHeight && rect.y - EST_H - 8 > 0) {
      top = rect.y - EST_H - 8;
    }
    return { left, top };
  }, [selection]);

  const openSynonym = (syn: string) => {
    setWord(syn);
    setResult(null);
  };

  const inVocab = result?.alreadyInVocab ?? false;
  const onAdd = async () => {
    if (!word || inVocab) return;
    const dict = result?.dictionary;
    const first = dict?.meanings[0]?.definitions[0] ?? null;
    await addWord({
      word,
      translation: result?.translation?.translatedText ?? null,
      definition: first?.definition ?? null,
      transcription: dict?.transcription ?? null,
      pos: dict?.meanings[0]?.pos ?? null,
      examples: first?.example ? [first.example] : [],
      context: selection?.sentence ?? null,
      bookUid: book?.book.uid ?? null,
      chapterIdx: book ? chapterIdx : null,
      contextCfi: selection?.cfiStart ?? null,
    });
    setOverlay(null);
  };

  return (
    <div
      ref={cardRef}
      data-testid="dict-popup"
      role="dialog"
      aria-label="Dictionary"
      className="vellum-scale-in fixed z-50 max-h-[70vh] max-w-[420px] overflow-y-auto border border-[var(--v-border)] p-3"
      style={{
        left: pos.left,
        top: pos.top,
        width: POPUP_W,
        background: 'var(--v-bg-raise)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--v-shadow)',
        animationDuration: '160ms',
        animationTimingFunction: 'var(--ease)',
      }}
    >
      {/* head */}
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-[20px] font-semibold text-[var(--v-fg)]">{word}</h3>
          {result?.dictionary?.transcription && (
            <p className="text-[12px] text-[var(--v-fg-muted)]">{result.dictionary.transcription}</p>
          )}
        </div>
        <button
          type="button"
          className={cn(
            'vellum-btn shrink-0 !h-7 !px-2 !text-[12px]',
            !inVocab && 'vellum-btn-accent',
          )}
          disabled={inVocab || loading || error}
          aria-label={inVocab ? 'Already in vocabulary' : 'Add to vocabulary'}
          onClick={onAdd}
        >
          {inVocab ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          )}
          {inVocab ? 'Already in vocabulary' : 'Add to vocabulary'}
        </button>
      </div>

      {/* body */}
      {loading ? (
        <Skeleton />
      ) : error ? (
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-[var(--v-fg-muted)]">Dictionary unavailable</span>
          <button
            type="button"
            className="vellum-btn !h-7 !px-2 !text-[12px]"
            onClick={() => setNonce((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      ) : (
        <>
          {result?.dictionary && result.dictionary.meanings.length > 0 ? (
            <div className="flex flex-col gap-3">
              {result.dictionary.meanings.map((m, mi) => (
                <section key={`${m.pos ?? 'other'}-${mi}`}>
                  {m.pos && (
                    <span className="mb-1.5 inline-block rounded-full border border-[var(--v-border)] px-2 py-0.5 text-[11px] uppercase text-[var(--v-fg-muted)]">
                      {m.pos}
                    </span>
                  )}
                  <ul className="flex flex-col gap-1.5">
                    {m.definitions.map((d, di) => (
                      <li key={di} className="text-[13px]">
                        <span className="vellum-selectable text-[var(--v-fg)]">{d.definition}</span>
                        {d.example && (
                          <p className="vellum-selectable mt-0.5 italic text-[var(--v-fg-muted)]">
                            “{d.example}”
                          </p>
                        )}
                        {d.synonyms.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {d.synonyms.map((syn) => (
                              <button
                                key={syn}
                                type="button"
                                className="rounded-full border border-[var(--v-border)] px-2 py-0.5 text-[11px] text-[var(--v-fg-muted)] transition-colors hover:border-[var(--v-accent)] hover:text-[var(--v-accent)]"
                                style={{ transitionDuration: 'var(--dur-fast)', transitionTimingFunction: 'var(--ease)' }}
                                onClick={() => openSynonym(syn)}
                              >
                                {syn}
                              </button>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : result?.translation ? (
            <div>
              <p className="vellum-selectable text-[15px] text-[var(--v-fg)]">
                {result.translation.translatedText}
              </p>
              <p className="mt-2 text-[11px] text-[var(--v-fg-muted)]">
                Definitions are available for English words
              </p>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
