#!/usr/bin/env bash
set -euo pipefail
umask 077

BASE_DIR="$(cd "$(dirname -- "$0")/.." && pwd -P)"
CONFIG_FILE="${CONFIG_FILE:-$BASE_DIR/config/mcporter.json}"
RUN_SMOKE="${RUN_SMOKE:-0}"
DISCOVERY_TIMEOUT_MS="${DISCOVERY_TIMEOUT_MS:-15000}"
CALL_TIMEOUT_MS="${CALL_TIMEOUT_MS:-30000}"
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
  if [ -n "$value" ]; then [ -x "$value" ] || fail "$variable is not executable: $value"; printf '%s\n' "$value"; return; fi
  command -v "$fallback" 2>/dev/null || fail "$fallback was not found"
}
verify_config() { "$NODE_BIN" "$CONFIG_HELPER" verify "$CONFIG_FILE" || fail "unsafe Exa config path"; }
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
run_capture() {
  local label="$1" timeout_ms="$2" duration status checker_status stdout_bytes stderr_bytes
  shift 2
  CAPTURE_INDEX=$((CAPTURE_INDEX + 1))
  CAPTURE_STDOUT="$TMP_ROOT/capture-$CAPTURE_INDEX.stdout"
  CAPTURE_STDERR="$TMP_ROOT/capture-$CAPTURE_INDEX.stderr"
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
  if [ "$stdout_bytes" -ge "$OUTPUT_FILE_LIMIT_BYTES" ] || [ "$stderr_bytes" -ge "$OUTPUT_FILE_LIMIT_BYTES" ]; then LAST_CAPPED=1; fi
  if [ "$status" -eq 0 ] && [ "$LAST_CAPPED" -eq 0 ]; then return 0; fi
  show_failure_detail
  [ "$LAST_CAPPED" -eq 0 ] || fail "$label exceeded MAX_OUTPUT_BYTES or was truncated"
  case "$status" in
    124) fail "$label timed out after $timeout_ms ms" ;;
    129|130|137|143) fail "$label was interrupted" ;;
    *) fail "$label failed with status $status" ;;
  esac
}
cleanup() {
  if [ -n "${ACTIVE_PID:-}" ]; then
    kill -KILL -- "-$ACTIVE_PID" 2>/dev/null || kill -KILL "$ACTIVE_PID" 2>/dev/null || true
    ACTIVE_PID=""
  fi
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
[ "$MAX_OUTPUT_BYTES" -ge 2048 ] || fail "MAX_OUTPUT_BYTES must be at least 2048"
OUTPUT_LIMIT_BLOCKS=$((MAX_OUTPUT_BYTES / 2048))
OUTPUT_FILE_LIMIT_BYTES=$((OUTPUT_LIMIT_BLOCKS * 1024))
NODE_BIN="$(resolve_binary NODE_BIN node)"
MCPORTER_BIN="$(resolve_binary MCPORTER_BIN mcporter)"
TIMEOUT_BIN="$(resolve_binary TIMEOUT_BIN timeout)"
[ -f "$CONFIG_HELPER" ] || fail "config helper not found: $CONFIG_HELPER"
[ -f "$CAPTURE_CHECKER" ] || fail "capture checker not found: $CAPTURE_CHECKER"
CONFIG_FILE="$("$NODE_BIN" "$CONFIG_HELPER" resolve "$CONFIG_FILE")" || fail "failed to resolve config path"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/exa-search-check.XXXXXX")"
ACTIVE_PID="" CAPTURE_INDEX=0 CAPTURE_STDOUT="" CAPTURE_STDERR="" LAST_CAPPED=0
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

log "base dir: $BASE_DIR"
log "mcporter: $MCPORTER_BIN"
log "config: $CONFIG_FILE"
verify_config
run_capture "configuration validation" "$DISCOVERY_TIMEOUT_MS" "$MCPORTER_BIN" --config "$CONFIG_FILE" config doctor
verify_config
run_capture "Exa configuration lookup" "$DISCOVERY_TIMEOUT_MS" "$MCPORTER_BIN" --config "$CONFIG_FILE" config get exa --json
verify_config
log "checking Exa schema"
run_capture "schema discovery" "$DISCOVERY_TIMEOUT_MS" "$MCPORTER_BIN" --config "$CONFIG_FILE" list exa --schema --json --timeout "$DISCOVERY_TIMEOUT_MS"
verify_config
"$NODE_BIN" - "$CAPTURE_STDOUT" <<'NODE' || fail "schema response validation failed"
const fs = require("fs");
let value;
try { value = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); }
catch { console.error("schema response is not valid JSON"); process.exit(1); }
if (!value || typeof value !== "object" || Array.isArray(value) || value.status !== "ok") process.exit(1);
const tools = new Map((Array.isArray(value.tools) ? value.tools : []).filter((tool) => tool && typeof tool.name === "string").map((tool) => [tool.name, tool]));
function schemaFor(name) {
  const schema = tools.get(name)?.inputSchema;
  if (!schema || schema.type !== "object" || !schema.properties || Array.isArray(schema.properties)) throw new Error(`${name} has no object inputSchema`);
  return schema;
}
function requires(schema, property) {
  if (!Array.isArray(schema.required) || !schema.required.includes(property)) throw new Error(`required property is missing: ${property}`);
}
try {
  const search = schemaFor("web_search_exa");
  requires(search, "query");
  if (search.properties.query?.type !== "string") throw new Error("query must be a string");
  if (search.properties.numResults?.type !== "number") throw new Error("numResults must be a number");
  const fetch = schemaFor("web_fetch_exa");
  requires(fetch, "urls");
  if (fetch.properties.urls?.type !== "array" || fetch.properties.urls?.items?.type !== "string") throw new Error("urls must be an array of strings");
  if (fetch.properties.maxCharacters?.type !== "number" || fetch.properties.maxCharacters?.minimum < 1) throw new Error("maxCharacters must be a positive number");
} catch (error) { console.error(error.message); process.exit(1); }
NODE
log "schema check: OK"
if [ "$RUN_SMOKE" = "1" ]; then
  log "running one live Exa search"
  run_capture "live search" "$CALL_TIMEOUT_MS" "$MCPORTER_BIN" --config "$CONFIG_FILE" call exa.web_search_exa \
    --args '{"query":"OpenClaw beginner guide","numResults":1}' --timeout "$CALL_TIMEOUT_MS" --output json
  verify_config
  "$NODE_BIN" - "$CAPTURE_STDOUT" <<'NODE' || fail "smoke response validation failed"
const fs = require("fs");
let value;
try { value = JSON.parse(fs.readFileSync(process.argv[2], "utf8")); }
catch { process.exit(1); }
if (!value || typeof value !== "object" || Array.isArray(value)) process.exit(1);
const envelopes = [value, value.raw, value.raw && value.raw.result].filter((item) => item && typeof item === "object" && !Array.isArray(item));
for (const envelope of envelopes) {
  if (envelope.isError === true || (Object.prototype.hasOwnProperty.call(envelope, "error") && envelope.error != null)) process.exit(1);
}
if (!Array.isArray(value.content) || !value.content.some((item) => item && item.type === "text" && typeof item.text === "string" && item.text.trim())) process.exit(1);
NODE
  log "live search: OK"
else
  log "live search skipped (RUN_SMOKE=0)"
fi
log "check complete"
