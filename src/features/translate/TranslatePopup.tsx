/**
 * TranslatePopup — anchored translation card (§5.7). Owned by [F6].
 * Self-wiring: App mounts it when uiStore.overlay === 'translate'; it reads the current
 * readerStore.selection and runs translate_text on open + whenever the target/provider change.
 * Props API: none (store-driven). z-50 sits in the frozen overlay tier (40/50/60).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Lang, TranslateResult, TranslatorInfo } from '@/lib/types';
import * as api from '@/lib/tauri';
import { clamp, cn, copyText } from '@/lib/utils';
import { Select } from '@/components/Select';
import { useReaderStore } from '@/stores/readerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { useVocabStore } from '@/stores/vocabStore';

const POPUP_W = 420;
const EST_H = 220;
const MARGIN = 12;

/** Three-dot pulsing skeleton shown while a translation is in flight. */
function Dots() {
  return (
    <span className="vellum-dots" aria-hidden>
      <span /><span /><span />
      <style>{`
        .vellum-dots { display:inline-flex; gap:4px; align-items:center; height:20px; }
        .vellum-dots > span { width:6px; height:6px; border-radius:50%;
          background: var(--v-fg-muted); opacity:.35; animation: vellum-dot 900ms var(--ease) infinite; }
        .vellum-dots > span:nth-child(2) { animation-delay:150ms; }
        .vellum-dots > span:nth-child(3) { animation-delay:300ms; }
        @keyframes vellum-dot { 0%,60%,100% { opacity:.3; transform:translateY(0); }
          30% { opacity:.9; transform:translateY(-2px); } }
      `}</style>
    </span>
  );
}

