/**
 * DictPopup tests (§8 F6): LookupResult → grouped meanings, examples, synonyms,
 * translation-only fallback for non-English words, alreadyInVocab disabled state,
 * suggest propagation to vocabStore, and total-failure retry.
 * lookup_word is mocked at the command level (src/test/setup.ts).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import DictPopup from '@/features/translate/DictPopup';
import { mockCommand, invokeCalls, mockBook } from '@/test/setup';
import { useReaderStore } from '@/stores/readerStore';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';
import type { LookupResult, OpenBook } from '@/lib/types';
import type { SelectionState } from '@/stores/readerStore';

const openBookFixture: OpenBook = {
  book: { ...mockBook, uid: 'aaaa1111', toc: [], chapters: [{ idx: 0, href: 'c0.xhtml', title: 'Г1', charCount: 1 }] },
  position: null, highlights: [], notes: [], bookmarks: [],
  indexStatus: { state: 'none', chaptersDone: 0, chaptersTotal: 0 },
};

const sel = (over: Partial<SelectionState> = {}): SelectionState => ({
  text: 'bright',
  cfiStart: 'epubcfi(/4/2/6/1:0)',
  cfiEnd: 'epubcfi(/4/2/6/1:6)',
  rect: { x: 100, y: 150, width: 60, height: 16 },
  sentence: 'A bright idea.',
  word: 'bright',
  ...over,
});

const richLookup: LookupResult = {
  word: 'bright',
  dictionary: {
    word: 'bright',
    transcription: '/braɪt/',
    meanings: [
      {
        pos: 'adjective',
        definitions: [
          { definition: 'giving out a lot of light', example: 'bright sunshine', synonyms: ['luminous', 'radiant'] },
          { definition: 'intelligent', example: 'a bright child', synonyms: ['clever'] },
        ],
      },
      {
        pos: 'adverb',
        definitions: [{ definition: 'in a bright manner', example: null, synonyms: [] }],
      },
    ],
  },
  translation: { translatedText: 'яркий', detectedSourceLang: 'en', targetLang: 'ru', providerId: 'google' },
  lookupCount: 3, suggestAdd: true, alreadyInVocab: false,
};

const translationOnly: LookupResult = {
  word: 'привет',
  translation: { translatedText: 'hello', detectedSourceLang: 'ru', targetLang: 'en', providerId: 'google' },
  dictionary: null,
  lookupCount: 1, suggestAdd: false, alreadyInVocab: false,
};

/** Mount + flush the lookup promise inside act(). */
async function renderPopup() {
  const utils = render(<DictPopup />);
  await act(async () => {});
  return utils;
}

const lookupCalls = () => invokeCalls.filter((c) => c.cmd === 'lookup_word');

