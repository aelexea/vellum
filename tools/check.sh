#!/usr/bin/env bash
# Vellum full verification gate — run before declaring integration done.
# Usage: tools/check.sh [--quick]   (--quick skips release build)
set -uo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1
QUICK="${1:-}"
FAIL=0

step() { echo; echo "═══ $* ═══"; }

step "cargo fmt --check"
(cd src-tauri && cargo fmt --check) || FAIL=$((FAIL+1))

step "cargo clippy -D warnings"
(cd src-tauri && cargo clippy --all-targets -- -D warnings 2>&1 | tail -20)
[[ ${PIPESTATUS[0]} -eq 0 ]] || FAIL=$((FAIL+1))

step "cargo test"
(cd src-tauri && cargo test 2>&1 | tail -30)
[[ ${PIPESTATUS[0]} -eq 0 ]] || FAIL=$((FAIL+1))

step "tsc + vite build"
npm run build 2>&1 | tail -8
[[ ${PIPESTATUS[0]} -eq 0 ]] || FAIL=$((FAIL+1))

step "vitest run"
npx vitest run 2>&1 | tail -20
[[ ${PIPESTATUS[0]} -eq 0 ]] || FAIL=$((FAIL+1))

if [[ "$QUICK" != "--quick" ]]; then
  step "tauri release build"
  npx tauri build --no-bundle 2>&1 | tail -6
  [[ ${PIPESTATUS[0]} -eq 0 ]] || FAIL=$((FAIL+1))
fi

echo
if [[ $FAIL -eq 0 ]]; then echo "ALL GATES GREEN"; else echo "GATES FAILED: $FAIL"; fi
exit $FAIL
