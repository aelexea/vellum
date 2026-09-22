# Design-preview harness

Renders the real Vellum UI in **headless Chrome** against a mocked backend and
saves a PNG per view — so the whole interface can be inspected and iterated on
without ever opening a window or needing the native Tauri shell.

This is design tooling. It is not part of the app build (`npm run build` /
`tauri build` use `vite.config.ts`; this uses `vite.preview.config.ts`).

## Usage

```sh
npm run preview:shots              # build + shoot every scenario
npm run preview:shots -- reader    # only scenarios whose name contains "reader"
```

Output lands in `/tmp/vellum-design/<scenario>.png`. Override with
`DESIGN_OUT=/some/dir`, and size with `SHOT_W` / `SHOT_H` (default 1280x800).

To re-shoot after editing `src/` without a full rebuild each time:

```sh
npm run preview:build              # once, after source changes
node tools/preview/shoot.mjs       # shoots from the existing dist
```

## How it works

- `vite.preview.config.ts` aliases every `@tauri-apps/*` module to
  `mocks/core.ts`, so `invoke()` resolves from a fixture table and `listen()`
  is a no-op. No backend, no native window.
- `mocks/data.ts` holds rich, populated fixtures (books with real covers,
  vocabulary, stats, highlights) so views render with content instead of
  empty states. The cover images and chapter text under `public/preview-fixtures/`
  were extracted from the Gutenberg test books.
- `preview-entry.tsx` mounts the real `App`, drives it to the requested
  view/overlay/theme via URL params, and patches `window.fetch` so `vellum://`
  chapter/cover requests are served from the fixtures.
- `shoot.mjs` serves `dist/` over a local port and runs headless Chrome
  (`--headless=new --screenshot`) once per scenario in `SCENARIOS`.

## Scenarios

Each entry in `SCENARIOS` (shoot.mjs) maps to a view/overlay/theme combination.
Add a new one there to capture a new state. URL params understood by
`preview-entry.tsx`: `view`, `overlay`, `theme`, `mode` (scroll/paginated),
`selection=1`, `section` (settings sub-panel).

## Fixtures are not the app

Chapter text, book titles and vocabulary here are English Gutenberg samples for
visual review only. The shipped app reads real EPUBs through the Rust backend.
Nothing in `tools/preview/` is imported by `src/`.
