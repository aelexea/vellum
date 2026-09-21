/**
 * Popover — base impl (scaffold-FE; props frozen).
 * Anchored fixed-position panel; closes on click-outside and Esc.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end' | 'right' | 'left';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Element the popover is anchored to (fixed positioning derived from its rect). */
  anchorEl: HTMLElement | null;
  placement?: PopoverPlacement;
  children: ReactNode;
  className?: string;
  gap?: number;
}

function positionFor(
  rect: DOMRect, placement: PopoverPlacement, gap: number,
): { top: number; left: number } {
  switch (placement) {
    case 'bottom-start': return { top: rect.bottom + gap, left: rect.left };
    case 'bottom-end': return { top: rect.bottom + gap, left: rect.right };
    case 'top-start': return { top: rect.top - gap, left: rect.left };
    case 'top-end': return { top: rect.top - gap, left: rect.right };
    case 'right': return { top: rect.top + rect.height / 2, left: rect.right + gap };
    case 'left': return { top: rect.top + rect.height / 2, left: rect.left - gap };
  }
}

export function Popover({
  open, onClose, anchorEl, placement = 'bottom-start', children, className, gap = 6,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [tick, setTick] = useState(0);

  useLayoutEffect(() => {
    if (!open || !anchorEl) { setPos(null); return; }
    const rect = anchorEl.getBoundingClientRect();
    const p = positionFor(rect, placement, gap);
    // 'end' placements align the popover's right edge with the anchor's.
    if (placement === 'bottom-end' || placement === 'top-end') {
      const w = ref.current?.offsetWidth ?? 0;
      p.left -= w;
    }
    if (placement === 'left') {
      const w = ref.current?.offsetWidth ?? 0;
      p.left -= w;
    }
    if (placement === 'right' || placement === 'left') {
      const h = ref.current?.offsetHeight ?? 0;
      p.top -= h / 2;
    }
    // Keep inside the viewport.
    const w = ref.current?.offsetWidth ?? 0;
    const h = ref.current?.offsetHeight ?? 0;
    p.left = Math.max(4, Math.min(p.left, window.innerWidth - w - 4));
    p.top = Math.max(4, Math.min(p.top, window.innerHeight - h - 4));
    setPos(p);
  }, [open, anchorEl, placement, gap, tick]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)
        && !(anchorEl && anchorEl.contains(e.target as Node))) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onMove = () => setTick((t) => t + 1);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, onClose, anchorEl]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="dialog"
      className={cn('vellum-panel vellum-scale-in fixed z-40', className)}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }}
    >
      {children}
    </div>
  );
}

export default Popover;
