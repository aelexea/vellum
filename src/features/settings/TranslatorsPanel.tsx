/**
 * TranslatorsPanel — [F3] per ARCHITECTURE.md §5.9 (Translation and the provider card
 * half of Dictionary (study)).
 *
 * mode="translate": default provider + target language + popupOnSelect + translate-kind
 * provider cards. mode="dict": dictionary provider select + dict-kind provider cards.
 * Provider config edits commit on blur/Enter → settingsStore.patch + save_provider_config.
 */
import { useEffect, useState } from 'react';
import { Select } from '@/components/Select';
import type { SelectOption } from '@/components/Select';
import { Spinner } from '@/components/Spinner';
import { Switch } from '@/components/Switch';
import { listLanguages, listTranslators, saveProviderConfig, testProvider } from '@/lib/tauri';
import type { Lang, ProviderConfig, TranslatorInfo } from '@/lib/types';
import { cn, errMsg } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

const DEFAULT_BASE_URLS: Record<string, string> = {
  lingva: 'https://lingva.ml',
  libre: 'https://libretranslate.example.com',
};

const EMPTY_CFG: ProviderConfig = { enabled: false, baseUrl: null, apiKey: null };

function RowLabel({ label, desc }: { label: string; desc?: string }) {
  return (
    <div className="min-w-0">
      <div className="v-set-label">{label}</div>
      {desc && <div className="v-set-desc">{desc}</div>}
    </div>
  );
}

