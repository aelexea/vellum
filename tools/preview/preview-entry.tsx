/**
 * Preview entry — mounts the real App with mocked Tauri modules (see vite.preview.config.ts)
 * and drives it into a requested view/overlay/theme via URL params, then signals readiness
 * for the screenshot script.
 *
 * URL: /preview.html?view=reader&overlay=search&theme=dark&selection=1
 *
 * NEVER opens a window — it is rendered by headless Chrome (tools/preview/shoot.mjs).
 * Design-tooling only; not part of the app build.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@/App';
import '@/styles/base.css';
import '@/styles/themes.css';
import { useUiStore, type Overlay, type View } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useReaderStore } from '@/stores/readerStore';
import { SETTINGS, OPEN_BOOK } from './mocks/data';

const params = new URLSearchParams(location.search);
const VIEW = (params.get('view') ?? 'library') as View;
const OVERLAY = params.get('overlay') as Overlay | null;
const THEME = params.get('theme');
const WANT_SELECTION = params.get('selection') === '1';
const MODE = params.get('mode'); // 'scroll' | 'paginated'
const SECTION = params.get('section'); // settings sub-panel

// Apply theme/mode to the FIXTURES before the app boots — get_settings and open_book
// then serve them from the start, so the reader page bg + reading mode are correct
// (patching the store after boot is too late for the reader's srcdoc/position).
if (THEME) SETTINGS.ui.themeId = THEME;
if (MODE === 'scroll' || MODE === 'paginated') {
  SETTINGS.reading.mode = MODE;
  if (OPEN_BOOK.position) OPEN_BOOK.position.mode = MODE;
}

// vellum:// fetches (chapter HTML + covers) don't exist in a browser; serve the
// fixture JSON / local files instead.
const chaptersPromise = fetch('/preview-fixtures/chapters.json').then((r) => r.json() as Promise<string[]>);
const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const chapter = url.match(/^vellum:\/\/book\/[^/]+\/chapter\/(\d+)/);
  if (chapter) {
    return chaptersPromise.then((bodies) => {
      const idx = Number(chapter[1]) || 0;
      const body = bodies[idx % bodies.length];
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/xhtml+xml' } });
    });
  }
  if (url.startsWith('vellum://')) {
    return realFetch('/preview-fixtures/covers/pg84.jpg', init);
  }
  return realFetch(input as RequestInfo, init);
}) as typeof window.fetch;

async function main() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);
  root.render(<App />);

  // Wait for boot to finish (spinner gone).
  const deadline = Date.now() + 15_000;
  while (useUiStore.getState().booting && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }

  if (THEME) {
    useSettingsStore.getState().patch({ ui: { themeId: THEME } });
    useUiStore.getState().applyTheme();
  }
  if (MODE) {
    useSettingsStore.getState().patch({ reading: { mode: MODE as 'scroll' | 'paginated' } });
  }

  if (VIEW === 'reader' || OVERLAY === 'dict' || OVERLAY === 'translate' || OVERLAY === 'toc' || OVERLAY === 'search' || OVERLAY === 'annotations' || OVERLAY === 'quickSettings') {
    useUiStore.getState().setView('reader');
    await useReaderStore.getState().open('pg84').catch(() => {});
    // Give ChapterFrame time to fetch + lay out.
    await new Promise((r) => setTimeout(r, 1200));
    if (WANT_SELECTION || OVERLAY === 'dict' || OVERLAY === 'translate') {
      useReaderStore.getState().setSelection({
        text: 'benevolent',
        cfiStart: 'epubcfi(/2/10)', cfiEnd: 'epubcfi(/2/10:10)',
        rect: { x: 460, y: 360, width: 120, height: 26 },
        sentence: 'I am by nature benevolent and good.',
        word: 'benevolent',
      });
    }
  } else {
    useUiStore.getState().setView(VIEW);
  }

  if (OVERLAY) {
    await new Promise((r) => setTimeout(r, 300));
    // dict/translate popups read `selection` (set above) + call lookup on mount.
    useUiStore.getState().setOverlay(OVERLAY);
    await new Promise((r) => setTimeout(r, 600));
    // Pre-fill the search query so the panel shows real results (debounced search).
    if (OVERLAY === 'search') {
      const input = document.querySelector<HTMLInputElement>('input[aria-label*="Search"], .vellum-panel input[type="text"], .vellum-panel input');
      if (input) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, 'monster');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  }

  // Settings sub-sections are local useState driven by the left nav; click into it.
  // Match on the nav's exact label (normalized) — a substring match would let "data"
  // hit the "Data directory" control inside the Library pane instead of the Data tab.
  if (VIEW === 'settings' && SECTION) {
    await new Promise((r) => setTimeout(r, 300));
    const norm = (s: string) => s.toLowerCase().replace(/\s*\(.*?\)\s*/g, '').trim();
    const want = norm(SECTION);
    const nav = document.querySelector('nav[aria-label="Settings sections"]');
    const btn = nav
      ? ([...nav.querySelectorAll('button')].find((b) => norm(b.textContent ?? '') === want) as HTMLElement | undefined)
      : undefined;
    if (!btn) console.error(`[preview] settings section not found: ${SECTION} (nav=${!!nav})`);
    btn?.click();
    await new Promise((r) => setTimeout(r, 500));
  }

  await new Promise((r) => setTimeout(r, 700));
  document.body.dataset.previewReady = '1';
}

void main();
