#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="$BASE_DIR/config"
CONFIG_FILE="$CONFIG_DIR/mcporter.json"
GLOBAL_NPM_PREFIX="${GLOBAL_NPM_PREFIX:-/root/.openclaw/workspace/.npm-global}"
GLOBAL_MCPORTER_BIN="$GLOBAL_NPM_PREFIX/bin/mcporter"
PATH_SHIM_DIR="${PATH_SHIM_DIR:-$HOME/.local/bin}"
PATH_SHIM_BIN="$PATH_SHIM_DIR/mcporter"
export PATH="$GLOBAL_NPM_PREFIX/bin:$PATH"
EXA_URL="https://mcp.exa.ai/mcp"

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

install_global_mcporter() {
  command -v npm >/dev/null 2>&1 || fail "npm not found, cannot auto-install shared mcporter"
  mkdir -p "$GLOBAL_NPM_PREFIX"
  log "mcporter not found, installing shared mcporter into: $GLOBAL_NPM_PREFIX" >&2
  npm install -g mcporter --prefix "$GLOBAL_NPM_PREFIX" >&2
  [ -x "$GLOBAL_MCPORTER_BIN" ] || fail "shared mcporter install failed: $GLOBAL_MCPORTER_BIN not found"
  printf '%s\n' "$GLOBAL_MCPORTER_BIN"
}

write_local_config() {
  mkdir -p "$CONFIG_DIR"
  cat >"$CONFIG_FILE" <<EOF
{
  "mcpServers": {
    "exa": {
      "url": "$EXA_URL"
    }
  }
}
EOF
}

ensure_command_visible() {
  mkdir -p "$PATH_SHIM_DIR"
  if [ -L "$PATH_SHIM_BIN" ] || [ ! -e "$PATH_SHIM_BIN" ]; then
    ln -sfn "$MCPORTER_BIN" "$PATH_SHIM_BIN"
    log "mcporter shim: $PATH_SHIM_BIN -> $MCPORTER_BIN"
    return 0
  fi
  log "mcporter shim skipped: existing non-symlink at $PATH_SHIM_BIN"
}

smoke_test() {
  log "running smoke test: exa.web_search_exa query:'OpenClaw beginner guide' numResults:1"
  (
    cd "$BASE_DIR"
    "$MCPORTER_BIN" call exa.web_search_exa query:"OpenClaw beginner guide" numResults:1 >/tmp/exa-search-smoke.json
  ) || fail "smoke test failed"
  log "smoke test: OK"
}

log "base dir: $BASE_DIR"
MCPORTER_BIN="$(resolve_mcporter || true)"
if [ -z "$MCPORTER_BIN" ]; then
  MCPORTER_BIN="$(install_global_mcporter)"
fi
[ -x "$MCPORTER_BIN" ] || fail "mcporter unavailable even after shared install attempt"
log "mcporter bin: $MCPORTER_BIN"
log "shared mcporter prefix: $GLOBAL_NPM_PREFIX"
ensure_command_visible

log "writing local mcporter config"
write_local_config

log "registering exa server with mcporter"
(
  cd "$BASE_DIR"
  "$MCPORTER_BIN" config add exa "$EXA_URL"
) || fail "mcporter registration failed"

log "local mcporter config: $CONFIG_FILE"
smoke_test
log "install complete"
