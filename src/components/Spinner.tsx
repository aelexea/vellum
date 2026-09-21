/**
 * Spinner — base impl (scaffold-FE; props frozen).
 */
import { cn } from '@/lib/utils';

export interface SpinnerProps {
  size?: number;
  className?: string;
  label?: string;
}

export function Spinner({ size = 18, className, label = 'Loading…' }: SpinnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('vellum-spin', className)}
      role="progressbar"
      aria-label={label}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <style>{`
        @keyframes vellum-spin { to { transform: rotate(360deg); } }
        .vellum-spin { animation: vellum-spin 900ms linear infinite; }
      `}</style>
    </svg>
  );
}

export default Spinner;
