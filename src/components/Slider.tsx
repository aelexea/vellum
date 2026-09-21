/**
 * Slider — base impl (scaffold-FE; props frozen).
 * Styled input[type=range] with an optional value bubble while dragging.
 */
import { useId, useState } from 'react';
import { cn } from '@/lib/utils';

export interface SliderProps {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** Committed value (on pointer release) — for expensive settings. */
  onCommit?: (v: number) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Render the bubble text; omit to disable the bubble. */
  format?: (v: number) => string;
  className?: string;
}

export function Slider({
  value, min, max, step = 1, onChange, onCommit, ariaLabel, disabled, format, className,
}: SliderProps) {
  const id = useId();
  const [dragging, setDragging] = useState(false);
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;

  return (
    <div className={cn('relative flex w-full items-center', className)}>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        className="vellum-range h-5 w-full appearance-none bg-transparent"
        style={{
          background: 'transparent',
          // Filled track via gradient on the element background (WebKit-friendly).
          backgroundImage: `linear-gradient(to right, var(--v-accent) ${pct}%, color-mix(in srgb, var(--v-fg) 15%, transparent) ${pct}%)`,
          backgroundSize: '100% 3px',
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center',
          borderRadius: 2,
        }}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => {
          setDragging(false);
          onCommit?.(value);
        }}
        onBlur={() => setDragging(false)}
      />
      {format && dragging && (
        <span
          className="vellum-num pointer-events-none absolute -top-6 z-10 rounded-[var(--radius-sm)] border border-[var(--v-border)] bg-[var(--v-bg-raise)] px-1.5 py-0.5 text-[11px] shadow-sm"
          style={{ left: `calc(${pct}% - ${(pct / 100) * 24}px)` }}
          aria-hidden
        >
          {format(value)}
        </span>
      )}
      <style>{`
        /* base.css's unlayered input reset (border/padding) outranks Tailwind's
           @layer utilities — undo it with a class selector so the track gradient sits
           flush and the thumb centers. */
        .vellum-range { border: 0; padding: 0; background: none; appearance: none; }
        .vellum-range::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px; height: 14px; border-radius: 50%;
          background: var(--v-accent); border: 2px solid var(--v-bg-alt);
          box-shadow: 0 0 0 1px var(--v-border);
          cursor: pointer;
          transition: transform var(--dur-fast) var(--ease);
        }
        .vellum-range::-webkit-slider-thumb:hover { transform: scale(1.15); }
        .vellum-range::-moz-range-thumb {
          width: 14px; height: 14px; border-radius: 50%;
          background: var(--v-accent); border: 2px solid var(--v-bg-alt);
          box-shadow: 0 0 0 1px var(--v-border);
          cursor: pointer;
        }
        .vellum-range:disabled { opacity: .45; }
      `}</style>
    </div>
  );
}

export default Slider;
