#!/usr/bin/env bash
set -euo pipefail
umask 077

BASE_DIR="$(cd "$(dirname -- "$0")/.." && pwd -P)"
CONFIG_FILE="${CONFIG_FILE:-$BASE_DIR/config/mcporter.json}"
EXA_URL="${EXA_URL:-https://mcp.exa.ai/mcp}"
RUN_CHECK="${RUN_CHECK:-1}"
RUN_SMOKE="${RUN_SMOKE:-0}"
COMMAND_TIMEOUT_MS="${COMMAND_TIMEOUT_MS:-15000}"
MAX_OUTPUT_BYTES="${MAX_OUTPUT_BYTES:-4194304}"
SHOW_ERROR_OUTPUT="${SHOW_ERROR_OUTPUT:-0}"
CONFIG_HELPER="$BASE_DIR/scripts/configure.mjs"
CAPTURE_CHECKER="$BASE_DIR/scripts/run-capped.mjs"

log() { printf '[exa-search] %s\n' "$*"; }
fail() { printf '[exa-search] ERROR: %s\n' "$*" >&2; exit 1; }
require_toggle() { case "$2" in 0|1) ;; *) fail "$1 must be 0 or 1" ;; esac; }
require_positive_integer() {
  case "$2" in ''|*[!0-9]*|0) fail "$1 must be a positive integer" ;; esac
  [ "${#2}" -le 9 ] || fail "$1 is too large"
  (( 10#$2 > 0 )) || fail "$1 must be a positive integer"
}
resolve_binary() {
  local variable="$1" fallback="$2" value="${!1:-}"
  if [ -n "$value" ]; then
    [ -x "$value" ] || fail "$variable is not executable: $value"
    printf '%s\n' "$value"
    return
  fi
  command -v "$fallback" 2>/dev/null || fail "$fallback was not found"
}
show_failure_detail() {
  [ "$SHOW_ERROR_OUTPUT" = "1" ] || return 0
  [ -s "$CAPTURE_STDERR" ] || return 0
  printf '[exa-search] captured stderr tail (may contain sensitive or untrusted data):\n' >&2
  "$NODE_BIN" - "$CAPTURE_STDERR" <<'NODE'
const fs = require("fs");
const data = fs.readFileSync(process.argv[2]);
const tail = data.subarray(Math.max(0, data.length - 8192));
process.stderr.write(tail);
if (tail.length && tail[tail.length - 1] !== 10) process.stderr.write("\n");
NODE
}
capture_command() {
  local label="$1" timeout_ms="$2" duration status checker_status stdout_bytes stderr_bytes
  shift 2
  CAPTURE_INDEX=$((CAPTURE_INDEX + 1))
  CAPTURE_STDOUT="$TMP_ROOT/capture-$CAPTURE_INDEX.stdout"
  CAPTURE_STDERR="$TMP_ROOT/capture-$CAPTURE_INDEX.stderr"
  LAST_LABEL="$label"
  LAST_TIMEOUT_MS="$timeout_ms"
  LAST_CAPPED=0
  printf -v duration '%d.%03ds' "$((timeout_ms / 1000))" "$((timeout_ms % 1000))"
  (
    ulimit -f "$OUTPUT_LIMIT_BLOCKS"
    exec "$TIMEOUT_BIN" --signal=KILL "$duration" "$@"
  ) >"$CAPTURE_STDOUT" 2>"$CAPTURE_STDERR" &
  ACTIVE_PID=$!
  if wait "$ACTIVE_PID"; then status=0; else status=$?; fi
  ACTIVE_PID=""

  checker_status=0
  if "$NODE_BIN" "$CAPTURE_CHECKER" "$MAX_OUTPUT_BYTES" "$CAPTURE_STDOUT" "$CAPTURE_STDERR"; then :
  else checker_status=$?; fi
  if [ "$checker_status" -eq 70 ]; then LAST_CAPPED=1
  elif [ "$checker_status" -ne 0 ]; then fail "capture validation failed"; fi
  stdout_bytes="$(wc -c <"$CAPTURE_STDOUT")"
  stderr_bytes="$(wc -c <"$CAPTURE_STDERR")"
  if [ "$stdout_bytes" -ge "$OUTPUT_FILE_LIMIT_BYTES" ] || [ "$stderr_bytes" -ge "$OUTPUT_FILE_LIMIT_BYTES" ]; then
    LAST_CAPPED=1
  fi
  LAST_STATUS=$status
  [ "$status" -eq 0 ] && [ "$LAST_CAPPED" -eq 0 ]
}
captured_failure() {
  show_failure_detail
  [ "$LAST_CAPPED" -eq 0 ] || fail "$LAST_LABEL exceeded MAX_OUTPUT_BYTES or was truncated"
  case "$LAST_STATUS" in
    124) fail "$LAST_LABEL timed out after $LAST_TIMEOUT_MS ms" ;;
    129|130|137|143) fail "$LAST_LABEL was interrupted" ;;
    *) fail "$LAST_LABEL failed with status $LAST_STATUS" ;;
  esac
}
require_capture() { capture_command "$@" || captured_failure; }
cleanup_stage() {
  if [ -n "${STAGED_CONFIG:-}" ]; then
    "$NODE_BIN" "$CONFIG_HELPER" cleanup "$CONFIG_FILE" "$STAGED_CONFIG" >/dev/null 2>&1 || true
    STAGED_CONFIG=""
  fi
}
cleanup() {
  if [ -n "${ACTIVE_PID:-}" ]; then
    kill -KILL -- "-$ACTIVE_PID" 2>/dev/null || kill -KILL "$ACTIVE_PID" 2>/dev/null || true
    ACTIVE_PID=""
  fi
  cleanup_stage
  if [ -n "${TMP_ROOT:-}" ]; then rm -r -- "$TMP_ROOT"; TMP_ROOT=""; fi
}

