/**
 * StatsView — [F4] per §5.8/§6.9: reading statistics.
 * Range segmented → get_stats(range) (direct lib call + local state), today ring vs the
 * fixed 30-min goal, div-based bar chart (week / 30-day month / last 12 days for "all"),
 * 2×2 tiles, vocab mini-tiles (→ vocab view) and a per-book top-5 list.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/icons';
import { Segmented } from '@/components/Segmented';
import type { SegmentedOption } from '@/components/Segmented';
import { Spinner } from '@/components/Spinner';
import { Tooltip } from '@/components/Tooltip';
import type { ReadingStats, StatsRange } from '@/lib/types';
import { getStats } from '@/lib/tauri';
import { cn, fmtDuration, errMsg } from '@/lib/utils';
import { useLibraryStore } from '@/stores/libraryStore';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';

const DAY_GOAL_SECONDS = 30 * 60;      // fixed daily goal (§5.8)
const DAY_MS = 86_400_000;
const DAY_LETTERS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Chart plot height (px). Bars are sized in px because Tooltip wraps each one. */
const CHART_H = 120;

const RING_SIZE = 120;
const RING_STROKE = 10;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;

const RANGE_OPTIONS: SegmentedOption<StatsRange>[] = [
  { value: 'day', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'all', label: 'All' },
];

/** Local-day key (yyyy-mm-dd) matching the backend `sessions.day`. */
function dayKey(t: number): string {
  const d = new Date(t);
  const m = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export interface Bar { key: string; seconds: number; label: string; today: boolean }

/**
 * Chart buckets per range: day/week → last 7 local days; month → last 30 thin bars;
 * all → the last 12 entries present in byDay. `byDay` is sparse (oldest first).
 */
export function buildBars(byDay: ReadingStats['byDay'], range: StatsRange, now = Date.now()): Bar[] {
  const secondsByDate = new Map<string, number>();
  for (const d of byDay) secondsByDate.set(d.date, d.seconds);

  if (range === 'all') {
    return byDay.slice(-12).map((d) => {
      const [, m, dd] = d.date.split('-');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const mi = Number(m) - 1;
      return {
        key: d.date,
        seconds: d.seconds,
        label: `${months[mi] ?? ''} ${Number(dd)}`.trim(),
        today: false,
      };
    });
  }

  const count = range === 'month' ? 30 : 7;
  const todayKey = dayKey(now);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const bars: Bar[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const t = start.getTime() - i * DAY_MS;
    const key = dayKey(t);
    const d = new Date(t);
    bars.push({
      key,
      seconds: secondsByDate.get(key) ?? 0,
      label: count === 7 ? DAY_LETTERS[(d.getDay() + 6) % 7] : `${d.getDate()}`,
      today: key === todayKey,
    });
  }
  return bars;
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--v-border)] bg-[var(--v-bg-raise)] px-3.5 py-3">
      <p className="text-[13px] text-[var(--v-fg-muted)]">{label}</p>
      <p className="vellum-num mt-1 text-[24px] font-semibold leading-none">{value}</p>
    </div>
  );
}

function MiniTile({ label, value, onClick }: { label: string; value: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-start gap-0.5 rounded-[var(--radius)] border border-[var(--v-border)] bg-[var(--v-bg-raise)] px-3 py-2 text-left transition-colors hover:border-[var(--v-accent)]"
      style={{ transitionDuration: 'var(--dur-fast)', transitionTimingFunction: 'var(--ease)' }}
    >
      <span className="vellum-num text-[17px] font-semibold leading-none">{value}</span>
      <span className="text-[11px] text-[var(--v-fg-muted)]">{label}</span>
    </button>
  );
}

