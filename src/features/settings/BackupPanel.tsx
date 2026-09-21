/**
 * BackupPanel — [F3] per ARCHITECTURE.md §5.9 (Data section).
 * Grid of async actions, each with a local spinner + toast: vocab export/import,
 * annotations export/import, settings export/import, DB backup, plus the auto-backup
 * info line and "Open data folder" (opener plugin).
 * Format pickers (json/csv/anki, json/md) are a small segmented popover above the button.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/components/icons';
import type { IconName } from '@/components/icons';
import { Popover } from '@/components/Popover';
import { Segmented } from '@/components/Segmented';
import { Spinner } from '@/components/Spinner';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { appDataDir } from '@tauri-apps/api/path';
import {
  backupDb, exportAnnotations, exportSettings, exportVocab,
  importAnnotations, importSettings, importVocab,
  openPath, saveFile,
} from '@/lib/tauri';
import { errMsg } from '@/lib/utils';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';

type ActionId =
  | 'exportVocab' | 'importVocab' | 'exportNotes' | 'importNotes'
  | 'exportSettings' | 'importSettings' | 'backupDb';

const ACTIONS: { id: ActionId; label: string; icon: IconName }[] = [
  { id: 'exportVocab', label: 'Export vocabulary', icon: 'languages' },
  { id: 'importVocab', label: 'Import vocabulary', icon: 'plus' },
  { id: 'exportNotes', label: 'Export notes', icon: 'notes' },
  { id: 'importNotes', label: 'Import notes', icon: 'plus' },
  { id: 'exportSettings', label: 'Export settings', icon: 'settings' },
  { id: 'importSettings', label: 'Import settings', icon: 'settings' },
  { id: 'backupDb', label: 'Back up database', icon: 'layers' },
];

/** Actions that need a format choice first. */
const FORMATS: Partial<Record<ActionId, string[]>> = {
  exportVocab: ['json', 'csv', 'anki'],
  exportNotes: ['json', 'md'],
};

const DEFAULT_NAME: Record<ActionId, string> = {
  exportVocab: 'vellum-vocab.json',
  importVocab: '',
  exportNotes: 'vellum-annotations.json',
  importNotes: '',
  exportSettings: 'vellum-settings.json',
  importSettings: '',
  backupDb: 'vellum-backup.db',
};

const JSON_CSV_FILTER = { name: 'JSON / CSV', extensions: ['json', 'csv'] };
const JSON_FILTER = { name: 'JSON', extensions: ['json'] };

/** Open-file picker for imports (lib/tauri.ts has no generic openFile; frozen). */
async function pickImportFile(filter: typeof JSON_CSV_FILTER): Promise<string | null> {
  const picked = await dialogOpen({
    multiple: false,
    filters: [filter],
    title: 'Choose file',
  });
  if (picked === null) return null;
  return Array.isArray(picked) ? (picked[0] ?? null) : picked;
}

