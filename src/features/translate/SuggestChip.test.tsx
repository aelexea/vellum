/**
 * SuggestChip tests (§8 F6): appears on vocabStore.suggest, "Add" prefills
 * add_vocab_word + toast + clears suggest, "×" dismisses with same-word session
 * suppression, and the 12 s auto-dismiss timer resets per new suggest.
 * The suppression Set is module-level, so each test uses its own word.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import SuggestChip from '@/features/translate/SuggestChip';
import { invokeCalls } from '@/test/setup';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';
import type { VocabSuggest } from '@/stores/vocabStore';

const suggestOf = (word: string, over: Partial<VocabSuggest> = {}): VocabSuggest => ({
  word,
  translation: 'яркий',
  definition: 'giving out a lot of light',
  transcription: '/braɪt/',
  pos: 'adjective',
  context: 'A bright idea.',
  contextCfi: 'epubcfi(/4/2/6/1:0)',
  bookUid: 'aaaa1111',
  chapterIdx: 2,
  lookupCount: 3,
  ...over,
});

const setSuggest = (s: VocabSuggest | null) => act(() => { useVocabStore.setState({ suggest: s }); });

describe('SuggestChip', () => {
  beforeEach(() => {
    useVocabStore.setState({
      words: [], suggest: null, dismissedSuggestions: [], lastLookup: null,
    });
    useUiStore.setState({ toasts: [], overlay: null });
  });

  afterEach(() => {
    useVocabStore.setState({ suggest: null, dismissedSuggestions: [] });
    useUiStore.setState({ toasts: [] });
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders the pill with the word and lookup count when suggest is set', () => {
    setSuggest(suggestOf('alpha'));
    render(<SuggestChip />);

    expect(screen.getByTestId('suggest-chip')).toBeInTheDocument();
    expect(screen.getByText(/The word “alpha” appeared 3 times\. Add to vocabulary\?/)).toBeInTheDocument();
  });

  it('renders nothing when suggest is null', () => {
    render(<SuggestChip />);
    expect(screen.queryByTestId('suggest-chip')).not.toBeInTheDocument();
  });

  it('pluralises the lookup count', () => {
    // One mounted chip, driven by successive store updates.
    render(<SuggestChip />);

    setSuggest(suggestOf('beta', { lookupCount: 1 }));
    expect(screen.getByText(/appeared 1 time\./)).toBeInTheDocument();

    setSuggest(suggestOf('gamma', { lookupCount: 2 }));
    expect(screen.getByText(/appeared 2 times\./)).toBeInTheDocument();

    setSuggest(suggestOf('delta', { lookupCount: 12 }));
    expect(screen.getByText(/appeared 12 times\./)).toBeInTheDocument();

    setSuggest(suggestOf('epsilon2', { lookupCount: 21 }));
    expect(screen.getByText(/appeared 21 times\./)).toBeInTheDocument();

    setSuggest(suggestOf('zeta2', { lookupCount: 5 }));
    expect(screen.getByText(/appeared 5 times\./)).toBeInTheDocument();
  });

  it('"Add" adds the prefilled word, toasts "Word added", clears suggest', async () => {
    setSuggest(suggestOf('epsilon'));
    render(<SuggestChip />);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'add_vocab_word')).toBe(true));
    const add = invokeCalls.find((c) => c.cmd === 'add_vocab_word')?.args as Record<string, unknown>;
    expect(add).toMatchObject({
      word: 'epsilon', translation: 'яркий', definition: 'giving out a lot of light',
      transcription: '/braɪt/', pos: 'adjective', context: 'A bright idea.',
      contextCfi: 'epubcfi(/4/2/6/1:0)', bookUid: 'aaaa1111', chapterIdx: 2,
    });
    expect(useUiStore.getState().toasts.some((t) => t.msg === 'Word added')).toBe(true);

    await waitFor(() => expect(useVocabStore.getState().suggest).toBeNull());
    expect(screen.queryByTestId('suggest-chip')).not.toBeInTheDocument();
  });

  it('"×" dismisses and suppresses the same word for the session', () => {
    setSuggest(suggestOf('zeta'));
    render(<SuggestChip />);
    expect(screen.getByTestId('suggest-chip')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(useVocabStore.getState().suggest).toBeNull();
    expect(useVocabStore.getState().dismissedSuggestions).toContain('zeta');

    // Module-level suppression: even with the store's dismissed list cleared,
    // the same word is not offered again this session.
    setSuggest(suggestOf('zeta'));
    useVocabStore.setState({ dismissedSuggestions: [] });
    expect(screen.queryByTestId('suggest-chip')).not.toBeInTheDocument();

    // A different word is still offered.
    setSuggest(suggestOf('eta'));
    expect(screen.getByTestId('suggest-chip')).toBeInTheDocument();
  });

  it('matches suppression case-insensitively', () => {
    setSuggest(suggestOf('Theta'));
    render(<SuggestChip />);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    setSuggest(suggestOf('theta'));
    expect(screen.queryByTestId('suggest-chip')).not.toBeInTheDocument();
  });

  it('auto-dismisses after 12 s', () => {
    vi.useFakeTimers();
    setSuggest(suggestOf('iota'));
    render(<SuggestChip />);
    expect(screen.getByTestId('suggest-chip')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(11_999); });
    expect(screen.getByTestId('suggest-chip')).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(1); });
    expect(screen.queryByTestId('suggest-chip')).not.toBeInTheDocument();
    expect(useVocabStore.getState().suggest).toBeNull();
    // auto-dismiss also suppresses the word for the rest of the session.
    setSuggest(suggestOf('iota'));
    expect(screen.queryByTestId('suggest-chip')).not.toBeInTheDocument();
  });

  it('restarts the 12 s timer for each new suggest', () => {
    vi.useFakeTimers();
    setSuggest(suggestOf('kappa'));
    render(<SuggestChip />);

    act(() => { vi.advanceTimersByTime(8_000); });
    setSuggest(suggestOf('lambda'));

    // 16 s total since the first suggest, but only 8 s since the second: still shown.
    act(() => { vi.advanceTimersByTime(8_000); });
    expect(screen.getByTestId('suggest-chip')).toBeInTheDocument();
    expect(screen.getByText(/The word “lambda”/)).toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(4_000); });
    expect(screen.queryByTestId('suggest-chip')).not.toBeInTheDocument();
  });

  it('sources book/chapter context from the suggest payload', async () => {
    // bbbb2222/7 differ from the mockBook fixture (aaaa1111) — proving the chip
    // reads the payload rather than any ambient reader state.
    setSuggest(suggestOf('mu', { bookUid: 'bbbb2222', chapterIdx: 7 }));
    render(<SuggestChip />);

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'add_vocab_word')).toBe(true));
    const add = invokeCalls.find((c) => c.cmd === 'add_vocab_word')?.args as Record<string, unknown>;
    expect(add).toMatchObject({ word: 'mu', bookUid: 'bbbb2222', chapterIdx: 7 });
  });
});
