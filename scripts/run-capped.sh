#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
BASE_DIR="$(cd "$(dirname -- "$SCRIPT_PATH")/.." && pwd -P)"
CAPTURE_CHECKER="$BASE_DIR/scripts/run-capped.mjs"
SAFE_TAIL="$BASE_DIR/scripts/safe-tail.mjs"

log_error() { printf '[exa-search] ERROR: %s\n' "$*" >&2; }
fail() { log_error "$*"; exit 1; }
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
    resolved="$(readlink -f -- "$value")" || fail "$variable could not be resolved"
  else
    value="$(command -v "$fallback" 2>/dev/null)" || fail "$fallback was not found"
    resolved="$(readlink -f -- "$value")" || fail "$fallback could not be resolved"
  fi
  printf '%s\n' "$resolved"
}
# shellcheck disable=SC2317 # cleanup is invoked by signal and EXIT traps.
cleanup() {
  if [ -n "${ACTIVE_PID:-}" ]; then
    kill -KILL -- "-$ACTIVE_PID" 2>/dev/null || kill -KILL "$ACTIVE_PID" 2>/dev/null || true
    ACTIVE_PID=""
  fi
  if [ -n "${TMP_ROOT:-}" ]; then rm -r -- "$TMP_ROOT"; TMP_ROOT=""; fi
}
show_failure_detail() {
  [ "$SHOW_ERROR_OUTPUT" = "1" ] || return 0
  [ -s "$CAPTURE_STDERR" ] || return 0
  printf '[exa-search] captured stderr tail (control characters escaped; may contain sensitive or untrusted data):\n' >&2
  "$NODE_BIN" "$SAFE_TAIL" "$CAPTURE_STDERR" 8192 || fail "failed to sanitize captured stderr"
}

[ "$#" -ge 5 ] || fail "usage: run-capped.sh LABEL TIMEOUT_MS MAX_OUTPUT_BYTES -- COMMAND [ARG...]"
LABEL="$1" TIMEOUT_MS="$2" MAX_OUTPUT_BYTES="$3"
shift 3
[ "$1" = "--" ] || fail "missing command separator"
shift
[ "$#" -gt 0 ] || fail "command is required"
SHOW_ERROR_OUTPUT="${SHOW_ERROR_OUTPUT:-0}"
require_toggle SHOW_ERROR_OUTPUT "$SHOW_ERROR_OUTPUT"
require_positive_integer TIMEOUT_MS "$TIMEOUT_MS"
require_positive_integer MAX_OUTPUT_BYTES "$MAX_OUTPUT_BYTES"
TIMEOUT_MS=$((10#$TIMEOUT_MS))
MAX_OUTPUT_BYTES=$((10#$MAX_OUTPUT_BYTES))
[ "$MAX_OUTPUT_BYTES" -ge 2048 ] || fail "MAX_OUTPUT_BYTES must be at least 2048"
OUTPUT_LIMIT_BLOCKS=$((MAX_OUTPUT_BYTES / 2048))
OUTPUT_FILE_LIMIT_BYTES=$((OUTPUT_LIMIT_BLOCKS * 1024))
NODE_BIN="$(resolve_binary NODE_BIN node)"
TIMEOUT_BIN="$(resolve_binary TIMEOUT_BIN timeout)"
BASH_BIN="$(readlink -f -- "$BASH")" || fail "bash could not be resolved"
[ -x "$BASH_BIN" ] || fail "resolved bash is not executable"
[ -f "$CAPTURE_CHECKER" ] || fail "capture checker not found"
[ -f "$SAFE_TAIL" ] || fail "safe tail helper not found"
TIMEOUT_VERSION="$({ "$TIMEOUT_BIN" --version 2>/dev/null || true; })"
case "$TIMEOUT_VERSION" in 'timeout (GNU coreutils)'*) ;; *) fail "GNU coreutils timeout is required" ;; esac

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/exa-search-capped.XXXXXX")"
CAPTURE_STDOUT="$TMP_ROOT/stdout"
CAPTURE_STDERR="$TMP_ROOT/stderr"
TIMEOUT_STDERR="$TMP_ROOT/timeout-stderr"
ACTIVE_PID=""
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
printf -v DURATION '%d.%03ds' "$((TIMEOUT_MS / 1000))" "$((TIMEOUT_MS % 1000))"
(
  ulimit -f "$OUTPUT_LIMIT_BLOCKS"
  # shellcheck disable=SC2016 # The inner script expands only in the child Bash.
  LC_ALL=C exec "$TIMEOUT_BIN" --verbose --signal=TERM --kill-after=1s "$DURATION" \
    "$BASH_BIN" -c '
      child_stderr="$1"
      shift
      exec "$@" 2>"$child_stderr"
    ' exa-search-child "$CAPTURE_STDERR" "$@"
) >"$CAPTURE_STDOUT" 2>"$TIMEOUT_STDERR" &
ACTIVE_PID=$!
if wait "$ACTIVE_PID"; then STATUS=0; else STATUS=$?; fi
ACTIVE_PID=""

CHECKER_STATUS=0
if "$NODE_BIN" "$CAPTURE_CHECKER" "$MAX_OUTPUT_BYTES" "$CAPTURE_STDOUT" "$CAPTURE_STDERR"; then :
else CHECKER_STATUS=$?; fi
if [ "$CHECKER_STATUS" -ne 0 ] && [ "$CHECKER_STATUS" -ne 70 ]; then fail "capture validation failed"; fi
STDOUT_BYTES="$(wc -c <"$CAPTURE_STDOUT")"
STDERR_BYTES="$(wc -c <"$CAPTURE_STDERR")"
CAPPED=0
if [ "$CHECKER_STATUS" -eq 70 ] || [ "$STDOUT_BYTES" -ge "$OUTPUT_FILE_LIMIT_BYTES" ] || [ "$STDERR_BYTES" -ge "$OUTPUT_FILE_LIMIT_BYTES" ]; then
  CAPPED=1
fi
if [ "$STATUS" -eq 0 ] && [ "$CAPPED" -eq 0 ]; then
  "$NODE_BIN" - "$CAPTURE_STDOUT" <<'NODE'
const fs = require("fs");
process.stdout.write(fs.readFileSync(process.argv[2]));
NODE
  exit 0
fi

show_failure_detail
[ "$CAPPED" -eq 0 ] || fail "$LABEL exceeded MAX_OUTPUT_BYTES or was truncated"
case "$STATUS" in
  124)
    if [ -s "$TIMEOUT_STDERR" ]; then fail "$LABEL timed out after $TIMEOUT_MS ms"; fi
    fail "$LABEL failed with status 124"
    ;;
  137)
    if [ -s "$TIMEOUT_STDERR" ]; then fail "$LABEL was killed with SIGKILL (deadline escalation)"; fi
    fail "$LABEL was killed with SIGKILL (child termination)"
    ;;
  129|130|143) fail "$LABEL was interrupted" ;;
  *) fail "$LABEL failed with status $STATUS" ;;
esac
