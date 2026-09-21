/**
 * Toast + ToastHost — base impl (scaffold-FE; F6 polished internals, props frozen).
 * ToastHost renders uiStore.toasts (bottom-center stack, auto-dismiss in the store).
 * Entry: subtle slide-up + fade 180 ms. Stacking follows the frozen overlay scale
 * (popover 40 · menus/modals/popups 50 · suggest chip 55 · toasts 60).
 */
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';
import type { ToastKind } from '@/stores/uiStore';

export interface ToastProps {
  msg: string;
  kind?: ToastKind;
  onDismiss?: () => void;
}

export function Toast({ msg, kind = 'info', onDismiss }: ToastProps) {
  return (
    <div
      role="status"
      className={cn(
        'vellum-panel flex items-center gap-2 px-3 py-2 text-[13px] vellum-toast-in',
        kind === 'error' && 'border-[#b3453c]/60',
      )}
      style={{ animationDuration: '180ms' }}
    >
      {kind === 'error' && (
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: '#b3453c' }} aria-hidden />
      )}
      {kind === 'success' && (
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--v-accent)' }} aria-hidden />
      )}
      <span className="vellum-selectable">{msg}</span>
      {onDismiss && (
        <button
          type="button"
          className="vellum-icon-btn ml-1 !h-5 !w-5"
          aria-label="Close"
          onClick={onDismiss}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** Mounted once in App.tsx (§5.12). */
export function ToastHost() {
  const toasts = useUiStore((s) => s.toasts);
  const dismiss = useUiStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed bottom-20 left-1/2 z-[60] flex -translate-x-1/2 flex-col-reverse items-center gap-2"
      aria-live="polite"
    >
      <style>{`
        @keyframes vellum-toast-in {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: none; }
        }
        .vellum-toast-in { animation: vellum-toast-in var(--dur-med) var(--ease); }
      `}</style>
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Toast msg={t.msg} kind={t.kind} onDismiss={() => dismiss(t.id)} />
        </div>
      ))}
    </div>
  );
}

export default Toast;
