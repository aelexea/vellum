/**
 * Switch — base impl (scaffold-FE; props frozen).
 * Toggle with text label; role="switch" + aria-checked.
 */
import { useId } from 'react';
import { cn } from '@/lib/utils';

export interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

export function Switch({
  checked, onChange, label, description, disabled, className,
}: SwitchProps) {
  const id = useId();

  const toggle = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cn(
        'relative h-[20px] w-[34px] shrink-0 rounded-full border transition-colors',
        'disabled:opacity-40',
        checked
          ? 'border-transparent bg-[var(--v-accent)]'
          : 'border-[var(--v-border)] bg-[var(--v-bg)]',
      )}
      style={{ transitionDuration: 'var(--dur-fast)', transitionTimingFunction: 'var(--ease)' }}
      onClick={() => onChange(!checked)}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[14px] w-[14px] rounded-full bg-[var(--v-bg-raise)] shadow-sm',
          'transition-transform',
          checked ? 'translate-x-[17px]' : 'translate-x-[2px]',
        )}
        style={{
          transitionDuration: 'var(--dur-fast)',
          transitionTimingFunction: 'var(--ease)',
          background: checked ? 'var(--v-accent-fg)' : 'var(--v-fg-muted)',
        }}
      />
    </button>
  );

  if (!label && !description) return <span className={className}>{toggle}</span>;

  return (
    <div className={cn('flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-[13px]">{label}</label>
        {description && (
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--v-fg-muted)]">{description}</p>
        )}
      </div>
      {toggle}
    </div>
  );
}

export default Switch;
