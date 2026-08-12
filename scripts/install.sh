#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
BASE_DIR="$(cd "$(dirname -- "$SCRIPT_PATH")/.." && pwd -P)"
CONFIG_FILE="${CONFIG_FILE:-$BASE_DIR/config/mcporter.json}"
RUN_CHECK="${RUN_CHECK:-1}"
RUN_SMOKE="${RUN_SMOKE:-0}"
COMMAND_TIMEOUT_MS="${COMMAND_TIMEOUT_MS:-15000}"
CALL_TIMEOUT_MS="${CALL_TIMEOUT_MS:-30000}"
MAX_OUTPUT_BYTES="${MAX_OUTPUT_BYTES:-4194304}"
SHOW_ERROR_OUTPUT="${SHOW_ERROR_OUTPUT:-0}"
CONFIG_HELPER="$BASE_DIR/scripts/configure.mjs"
CAPPED_RUNNER="$BASE_DIR/scripts/run-capped.sh"

log() { printf '[exa-search] %s\n' "$*"; }
fail() { printf '[exa-search] ERROR: %s\n' "$*" >&2; exit 1; }
require_toggle() { case "$2" in 0|1) ;; *) fail "$1 must be 0 or 1" ;; esac; }
require_positive_integer() {
  case "$2" in ''|*[!0-9]*|0) fail "$1 must be a positive integer" ;; esac
  [ "${#2}" -le 9 ] || fail "$1 is too large"
  (( 10#$2 > 0 )) || fail "$1 must be a positive integer"
}
resolve_binary() {
  local variable="$1" fallback="$2" value="${!1:-}" resolved
  if [ -n "$value" ]; then
    [ -x "$value" ] || fail "$variable is not executable: $value"
  elif [ "$fallback" = "mcporter" ] && [ -x "$BASE_DIR/node_modules/.bin/mcporter" ]; then
    value="$BASE_DIR/node_modules/.bin/mcporter"
  else
    value="$(command -v "$fallback" 2>/dev/null)" || fail "$fallback was not found"
  fi
  resolved="$(readlink -f -- "$value")" || fail "$variable could not be resolved"
  printf '%s\n' "$resolved"
}
cleanup_stage() {
  if [ -n "${STAGED_CONFIG:-}" ]; then
    "$NODE_BIN" "$CONFIG_HELPER" cleanup "$CONFIG_FILE" "$STAGED_CONFIG" >/dev/null 2>&1 || true
    STAGED_CONFIG=""
  fi
}
stop_active() {
  if [ -n "${ACTIVE_PID:-}" ]; then
    kill -TERM "$ACTIVE_PID" 2>/dev/null || true
    wait "$ACTIVE_PID" 2>/dev/null || true
    ACTIVE_PID=""
  fi
}
cleanup() { stop_active; cleanup_stage; }
run_capped() {
  local label="$1" timeout_ms="$2" status
  shift 2
  NODE_BIN="$NODE_BIN" TIMEOUT_BIN="$TIMEOUT_BIN" SHOW_ERROR_OUTPUT="$SHOW_ERROR_OUTPUT" \
    "$CAPPED_RUNNER" "$label" "$timeout_ms" "$MAX_OUTPUT_BYTES" -- "$@" &
  ACTIVE_PID=$!
  if wait "$ACTIVE_PID"; then status=0; else status=$?; fi
  ACTIVE_PID=""
  return "$status"
}
run_check() {
  local status
  NODE_BIN="$NODE_BIN" MCPORTER_BIN="$MCPORTER_BIN" TIMEOUT_BIN="$TIMEOUT_BIN" \
    CONFIG_FILE="$STAGED_CONFIG" RUN_SMOKE="$RUN_SMOKE" \
    DISCOVERY_TIMEOUT_MS="$COMMAND_TIMEOUT_MS" CALL_TIMEOUT_MS="$CALL_TIMEOUT_MS" \
    MAX_OUTPUT_BYTES="$MAX_OUTPUT_BYTES" SHOW_ERROR_OUTPUT="$SHOW_ERROR_OUTPUT" \
    bash "$BASE_DIR/scripts/check.sh" &
  ACTIVE_PID=$!
  if wait "$ACTIVE_PID"; then status=0; else status=$?; fi
  ACTIVE_PID=""
  return "$status"
}

[ "${EXA_URL+x}" != x ] || fail "EXA_URL is unsupported; only https://mcp.exa.ai/mcp is allowed"
require_toggle RUN_CHECK "$RUN_CHECK"
require_toggle RUN_SMOKE "$RUN_SMOKE"
require_toggle SHOW_ERROR_OUTPUT "$SHOW_ERROR_OUTPUT"
[ "$RUN_SMOKE" = "0" ] || [ "$RUN_CHECK" = "1" ] || fail "RUN_SMOKE=1 requires RUN_CHECK=1"
require_positive_integer COMMAND_TIMEOUT_MS "$COMMAND_TIMEOUT_MS"
require_positive_integer CALL_TIMEOUT_MS "$CALL_TIMEOUT_MS"
require_positive_integer MAX_OUTPUT_BYTES "$MAX_OUTPUT_BYTES"
COMMAND_TIMEOUT_MS=$((10#$COMMAND_TIMEOUT_MS))
CALL_TIMEOUT_MS=$((10#$CALL_TIMEOUT_MS))
MAX_OUTPUT_BYTES=$((10#$MAX_OUTPUT_BYTES))
NODE_BIN="$(resolve_binary NODE_BIN node)"
MCPORTER_BIN="$(resolve_binary MCPORTER_BIN mcporter)"
TIMEOUT_BIN="$(resolve_binary TIMEOUT_BIN timeout)"
[ -f "$CONFIG_HELPER" ] || fail "config helper not found: $CONFIG_HELPER"
[ -x "$CAPPED_RUNNER" ] || fail "capped runner not found: $CAPPED_RUNNER"
CONFIG_FILE="$("$NODE_BIN" "$CONFIG_HELPER" resolve "$CONFIG_FILE")" || fail "failed to resolve config path"
STAGED_CONFIG="" ACTIVE_PID=""
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

log "base dir: $BASE_DIR"
log "mcporter: $MCPORTER_BIN"
log "config: $CONFIG_FILE"
for attempt in 1 2 3 4 5; do
  STAGED_CONFIG="$("$NODE_BIN" "$CONFIG_HELPER" prepare "$CONFIG_FILE" "$$")" || fail "failed to prepare Exa config"
  normalize_status="$("$NODE_BIN" "$CONFIG_HELPER" normalize "$CONFIG_FILE" "$STAGED_CONFIG" "$MCPORTER_BIN")" || \
    fail "refusing unsupported existing Exa configuration"
  run_capped "staged configuration validation" "$COMMAND_TIMEOUT_MS" \
    "$MCPORTER_BIN" --config "$STAGED_CONFIG" config doctor >/dev/null

  if [ "$RUN_CHECK" = "1" ]; then
    run_check
  fi

  commit_status=0
  if "$NODE_BIN" "$CONFIG_HELPER" commit "$CONFIG_FILE" "$STAGED_CONFIG" "$MCPORTER_BIN"; then
    STAGED_CONFIG=""
    log "configuration: $normalize_status"
    break
  else
    commit_status=$?
  fi
  cleanup_stage
  if [ "$commit_status" -ne 75 ] || [ "$attempt" -eq 5 ]; then
    fail "failed to commit Exa config safely"
  fi
  log "config changed concurrently; retrying transaction"
done

cleanup
trap - EXIT HUP INT TERM
log "setup complete"