export function BackupPanel() {
  const toast = useUiStore((s) => s.toast);
  const load = useSettingsStore((s) => s.load);
  const applyTheme = useUiStore((s) => s.applyTheme);

  const [busy, setBusy] = useState<ActionId | null>(null);
  const [formatFor, setFormatFor] = useState<ActionId | null>(null);
  const anchorRef = useRef<Record<string, HTMLElement | null>>({});

  // Close the format popover on outside click / Esc.
  useEffect(() => {
    if (formatFor === null) return;
    const onDown = (e: MouseEvent) => {
      const anchor = anchorRef.current[formatFor];
      if (anchor && anchor.contains(e.target as Node)) return;
      const pop = document.querySelector('[data-format-popover]');
      if (pop && pop.contains(e.target as Node)) return;
      setFormatFor(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFormatFor(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [formatFor]);

  const run = async (id: ActionId, format?: string) => {
    setFormatFor(null);
    setBusy(id);
    try {
      switch (id) {
        case 'exportVocab': {
          const ext = format ?? 'json';
          const path = await saveFile(nameWithExt(DEFAULT_NAME.exportVocab, ext), [
            { name: ext.toUpperCase(), extensions: [ext] },
          ]);
          if (path === null) return;
          const n = await exportVocab(path, ext);
          toast(`Done · words: ${n}`, 'success');
          break;
        }
        case 'importVocab': {
          const path = await pickImportFile(JSON_CSV_FILTER);   // §4.6: json + csv
          if (path === null) return;
          const n = await importVocab(path);
          toast(`Words imported: ${n}`, 'success');
          break;
        }
        case 'exportNotes': {
          const ext = format ?? 'json';
          const path = await saveFile(nameWithExt(DEFAULT_NAME.exportNotes, ext), [
            { name: ext.toUpperCase(), extensions: [ext] },
          ]);
          if (path === null) return;
          const n = await exportAnnotations(null, path, ext);
          toast(`Done · entries: ${n}`, 'success');
          break;
        }
        case 'importNotes': {
          const path = await pickImportFile(JSON_FILTER);        // §4.7: json only
          if (path === null) return;
          const n = await importAnnotations(path);
          toast(`Entries imported: ${n}`, 'success');
          break;
        }
        case 'exportSettings': {
          const path = await saveFile(DEFAULT_NAME.exportSettings, [
            { name: 'JSON', extensions: ['json'] },
          ]);
          if (path === null) return;
          await exportSettings(path);
          toast('Done', 'success');
          break;
        }
        case 'importSettings': {
          const path = await pickImportFile(JSON_FILTER);        // §4.7: json only
          if (path === null) return;
          await importSettings(path);
          await load();                    // refresh the store from the imported file
          applyTheme();
          toast('Done', 'success');
          break;
        }
        case 'backupDb': {
          const path = await saveFile(DEFAULT_NAME.backupDb, [
            { name: 'SQLite', extensions: ['db'] },
          ]);
          if (path === null) return;
          await backupDb(path);
          toast('Done', 'success');
          break;
        }
      }
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(null);
    }
  };

  const onClickAction = (id: ActionId) => {
    const formats = FORMATS[id];
    if (formats && formats.length > 1) {
      setFormatFor((cur) => (cur === id ? null : id));
      return;
    }
    void run(id);
  };

  const openDataDir = async () => {
    try {
      // Resolve the real app-data dir at runtime; fall back to the XDG default
      // when the path API is unavailable (e.g. plain-browser dev).
      const dir = await appDataDir().catch(() => DATA_DIR);
      await openPath(dir);
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {ACTIONS.map((a) => (
          <div key={a.id} className="relative">
            <button
              type="button"
              className="vellum-btn w-full justify-start"
              data-action={a.id}
              disabled={busy !== null}
              aria-haspopup={FORMATS[a.id] ? 'menu' : undefined}
              aria-expanded={formatFor === a.id}
              ref={(el) => { anchorRef.current[a.id] = el; }}
              onClick={() => onClickAction(a.id)}
            >
              {busy === a.id
                ? <Spinner size={15} label="Working…" />
                : <Icon name={a.icon} size={15} className="shrink-0 text-[var(--v-fg-muted)]" />}
              <span className="truncate">{a.label}</span>
            </button>

            <Popover
              open={formatFor === a.id}
              onClose={() => setFormatFor(null)}
              anchorEl={anchorRef.current[a.id] ?? null}
              placement="bottom-start"
              className="p-1"
            >
              <div data-format-popover>
                <Segmented
                  ariaLabel="Format"
                  size="sm"
                  value=""
                  onChange={(v) => void run(a.id, v)}
                  options={(FORMATS[a.id] ?? []).map((f) => ({
                    value: f, label: f.toUpperCase(),
                  }))}
                />
              </div>
            </Popover>
          </div>
        ))}
      </div>

      <p className="v-set-desc">Auto-backup runs every 7 days</p>

      <div>
        <button type="button" className="vellum-btn" data-action="openDataDir" onClick={() => void openDataDir()}>
          <Icon name="layers" size={15} className="text-[var(--v-fg-muted)]" />
          Open data folder
        </button>
      </div>
    </div>
  );
}

/** Data dir per §4.7 — used for "Open data folder". */
const DATA_DIR = '~/.local/share/com.vellum.reader';

/** Replace the extension of a default file name. */
function nameWithExt(name: string, ext: string): string {
  return `${name.replace(/\.[a-z0-9]+$/i, '')}.${ext}`;
}

export default BackupPanel;
