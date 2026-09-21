/**
 * ContextMenu — base impl (scaffold-FE; props frozen).
 * Positioned menu opened via right-click / ⋯ button. Click-outside + Esc close.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface ContextMenuItem {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}

export interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

/** Helper for consumers: open a menu at a mouse event position. */
export function menuPosFromEvent(e: { clientX: number; clientY: number }): { x: number; y: number } {
  return { x: e.clientX, y: e.clientY };
}

export function ContextMenu({ open, x, y, items, onSelect, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    if (!open || !ref.current) { setPos({ x, y }); return; }
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - w - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - h - 4)),
    });
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onCtx = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
      else e.preventDefault();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('contextmenu', onCtx);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('contextmenu', onCtx);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="menu"
      className="vellum-panel vellum-scale-in fixed z-50 min-w-44 overflow-hidden p-1"
      style={{ top: pos.y, left: pos.x, animationDuration: '120ms' }}
    >
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          role="menuitem"
          disabled={it.disabled}
          className={cn(
            'flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-left text-[13px]',
            'transition-colors',
            it.danger ? 'text-[#c2524a] hover:bg-[#c2524a]/10' : 'hover:bg-[color-mix(in_srgb,var(--v-fg)_8%,transparent)]',
            it.disabled && 'opacity-40 hover:bg-transparent',
          )}
          style={{ transitionDuration: 'var(--dur-fast)', transitionTimingFunction: 'var(--ease)' }}
          onClick={() => {
            if (it.disabled) return;
            onSelect(it.id);
            onClose();
          }}
        >
          {it.icon}
          {it.label}
        </button>
      ))}
    </div>
  );
}

export default ContextMenu;
