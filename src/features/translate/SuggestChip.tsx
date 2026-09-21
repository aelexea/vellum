/**
 * SuggestChip — bottom-center pill offering to add a frequently looked-up word (§5.7).
 * Owned by [F6]. Self-wiring: App mounts it while vocabStore.suggest !== null.
 * "Add" → prefilled vocabStore.add (toast "Word added" comes from the store);
 * "×" → dismissSuggest + module-level session suppression for the same word.
 * Auto-dismisses after 12 s (timer resets per new suggest). z-[55]: above popups/menus
 * (40/50), below toasts (60) — the frozen tier scale.
 */
import { useEffect } from 'react';
import { useVocabStore } from '@/stores/vocabStore';

const AUTO_DISMISS_MS = 12_000;

/** word_norms dismissed via "×" or auto-dismiss — never re-suggested this session. */
const suppressed = new Set<string>();

const norm = (w: string): string => w.toLowerCase().trim();

function pluralTimes(n: number): string {
  return Math.abs(n) === 1 ? 'time' : 'times';
}

export default function SuggestChip() {
  const suggest = useVocabStore((s) => s.suggest);
  const setSuggest = useVocabStore((s) => s.setSuggest);
  const dismissSuggest = useVocabStore((s) => s.dismissSuggest);
  const add = useVocabStore((s) => s.add);

  const key = suggest ? norm(suggest.word) : null;

  // Auto-dismiss 12 s after each new suggest.
  useEffect(() => {
    if (!suggest) return;
    const timer = setTimeout(() => {
      const s = useVocabStore.getState().suggest;
      if (s) {
        suppressed.add(norm(s.word));
        dismissSuggest();
      }
    }, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [suggest, dismissSuggest]);

  if (!suggest || (key !== null && suppressed.has(key))) return null;

  const onAdd = async () => {
    const s = useVocabStore.getState().suggest;
    if (!s) return;
    await add({
      word: s.word,
      translation: s.translation,
      definition: s.definition,
      transcription: s.transcription,
      pos: s.pos,
      context: s.context,
      contextCfi: s.contextCfi,
      bookUid: s.bookUid,
      chapterIdx: s.chapterIdx,
    });
    setSuggest(null);
  };

  const onDismiss = () => {
    suppressed.add(norm(suggest.word));
    dismissSuggest();
  };

  return (
    <div
      data-testid="suggest-chip"
      role="status"
      className="vellum-chip-in fixed bottom-6 left-1/2 z-[55] flex items-center gap-2.5 rounded-full border border-[var(--v-border)] px-4 py-2 text-[13px]"
      style={{
        background: 'var(--v-bg-raise)',
        boxShadow: 'var(--v-shadow)',
        transform: 'translateX(-50%)',
      }}
    >
      <style>{`
        @keyframes vellum-chip-in {
          from { opacity: 0; transform: translateX(-50%) translateY(10px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        .vellum-chip-in { animation: vellum-chip-in 180ms var(--ease); }
      `}</style>
      <span className="vellum-selectable text-[var(--v-fg)]">
        The word “{suggest.word}” appeared {suggest.lookupCount} {pluralTimes(suggest.lookupCount)}. Add to vocabulary?
      </span>
      <button
        type="button"
        className="vellum-btn vellum-btn-accent shrink-0 !h-7 !px-2.5 !text-[12px]"
        onClick={onAdd}
      >
        Add
      </button>
      <button
        type="button"
        className="vellum-icon-btn shrink-0 !h-6 !w-6"
        aria-label="Close"
        onClick={onDismiss}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