export default function TranslatePopup() {
  const selection = useReaderStore((s) => s.selection);
  const book = useReaderStore((s) => s.book);
  const chapterIdx = useReaderStore((s) => s.chapterIdx);
  const setOverlay = useUiStore((s) => s.setOverlay);
  const toast = useUiStore((s) => s.toast);
  const addWord = useVocabStore((s) => s.add);
  const translateSettings = useSettingsStore((s) => s.settings.translate);
  const patch = useSettingsStore((s) => s.patch);

  const [langs, setLangs] = useState<Lang[]>([]);
  const [providers, setProviders] = useState<TranslatorInfo[]>([]);
  const [targetLang, setTargetLang] = useState(translateSettings.defaultTargetLang);
  const [providerId, setProviderId] = useState(translateSettings.defaultProviderId);
  const [result, setResult] = useState<TranslateResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  const cardRef = useRef<HTMLDivElement>(null);
  const reqId = useRef(0);
  const text = selection?.text ?? '';

  // Language + provider option lists (loaded once).
  useEffect(() => {
    let alive = true;
    api.listLanguages()
      .then((l) => { if (alive) setLangs(l); })
      .catch(() => {});
    api.listTranslators()
      .then((t) => { if (alive) setProviders(t.filter((p) => p.kind !== 'dict')); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Auto-translate on open + whenever the source/target/provider change (§5.7).
  useEffect(() => {
    if (!text) { setLoading(false); return; }
    const id = ++reqId.current;
    setLoading(true);
    setError(false);
    api.translateText(text, 'auto', targetLang, providerId)
      .then((r) => { if (id === reqId.current) { setResult(r); setLoading(false); } })
      .catch(() => { if (id === reqId.current) { setResult(null); setError(true); setLoading(false); } });
  }, [text, targetLang, providerId, nonce]);

  // Esc + click-outside close (App also handles Esc globally; this keeps the popup
  // self-contained when mounted standalone, e.g. in tests).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) setOverlay(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOverlay(null); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [setOverlay]);

  // Anchored near the selection rect, clamped to the viewport, flipped above on overflow.
  const pos = useMemo(() => {
    const rect = selection?.rect;
    if (!rect) return { left: MARGIN, top: MARGIN };
    const left = clamp(rect.x, MARGIN, Math.max(MARGIN, window.innerWidth - POPUP_W - MARGIN));
    let top = rect.y + rect.height + 8;
    if (top + EST_H > window.innerHeight && rect.y - EST_H - 8 > 0) {
      top = rect.y - EST_H - 8;
    }
    return { left, top };
  }, [selection]);

  const langOptions = useMemo(() => {
    const opts = langs.map((l) => ({ value: l.code, label: l.nameRu }));
    if (opts.length === 0) return [{ value: targetLang, label: targetLang }];
    if (!opts.some((o) => o.value === targetLang)) {
      return [{ value: targetLang, label: targetLang }, ...opts];
    }
    return opts;
  }, [langs, targetLang]);

  const providerOptions = useMemo(
    () => providers.map((p) => ({ value: p.id, label: p.name })),
    [providers],
  );

  const onLangChange = (code: string) => {
    setTargetLang(code);
    patch({ translate: { defaultTargetLang: code } });
  };
  const onProviderChange = (id: string) => {
    setProviderId(id);
    patch({ translate: { defaultProviderId: id } });
  };

  const onCopy = async () => {
    if (!result) return;
    const ok = await copyText(result.translatedText);
    if (ok) toast('Copied', 'success');
  };

  // "Add to vocabulary" is offered only for single-token selections (§5.7).
  const singleWord = selection?.word;
  const onAdd = async () => {
    if (!singleWord) return;
    await addWord({
      word: singleWord,
      translation: result?.translatedText ?? null,
      context: selection?.sentence ?? null,
      bookUid: book?.book.uid ?? null,
      chapterIdx: book ? chapterIdx : null,
      contextCfi: selection?.cfiStart ?? null,
    });
    setOverlay(null);
  };

  return (
    <div
      ref={cardRef}
      data-testid="translate-popup"
      role="dialog"
      aria-label="Translation"
      className="vellum-scale-in fixed z-50 max-w-[420px] border border-[var(--v-border)] p-3"
      style={{
        left: pos.left,
        top: pos.top,
        width: POPUP_W,
        background: 'var(--v-bg-raise)',
        borderRadius: 'var(--radius)',
        boxShadow: 'var(--v-shadow)',
        animationDuration: '160ms',
        animationTimingFunction: 'var(--ease)',
      }}
    >
      {/* source text */}
      {text && (
        <p
          className="vellum-selectable mb-2.5 text-[13px] italic text-[var(--v-fg-muted)]"
          style={{
            borderLeft: '2px solid var(--v-accent)',
            paddingLeft: 8,
            display: '-webkit-box',
            WebkitLineClamp: 6,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {text}
        </p>
      )}

      {/* detected → target lang + provider */}
      <div className="mb-2.5 flex items-center gap-2">
        <span
          className="shrink-0 rounded-full border border-[var(--v-border)] px-2 py-0.5 text-[11px] uppercase text-[var(--v-fg-muted)]"
          title={result ? `Detected language: ${result.detectedSourceLang}` : undefined}
        >
          {loading ? '…' : (result?.detectedSourceLang ?? '—')}
        </span>
        <span className="shrink-0 text-[var(--v-fg-muted)]" aria-hidden>→</span>
        <Select
          className="min-w-0 flex-1"
          ariaLabel="Target language"
          searchable
          options={langOptions}
          value={targetLang}
          onChange={onLangChange}
        />
        {providerOptions.length > 0 && (
          <Select
            className="w-28 shrink-0"
            ariaLabel="Translation provider"
            options={providerOptions}
            value={providerId}
            onChange={onProviderChange}
          />
        )}
      </div>

      {/* result */}
      <div className="min-h-[40px]">
        {loading ? (
          <Dots />
        ) : error ? (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--v-fg-muted)]">Translation unavailable</span>
            <button
              type="button"
              className="vellum-btn !h-7 !px-2 !text-[12px]"
              onClick={() => setNonce((n) => n + 1)}
            >
              Retry
            </button>
          </div>
        ) : (
          <p className="vellum-selectable whitespace-pre-wrap text-[15px] text-[var(--v-fg)]">
            {result?.translatedText}
          </p>
        )}
      </div>

      {/* actions */}
      <div className="mt-3 flex items-center gap-2 border-t border-[var(--v-border)] pt-2.5">
        <button
          type="button"
          className="vellum-btn !h-8"
          onClick={onCopy}
          disabled={!result}
        >
          Copy
        </button>
        {singleWord && (
          <button
            type="button"
            className={cn('vellum-btn vellum-btn-accent !h-8')}
            onClick={onAdd}
          >
            Add to vocabulary
          </button>
        )}
      </div>
    </div>
  );
}