describe('DictPopup', () => {
  beforeEach(() => {
    useReaderStore.setState({ book: openBookFixture, chapterIdx: 0, selection: sel() });
    useUiStore.setState({ overlay: 'dict', toasts: [] });
    useVocabStore.setState({ words: [], suggest: null, lastLookup: null, dismissedSuggestions: [] });
    mockCommand('lookup_word', richLookup);
  });

  afterEach(() => {
    useReaderStore.setState({ selection: null });
    useUiStore.setState({ overlay: null, toasts: [] });
    vi.restoreAllMocks();
  });

  it('looks up the word with reading context on mount', async () => {
    await renderPopup();
    await screen.findByText('giving out a lot of light');

    expect(lookupCalls()).toHaveLength(1);
    expect(lookupCalls()[0].args).toMatchObject({
      word: 'bright',
      context: { bookUid: 'aaaa1111', chapterIdx: 0, sentence: 'A bright idea.', cfi: 'epubcfi(/4/2/6/1:0)' },
    });
  });

  it('maps a LookupResult into pos groups, examples and synonyms', async () => {
    await renderPopup();
    await screen.findByText('giving out a lot of light');

    expect(screen.getByText('bright')).toBeInTheDocument();
    expect(screen.getByText('/braɪt/')).toBeInTheDocument();
    // two pos chips
    expect(screen.getByText('adjective')).toBeInTheDocument();
    expect(screen.getByText('adverb')).toBeInTheDocument();
    // definitions + italic examples
    expect(screen.getByText('intelligent')).toBeInTheDocument();
    expect(screen.getByText('in a bright manner')).toBeInTheDocument();
    expect(screen.getByText('“bright sunshine”')).toBeInTheDocument();
    // synonyms render as chips
    expect(screen.getByRole('button', { name: 'luminous' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'clever' })).toBeInTheDocument();
  });

  it('re-runs the lookup for a clicked synonym', async () => {
    mockCommand('lookup_word', richLookup);
    await renderPopup();
    await screen.findByText('giving out a lot of light');

    mockCommand('lookup_word', { ...richLookup, word: 'luminous', dictionary: null });
    fireEvent.click(screen.getByRole('button', { name: 'luminous' }));

    await waitFor(() => expect(lookupCalls()).toHaveLength(2));
    expect(lookupCalls()[1].args).toMatchObject({ word: 'luminous' });
    expect(screen.getByRole('heading', { name: 'luminous' })).toBeInTheDocument();
  });

  it('propagates suggestAdd to vocabStore.suggest', async () => {
    await renderPopup();
    await screen.findByText('giving out a lot of light');

    const suggest = useVocabStore.getState().suggest;
    expect(suggest).not.toBeNull();
    expect(suggest).toMatchObject({ word: 'bright', translation: 'яркий', lookupCount: 3 });
    expect(suggest?.definition).toBe('giving out a lot of light');
    expect(suggest?.pos).toBe('adjective');
  });

  it('shows a translation-only block + hint when there is no dictionary result', async () => {
    useReaderStore.setState({ selection: sel({ text: 'привет', word: 'привет' }) });
    mockCommand('lookup_word', translationOnly);
    await renderPopup();

    expect(await screen.findByText('hello')).toBeInTheDocument();
    expect(screen.getByText('Definitions are available for English words')).toBeInTheDocument();
    expect(screen.queryByText('adjective')).not.toBeInTheDocument();
  });

  it('disables "Add to vocabulary" as "Already in vocabulary" when alreadyInVocab', async () => {
    mockCommand('lookup_word', { ...richLookup, alreadyInVocab: true, suggestAdd: false });
    await renderPopup();
    await screen.findByText('giving out a lot of light');

    const btn = screen.getByRole('button', { name: 'Already in vocabulary' });
    expect(btn).toBeDisabled();
    // suggest is NOT set when already in vocab
    expect(useVocabStore.getState().suggest).toBeNull();
  });

  it('adds the word with definition/transcription/pos prefilled from the first meaning', async () => {
    await renderPopup();
    await screen.findByText('giving out a lot of light');

    fireEvent.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

    await waitFor(() => expect(invokeCalls.some((c) => c.cmd === 'add_vocab_word')).toBe(true));
    const add = invokeCalls.find((c) => c.cmd === 'add_vocab_word')?.args as Record<string, unknown>;
    expect(add).toMatchObject({
      word: 'bright', translation: 'яркий', definition: 'giving out a lot of light',
      transcription: '/braɪt/', pos: 'adjective', examples: ['bright sunshine'],
      bookUid: 'aaaa1111', chapterIdx: 0, context: 'A bright idea.', contextCfi: 'epubcfi(/4/2/6/1:0)',
    });
    expect(useUiStore.getState().overlay).toBeNull();
  });

  it('shows "Dictionary unavailable" + retry when both dict and translation fail', async () => {
    mockCommand('lookup_word', () => { throw new Error('offline'); });
    await renderPopup();

    expect(await screen.findByText('Dictionary unavailable')).toBeInTheDocument();
    const failed = lookupCalls().length;

    mockCommand('lookup_word', richLookup);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('giving out a lot of light')).toBeInTheDocument();
    expect(lookupCalls().length).toBeGreaterThan(failed);
  });

  it('closes on Escape', async () => {
    await renderPopup();
    await screen.findByText('giving out a lot of light');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().overlay).toBeNull();
  });
});
