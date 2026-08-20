#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
BASE_DIR="$(cd "$(dirname -- "$SCRIPT_PATH")/.." && pwd -P)"
CONFIG_FILE="${CONFIG_FILE:-$BASE_DIR/config/mcporter.json}"
CALL_TIMEOUT_MS="${CALL_TIMEOUT_MS:-30000}"
MAX_OUTPUT_BYTES="${MAX_OUTPUT_BYTES:-4194304}"
SHOW_ERROR_OUTPUT="${SHOW_ERROR_OUTPUT:-0}"
CONFIG_HELPER="$BASE_DIR/scripts/configure.mjs"
CAPPED_RUNNER="$BASE_DIR/scripts/run-capped.sh"
CALL_HELPER="$BASE_DIR/scripts/exa-call.mjs"

fail() { printf '[exa-search] ERROR: %s\n' "$*" >&2; exit 1; }
resolve_binary() {
  local variable="$1" fallback="$2" value="${!1:-}" resolved
  if [ -n "$value" ]; then [ -x "$value" ] || fail "$variable is not executable";
  elif [ "$fallback" = "mcporter" ] && [ -x "$BASE_DIR/node_modules/.bin/mcporter" ]; then
    value="$BASE_DIR/node_modules/.bin/mcporter"
  else value="$(command -v "$fallback" 2>/dev/null)" || fail "$fallback was not found"; fi
  resolved="$(readlink -f -- "$value")" || fail "$variable could not be resolved"
  printf '%s\n' "$resolved"
}

[ "$#" -ge 1 ] || fail "usage: call.sh search NUM_RESULTS QUERY | fetch MAX_CHARACTERS URL [URL...]"
MODE="$1"
shift
case "$MODE" in
  search) [ "$#" -eq 2 ] || fail "search requires NUM_RESULTS and one shell-quoted QUERY" ;;
  fetch)
    if [ "$#" -lt 2 ] || [ "$#" -gt 4 ]; then
      fail "fetch requires MAX_CHARACTERS and 1-3 shell-quoted URLs"
    fi
    ;;
  *) fail "mode must be search or fetch" ;;
esac
NODE_BIN="$(resolve_binary NODE_BIN node)"
MCPORTER_BIN="$(resolve_binary MCPORTER_BIN mcporter)"
TIMEOUT_BIN="$(resolve_binary TIMEOUT_BIN timeout)"
CONFIG_FILE="$("$NODE_BIN" "$CONFIG_HELPER" resolve "$CONFIG_FILE")" || fail "failed to resolve config path"
"$NODE_BIN" "$CONFIG_HELPER" verify-policy "$CONFIG_FILE" "$MCPORTER_BIN" || fail "unsafe or unsupported Exa config"
"$NODE_BIN" "$CALL_HELPER" validate "$MCPORTER_BIN" "$CONFIG_FILE" "$CALL_TIMEOUT_MS" "$MODE" "$@" || \
  fail "invalid Exa $MODE arguments"

exec env NODE_BIN="$NODE_BIN" TIMEOUT_BIN="$TIMEOUT_BIN" SHOW_ERROR_OUTPUT="$SHOW_ERROR_OUTPUT" \
  "$CAPPED_RUNNER" "Exa $MODE" "$CALL_TIMEOUT_MS" "$MAX_OUTPUT_BYTES" -- \
  "$NODE_BIN" --max-old-space-size=128 "$CALL_HELPER" call \
  "$MCPORTER_BIN" "$CONFIG_FILE" "$CALL_TIMEOUT_MS" "$MODE" "$@"
