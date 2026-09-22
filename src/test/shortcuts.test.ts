import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHORTCUTS, SHORTCUT_LABELS, SELECTION_SCOPED_ACTIONS,
  comboFromEvent, combosEqual, displayKey, findActionForEvent, findConflict,
  normalizeKey, parseCombo, serializeCombo,
} from '@/features/reader/Shortcuts';

describe('DEFAULT_SHORTCUTS (§5.10)', () => {
  it('matches the frozen default map', () => {
    expect(DEFAULT_SHORTCUTS).toMatchObject({
      nextPage: 'Right',
      prevPage: 'Left',
      nextPageAlt: 'PageDown',
      prevPageAlt: 'PageUp',
      spaceNext: 'Space',
      nextChapter: 'Ctrl+Right',
      prevChapter: 'Ctrl+Left',
      toggleSearch: 'Ctrl+F',
      toggleToc: 'Ctrl+T',
      toggleAnnotations: 'Ctrl+Shift+A',
      fontInc: 'Ctrl+=',
      fontDec: 'Ctrl+-',
      cycleTheme: 'Ctrl+J',
      toggleMode: 'Ctrl+Shift+M',
      toggleUi: 'Ctrl+H',
      fullscreen: 'F11',
      bookmark: 'Ctrl+D',
      translate: 'Ctrl+Shift+T',
      dictionary: 'Ctrl+Shift+D',
      addVocab: 'Ctrl+Shift+V',
      openSettings: 'Ctrl+,',
      backToLibrary: 'Ctrl+L',
      startReview: 'Ctrl+Shift+R',
      quit: 'Ctrl+Q',
    });
  });

  it('every action has a label (§6.8)', () => {
    for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
      expect(SHORTCUT_LABELS[action as keyof typeof SHORTCUT_LABELS]).toBeTruthy();
    }
  });

  it('every default combo parses', () => {
    for (const [action, combo] of Object.entries(DEFAULT_SHORTCUTS)) {
      expect(parseCombo(combo), `${action}: ${combo}`).not.toBeNull();
    }
  });
});

describe('parseCombo / serializeCombo roundtrip', () => {
  const cases = [
    'Right', 'Left', 'PageDown', 'Space', 'F11',
    'Ctrl+F', 'Ctrl+Shift+A', 'Ctrl+=', 'Ctrl+-', 'Ctrl+,',
    'Ctrl+Shift+Alt+K', 'Meta+P',
  ];
  it.each(cases)('roundtrips %s', (combo) => {
    const parsed = parseCombo(combo)!;
    // serializeCombo emits a canonical modifier order (Ctrl→Shift→Alt→Meta), so an
    // exactly-canonical input round-trips verbatim…
    expect(serializeCombo(parsed)).toBe(combo);
    // …and serialization is idempotent for ANY input.
    expect(serializeCombo(parseCombo(serializeCombo(parsed))!)).toBe(serializeCombo(parsed));
  });

  it('normalizes modifier order while preserving semantics', () => {
    const parsed = parseCombo('Alt+Ctrl+Shift+K')!;
    expect(serializeCombo(parsed)).toBe('Ctrl+Shift+Alt+K'); // canonical order
    expect(combosEqual(parsed, parseCombo('Ctrl+Shift+Alt+K')!)).toBe(true);
  });

  it('is case-insensitive', () => {
    const a = parseCombo('ctrl+shift+a')!;
    const b = parseCombo('Ctrl+Shift+A')!;
    expect(combosEqual(a, b)).toBe(true);
    expect(a.key).toBe('a');
  });

  it('normalizes arrow names', () => {
    expect(parseCombo('ArrowRight')!.key).toBe('right');
    expect(normalizeKey('ArrowLeft')).toBe('left');
  });

  it('rejects empty/whitespace combos', () => {
    expect(parseCombo('')).toBeNull();
    expect(parseCombo('Ctrl+')).toBeNull();
  });
});

describe('comboFromEvent / findActionForEvent', () => {
  const ev = (key: string, mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
    key,
    ctrlKey: mods.ctrlKey ?? false,
    shiftKey: mods.shiftKey ?? false,
    altKey: mods.altKey ?? false,
    metaKey: mods.metaKey ?? false,
  });

  it('maps events to actions via the settings map', () => {
    expect(findActionForEvent(DEFAULT_SHORTCUTS, ev('ArrowRight'))).toBe('nextPage');
    expect(findActionForEvent(DEFAULT_SHORTCUTS, ev('f', { ctrlKey: true }))).toBe('toggleSearch');
    expect(findActionForEvent(DEFAULT_SHORTCUTS, ev('a', { ctrlKey: true, shiftKey: true }))).toBe('toggleAnnotations');
    expect(findActionForEvent(DEFAULT_SHORTCUTS, ev('F11'))).toBe('fullscreen');
    expect(findActionForEvent(DEFAULT_SHORTCUTS, ev('q', { ctrlKey: true }))).toBe('quit');
  });

  it('plain keys never match Ctrl combos', () => {
    expect(findActionForEvent(DEFAULT_SHORTCUTS, ev('f'))).toBeNull();
    expect(findActionForEvent(DEFAULT_SHORTCUTS, ev('F'))).toBeNull();
  });

  it('respects user rebinding', () => {
    const map = { ...DEFAULT_SHORTCUTS, toggleSearch: 'Ctrl+K' };
    expect(findActionForEvent(map, ev('k', { ctrlKey: true }))).toBe('toggleSearch');
    expect(findActionForEvent(map, ev('f', { ctrlKey: true }))).toBeNull();
  });

  it('comboFromEvent folds layout variants (+ → =)', () => {
    expect(comboFromEvent(ev('+', { ctrlKey: true })).key).toBe('=');
  });

  it('a real Space keydown (e.key === " ") matches the Space binding', () => {
    // Regression: normalizeKey trimmed ' ' to '' before folding it to 'space', so a
    // genuine Space press never matched spaceNext ('Space').
    expect(findActionForEvent(DEFAULT_SHORTCUTS, ev(' '))).toBe('spaceNext');
    expect(comboFromEvent(ev(' ')).key).toBe('space');
  });
});

describe('findConflict', () => {
  it('flags a combo already bound to another action', () => {
    expect(findConflict(DEFAULT_SHORTCUTS, 'toggleSearch', 'Ctrl+T')).toBe('toggleToc');
    expect(findConflict(DEFAULT_SHORTCUTS, 'toggleSearch', 'Ctrl+Alt+Z')).toBeNull();
  });
});

describe('displayKey', () => {
  it('renders canonical keys for display', () => {
    expect(displayKey('right')).toBe('Right');
    expect(displayKey('pagedown')).toBe('PageDown');
    expect(displayKey('space')).toBe('Space');
    expect(displayKey('f5')).toBe('F5');
    expect(displayKey('a')).toBe('A');
  });
});

describe('selection-scoped actions (§5.10)', () => {
  it('translate/dictionary/addVocab require a selection', () => {
    expect(SELECTION_SCOPED_ACTIONS.has('translate')).toBe(true);
    expect(SELECTION_SCOPED_ACTIONS.has('dictionary')).toBe(true);
    expect(SELECTION_SCOPED_ACTIONS.has('addVocab')).toBe(true);
    expect(SELECTION_SCOPED_ACTIONS.has('nextPage')).toBe(false);
  });
});
