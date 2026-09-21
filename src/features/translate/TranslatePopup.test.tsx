/**
 * TranslatePopup tests (§8 F6): mount-time auto-translate, lang/provider re-translate,
 * error + retry, copy, "Add to vocabulary" gating and prefill.
 * Backend is mocked at the command level by src/test/setup.ts (mockCommand/invokeCalls).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import TranslatePopup from '@/features/translate/TranslatePopup';
import { mockCommand, invokeCalls } from '@/test/setup';
import { useReaderStore } from '@/stores/readerStore';
import { DEFAULT_SETTINGS, deepMerge, useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';
import type { SelectionState } from '@/stores/readerStore';

const sel = (over: Partial<SelectionState> = {}): SelectionState => ({
  text: 'hello world',
  cfiStart: 'epubcfi(/4/2/6/1:4)',
  cfiEnd: 'epubcfi(/4/2/6/1:15)',
  rect: { x: 120, y: 200, width: 90, height: 18 },
  sentence: 'Say hello world again.',
  word: undefined,
  ...over,
});

/** Mount + flush the option-list and translate promises inside act(). */
async function renderPopup() {
  const utils = render(<TranslatePopup />);
  await act(async () => {});
  return utils;
}

const translateCalls = () => invokeCalls.filter((c) => c.cmd === 'translate_text');
const lastTranslate = () => translateCalls()[translateCalls().length - 1]
  ?.args as { text: string; from: string; to: string; providerId: string | null } | undefined;

describe('TranslatePopup', () => {
  beforeEach(() => {
    useReaderStore.setState({ book: null, chapterIdx: 0, selection: sel() });
    useUiStore.setState({ overlay: 'translate', toasts: [] });
    useVocabStore.setState({ words: [], suggest: null });
    // The store persists across tests in a file; restore §6.6 defaults each time.
    useSettingsStore.setState({ settings: deepMerge(DEFAULT_SETTINGS, {}) });
    mockCommand('translate_text', {
      translatedText: 'привет мир', detectedSourceLang: 'en', targetLang: 'ru', providerId: 'google',
    });
  });

  afterEach(() => {
    useReaderStore.setState({ selection: null });
    useUiStore.setState({ overlay: null, toasts: [] });
    vi.restoreAllMocks();
  });

  it('renders the source text and auto-translates on mount', async () => {
    await renderPopup();
    expect(screen.getByText('hello world')).toBeInTheDocument();

    expect(await screen.findByText('привет мир')).toBeInTheDocument();
    expect(lastTranslate()).toMatchObject({ text: 'hello world', from: 'auto', to: 'ru', providerId: 'google' });
  });

  it('shows the detected source language chip from the result', async () => {
    await renderPopup();
    expect(await screen.findByText('en')).toBeInTheDocument();
  });

  it('re-translates with the new target language and persists the choice', async () => {
    // Mocked locally so the option labels do not depend on the shared
    // list_languages fixture in src/test/setup.ts (backend language names are
    // being translated to English).
    mockCommand('list_languages', [
      { code: 'ru', nameRu: 'Russian' },
      { code: 'en', nameRu: 'English' },
    ]);
    await renderPopup();
    await screen.findByText('привет мир');
    const before = translateCalls().length;

    fireEvent.click(screen.getByRole('combobox', { name: 'Target language' }));
    fireEvent.click(await screen.findByRole('option', { name: 'English' }));

    await waitFor(() => expect(translateCalls().length).toBeGreaterThan(before));
    expect(lastTranslate()?.to).toBe('en');
    expect(useSettingsStore.getState().settings.translate.defaultTargetLang).toBe('en');
  });

  it('switches provider and re-runs the translation', async () => {
    mockCommand('list_translators', [
      { id: 'google', name: 'Google', kind: 'translate', needsConfig: false, configured: true },
      { id: 'lingva', name: 'Lingva', kind: 'translate', needsConfig: false, configured: true },
      { id: 'dictionaryapi', name: 'Dictionary', kind: 'dict', needsConfig: false, configured: true },
    ]);
    await renderPopup();
    await screen.findByText('привет мир');
    const before = translateCalls().length;

    fireEvent.click(screen.getByRole('combobox', { name: 'Translation provider' }));
    const lingva = await screen.findByRole('option', { name: 'Lingva' });
    // dict-kind providers are not offered for translation.
    expect(screen.queryByRole('option', { name: 'Dictionary' })).not.toBeInTheDocument();
    fireEvent.click(lingva);

    await waitFor(() => expect(translateCalls().length).toBeGreaterThan(before));
    expect(lastTranslate()?.providerId).toBe('lingva');
    expect(useSettingsStore.getState().settings.translate.defaultProviderId).toBe('lingva');
  });

  it('shows "Translation unavailable" on failure and retries on "Retry"', async () => {
    mockCommand('translate_text', () => { throw new Error('offline'); });
    await renderPopup();

    expect(await screen.findByText('Translation unavailable')).toBeInTheDocument();
    const failed = translateCalls().length;

    mockCommand('translate_text', {
      translatedText: 'привет мир', detectedSourceLang: 'en', targetLang: 'ru', providerId: 'google',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('привет мир')).toBeInTheDocument();
    expect(translateCalls().length).toBeGreaterThan(failed);
  });

  it('copies the translation and toasts "Copied"', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, configurable: true, writable: true,
    });

    await renderPopup();
    await screen.findByText('привет мир');
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('привет мир'));
    expect(useUiStore.getState().toasts.some((t) => t.msg === 'Copied')).toBe(true);
  });

  it('adds a single-word selection to the vocab prefilled, then closes', async () => {
    useReaderStore.setState({
      selection: sel({ text: 'hello', word: 'hello', sentence: 'Say hello now.' }),
    });
    await renderPopup();
    await screen.findByText('привет мир');

    fireEvent.click(screen.getByRole('button', { name: 'Add to vocabulary' }));

    await waitFor(() => {
      expect(invokeCalls.some((c) => c.cmd === 'add_vocab_word')).toBe(true);
    });
    const add = invokeCalls.find((c) => c.cmd === 'add_vocab_word')?.args as Record<string, unknown>;
    expect(add).toMatchObject({
      word: 'hello', translation: 'привет мир', context: 'Say hello now.',
      contextCfi: 'epubcfi(/4/2/6/1:4)',
    });
    // The toast string comes from vocabStore, translated per the shared glossary.
    expect(useUiStore.getState().toasts.some((t) => t.msg === 'Word added')).toBe(true);
    expect(useUiStore.getState().overlay).toBeNull();
  });

  it('hides "Add to vocabulary" for multi-word selections', async () => {
    await renderPopup();
    await screen.findByText('привет мир');
    expect(screen.queryByRole('button', { name: 'Add to vocabulary' })).not.toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    await renderPopup();
    await screen.findByText('привет мир');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().overlay).toBeNull();
  });

  it('clamps the anchored position into the viewport', async () => {
    useReaderStore.setState({
      selection: sel({ rect: { x: 5000, y: 20, width: 40, height: 16 } }),
    });
    await renderPopup();
    await screen.findByText('привет мир');

    const card = screen.getByTestId('translate-popup');
    const left = Number.parseFloat(card.style.left);
    expect(left).toBeLessThanOrEqual(Math.max(12, window.innerWidth - 420 - 12));
    expect(Number.parseFloat(card.style.top)).toBeGreaterThanOrEqual(12);
  });
});