/** One provider: enable switch, optional base URL / API key, connection test. */
function ProviderCard({
  info, cfg, defaultProvider, onCommit,
}: {
  info: TranslatorInfo;
  cfg: ProviderConfig;
  defaultProvider: boolean;
  onCommit: (patch: Partial<ProviderConfig>) => void;
}) {
  const toast = useUiStore((s) => s.toast);
  const [baseUrl, setBaseUrl] = useState(cfg.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(cfg.apiKey ?? '');
  const [testing, setTesting] = useState(false);

  // Re-sync when the stored config changes elsewhere (settings import, another panel).
  useEffect(() => { setBaseUrl(cfg.baseUrl ?? ''); }, [cfg.baseUrl]);
  useEffect(() => { setApiKey(cfg.apiKey ?? ''); }, [cfg.apiKey]);

  const commitUrl = () => {
    const v = baseUrl.trim();
    onCommit({ baseUrl: v === '' ? null : v });
  };
  const commitKey = () => {
    const v = apiKey.trim();
    onCommit({ apiKey: v === '' ? null : v });
  };

  const onTest = async () => {
    setTesting(true);
    try {
      const ok = await testProvider(info.id);
      toast(ok ? 'Works' : "Doesn't work", ok ? 'success' : 'error');
    } catch {
      toast("Doesn't work", 'error');
    } finally {
      setTesting(false);
    }
  };

  return (
    <li
      className="rounded-[var(--radius)] border border-[var(--v-border)] bg-[var(--v-bg-alt)] p-3"
      data-provider={info.id}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{info.name}</div>
          {defaultProvider && (
            <div className="v-set-desc">Default provider</div>
          )}
        </div>
        <Switch
          label="Enabled"
          className="shrink-0"
          checked={cfg.enabled}
          onChange={(v) => onCommit({ enabled: v })}
        />
      </div>

      {info.needsConfig && (
        <div className="mt-2.5 flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <span className="w-[92px] shrink-0 text-[12px] text-[var(--v-fg-muted)]">Address</span>
            <input
              type="text"
              className="vellum-selectable h-7 min-w-0 flex-1 text-[12px]"
              placeholder={DEFAULT_BASE_URLS[info.id] ?? 'https://…'}
              aria-label={`${info.name}: server address`}
              value={baseUrl}
              spellCheck={false}
              onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={commitUrl}
              onKeyDown={(e) => { if (e.key === 'Enter') commitUrl(); }}
            />
          </label>
          {info.id === 'libre' && (
            <label className="flex items-center gap-2">
              <span className="w-[92px] shrink-0 text-[12px] text-[var(--v-fg-muted)]">API key</span>
              <input
                type="password"
                className="vellum-selectable h-7 min-w-0 flex-1 text-[12px]"
                placeholder="••••••••"
                aria-label={`${info.name}: API key`}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onBlur={commitKey}
                onKeyDown={(e) => { if (e.key === 'Enter') commitKey(); }}
              />
            </label>
          )}
        </div>
      )}

      <div className="mt-2.5">
        <button
          type="button"
          className="vellum-btn"
          disabled={testing}
          onClick={() => void onTest()}
        >
          {testing && <Spinner size={14} label="Checking…" />}
          Test connection
        </button>
      </div>
    </li>
  );
}

export interface TranslatorsPanelProps {
  /** 'translate' → Translation section; 'dict' → Dictionary (study) section. */
  mode: 'translate' | 'dict';
}

export function TranslatorsPanel({ mode }: TranslatorsPanelProps) {
  const settings = useSettingsStore((s) => s.settings);
  const patch = useSettingsStore((s) => s.patch);

  const [translators, setTranslators] = useState<TranslatorInfo[]>([]);
  const [langs, setLangs] = useState<Lang[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listTranslators();
        if (!cancelled) setTranslators(list);
      } catch (e) {
        if (!cancelled) useUiStore.getState().toast(errMsg(e), 'error');
      }
    })();
    if (mode === 'translate') {
      void (async () => {
        try {
          const l = await listLanguages();
          if (!cancelled) setLangs(l);
        } catch {
          /* language list is a convenience — stay silent */
        }
      })();
    }
    return () => { cancelled = true; };
  }, [mode]);

  const visible = translators.filter((t) =>
    (mode === 'translate' ? t.kind !== 'dict' : t.kind !== 'translate'));

  const providerOptions: SelectOption[] = visible.map((t) => ({
    value: t.id, label: t.name,
  }));
  const langOptions: SelectOption[] = langs.map((l) => ({
    value: l.code, label: l.nameRu, hint: l.code,
  }));

  const defaultId = mode === 'translate'
    ? settings.translate.defaultProviderId
    : settings.dictionary.defaultProviderId;

  const commitCfg = (id: string, part: Partial<ProviderConfig>) => {
    const cur = settings.translate.providers[id]
      ?? { ...EMPTY_CFG, enabled: id === defaultId };
    const cfg: ProviderConfig = { ...cur, ...part };
    patch({ translate: { providers: { [id]: cfg } } });
    void saveProviderConfig(id, cfg).catch((e) => {
      useUiStore.getState().toast(errMsg(e), 'error');
    });
  };

  return (
    <div className="flex flex-col">
      {mode === 'translate' ? (
        <>
          <div className="v-set-row">
            <RowLabel label="Translation provider" />
            <div className="v-set-control">
              <Select
                ariaLabel="Translation provider"
                className="w-full"
                value={settings.translate.defaultProviderId}
                onChange={(v) => patch({ translate: { defaultProviderId: v } })}
                options={providerOptions}
              />
            </div>
          </div>
          <div className="v-set-row">
            <RowLabel label="Target language" />
            <div className="v-set-control">
              <Select
                ariaLabel="Target language"
                className="w-full"
                searchable
                searchPlaceholder="Search languages…"
                value={settings.translate.defaultTargetLang}
                onChange={(v) => patch({ translate: { defaultTargetLang: v } })}
                options={langOptions}
              />
            </div>
          </div>
          <div className="py-2">
            <Switch
              label="Show translation immediately on selection"
              description="Otherwise the translation opens from a toolbar button or shortcut."
              checked={settings.translate.popupOnSelect}
              onChange={(v) => patch({ translate: { popupOnSelect: v } })}
            />
          </div>
          <h2 className="v-set-head">Providers</h2>
        </>
      ) : (
        <>
          <div className="v-set-row">
            <RowLabel
              label="Dictionary provider"
              desc="Definitions, transcription and examples for individual words."
            />
            <div className="v-set-control">
              <Select
                ariaLabel="Dictionary provider"
                className="w-full"
                value={settings.dictionary.defaultProviderId}
                onChange={(v) => patch({ dictionary: { defaultProviderId: v } })}
                options={providerOptions}
              />
            </div>
          </div>
          <h2 className="v-set-head">Providers</h2>
        </>
      )}

      {visible.length === 0 ? (
        <p className={cn('py-3 text-[12px] text-[var(--v-fg-muted)]')}>
          No providers available.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((info) => (
            <ProviderCard
              key={info.id}
              info={info}
              cfg={settings.translate.providers[info.id]
                ?? { ...EMPTY_CFG, enabled: info.id === defaultId }}
              defaultProvider={info.id === defaultId}
              onCommit={(part) => commitCfg(info.id, part)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

export default TranslatorsPanel;
