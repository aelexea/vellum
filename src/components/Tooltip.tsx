/**
 * Tooltip — base impl (scaffold-FE; F6 polished internals, props frozen).
 * Hover with 400 ms delay; also shows on keyboard focus. Clamped to the viewport
 * (margin shift) so tips near window edges stay readable.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';

export interface TooltipProps {
  label: string;
  children: ReactElement;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  delay?: number;
  disabled?: boolean;
}

export function Tooltip({
  label, children, placement = 'top', delay = 400, disabled,
}: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [shift, setShift] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // Keep the tip inside the viewport: nudge along the free axis via margin
  // (inline transforms would fight the Tailwind centering translate classes).
  useLayoutEffect(() => {
    if (!visible || !tipRef.current) { setShift(0); return; }
    const r = tipRef.current.getBoundingClientRect();
    const pad = 4;
    let dx = 0;
    if (r.left < pad) dx = pad - r.left;
    else if (r.right > window.innerWidth - pad) dx = (window.innerWidth - pad) - r.right;
    let dy = 0;
    if (r.top < pad) dy = pad - r.top;
    else if (r.bottom > window.innerHeight - pad) dy = (window.innerHeight - pad) - r.bottom;
    setShift(placement === 'left' || placement === 'right' ? dy : dx);
  }, [visible, label, placement]);

  const show = () => {
    if (disabled) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setVisible(true), delay);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setVisible(false);
  };

  const vertical = placement === 'left' || placement === 'right';

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={show}
      onBlurCapture={hide}
    >
      {children}
      {visible && (
        <span
          ref={tipRef}
          role="tooltip"
          className={cn(
            'pointer-events-none absolute z-50 whitespace-nowrap rounded-[var(--radius-sm)]',
            'border border-[var(--v-border)] bg-[var(--v-bg-raise)] px-2 py-1 text-[11px]',
            'text-[var(--v-fg)] shadow-sm vellum-fade-in',
            placement === 'top' && 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
            placement === 'bottom' && 'top-full left-1/2 mt-1.5 -translate-x-1/2',
            placement === 'left' && 'right-full top-1/2 mr-1.5 -translate-y-1/2',
            placement === 'right' && 'left-full top-1/2 ml-1.5 -translate-y-1/2',
          )}
          style={{
            animationDuration: '120ms',
            marginLeft: vertical ? 0 : shift,
            marginTop: vertical ? shift : 0,
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

export default Tooltip;