export default function StatsView() {
  const [range, setRange] = useState<StatsRange>('week');
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [loading, setLoading] = useState(true);

  const vocabStats = useVocabStore((s) => s.stats);
  const books = useLibraryStore((s) => s.books);

  const fetchRange = useCallback(async (r: StatsRange) => {
    setLoading(true);
    try {
      setStats(await getStats(r));
    } catch (e) {
      setStats(null);
      useUiStore.getState().toast(errMsg(e), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRange(range);
  }, [range, fetchRange]);

  useEffect(() => {
    void useVocabStore.getState().loadStats();
    if (useLibraryStore.getState().books.length === 0) void useLibraryStore.getState().load();
  }, []);

  const bars = useMemo(
    () => buildBars(stats?.byDay ?? [], range),
    [stats, range],
  );
  const maxSeconds = Math.max(1, ...bars.map((b) => b.seconds));

  // Ring = today vs the 30-min goal: for range 'day' rangeSeconds is today; otherwise
  // pull today's entry out of byDay (the ring stays a today-ring across ranges).
  const todaySeconds = useMemo(() => {
    if (!stats) return 0;
    if (range === 'day') return stats.rangeSeconds;
    const key = dayKey(Date.now());
    return stats.byDay.find((d) => d.date === key)?.seconds ?? 0;
  }, [stats, range]);
  const ringProgress = Math.min(1, todaySeconds / DAY_GOAL_SECONDS);
  const ringDash = `${RING_CIRCUMFERENCE * ringProgress} ${RING_CIRCUMFERENCE}`;

  const topBooks = useMemo(
    () =>
      [...books]
        .sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0))
        .slice(0, 5),
    [books],
  );

  const openVocab = useCallback(() => useUiStore.getState().setView('vocab'), []);
  const isEmpty = stats !== null
    && stats.rangeSeconds === 0
    && stats.pagesTurned === 0
    && stats.byDay.every((d) => d.seconds === 0);

  return (
    <div
      className="vellum-fade-in flex h-full flex-col"
      style={{ animationDuration: '160ms' }}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-[var(--v-border)] px-5 py-3.5">
        <button
          type="button"
          className="vellum-icon-btn -ml-1.5"
          aria-label="Back to library"
          title="Back to library"
          onClick={() => useUiStore.getState().setView('library')}
        >
          <Icon name="arrowLeft" size={18} />
        </button>
        <h1 className="text-[17px] font-semibold tracking-[-0.01em]">Reading stats</h1>
        <div className="flex-1" />
        <Segmented
          options={RANGE_OPTIONS}
          value={range}
          onChange={setRange}
          ariaLabel="Stats period"
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading && !stats ? (
          <div className="flex h-40 items-center justify-center text-[var(--v-fg-muted)]">
            <Spinner size={22} />
          </div>
        ) : stats === null || isEmpty ? (
          <div className="flex h-40 items-center justify-center text-[13px] text-[var(--v-fg-muted)]">
            No stats yet — open a book
          </div>
        ) : (
          <div className="mx-auto flex max-w-[760px] flex-col gap-5">
            {/* ------------------------------------------------- ring + tiles */}
            <div className="flex flex-wrap items-center gap-5">
              <div
                className="relative shrink-0"
                style={{ width: RING_SIZE, height: RING_SIZE }}
                role="img"
                aria-label={`Read ${fmtDuration(todaySeconds)} of 30 min today`}
              >
                <svg width={RING_SIZE} height={RING_SIZE} className="-rotate-90">
                  <circle
                    cx={RING_SIZE / 2}
                    cy={RING_SIZE / 2}
                    r={RING_R}
                    fill="none"
                    stroke="var(--v-border)"
                    strokeWidth={RING_STROKE}
                  />
                  <circle
                    data-testid="stats-ring"
                    cx={RING_SIZE / 2}
                    cy={RING_SIZE / 2}
                    r={RING_R}
                    fill="none"
                    stroke="var(--v-accent)"
                    strokeWidth={RING_STROKE}
                    strokeLinecap="round"
                    strokeDasharray={ringDash}
                    style={{ transition: 'stroke-dasharray 200ms var(--ease)' }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="vellum-num text-[17px] font-semibold leading-none">
                    {fmtDuration(todaySeconds)}
                  </span>
                  <span className="mt-1 text-[11px] text-[var(--v-fg-muted)]">of 30 min</span>
                </div>
              </div>

              <div className="grid min-w-[280px] flex-1 grid-cols-2 gap-2.5">
                <Tile label="Reading time" value={fmtDuration(stats.rangeSeconds)} />
                <Tile label="Pages turned" value={String(stats.pagesTurned)} />
                <Tile label="Books" value={String(stats.booksTouched)} />
                <Tile label="Streak" value={`${stats.streakDays}d`} />
              </div>
            </div>

            {/* ------------------------------------------------------- chart */}
            <section className="rounded-[var(--radius)] border border-[var(--v-border)] bg-[var(--v-bg-raise)] px-4 py-3.5">
              <div
                className="grid items-end gap-1"
                style={{
                  height: CHART_H,
                  gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))`,
                }}
                data-testid="stats-chart"
              >
                {bars.map((b) => (
                  <Tooltip
                    key={b.key}
                    label={b.seconds > 0 ? fmtDuration(b.seconds) : '0m'}
                    placement="top"
                  >
                    <div
                      data-testid="stats-bar"
                      data-today={b.today || undefined}
                      className={cn(
                        'w-full rounded-t-[3px]',
                        b.today ? 'bg-[var(--v-accent)]' : 'bg-[color-mix(in_srgb,var(--v-fg)_18%,transparent)]',
                      )}
                      style={{
                        height: b.seconds > 0
                          ? `${Math.max(3, Math.round((b.seconds / maxSeconds) * (CHART_H - 8)))}px`
                          : '0px',
                        transition: 'height 200ms var(--ease)',
                      }}
                    />
                  </Tooltip>
                ))}
              </div>
              <div
                className="mt-1.5 grid gap-1"
                style={{ gridTemplateColumns: `repeat(${bars.length}, minmax(0, 1fr))` }}
              >
                {bars.map((b) => (
                  <span
                    key={b.key}
                    className={cn(
                      'min-w-0 truncate text-center text-[10px]',
                      b.today ? 'text-[var(--v-accent)]' : 'text-[var(--v-fg-muted)]',
                    )}
                  >
                    {b.label}
                  </span>
                ))}
              </div>
            </section>

            {/* -------------------------------------------------- vocab tiles */}
            <section className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <MiniTile label="Total words" value={vocabStats.total} onClick={openVocab} />
              <MiniTile label="Learning" value={vocabStats.byStatus.learning} onClick={openVocab} />
              <MiniTile label="Known" value={vocabStats.byStatus.known} onClick={openVocab} />
              <MiniTile label="Due for review" value={vocabStats.dueToday} onClick={openVocab} />
            </section>

            {/* ----------------------------------------------------- per book */}
            {topBooks.length > 0 && (
              <section className="flex flex-col gap-2">
                <p className="text-[12px] font-medium text-[var(--v-fg-muted)]">Books</p>
                {topBooks.map((b) => (
                  <div
                    key={b.uid}
                    className="flex items-center gap-3 rounded-[var(--radius)] border border-[var(--v-border)] bg-[var(--v-bg-raise)] px-3.5 py-2"
                  >
                    <span className="text-[var(--v-fg-muted)]">
                      <Icon name="book" size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px]">{b.title}</p>
                      <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-[var(--v-border)]">
                        <div
                          className="h-full rounded-full bg-[var(--v-accent)]"
                          style={{ width: `${Math.round(Math.min(1, Math.max(0, b.progress)) * 100)}%` }}
                        />
                      </div>
                    </div>
                    <span className="vellum-num shrink-0 text-[12px] text-[var(--v-fg-muted)]">
                      {Math.round(Math.min(1, Math.max(0, b.progress)) * 100)} %
                    </span>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
