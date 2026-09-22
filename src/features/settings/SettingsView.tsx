/**
 * SettingsView — [F3] per ARCHITECTURE.md §5.9.
 * Full view: 220 px left nav (8 sections) + scrollable right pane (max-w 720 px).
 * Header "Settings" + back arrow returning to the previous view via uiStore.
 * Every control change calls settingsStore.patch() immediately — zero save buttons
 * (the store debounces persistence).
 */
import { useEffect, useState } from 'react';
import '@/styles/themes.css';
import { Icon } from '@/components/icons';
import type { IconName } from '@/components/icons';
import { Segmented } from '@/components/Segmented';
import { Select } from '@/components/Select';
import { Slider } from '@/components/Slider';
import { Switch } from '@/components/Switch';
import { PageMock, ThemeEditor } from '@/features/settings/ThemeEditor';
import { TypographyPanel } from '@/features/settings/TypographyPanel';
import { TranslatorsPanel } from '@/features/settings/TranslatorsPanel';
import { ShortcutsPanel } from '@/features/settings/ShortcutsPanel';
import { BackupPanel } from '@/features/settings/BackupPanel';
import { BUILTIN_THEMES } from '@/lib/themes';
import { openDir, rescanLibrary } from '@/lib/tauri';
import type { Theme } from '@/lib/types';
import { cn, errMsg } from '@/lib/utils';
import { useLibraryStore } from '@/stores/libraryStore';
import { useReaderStore } from '@/stores/readerStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

type Section =
  | 'appearance' | 'text' | 'reading' | 'translate'
  | 'dictionary' | 'library' | 'shortcuts' | 'data';

const SECTIONS: { id: Section; label: string; icon: IconName }[] = [
  { id: 'appearance', label: 'Appearance', icon: 'sun' },
  { id: 'text', label: 'Text', icon: 'type' },
  { id: 'reading', label: 'Reading', icon: 'book' },
  { id: 'translate', label: 'Translation', icon: 'languages' },
  { id: 'dictionary', label: 'Dictionary (study)', icon: 'bookmark' },
  { id: 'library', label: 'Library', icon: 'layers' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'toc' },
  { id: 'data', label: 'Data', icon: 'notes' },
];

const SORT_OPTIONS = [
  { value: 'lastOpened', label: 'Recently opened' },
  { value: 'title', label: 'Title' },
  { value: 'author', label: 'Author' },
  { value: 'progress', label: 'Progress' },
  { value: 'added', label: 'Date added' },
];

function ThemeCard({
  theme, active, onSelect,
}: { theme: Theme; active: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      data-theme-id={theme.id}
      className={cn(
        'flex flex-col gap-2 rounded-[var(--radius)] border p-2 text-left transition-colors',
        active
          ? 'border-[var(--v-accent)] bg-[color-mix(in_srgb,var(--v-accent)_8%,transparent)]'
          : 'border-[var(--v-border)] bg-[var(--v-bg-alt)] hover:border-[color-mix(in_srgb,var(--v-fg)_25%,var(--v-border))]',
      )}
      style={{ transitionDuration: 'var(--dur-fast)', transitionTimingFunction: 'var(--ease)' }}
    >
      <PageMock theme={theme} />
      <span className="flex items-center gap-1.5 px-0.5 text-[12px]">
        <span className="truncate">{theme.name}</span>
        {active && (
          <Icon name="check" size={13} className="ml-auto shrink-0 text-[var(--v-accent)]" />
        )}
      </span>
    </button>
  );
}

/** Label + optional muted description, left column of a settings row. */
function RowLabel({ label, desc }: { label: string; desc?: string }) {
  return (
    <div className="min-w-0">
      <div className="v-set-label">{label}</div>
      {desc && <div className="v-set-desc">{desc}</div>}
    </div>
  );
}

