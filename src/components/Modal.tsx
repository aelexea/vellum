/**
 * Modal — base impl (scaffold-FE; F6 polished internals, props frozen).
 * Fixed overlay (no portal), blurred backdrop, Esc closes, scale-in 160 ms,
 * Tab focus trap, autofocus (explicit [autofocus] → first field → dialog), body scroll lock.
 */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/uiStore';

export interface ModalProps {
  open?: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Tailwind width class; default max-w-md. */
  widthClass?: string;
  closeOnBackdrop?: boolean;
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function Modal({
  open = true, onClose, title, children, footer, widthClass, closeOnBackdrop = true,
}: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const el = ref.current;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !el) return;
      // Focus trap: cycle Tab within the dialog.
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || active === el || !el.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !el.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey, true);

    // Autofocus: explicit [autofocus] (React renders the attribute) → first field → dialog.
    const target = el?.querySelector<HTMLElement>('[autofocus]')
      ?? el?.querySelector<HTMLElement>('input:not([type="hidden"]),textarea,select')
      ?? el;
    target?.focus();

    // Body scroll lock while the dialog is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="presentation"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      {/* backdrop */}
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-[2px] vellum-fade-in"
        aria-hidden
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={cn(
          'vellum-panel vellum-scale-in relative w-full outline-none',
          widthClass ?? 'max-w-md',
        )}
        style={{ animationDuration: '160ms' }}
      >
        {title && (
          <header className="flex items-center justify-between border-b border-[var(--v-border)] px-4 py-2.5">
            <h2 className="text-sm font-semibold">{title}</h2>
            <button
              type="button"
              className="vellum-icon-btn"
              aria-label="Close"
              onClick={onClose}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </header>
        )}
        <div className="px-4 py-3">{children}</div>
        {footer && (
          <footer className="flex items-center justify-end gap-2 border-t border-[var(--v-border)] px-4 py-2.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

/**
 * ConfirmHost — renders uiStore.pendingConfirm (§5.12). Mounted once in App.tsx.
 * confirm()/confirmWithCheck() resolve when the user answers.
 */
export function ConfirmHost() {
  const pending = useUiStore((s) => s.pendingConfirm);
  const resolveConfirm = useUiStore((s) => s.resolveConfirm);

  return (
    <Modal
      open={pending !== null}
      onClose={() => resolveConfirm(false)}
      title={pending?.title}
      widthClass="max-w-sm"
      footer={pending && (
        <>
          <button
            type="button"
            className="vellum-btn"
            onClick={() => resolveConfirm(false)}
          >
            {pending.cancelLabel ?? 'Cancel'}
          </button>
          <button
            type="button"
            className={cn('vellum-btn', pending.danger ? 'vellum-btn-danger' : 'vellum-btn-accent')}
            style={pending.danger
              ? { background: '#b3453c', borderColor: '#b3453c', color: '#fff' }
              : undefined}
            onClick={() => {
              const box = document.getElementById('vellum-confirm-check') as HTMLInputElement | null;
              resolveConfirm(true, box?.checked ?? false);
            }}
            autoFocus
          >
            {pending.confirmLabel ?? 'Done'}
          </button>
        </>
      )}
    >
      {pending?.message && <p className="text-[13px] text-[var(--v-fg)]">{pending.message}</p>}
      {pending?.checkboxLabel && (
        <label className="mt-3 flex items-center gap-2 text-[13px] text-[var(--v-fg-muted)]">
          <input id="vellum-confirm-check" type="checkbox" defaultChecked={false} />
          {pending.checkboxLabel}
        </label>
      )}
    </Modal>
  );
}

export default Modal;