require_toggle RUN_CHECK "$RUN_CHECK"
require_toggle RUN_SMOKE "$RUN_SMOKE"
require_toggle SHOW_ERROR_OUTPUT "$SHOW_ERROR_OUTPUT"
require_positive_integer COMMAND_TIMEOUT_MS "$COMMAND_TIMEOUT_MS"
require_positive_integer MAX_OUTPUT_BYTES "$MAX_OUTPUT_BYTES"
COMMAND_TIMEOUT_MS=$((10#$COMMAND_TIMEOUT_MS))
MAX_OUTPUT_BYTES=$((10#$MAX_OUTPUT_BYTES))
[ "$MAX_OUTPUT_BYTES" -ge 2048 ] || fail "MAX_OUTPUT_BYTES must be at least 2048"
OUTPUT_LIMIT_BLOCKS=$((MAX_OUTPUT_BYTES / 2048))
OUTPUT_FILE_LIMIT_BYTES=$((OUTPUT_LIMIT_BLOCKS * 1024))
NODE_BIN="$(resolve_binary NODE_BIN node)"
MCPORTER_BIN="$(resolve_binary MCPORTER_BIN mcporter)"
TIMEOUT_BIN="$(resolve_binary TIMEOUT_BIN timeout)"
[ -f "$CONFIG_HELPER" ] || fail "config helper not found: $CONFIG_HELPER"
[ -f "$CAPTURE_CHECKER" ] || fail "capture checker not found: $CAPTURE_CHECKER"
CONFIG_FILE="$("$NODE_BIN" "$CONFIG_HELPER" resolve "$CONFIG_FILE")" || fail "failed to resolve config path"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/exa-search-install.XXXXXX")"
STAGED_CONFIG="" ACTIVE_PID="" CAPTURE_INDEX=0 CAPTURE_STDOUT="" CAPTURE_STDERR=""
LAST_LABEL="" LAST_TIMEOUT_MS=0 LAST_STATUS=0 LAST_CAPPED=0
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

log "base dir: $BASE_DIR"
log "mcporter: $MCPORTER_BIN"
log "config: $CONFIG_FILE"
config_status=""
for attempt in 1 2 3 4 5; do
  STAGED_CONFIG="$("$NODE_BIN" "$CONFIG_HELPER" prepare "$CONFIG_FILE")" || fail "failed to prepare Exa config"
  require_capture "existing mcporter config validation" "$COMMAND_TIMEOUT_MS" \
    "$MCPORTER_BIN" --config "$STAGED_CONFIG" config doctor
  if capture_command "Exa configuration lookup" "$COMMAND_TIMEOUT_MS" \
      "$MCPORTER_BIN" --config "$STAGED_CONFIG" config get exa --json; then
    config_status="preserved"
  else
    [ "$LAST_STATUS" -eq 1 ] && [ "$LAST_CAPPED" -eq 0 ] || captured_failure
    require_capture "adding Exa configuration" "$COMMAND_TIMEOUT_MS" \
      "$MCPORTER_BIN" --config "$STAGED_CONFIG" config add exa "$EXA_URL"
    require_capture "updated mcporter config validation" "$COMMAND_TIMEOUT_MS" \
      "$MCPORTER_BIN" --config "$STAGED_CONFIG" config doctor
    config_status="added"
  fi
  commit_status=0
  if "$NODE_BIN" "$CONFIG_HELPER" commit "$CONFIG_FILE" "$STAGED_CONFIG"; then
    STAGED_CONFIG=""; break
  else commit_status=$?; fi
  cleanup_stage
  if [ "$commit_status" -ne 75 ] || [ "$attempt" -eq 5 ]; then fail "failed to commit Exa config safely"; fi
done
case "$config_status" in
  preserved) log "existing exa server preserved" ;;
  added) log "exa server added" ;;
  *) fail "unexpected config state" ;;
esac
if [ "$RUN_CHECK" = "1" ]; then
  NODE_BIN="$NODE_BIN" MCPORTER_BIN="$MCPORTER_BIN" TIMEOUT_BIN="$TIMEOUT_BIN" \
  CONFIG_FILE="$CONFIG_FILE" RUN_SMOKE="$RUN_SMOKE" MAX_OUTPUT_BYTES="$MAX_OUTPUT_BYTES" \
  SHOW_ERROR_OUTPUT="$SHOW_ERROR_OUTPUT" bash "$BASE_DIR/scripts/check.sh"
fi
cleanup
trap - EXIT HUP INT TERM
log "setup complete"
