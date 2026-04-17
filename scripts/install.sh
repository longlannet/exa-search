#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_DIR="$BASE_DIR/config"
CONFIG_FILE="$CONFIG_DIR/mcporter.json"
GLOBAL_NPM_PREFIX="${GLOBAL_NPM_PREFIX:-/root/.openclaw/workspace/.npm-global}"
GLOBAL_MCPORTER_BIN="$GLOBAL_NPM_PREFIX/bin/mcporter"
PATH_SHIM_DIR="${PATH_SHIM_DIR:-$HOME/.local/bin}"
PATH_SHIM_BIN="$PATH_SHIM_DIR/mcporter"
LEGACY_LOGIN_PATH_LINES=(
  'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/root/.openclaw/workspace/.npm-global/bin:$PATH"'
)
PATH_BLOCK_HEADER='# exa-search mcporter PATH'
LOGIN_PATH_LINES=(
  'path_prepend_once() {'
  '  case ":$PATH:" in'
  '    *":$1:"*) ;;'
  '    *) PATH="$1:$PATH" ;;'
  '  esac'
  '}'
  'path_dedupe() {'
  '  local old_path="$PATH" new_path="" dir IFS=":"'
  '  for dir in $old_path; do'
  '    [ -n "$dir" ] || continue'
  '    case ":$new_path:" in'
  '      *":$dir:"*) ;;'
  '      *) new_path="${new_path:+$new_path:}$dir" ;;'
  '    esac'
  '  done'
  '  PATH="$new_path"'
  '}'
  'path_prepend_once "/root/.openclaw/workspace/.npm-global/bin"'
  'path_prepend_once "$HOME/.npm-global/bin"'
  'path_prepend_once "$HOME/.local/bin"'
  'path_dedupe'
  'export PATH'
)
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

normalize_login_shell_path() {
  local file legacy_line
  for file in "$HOME/.bashrc" "$HOME/.profile"; do
    touch "$file"
    for legacy_line in "${LEGACY_LOGIN_PATH_LINES[@]}"; do
      python3 - <<'PY' "$file" "$legacy_line" "$PATH_BLOCK_HEADER"
import sys
path, legacy, header = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, 'r', encoding='utf-8') as f:
    lines = f.read().splitlines()
out = []
i = 0
changed = False
while i < len(lines):
    line = lines[i]
    if line == legacy:
        changed = True
        i += 1
        continue
    if line == header:
        changed = True
        i += 1
        while i < len(lines) and lines[i] != 'export PATH':
            i += 1
        if i < len(lines) and lines[i] == 'export PATH':
            i += 1
        continue
    out.append(line)
    i += 1
with open(path, 'w', encoding='utf-8') as f:
    for line in out:
        f.write(line + '\n')
print('changed' if changed else 'unchanged')
PY
    done
  done
  if ! grep -Fqx "$PATH_BLOCK_HEADER" "$HOME/.bashrc"; then
    printf '\n%s\n' "$PATH_BLOCK_HEADER" >> "$HOME/.bashrc"
    for line in "${LOGIN_PATH_LINES[@]}"; do
      printf '%s\n' "$line" >> "$HOME/.bashrc"
    done
    log "added deduplicating PATH block to $HOME/.bashrc"
  else
    log "deduplicating PATH block already present in $HOME/.bashrc"
  fi
}

verify_login_shell_visibility() {
  normalize_login_shell_path
  if bash -lc 'command -v mcporter >/dev/null 2>&1'; then
    log "login shell mcporter visibility: OK"
    return 0
  fi
  fail "mcporter still not visible in login shell after PATH normalization"
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
verify_login_shell_visibility

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
