/**
 * Vite config for the DESIGN-PREVIEW harness only (tools/preview). Builds/serves the
 * real src/ App but aliases every @tauri-apps/* module to a mock, so the UI renders
 * in headless Chrome with fixture data — no native window, no backend.
 *
 * Not used by `tauri build` or `npm run build` (those use vite.config.ts).
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const mocks = fileURLToPath(new URL('./tools/preview/mocks/core.ts', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: fileURLToPath(new URL('./tools/preview', import.meta.url)),
  publicDir: fileURLToPath(new URL('./tools/preview/public', import.meta.url)),
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: mocks },
      { find: /^@tauri-apps\/api\/event$/, replacement: mocks },
      { find: /^@tauri-apps\/api\/path$/, replacement: mocks },
      { find: /^@tauri-apps\/plugin-dialog$/, replacement: mocks },
      { find: /^@tauri-apps\/plugin-opener$/, replacement: mocks },
      { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
    ],
  },
  server: { port: 5199, strictPort: true },
  build: { outDir: fileURLToPath(new URL('./tools/preview/dist', import.meta.url)), emptyOutDir: true },
});
