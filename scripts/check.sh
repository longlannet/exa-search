#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
BASE_DIR="$(cd "$(dirname -- "$SCRIPT_PATH")/.." && pwd -P)"
CONFIG_FILE="${CONFIG_FILE:-$BASE_DIR/config/mcporter.json}"
RUN_SMOKE="${RUN_SMOKE:-0}"
DISCOVERY_TIMEOUT_MS="${DISCOVERY_TIMEOUT_MS:-15000}"
CALL_TIMEOUT_MS="${CALL_TIMEOUT_MS:-30000}"
MAX_OUTPUT_BYTES="${MAX_OUTPUT_BYTES:-4194304}"
SHOW_ERROR_OUTPUT="${SHOW_ERROR_OUTPUT:-0}"
CONFIG_HELPER="$BASE_DIR/scripts/configure.mjs"
CAPPED_RUNNER="$BASE_DIR/scripts/run-capped.sh"
CALL_HELPER="$BASE_DIR/scripts/exa-call.mjs"
SCHEMA_HELPER="$BASE_DIR/scripts/schema-list.mjs"
SCHEMA_CHECKER="$BASE_DIR/scripts/schema-check.mjs"

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
verify_policy() {
  "$NODE_BIN" "$CONFIG_HELPER" verify-policy "$CONFIG_FILE" "$MCPORTER_BIN" || \
    fail "unsafe or unsupported Exa config"
}
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
stop_active() {
  if [ -n "${ACTIVE_PID:-}" ]; then
    kill -TERM "$ACTIVE_PID" 2>/dev/null || true
    wait "$ACTIVE_PID" 2>/dev/null || true
    ACTIVE_PID=""
  fi
}
cleanup() {
  stop_active
  if [ -n "${TMP_ROOT:-}" ]; then rm -r -- "$TMP_ROOT"; TMP_ROOT=""; fi
}

require_toggle RUN_SMOKE "$RUN_SMOKE"
require_toggle SHOW_ERROR_OUTPUT "$SHOW_ERROR_OUTPUT"
require_positive_integer DISCOVERY_TIMEOUT_MS "$DISCOVERY_TIMEOUT_MS"
require_positive_integer CALL_TIMEOUT_MS "$CALL_TIMEOUT_MS"
require_positive_integer MAX_OUTPUT_BYTES "$MAX_OUTPUT_BYTES"
DISCOVERY_TIMEOUT_MS=$((10#$DISCOVERY_TIMEOUT_MS))
CALL_TIMEOUT_MS=$((10#$CALL_TIMEOUT_MS))
MAX_OUTPUT_BYTES=$((10#$MAX_OUTPUT_BYTES))
NODE_BIN="$(resolve_binary NODE_BIN node)"
MCPORTER_BIN="$(resolve_binary MCPORTER_BIN mcporter)"
TIMEOUT_BIN="$(resolve_binary TIMEOUT_BIN timeout)"
for required_file in "$CONFIG_HELPER" "$CALL_HELPER" "$SCHEMA_HELPER" "$SCHEMA_CHECKER"; do
  [ -f "$required_file" ] || fail "required helper not found: $required_file"
done
[ -x "$CAPPED_RUNNER" ] || fail "capped runner not found: $CAPPED_RUNNER"
CONFIG_FILE="$("$NODE_BIN" "$CONFIG_HELPER" resolve "$CONFIG_FILE")" || fail "failed to resolve config path"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/exa-search-check.XXXXXX")"
SCHEMA_OUTPUT="$TMP_ROOT/schema.json"
ACTIVE_PID=""
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

log "base dir: $BASE_DIR"
log "mcporter: $MCPORTER_BIN"
log "config: $CONFIG_FILE"
verify_policy
run_capped "configuration validation" "$DISCOVERY_TIMEOUT_MS" \
  "$NODE_BIN" --max-old-space-size=128 "$MCPORTER_BIN" \
  --config "$CONFIG_FILE" config doctor >/dev/null
verify_policy
log "checking Exa schema"
run_capped "schema discovery" "$DISCOVERY_TIMEOUT_MS" \
  "$NODE_BIN" --max-old-space-size=128 "$SCHEMA_HELPER" "$MCPORTER_BIN" "$CONFIG_FILE" \
  >"$SCHEMA_OUTPUT"
verify_policy
"$NODE_BIN" "$SCHEMA_CHECKER" "$SCHEMA_OUTPUT" || fail "schema response validation failed"
log "schema check: OK"

if [ "$RUN_SMOKE" = "1" ]; then
  log "running one live Exa search"
  run_capped "live search" "$CALL_TIMEOUT_MS" \
    "$NODE_BIN" --max-old-space-size=128 "$CALL_HELPER" call \
    "$MCPORTER_BIN" "$CONFIG_FILE" "$CALL_TIMEOUT_MS" \
    search 1 "OpenClaw beginner guide" >/dev/null
  verify_policy
  log "live search: OK"
else
  log "live search skipped (RUN_SMOKE=0)"
fi
log "check complete"
