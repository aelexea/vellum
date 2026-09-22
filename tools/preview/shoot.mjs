#!/usr/bin/env node
/**
 * Background screenshot harness for DESIGN review — renders Vellum's UI in HEADLESS
 * Chrome (no window ever appears on the user's screen) against the mocked-backend
 * preview build, and saves a PNG per scenario.
 *
 *   node tools/preview/shoot.mjs [--build] [scenarioFilter]
 *
 * Scenarios live in SCENARIOS below. Output: /tmp/vellum-design/<name>.png
 */
import { build } from 'vite';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DIST = join(ROOT, 'dist');
const OUT = process.env.DESIGN_OUT || '/tmp/vellum-design';
const PORT = 5199;
const CHROME = process.env.CHROME_BIN || 'google-chrome-stable';

const SCENARIOS = [
  { name: '01-library',          view: 'library' },
  { name: '02-library-dark',     view: 'library', theme: 'dark' },
  { name: '03-reader',           view: 'reader' },
  { name: '04-reader-toc',       view: 'reader', overlay: 'toc' },
  { name: '05-reader-search',    view: 'reader', overlay: 'search' },
  { name: '06-reader-quick',     view: 'reader', overlay: 'quickSettings' },
  { name: '07-reader-annot',     view: 'reader', overlay: 'annotations' },
  { name: '08-reader-sepia',     view: 'reader', theme: 'sepia' },
  { name: '09-reader-oled',      view: 'reader', theme: 'oled' },
  { name: '10-reader-scroll',    view: 'reader', extra: '&mode=scroll' },
  { name: '11-translate',        view: 'reader', overlay: 'translate', selection: 1 },
  { name: '12-dict',             view: 'reader', overlay: 'dict', selection: 1 },
  { name: '13-vocab',            view: 'vocab' },
  { name: '14-review',           view: 'vocab', overlay: 'review' },
  { name: '15-stats',            view: 'stats' },
  { name: '16-settings',         view: 'settings' },
  { name: '17-settings-text',    view: 'settings', extra: '&section=text' },
  { name: '18-settings-appearance', view: 'settings', extra: '&section=appearance' },
  { name: '19-settings-reading', view: 'settings', extra: '&section=reading' },
  { name: '20-settings-translate', view: 'settings', extra: '&section=translation' },
  { name: '20b-settings-dictionary', view: 'settings', extra: '&section=dictionary' },
  { name: '21-settings-library', view: 'settings', extra: '&section=library' },
  { name: '22-settings-shortcuts', view: 'settings', extra: '&section=shortcuts' },
  { name: '23-settings-data', view: 'settings', extra: '&section=data' },
];

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };

function staticServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    let p = decodeURIComponent(url.pathname);
    if (p === '/') p = '/index.html';
    const file = join(DIST, normalize(p).replace(/^(\.\.[/\\])+/, ''));
    try {
      const s = await stat(file);
      if (s.isDirectory()) throw new Error('dir');
      const buf = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch {
      // SPA fallback for client-side routing; also serve index.html
      try {
        const buf = await readFile(join(DIST, 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(buf);
      } catch {
        res.writeHead(404); res.end('not found');
      }
    }
  });
}

function urlFor(sc) {
  const q = new URLSearchParams();
  q.set('view', sc.view);
  if (sc.overlay) q.set('overlay', sc.overlay);
  if (sc.theme) q.set('theme', sc.theme);
  if (sc.selection) q.set('selection', '1');
  return `http://localhost:${PORT}/index.html?${q.toString()}${sc.extra ?? ''}`;
}

function shoot(url, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--force-device-scale-factor=1',
      `--window-size=${process.env.SHOT_W || 1280},${process.env.SHOT_H || 800}`,
      '--virtual-time-budget=12000',
      `--screenshot=${outPath}`, url,
    ];
    const c = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('error', reject);
    c.on('close', (code) => {
      if (code === 0) resolve(outPath);
      else reject(new Error(`chrome exited ${code}: ${err.slice(-400)}`));
    });
  });
}

const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
const wantBuild = process.argv.includes('--build');

const todo = SCENARIOS.filter((s) => !filter || s.name.includes(filter));
if (wantBuild) {
  console.error('building preview bundle…');
  await build({ configFile: join(ROOT, '..', '..', 'vite.preview.config.ts') });
}

const server = staticServer();
await new Promise((r) => server.listen(PORT, r));
console.error(`static server on :${PORT}; ${todo.length} scenario(s) → ${OUT}`);

import { mkdir } from 'node:fs/promises';
await mkdir(OUT, { recursive: true });

let ok = 0;
for (const sc of todo) {
  const out = join(OUT, `${sc.name}.png`);
  try {
    await shoot(urlFor(sc), out);
    console.error(`  ok  ${sc.name}`);
    ok++;
  } catch (e) {
    console.error(`  FAIL ${sc.name}: ${e.message}`);
  }
}
server.close();
console.error(`done: ${ok}/${todo.length} screenshots`);
process.exit(ok === todo.length ? 0 : 1);
