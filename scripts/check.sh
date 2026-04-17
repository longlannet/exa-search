#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="$BASE_DIR/config/mcporter.json"
GLOBAL_NPM_PREFIX="${GLOBAL_NPM_PREFIX:-/root/.openclaw/workspace/.npm-global}"
GLOBAL_MCPORTER_BIN="$GLOBAL_NPM_PREFIX/bin/mcporter"
export PATH="$GLOBAL_NPM_PREFIX/bin:$PATH"
RUN_SMOKE="${RUN_SMOKE:-1}"

log() { printf '[exa-search] %s\n' "$*"; }
fail() { printf '[exa-search] ERROR: %s\n' "$*" >&2; exit 1; }

resolve_mcporter() {
  if [ -n "${MCPORTER_BIN:-}" ] && [ -x "${MCPORTER_BIN}" ]; then
    printf '%s\n' "$MCPORTER_BIN"
    return 0
  fi
  if command -v mcporter >/dev/null 2>&1; then
    command -v mcporter
    return 0
  fi
  for candidate in \
    "$GLOBAL_MCPORTER_BIN" \
    "/root/.openclaw/workspace/.npm-global/bin/mcporter"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

smoke_test() {
  log "running smoke test: exa.web_search_exa query:'OpenClaw beginner guide' numResults:1"
  (
    cd "$BASE_DIR"
    "$MCPORTER_BIN" call exa.web_search_exa query:"OpenClaw beginner guide" numResults:1 >/tmp/exa-search-check-smoke.json
  ) || fail "smoke test failed"
  log "smoke test: OK"
}

log "base dir: $BASE_DIR"
[ -f "$CONFIG_FILE" ] || fail "local mcporter config not found: $CONFIG_FILE"
log "local mcporter config: OK"

MCPORTER_BIN="$(resolve_mcporter || true)"
[ -n "$MCPORTER_BIN" ] || fail "mcporter not found. Run install.sh first or export MCPORTER_BIN"
log "mcporter: OK ($MCPORTER_BIN)"
log "shared mcporter prefix: $GLOBAL_NPM_PREFIX"
log "local mcporter config: $CONFIG_FILE"

log "checking login shell mcporter visibility"
bash -lc 'command -v mcporter >/dev/null 2>&1' || fail "login shell cannot find mcporter; run install.sh again"
log "login shell visibility: OK"

log "checking schema visibility"
(
  cd "$BASE_DIR"
  "$MCPORTER_BIN" list exa --schema >/tmp/exa-search-schema.txt
) || fail "schema check failed"
log "schema check: OK"

if [ "$RUN_SMOKE" = "1" ]; then
  smoke_test
fi

log "check complete"
