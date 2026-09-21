/**
 * ReviewSession — [F4] per §5.8/§4.6: full-screen review overlay.
 * Progress bar + card (front: word, back: translation/definition/context/examples)
 * with a 200 ms crossfade (no 3D flip) and four grade buttons whose interval previews
 * are computed client-side from the SM-2 lite formulas (§4.6).
 *
 * Keys: Space flip · 1–4 grade · Esc exit (App's global handler closes the overlay).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Icon } from '@/components/icons';
import { Spinner } from '@/components/Spinner';
import type { ReviewResult, VocabWord } from '@/lib/types';
import { clamp } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';

const DAY_MS = 86_400_000;
const EASE_DEFAULT = 2.5;   // §4.6 default; fallback only — VocabWord carries the real `ease`
const AGAIN_MINUTES = 10;

export type GradeId = ReviewResult;

export const GRADES: { id: GradeId; label: string; key: string }[] = [
  { id: 'again', label: 'Again', key: '1' },
  { id: 'hard', label: 'Hard', key: '2' },
  { id: 'good', label: 'Good', key: '3' },
  { id: 'easy', label: 'Easy', key: '4' },
];

/** '10m' / '3h' / '1d' — days rounded, minimum 1 (§5.8 preview format). */
export function fmtInterval(minutes: number): string {
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.max(1, Math.round(hours))}h`;
  return `${Math.max(1, Math.round(hours / 24))}d`;
}

/**
 * §4.6 SM-2 lite preview for a grade on `word`:
 * again → 10m; hard → interval × 1.2 (first review: 1d); good → interval × ease
 * (first: 1d); easy → first 3d, else interval × ease × 1.3.
 */
export function intervalPreview(word: VocabWord, grade: GradeId): string {
  if (grade === 'again') return fmtInterval(AGAIN_MINUTES);

  const first = word.intervalDays === null || word.reviewCount === 0;
  const ease = word.ease ?? EASE_DEFAULT;
  const interval = word.intervalDays ?? 0;

  let days: number;
  if (grade === 'hard') days = first ? 1 : interval * 1.2;
  else if (grade === 'good') days = first ? 1 : interval * ease;
  else days = first ? 3 : interval * ease * 1.3;

  return fmtInterval(days * 24 * 60);
}

/** Tint per grade: "Again" red, the rest a subtle neutral → accent ramp (§5.8). */
function gradeStyle(id: GradeId): CSSProperties {
  switch (id) {
    case 'again':
      return {
        background: 'color-mix(in srgb, #c2524a 12%, transparent)',
        borderColor: 'color-mix(in srgb, #c2524a 35%, transparent)',
        color: 'color-mix(in srgb, #c2524a 88%, var(--v-fg))',
      };
    case 'hard':
      return {
        background: 'var(--v-bg-alt)',
        borderColor: 'var(--v-border)',
        color: 'var(--v-fg)',
      };
    case 'good':
      return {
        background: 'color-mix(in srgb, var(--v-accent) 12%, transparent)',
        borderColor: 'color-mix(in srgb, var(--v-accent) 30%, transparent)',
        color: 'var(--v-fg)',
      };
    case 'easy':
      return {
        background: 'color-mix(in srgb, var(--v-accent) 24%, transparent)',
        borderColor: 'color-mix(in srgb, var(--v-accent) 45%, transparent)',
        color: 'var(--v-accent)',
      };
  }
}

type Phase = 'loading' | 'empty' | 'review' | 'summary';

/** Words due tomorrow (calendar day) — shown on the "All done for today" pane. */
function dueTomorrowCount(words: VocabWord[], now: number = Date.now()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const from = start.getTime() + DAY_MS;
  const to = from + DAY_MS;
  return words.filter((w) => w.dueAt !== null && w.dueAt >= from && w.dueAt < to).length;
}

function pluralWords(n: number): string {
  return Math.abs(n) === 1 ? 'word' : 'words';
}

export default function ReviewSession() {
  const queue = useVocabStore((s) => s.queue);
  const queuePos = useVocabStore((s) => s.queuePos);
  const words = useVocabStore((s) => s.words);
  const [phase, setPhase] = useState<Phase>('loading');
  const [revealed, setRevealed] = useState(false);

  // ------------------------------------------------------------- start / end
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const vocab = useVocabStore.getState();
      if (vocab.queue.length === 0) await vocab.startReview();
      if (cancelled) return;
      const st = useVocabStore.getState();
      if (st.queue.length === 0) {
        setPhase('empty');
        // `words` feeds the due-tomorrow hint; only needed on the empty pane.
        if (st.words.length === 0) void st.load();
      } else {
        setPhase('review');
      }
    })();
    return () => {
      cancelled = true;
      // Flush the session counter + summary toast on any exit path (Esc, ×, Close).
      useVocabStore.getState().endReview();
    };
  }, []);

  const card = queuePos < queue.length ? queue[queuePos] : null;

  useEffect(() => {
    if (phase !== 'review') return;
    if (card === null) setPhase('summary');
  }, [phase, card]);

  useEffect(() => {
    setRevealed(false);
  }, [queuePos]);

  const flip = useCallback(() => setRevealed(true), []);

  const grade = useCallback(async (result: GradeId) => {
    if (!useVocabStore.getState().queue[useVocabStore.getState().queuePos]) return;
    await useVocabStore.getState().review(result);
  }, []);

  const requestClose = useCallback(async () => {
    const reviewed = useVocabStore.getState().reviewedThisSession;
    if (reviewed > 0) {
      const ok = await useUiStore.getState().confirm({
        title: 'End review?',
        message: `Words reviewed: ${reviewed}`,
        confirmLabel: 'End',
        cancelLabel: 'Cancel',
      });
      if (!ok) return;
    }
    useUiStore.getState().setOverlay(null);
  }, []);

  // ------------------------------------------------------------------ keys
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (phase !== 'review') return;

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        if (!revealed) flip();
        return;
      }
      if (revealed) {
        const g = GRADES.find((x) => x.key === e.key);
        if (g) {
          e.preventDefault();
          void grade(g.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, revealed, flip, grade]);

  const total = queue.length;
  const index = clamp(queuePos + 1, 1, Math.max(1, total));
  const progress = total > 0 ? clamp(queuePos / total, 0, 1) : 0;
  const reviewed = useVocabStore((s) => s.reviewedThisSession);
  const tomorrow = useMemo(() => dueTomorrowCount(words), [words]);

  return (
    <div
      data-testid="review-session"
      className="fixed inset-0 z-[60] flex flex-col bg-[var(--v-bg)]"
      role="dialog"
      aria-modal="true"
      aria-label="Review"
    >
      {/* ---------------------------------------------------------- progress */}
      <div className="flex items-center gap-3 px-5 pt-4">
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--v-border)]">
          <div
            data-testid="review-progress"
            className="h-full rounded-full bg-[var(--v-accent)]"
            style={{
              width: `${progress * 100}%`,
              transition: 'width 200ms var(--ease)',
            }}
          />
        </div>
        {phase === 'review' && (
          <span className="vellum-num shrink-0 text-[12px] text-[var(--v-fg-muted)]">
            {index} / {total}
          </span>
        )}
        <button
          type="button"
          className="vellum-icon-btn h-8 w-8 shrink-0"
          aria-label="Close"
          onClick={() => void requestClose()}
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      {/* -------------------------------------------------------------- body */}
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-6">
        {phase === 'loading' && (
          <div className="text-[var(--v-fg-muted)]">
            <Spinner size={22} />
          </div>
        )}

        {phase === 'empty' && (
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="text-[var(--v-accent)]">
              <Icon name="check" size={28} />
            </span>
            <p className="text-[17px] font-semibold">All done for today</p>
            <p className="vellum-num max-w-[300px] text-[13px] text-[var(--v-fg-muted)]">
              {tomorrow > 0
                ? `Due tomorrow: ${tomorrow} ${pluralWords(tomorrow)}`
                : 'New reviews will appear once words become due'}
            </p>
            <button
              type="button"
              className="vellum-btn mt-1"
              onClick={() => useUiStore.getState().setOverlay(null)}
            >
              Close
            </button>
          </div>
        )}

        {phase === 'summary' && (
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="text-[var(--v-accent)]">
              <Icon name="check" size={28} />
            </span>
            <p className="vellum-num text-[17px] font-semibold">
              Words reviewed: {reviewed}
            </p>
            <button
              type="button"
              className="vellum-btn mt-1"
              onClick={() => useUiStore.getState().setOverlay(null)}
            >
              Close
            </button>
          </div>
        )}

        {phase === 'review' && card && (
          <div
            className="vellum-panel flex w-full max-w-[560px] flex-col justify-between overflow-hidden bg-[var(--v-bg-raise)] p-6"
            style={{ borderRadius: 16, minHeight: 320 }}
            role="presentation"
            onClick={() => { if (!revealed) flip(); }}
          >
            {!revealed ? (
              <div
                key="front"
                data-testid="review-front"
                className="vellum-fade-in flex flex-1 flex-col items-center justify-center gap-3 text-center"
                style={{ animationDuration: '200ms' }}
              >
                <p className="text-[32px] font-semibold leading-tight">{card.word}</p>
                {card.transcription && (
                  <p className="text-[13px] text-[var(--v-fg-muted)]">{card.transcription}</p>
                )}
                <button
                  type="button"
                  className="vellum-btn mt-3"
                  onClick={(e) => {
                    e.stopPropagation();
                    flip();
                  }}
                >
                  Show translation
                </button>
                <p className="mt-auto pt-4 text-[11px] text-[var(--v-fg-muted)]">
                  Space to show translation
                </p>
              </div>
            ) : (
              <div
                key="back"
                data-testid="review-back"
                className="vellum-fade-in flex flex-1 flex-col"
                style={{ animationDuration: '200ms' }}
              >
                <p className="text-center text-[24px] font-semibold leading-tight">{card.word}</p>
                <p className="mt-2 text-center text-[20px]">
                  {card.translation ?? '—'}
                </p>

                {card.definition && (
                  <p className="mt-2 text-center text-[13px] text-[var(--v-fg-muted)]">
                    {card.definition}
                  </p>
                )}

                {card.context && (
                  <>
                    <div className="my-4 h-px bg-[var(--v-border)]" aria-hidden />
                    <p className="text-[13px] italic leading-relaxed text-[var(--v-fg)]">
                      {card.context}
                    </p>
                    {(card.bookTitle || card.chapterIdx !== null) && (
                      <p className="mt-1 text-[11px] text-[var(--v-fg-muted)]">
                        {card.bookTitle}
                        {card.chapterIdx !== null && ` · chapter ${card.chapterIdx + 1}`}
                      </p>
                    )}
                  </>
                )}

                {card.examples.length > 0 && (
                  <div className="mt-4 flex flex-col gap-1.5">
                    <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--v-fg-muted)]">
                      Examples
                    </p>
                    {card.examples.map((ex) => (
                      <p key={ex} className="text-[13px] italic text-[var(--v-fg-muted)]">
                        {ex}
                      </p>
                    ))}
                  </div>
                )}

                <div className="mt-auto grid grid-cols-4 gap-2 pt-6">
                  {GRADES.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      data-testid={`grade-${g.id}`}
                      className="flex flex-col items-center gap-0.5 rounded-[var(--radius-sm)] border px-1 py-2"
                      style={{
                        ...gradeStyle(g.id),
                        transition: 'background var(--dur-fast) var(--ease), opacity var(--dur-fast) var(--ease)',
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        void grade(g.id);
                      }}
                    >
                      <span className="text-[13px] font-medium">{g.label}</span>
                      <span className="vellum-num text-[11px] opacity-70">
                        {intervalPreview(card, g.id)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