export default function SettingsView() {
  const [section, setSection] = useState<Section>('appearance');
  // null = closed; 'new' = creating; otherwise the id of the custom theme being edited.
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  const settings = useSettingsStore((s) => s.settings);
  const patch = useSettingsStore((s) => s.patch);
  const applyTheme = useUiStore((s) => s.applyTheme);
  const setView = useUiStore((s) => s.setView);
  const confirm = useUiStore((s) => s.confirm);
  const toast = useUiStore((s) => s.toast);
  const book = useReaderStore((s) => s.book);

  const customThemes = settings.ui.customThemes;
  const themeId = settings.ui.themeId;
  const allThemes: Theme[] = [...BUILTIN_THEMES, ...customThemes];
  const activeTheme = allThemes.find((t) => t.id === themeId) ?? BUILTIN_THEMES[0]!;

  // Animations off → kill-switch data attribute consumed by themes.css (§5.9).
  useEffect(() => {
    document.documentElement.dataset.animations = settings.ui.animations ? 'on' : 'false';
  }, [settings.ui.animations]);

  const selectTheme = (id: string) => {
    patch({ ui: { themeId: id } });
    applyTheme();
  };

  const back = () => {
    useSettingsStore.getState().flush();
    setView(book !== null ? 'reader' : 'library');
  };

  const removeTheme = async (t: Theme) => {
    const ok = await confirm({
      title: `Delete theme “${t.name}”?`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    patch({
      ui: {
        customThemes: customThemes.filter((c) => c.id !== t.id),
        // Deleting the active theme falls back to 'light'.
        themeId: themeId === t.id ? 'light' : themeId,
      },
    });
    applyTheme();
  };

  const addDir = async () => {
    try {
      const dir = await openDir();
      if (!dir) return;
      const dirs = settings.library.watchedDirs;
      if (dirs.includes(dir)) return;
      patch({ library: { watchedDirs: [...dirs, dir] } });
      // Scan the new folder immediately so the user sees feedback; without this the
      // folder stays inert until an explicit Rescan (libraryStore.scanDir already
      // reports imported/skipped counts via a toast and reloads the grid).
      await useLibraryStore.getState().scanDir(dir);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  const onRescan = async () => {
    try {
      const rep = await rescanLibrary();
      toast(`Books added: ${rep.imported.length}`, 'success');
      await useLibraryStore.getState().load();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  // Draft for the editor: clone of the active theme when creating, the stored one when editing.
  const editorTheme: Theme | null =
    editing === 'new'
      ? { ...activeTheme, id: '', name: '', builtin: false }
      : editing !== null
        ? (customThemes.find((t) => t.id === editing) ?? null)
        : null;

  return (
    <div className="flex h-full w-full flex-col bg-[var(--v-bg)] text-[var(--v-fg)]">
      <header className="flex h-[44px] shrink-0 items-center gap-2 border-b border-[var(--v-border)] px-3">
        <button type="button" className="vellum-icon-btn" aria-label="Back" onClick={back}>
          <Icon name="arrowLeft" size={18} />
        </button>
        <h1 className="text-[15px] font-semibold">Settings</h1>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="flex w-[220px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--v-border)] p-2"
        >
          {SECTIONS.map((s) => {
            const active = s.id === section;
            return (
              <button
                key={s.id}
                type="button"
                aria-current={active}
                onClick={() => setSection(s.id)}
                className={cn(
                  'flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-[13px]',
                  'transition-colors',
                  active
                    ? 'bg-[color-mix(in_srgb,var(--v-accent)_14%,transparent)] font-medium text-[var(--v-accent)]'
                    : 'text-[var(--v-fg-muted)] hover:bg-[color-mix(in_srgb,var(--v-fg)_6%,transparent)] hover:text-[var(--v-fg)]',
                )}
                style={{ transitionDuration: 'var(--dur-fast)', transitionTimingFunction: 'var(--ease)' }}
              >
                <Icon name={s.icon} size={16} className="shrink-0" />
                <span className="truncate">{s.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div key={section} className="v-section mx-auto w-full max-w-[720px] px-6 py-5">
            {section === 'appearance' && (
              <>
                <h2 className="v-set-head">Theme</h2>
                <div className="grid grid-cols-2 gap-3 sm:max-w-[420px]">
                  {BUILTIN_THEMES.map((t) => (
                    <ThemeCard
                      key={t.id}
                      theme={t}
                      active={themeId === t.id}
                      onSelect={() => selectTheme(t.id)}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={() => setEditing('new')}
                    className={cn(
                      'flex min-h-[118px] flex-col items-center justify-center gap-1.5',
                      'rounded-[var(--radius)] border border-dashed border-[var(--v-border)]',
                      'text-[12px] text-[var(--v-fg-muted)] transition-colors',
                      'hover:border-[var(--v-accent)] hover:text-[var(--v-accent)]',
                    )}
                    style={{ transitionDuration: 'var(--dur-fast)', transitionTimingFunction: 'var(--ease)' }}
                  >
                    <Icon name="plus" size={20} />
                    <span>Create theme</span>
                  </button>
                </div>

                {customThemes.length > 0 && (
                  <>
                    <h2 className="v-set-head">Custom themes</h2>
                    <ul className="flex flex-col gap-1.5">
                      {customThemes.map((t) => (
                        <li
                          key={t.id}
                          className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--v-border)] bg-[var(--v-bg-alt)] px-2 py-1.5"
                        >
                          <span
                            className="h-6 w-6 shrink-0 rounded-[4px] border border-[var(--v-border)]"
                            style={{ background: t.page.bg }}
                            aria-hidden
                          />
                          <button
                            type="button"
                            className={cn(
                              'min-w-0 flex-1 truncate text-left text-[13px]',
                              themeId === t.id && 'text-[var(--v-accent)]',
                            )}
                            onClick={() => selectTheme(t.id)}
                          >
                            {t.name || 'Untitled'}
                          </button>
                          <button
                            type="button"
                            className="vellum-icon-btn !h-7 !w-7"
                            aria-label="Edit theme"
                            onClick={() => setEditing(t.id)}
                          >
                            <Icon name="edit" size={15} />
                          </button>
                          <button
                            type="button"
                            className="vellum-icon-btn !h-7 !w-7"
                            aria-label="Delete theme"
                            onClick={() => void removeTheme(t)}
                          >
                            <Icon name="trash" size={15} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                <h2 className="v-set-head">Interface</h2>
                <div className="flex flex-col divide-y divide-[var(--v-border)]">
                  <div className="py-2">
                    <Switch
                      label="Animations"
                      checked={settings.ui.animations}
                      onChange={(v) => patch({ ui: { animations: v } })}
                    />
                  </div>
                  <div className="py-2">
                    <Switch
                      label="Hide interface while reading"
                      description="The top and bottom bars hide when you stop moving the mouse."
                      checked={settings.ui.autoHideChrome}
                      onChange={(v) => patch({ ui: { autoHideChrome: v } })}
                    />
                  </div>
                </div>
              </>
            )}

            {section === 'text' && <TypographyPanel />}

            {section === 'reading' && (
              <>
                <div className="v-set-row">
                  <RowLabel label="Reading mode" />
                  <div className="v-set-control">
                    <Segmented
                      ariaLabel="Reading mode"
                      value={settings.reading.mode}
                      onChange={(v) => patch({ reading: { mode: v } })}
                      options={[
                        { value: 'paginated', label: 'Pages' },
                        { value: 'scroll', label: 'Scroll' },
                      ]}
                    />
                  </div>
                </div>
                <div className="v-set-row">
                  <RowLabel label="Page-turn animation" />
                  <div className="v-set-control">
                    <Select
                      ariaLabel="Page-turn animation"
                      className="w-full"
                      value={settings.reading.pageTurn}
                      onChange={(v) =>
                        patch({ reading: { pageTurn: v as 'slide' | 'fade' | 'none' } })}
                      options={[
                        { value: 'slide', label: 'Slide' },
                        { value: 'fade', label: 'Fade' },
                        { value: 'none', label: 'No animation' },
                      ]}
                    />
                  </div>
                </div>
                <div className="mt-2 flex flex-col divide-y divide-[var(--v-border)]">
                  <div className="py-2">
                    <Switch
                      label="Preload chapters"
                      description="Neighboring chapters are prepared ahead, so page turns are instant."
                      checked={settings.reading.prefetch}
                      onChange={(v) => patch({ reading: { prefetch: v } })}
                    />
                  </div>
                  <div className="py-2">
                    <Switch
                      label="Mouse wheel turns pages"
                      checked={settings.reading.wheelTurnsPage}
                      onChange={(v) => patch({ reading: { wheelTurnsPage: v } })}
                    />
                  </div>
                  <div className="py-2">
                    <Switch
                      label="Click zones"
                      description="Click left to go back, right to go forward, center to hide the bars."
                      checked={settings.reading.clickZones}
                      onChange={(v) => patch({ reading: { clickZones: v } })}
                    />
                  </div>
                </div>
              </>
            )}

            {section === 'translate' && <TranslatorsPanel mode="translate" />}

            {section === 'dictionary' && (
              <>
                <TranslatorsPanel mode="dict" />
                <h2 className="v-set-head">Review</h2>
                <div className="v-set-row">
                  <RowLabel
                    label="Suggest word after N lookups"
                    desc="How many times you must select a word before Vellum suggests adding it to your vocabulary."
                  />
                  <div className="v-set-control">
                    <Slider
                      ariaLabel="Suggest word after N lookups"
                      min={1}
                      max={10}
                      step={1}
                      value={settings.vocab.suggestAfterLookups}
                      format={(v) => `${v}`}
                      onChange={(v) => patch({ vocab: { suggestAfterLookups: v } })}
                    />
                    <span className="vellum-num w-6 shrink-0 text-right text-[12px]">
                      {settings.vocab.suggestAfterLookups}
                    </span>
                  </div>
                </div>
                <div className="v-set-row">
                  <RowLabel label="Daily review limit" />
                  <div className="v-set-control">
                    <Slider
                      ariaLabel="Daily review limit"
                      min={10}
                      max={200}
                      step={10}
                      value={settings.vocab.dailyReviewLimit}
                      format={(v) => `${v}`}
                      onChange={(v) => patch({ vocab: { dailyReviewLimit: v } })}
                    />
                    <span className="vellum-num w-8 shrink-0 text-right text-[12px]">
                      {settings.vocab.dailyReviewLimit}
                    </span>
                  </div>
                </div>
              </>
            )}

            {section === 'library' && (
              <>
                <h2 className="v-set-head">Folders</h2>
                <ul className="flex flex-col gap-1.5">
                  {settings.library.watchedDirs.length === 0 && (
                    <li className="text-[12px] text-[var(--v-fg-muted)]">
                      No folders added — books are imported manually.
                    </li>
                  )}
                  {settings.library.watchedDirs.map((dir) => (
                    <li
                      key={dir}
                      className="flex items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--v-border)] bg-[var(--v-bg-alt)] px-2.5 py-1.5"
                    >
                      <span className="vellum-selectable min-w-0 flex-1 truncate text-[12px]">
                        {dir}
                      </span>
                      <button
                        type="button"
                        className="vellum-icon-btn !h-7 !w-7"
                        aria-label={`Remove folder ${dir}`}
                        onClick={() =>
                          patch({
                            library: {
                              watchedDirs: settings.library.watchedDirs.filter((d) => d !== dir),
                            },
                          })}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="mt-2 flex gap-2">
                  <button type="button" className="vellum-btn" onClick={() => void addDir()}>
                    <Icon name="plus" size={15} />
                    Add folder
                  </button>
                  <button type="button" className="vellum-btn" onClick={() => void onRescan()}>
                    Rescan
                  </button>
                </div>

                <h2 className="v-set-head">Library view</h2>
                <div className="v-set-row">
                  <RowLabel label="Display" />
                  <div className="v-set-control">
                    <Segmented
                      ariaLabel="Display"
                      value={settings.library.view}
                      onChange={(v) => patch({ library: { view: v } })}
                      options={[
                        { value: 'grid', label: 'Grid' },
                        { value: 'list', label: 'List' },
                      ]}
                    />
                  </div>
                </div>
                <div className="v-set-row">
                  <RowLabel label="Sort" />
                  <div className="v-set-control">
                    <Select
                      ariaLabel="Sort"
                      className="w-full"
                      value={settings.library.sort}
                      onChange={(v) =>
                        patch({ library: { sort: v as typeof settings.library.sort } })}
                      options={SORT_OPTIONS}
                    />
                  </div>
                </div>
              </>
            )}

            {section === 'shortcuts' && <ShortcutsPanel />}

            {section === 'data' && <BackupPanel />}
          </div>
        </div>
      </div>

      <ThemeEditor theme={editorTheme} onClose={() => setEditing(null)} />
    </div>
  );
}
