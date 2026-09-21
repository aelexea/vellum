/**
 * App shell — FROZEN (scaffold-FE) per ARCHITECTURE.md §5.12.
 * View router (uiStore.view), overlay mount points, boot sequence, global shortcuts,
 * smoke-test hook (VELLUM_SMOKE via get_smoke_config).
 */
import { useEffect } from 'react';
import LibraryView from '@/features/library/LibraryView';
import ReaderView from '@/features/reader/ReaderView';
import TocPanel from '@/features/reader/TocPanel';
import QuickSettings from '@/features/reader/QuickSettings';
import SearchPanel from '@/features/search/SearchPanel';
import AnnotationsPanel from '@/features/annotations/AnnotationsPanel';
import VocabView from '@/features/vocab/VocabView';
import ReviewSession from '@/features/vocab/ReviewSession';
import StatsView from '@/features/stats/StatsView';
import SettingsView from '@/features/settings/SettingsView';
import TranslatePopup from '@/features/translate/TranslatePopup';
import DictPopup from '@/features/translate/DictPopup';
import SuggestChip from '@/features/translate/SuggestChip';
import { ToastHost } from '@/components/Toast';
import { ConfirmHost } from '@/components/Modal';
import { Spinner } from '@/components/Spinner';
import { useUiStore } from '@/stores/uiStore';
import type { Overlay } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useLibraryStore } from '@/stores/libraryStore';
import { useReaderStore } from '@/stores/readerStore';
import { useVocabStore } from '@/stores/vocabStore';
import { dispatchAction, findActionForEvent, isDispatchable } from '@/features/reader/Shortcuts';
import { getSmokeConfig, importBooks } from '@/lib/tauri';

const FIRST_RUN_KEY = 'vellum.firstRunDone';

export default function App() {
  const view = useUiStore((s) => s.view);
  const overlay = useUiStore((s) => s.overlay);
  const booting = useUiStore((s) => s.booting);
  const book = useReaderStore((s) => s.book);
  const readerLoading = useReaderStore((s) => s.loading);
  const suggest = useVocabStore((s) => s.suggest);

  // ------------------------------------------------------------------- boot
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const settings = useSettingsStore.getState();
      const ui = useUiStore.getState();

      await settings.load();

      // §6.6 — honor prefers-color-scheme: dark on first run only.
      try {
        if (!localStorage.getItem(FIRST_RUN_KEY)) {
          const prefersDark = typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-color-scheme: dark)').matches;
          if (prefersDark) settings.patch({ ui: { themeId: 'dark' } });
          localStorage.setItem(FIRST_RUN_KEY, '1');
        }
      } catch { /* private mode / jsdom without storage */ }

      ui.applyTheme();

      // Smoke-test hook (tools/smoke.sh): backend returns null unless VELLUM_SMOKE is set.
      const smoke = await getSmokeConfig().catch(() => null);
      if (smoke && !cancelled) {
        if (smoke.theme) {
          settings.patch({ ui: { themeId: smoke.theme } });
          ui.applyTheme();
        }
        if (smoke.book) {
          const rep = await importBooks([smoke.book]).catch(() => null);
          if (rep && rep.imported[0]) {
            await useLibraryStore.getState().load();
            if (smoke.view === 'reader') {
              await useReaderStore.getState().open(rep.imported[0].uid).catch(() => {});
            }
          }
        }
        if (smoke.view && smoke.view !== 'reader') {
          ui.setView(smoke.view as Parameters<typeof ui.setView>[0]);
        }
        if (smoke.overlay) {
          setTimeout(() => {
            useUiStore.getState().setOverlay(smoke.overlay as Overlay);
          }, 800);
        }
      }

      if (!cancelled) {
        await useLibraryStore.getState().load();
        await useLibraryStore.getState().subscribeEvents();
        ui.setBooting(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Flush reading state when the window goes away (§5.12).
  useEffect(() => {
    const flush = () => {
      const r = useReaderStore.getState();
      if (r.book) void r.close();
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, []);

  // ------------------------------------------------- global shortcuts (§5.10)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const ui = useUiStore.getState();

      // Esc always closes the topmost overlay, even from editable fields.
      if (e.key === 'Escape') {
        if (ui.overlay) { ui.closeOverlay(); e.preventDefault(); }
        return;
      }

      // Ignore typing in form fields, except Ctrl-combos (§5.10).
      const t = e.target as HTMLElement | null;
      const editable = !!t && (
        t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
        || t.isContentEditable
      );
      if (editable && !e.ctrlKey && !e.metaKey) return;

      const shortcuts = useSettingsStore.getState().shortcuts();
      const action = findActionForEvent(shortcuts, e);
      if (!action) return;

      // Every §5.10 action is wired in Shortcuts.dispatchAction (reader-scoped,
      // overlay-scoped, typography/theme/mode, selection-scoped and window actions).
      // preventDefault must stay synchronous, so gate on the known action set and let
      // the dispatch run (it resolves the stores lazily).
      if (!isDispatchable(action)) return;
      e.preventDefault();
      void dispatchAction(action);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // ------------------------------------------------------------------ render
  const leftDrawer =
    overlay === 'toc' ? <TocPanel />
      : overlay === 'search' ? <SearchPanel />
        : overlay === 'annotations' ? <AnnotationsPanel />
          : null;

  const showReader = view === 'reader' && (book !== null || readerLoading);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[var(--v-bg)] text-[var(--v-fg)]">
      {booting ? (
        <div className="flex h-full items-center justify-center text-[var(--v-fg-muted)]">
          <Spinner size={22} />
        </div>
      ) : (
        <main className="h-full w-full">
          {showReader ? (
            readerLoading && !book
              ? (
                <div className="flex h-full items-center justify-center text-[var(--v-fg-muted)]">
                  <Spinner size={22} />
                </div>
              )
              : <ReaderView />
          )
            : view === 'library' ? <LibraryView />
              : view === 'vocab' ? <VocabView />
                : view === 'stats' ? <StatsView />
                  : view === 'settings' ? <SettingsView />
                    : <LibraryView />}
        </main>
      )}

      {/* Overlay mount points (§5.12) */}
      {leftDrawer}
      {overlay === 'quickSettings' && <QuickSettings />}
      {overlay === 'translate' && <TranslatePopup />}
      {overlay === 'dict' && <DictPopup />}
      {overlay === 'review' && <ReviewSession />}
      {suggest !== null && <SuggestChip />}

      <ToastHost />
      <ConfirmHost />
    </div>
  );
}
