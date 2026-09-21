/**
 * ImportBar — [F1] per ARCHITECTURE.md §5.5.
 *
 * The thin 2 px accent progress bar under the library header. Driven entirely by the frozen
 * libraryStore: `importing` gates visibility, `importProgress` (from the backend
 * `import-progress` event) makes it determinate. The "Books added: N" finish toast is the
 * store's job (reportToast), not this component's.
 *
 * Renders as an absolutely positioned strip so appearing/disappearing never shifts the layout.
 * Mount it inside a `relative` header.
 */
import { cn } from '@/lib/utils';
import { useLibraryStore } from '@/stores/libraryStore';

export interface ImportBarProps {
  className?: string;
}

export function ImportBar({ className }: ImportBarProps) {
  const importing = useLibraryStore((s) => s.importing);
  const progress = useLibraryStore((s) => s.importProgress);

  if (!importing) return null;

  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const determinate = total > 0;
  const pct = determinate ? Math.min(100, Math.round((done / total) * 100)) : 0;

  return (
    <div
      role="progressbar"
      aria-label="Importing books"
      aria-valuenow={determinate ? pct : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      data-testid="import-bar"
      className={cn(
        'pointer-events-none absolute inset-x-0 bottom-0 z-20 h-[2px] overflow-hidden',
        'bg-[color-mix(in_srgb,var(--v-accent)_16%,transparent)]',
        className,
      )}
    >
      {determinate
        ? (
          <div
            data-testid="import-bar-fill"
            className="h-full bg-[var(--v-accent)]"
            style={{ width: `${pct}%`, transition: 'width var(--dur-med) var(--ease)' }}
          />
        )
        : (
          <div
            data-testid="import-bar-sweep"
            className="vellum-import-sweep h-full w-1/3 bg-[var(--v-accent)]"
          />
        )}
      <style>{`
        @keyframes vellum-import-sweep {
          from { transform: translateX(-100%); }
          to { transform: translateX(400%); }
        }
        .vellum-import-sweep { animation: vellum-import-sweep 1100ms linear infinite; }
      `}</style>
    </div>
  );
}

export default ImportBar;
