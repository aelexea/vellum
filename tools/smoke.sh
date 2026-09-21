#!/usr/bin/env bash
# Vellum smoke test: launches the release binary on the live Wayland session,
# captures screenshots of key views, asserts the process stayed alive, kills it.
#
# Env hooks the app must honor (implemented in src-tauri/src/lib.rs setup):
#   VELLUM_SMOKE=1              smoke mode (e.g. skip first-run animations noise)
#   VELLUM_SMOKE_BOOK=<epub>    auto-import this epub at startup
#   VELLUM_SMOKE_VIEW=<view>    open view: library|reader|vocab|stats|settings
#   VELLUM_SMOKE_OVERLAY=<name> open overlay in reader: toc|search|annotations|quickSettings
#   VELLUM_SMOKE_THEME=<id>     force theme: light|dark|sepia|oled
#
# Usage: tools/smoke.sh [release|debug]
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-release}"
BIN="$ROOT/src-tauri/target/$PROFILE/vellum"
OUT="${SMOKE_OUT:-/tmp/vellum-smoke}"
mkdir -p "$OUT"

if [[ ! -x "$BIN" ]]; then
  echo "FAIL: binary not found at $BIN (build first)"
  exit 1
fi

command -v grim >/dev/null || { echo "FAIL: grim not installed"; exit 1; }

FAILURES=0

shoot() { # name  [extra env...]
  local name="$1"; shift
  echo "--- launching: $name"
  env VELLUM_SMOKE=1 "$@" "$BIN" &
  local pid=$!
  sleep "${SMOKE_WAIT:-6}"
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "FAIL: [$name] process died early"; FAILURES=$((FAILURES+1))
    wait "$pid" 2>/dev/null
    return
  fi
  sleep 1
  grim "$OUT/$name.png" || { echo "FAIL: [$name] grim failed"; FAILURES=$((FAILURES+1)); }
  # give webview a moment more, second frame is more representative
  sleep 2
  grim "$OUT/$name-2.png" 2>/dev/null
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  echo "ok: $OUT/$name.png"
}

BOOK="$ROOT/testbooks/pg84.epub"

shoot library
shoot library-dark        VELLUM_SMOKE_THEME=dark
shoot reader              VELLUM_SMOKE_BOOK="$BOOK" VELLUM_SMOKE_VIEW=reader
shoot reader-toc          VELLUM_SMOKE_BOOK="$BOOK" VELLUM_SMOKE_VIEW=reader VELLUM_SMOKE_OVERLAY=toc
shoot reader-search       VELLUM_SMOKE_BOOK="$BOOK" VELLUM_SMOKE_VIEW=reader VELLUM_SMOKE_OVERLAY=search
shoot reader-quick        VELLUM_SMOKE_BOOK="$BOOK" VELLUM_SMOKE_VIEW=reader VELLUM_SMOKE_OVERLAY=quickSettings
shoot reader-sepia        VELLUM_SMOKE_BOOK="$BOOK" VELLUM_SMOKE_VIEW=reader VELLUM_SMOKE_THEME=sepia
shoot vocab               VELLUM_SMOKE_VIEW=vocab
shoot stats               VELLUM_SMOKE_VIEW=stats
shoot settings            VELLUM_SMOKE_VIEW=settings

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "SMOKE OK — screenshots in $OUT"
else
  echo "SMOKE FAILED: $FAILURES view(s) crashed or not captured"
fi
exit $FAILURES
