/**
 * ShortcutsPanel — [F3] per ARCHITECTURE.md §5.9 ("Shortcuts").
 * Rows: action label (SHORTCUT_LABELS from F2's Shortcuts.ts, read-only) + a
 * combo capture field. Click → "Press keys…" → keydown: Esc cancels, Backspace
 * clears (empty combo), otherwise serializeCombo + findConflict against every other
 * action; a conflict gets a red border + toast and is rejected.
 * "Reset all" restores DEFAULT_SHORTCUTS.
 *
 * Only frozen helpers are imported from Shortcuts.ts (F2 owns/extends that file).
 */
import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SHORTCUTS, SHORTCUT_LABELS,
  comboFromEvent, findConflict, serializeCombo,
} from '@/features/reader/Shortcuts';
import type { ShortcutAction } from '@/features/reader/Shortcuts';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

/** §5.10 map order, grouped so related actions sit together. */
const ACTION_ORDER: ShortcutAction[] = [
  'nextPage', 'prevPage', 'nextPageAlt', 'prevPageAlt', 'spaceNext',
  'nextChapter', 'prevChapter',
  'toggleSearch', 'toggleToc', 'toggleAnnotations',
  'fontInc', 'fontDec',
  'cycleTheme', 'toggleMode', 'toggleUi', 'fullscreen',
  'bookmark', 'translate', 'dictionary', 'addVocab',
  'openSettings', 'backToLibrary', 'startReview', 'quit',
];

/**
 * SHORTCUT_LABELS repeats "Next page" for three distinct actions; a short
 * parenthetical keeps the rows distinguishable without touching F2's table.
 */
const LABEL_SUFFIX: Partial<Record<ShortcutAction, string>> = {
  nextPageAlt: '(PageDown)',
  spaceNext: '(space)',
};

/** Row label from F2's frozen table (+ disambiguating suffix). */
function labelFor(action: ShortcutAction): string {
  const suffix = LABEL_SUFFIX[action];
  return suffix ? `${SHORTCUT_LABELS[action]} ${suffix}` : SHORTCUT_LABELS[action];
}

/** Keys that are modifiers only — they do not form a combo on their own. */
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta']);

export function ShortcutsPanel() {
  const shortcuts = useSettingsStore((s) => s.settings.shortcuts);
  const patch = useSettingsStore((s) => s.patch);
  const toast = useUiStore((s) => s.toast);

  const [capturing, setCapturing] = useState<string | null>(null);
  // Action whose last attempt conflicted — red border until it resolves.
  const [rejected, setRejected] = useState<string | null>(null);

  // Refs so the capture-phase listener reads fresh state without re-subscribing.
  const capturingRef = useRef<string | null>(null);
  capturingRef.current = capturing;
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    if (capturing === null) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const action = capturingRef.current;
      if (action === null) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setCapturing(null);
        setRejected(null);
        return;
      }
      if (e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        patch({ shortcuts: { [action]: '' } });
        setCapturing(null);
        setRejected(null);
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) return;   // wait for the main key

      e.preventDefault();
      e.stopPropagation();

      const combo = serializeCombo(comboFromEvent(e));
      const effective = { ...DEFAULT_SHORTCUTS, ...shortcutsRef.current };
      const clash = findConflict(effective, action, combo);
      if (clash !== null) {
        setRejected(action);
        toast(`Already assigned: ${labelFor(clash as ShortcutAction)}`, 'error');
        return;                              // reject — keep capturing
      }
      patch({ shortcuts: { [action]: combo } });
      setRejected(null);
      setCapturing(null);
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [capturing, patch, toast]);

  const effective: Record<string, string> = { ...DEFAULT_SHORTCUTS, ...shortcuts };

  return (
    <div className="flex flex-col">
      <div className="mb-1 flex items-start justify-between gap-3">
        <p className="v-set-desc">
          Click a field and press a new combination. Esc cancels, Backspace clears.
        </p>
        <button
          type="button"
          className="vellum-btn shrink-0"
          onClick={() => {
            patch({ shortcuts: { ...DEFAULT_SHORTCUTS } });
            setRejected(null);
          }}
        >
          Reset all
        </button>
      </div>

      <ul className="flex flex-col">
        {ACTION_ORDER.map((action) => {
          const combo = effective[action] ?? '';
          const isCapturing = capturing === action;
          const isRejected = rejected === action && !isCapturing;
          return (
            <li key={action} className="v-set-row !py-1.5" data-action={action}>
              <span className="v-set-label truncate">{labelFor(action)}</span>
              <div className="v-set-control justify-end">
                <button
                  type="button"
                  aria-label={`Shortcut: ${labelFor(action)}`}
                  data-capture={action}
                  aria-keyshortcuts={combo || undefined}
                  onClick={() => {
                    setRejected(null);
                    setCapturing((c) => (c === action ? null : action));
                  }}
                  className={cn(
                    'vellum-num h-7 min-w-[110px] rounded-[var(--radius-sm)] border px-2',
                    'text-[12px] transition-colors',
                    isRejected
                      ? 'border-[#b3453c] text-[#b3453c]'
                      : isCapturing
                        ? 'border-[var(--v-accent)] text-[var(--v-accent)]'
                        : 'border-[var(--v-border)] bg-[var(--v-bg-alt)]',
                  )}
                  style={{ transitionDuration: 'var(--dur-fast)', transitionTimingFunction: 'var(--ease)' }}
                >
                  {isCapturing ? 'Press keys…' : (combo || '—')}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export default ShortcutsPanel;
