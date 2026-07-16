#!/usr/bin/env bash
set -euo pipefail
umask 077
BASE_DIR="$(cd "$(dirname -- "$0")/.." && pwd -P)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/exa-search-selftest.XXXXXX")"
trap 'rm -r -- "$TMP_ROOT"' EXIT
log() { printf '[exa-search:selftest] %s\n' "$*"; }
fail() { printf '[exa-search:selftest] ERROR: %s\n' "$*" >&2; exit 1; }
expect_failure() { local label="$1"; shift; if "$@" >"$TMP_ROOT/expected-failure.log" 2>&1; then fail "$label unexpectedly succeeded"; fi; }
digest() { node -e 'const fs=require("fs"),c=require("crypto").createHash("sha256"); for(const f of process.argv.slice(1)) c.update(fs.readFileSync(f)); process.stdout.write(c.digest("hex"));' "$@"; }
mode_of() { node -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"; }
assert_mode_600() { [ "$(mode_of "$1")" = "600" ] || fail "config mode is not 600: $1"; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }
REAL_MCPORTER="${MCPORTER_BIN:-$(command -v mcporter 2>/dev/null || true)}"
[ -n "$REAL_MCPORTER" ] && [ -x "$REAL_MCPORTER" ] || fail "mcporter not found"
mkdir -p "$TMP_ROOT/home" "$TMP_ROOT/config" "$TMP_ROOT/bin"
printf 'BASHRC_KEEP\n' >"$TMP_ROOT/home/.bashrc"
printf 'PROFILE_KEEP\n' >"$TMP_ROOT/home/.profile"
rc_before="$(digest "$TMP_ROOT/home/.bashrc" "$TMP_ROOT/home/.profile")"

cat >"$TMP_ROOT/bin/fake-mcporter" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
original=("$@")
config_path="" args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) [ "$#" -ge 2 ] || exit 2; config_path="$2"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
[ -n "$config_path" ] || exit 2
case "$config_path" in /*) ;; *) exit 2 ;; esac
[ -z "${CALL_LOG:-}" ] || { printf '%q ' "${original[@]}" >>"$CALL_LOG"; printf '\n' >>"$CALL_LOG"; }
[ "${WARN_STDERR:-0}" != 1 ] || printf 'mcporter test warning\n' >&2
[ "${WARN_TOOL_NAMES_STDERR:-0}" != 1 ] || printf 'web_search_exa web_fetch_exa\n' >&2
[ "${OVERSIZE_STDERR:-0}" != 1 ] || node -e 'process.stderr.write("e".repeat(65536))'
if [ -n "${EXPECTED_STAGE_PARENT:-}" ] && [ "${args[0]:-}" = config ]; then
  [ "$(dirname -- "$config_path")" = "$EXPECTED_STAGE_PARENT" ] || exit 2
  [ "$config_path" != "${LIVE_CONFIG_PATH:-}" ] || exit 2
fi
joined=" ${args[*]} "
case "${args[0]:-}:${args[1]:-}:${args[2]:-}" in
  config:doctor:)
    [ "${DOCTOR_FAIL:-0}" != 1 ] || exit 1
    if [ -n "${SWAP_CONFIG_PATH:-}" ] && [ ! -e "${SWAP_MARKER_PATH:-}" ]; then
      : >"$SWAP_MARKER_PATH"; rm -f -- "$SWAP_CONFIG_PATH"; ln -s -- "$SWAP_VICTIM_PATH" "$SWAP_CONFIG_PATH"
    fi ;;
  config:get:exa)
    [[ "$joined" == *" --json "* ]] || exit 2
    node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!v.mcpServers||!Object.prototype.hasOwnProperty.call(v.mcpServers,"exa")) process.exit(1)' "$config_path"
    printf '{"name":"exa"}\n' ;;
  config:add:exa)
    [ "${ADD_FAIL:-0}" != 1 ] || exit 1
    node -e 'const fs=require("fs"),v=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); v.mcpServers||={}; v.mcpServers.exa={baseUrl:process.argv[2]}; fs.writeFileSync(process.argv[1],JSON.stringify(v,null,2)+"\n")' "$config_path" "${args[3]:-}" ;;
  list:exa:--schema)
    [[ "$joined" == *" --json "* && "$joined" == *" --timeout "* ]] || exit 2
    case "${SCHEMA_MODE:-valid}" in
      valid) printf '%s\n' '{"status":"ok","tools":[{"name":"web_search_exa","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"numResults":{"type":"number"}},"required":["query"]}},{"name":"web_fetch_exa","inputSchema":{"type":"object","properties":{"urls":{"type":"array","items":{"type":"string"}},"maxCharacters":{"type":"number","minimum":1}},"required":["urls"]}}]}' ;;
      large) node -e 'const s={status:"ok",tools:[{name:"web_search_exa",inputSchema:{type:"object",properties:{query:{type:"string"},numResults:{type:"number"}},required:["query"]}},{name:"web_fetch_exa",inputSchema:{type:"object",properties:{urls:{type:"array",items:{type:"string"}},maxCharacters:{type:"number",minimum:1}},required:["urls"]}}],padding:"x".repeat(1048576)}; process.stdout.write(JSON.stringify(s))' ;;
      missing) printf '{"status":"ok","tools":[]}\n' ;;
      spoof) printf '{"status":"ok","tools":[{"name":"other","description":"web_search_exa web_fetch_exa"}]}\n' ;;
      bad-query) printf '%s\n' '{"status":"ok","tools":[{"name":"web_search_exa","inputSchema":{"type":"object","properties":{"query":{"type":"number"},"numResults":{"type":"number"}},"required":["query"]}},{"name":"web_fetch_exa","inputSchema":{"type":"object","properties":{"urls":{"type":"array","items":{"type":"string"}},"maxCharacters":{"type":"number","minimum":1}},"required":["urls"]}}]}' ;;
      bad-fetch) printf '%s\n' '{"status":"ok","tools":[{"name":"web_search_exa","inputSchema":{"type":"object","properties":{"query":{"type":"string"},"numResults":{"type":"number"}},"required":["query"]}},{"name":"web_fetch_exa","inputSchema":{"type":"object","properties":{"urls":{"type":"string"},"maxCharacters":{"type":"number","minimum":0}},"required":[]}}]}' ;;
      status-error) printf '{"status":"error","tools":[]}\n' ;;
      oversize) node -e 'process.stdout.write("x".repeat(65536))' ;;
      hang) [ -z "${HANG_PID_FILE:-}" ] || printf '%s\n' "$$" >"$HANG_PID_FILE"; sleep 10 ;;
      *) exit 2 ;;
    esac ;;
  call:exa.web_search_exa:--args)
    [[ "$joined" == *" --output json "* && "$joined" == *" --timeout "* ]] || exit 2
    case "${SMOKE_MODE:-valid}" in
      valid) printf '{"isError":false,"content":[{"type":"text","text":"ok"}]}\n' ;;
      is-error) printf '{"isError":true,"content":[{"type":"text","text":"rate limited"}]}\n' ;;
      nested-error) printf '{"raw":{"isError":true},"content":[{"type":"text","text":"failed"}]}\n' ;;
      error-field) printf '{"error":{"message":"failed"},"content":[{"type":"text","text":"failed"}]}\n' ;;
      empty) printf '{"content":[]}\n' ;;
      unwrapped) printf '{"results":[{"title":"not an envelope"}]}\n' ;;
      invalid) printf 'not-json\n' ;;
      oversize) node -e 'process.stdout.write(JSON.stringify({content:[{type:"text",text:"x".repeat(65536)}]}))' ;;
      *) exit 2 ;;
    esac ;;
  *) exit 2 ;;
esac
SH
chmod 700 "$TMP_ROOT/bin/fake-mcporter"
FAKE_MCPORTER="$TMP_ROOT/bin/fake-mcporter"

cat >"$TMP_ROOT/config/preserve.json" <<'JSON'
{"mcpServers":{"keep":{"baseUrl":"https://example.invalid/mcp"},"exa":{"baseUrl":"https://custom.invalid/mcp","headers":{"x-api-key":"***"}}}}
JSON
preserve_before="$(digest "$TMP_ROOT/config/preserve.json")"
HOME="$TMP_ROOT/home" MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/preserve.json" EXPECTED_STAGE_PARENT="$TMP_ROOT/config" LIVE_CONFIG_PATH="$TMP_ROOT/config/preserve.json" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh" >/dev/null
[ "$preserve_before" = "$(digest "$TMP_ROOT/config/preserve.json")" ] || fail "existing Exa config changed"
[ "$rc_before" = "$(digest "$TMP_ROOT/home/.bashrc" "$TMP_ROOT/home/.profile")" ] || fail "setup modified shell files"
assert_mode_600 "$TMP_ROOT/config/preserve.json"
log "existing config, credentials, and shell files preserved"

cat >"$TMP_ROOT/config/comments.jsonc" <<'JSONC'
{// keep comment
"mcpServers":{"exa":{"baseUrl":"https://custom.invalid/mcp"},},}
JSONC
comments_before="$(digest "$TMP_ROOT/config/comments.jsonc")"
MCPORTER_BIN="$REAL_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/comments.jsonc" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh" >/dev/null
[ "$comments_before" = "$(digest "$TMP_ROOT/config/comments.jsonc")" ] || fail "existing JSONC was rewritten"
log "existing JSONC preserved"

ln -s "$TMP_ROOT/config/preserve.json" "$TMP_ROOT/config/symlink.json"
expect_failure "symlink config" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/symlink.json" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
ln -s "$TMP_ROOT/config/missing.json" "$TMP_ROOT/config/dangling.json"
expect_failure "dangling symlink" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/dangling.json" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
mkfifo "$TMP_ROOT/config/fifo.json"
expect_failure "FIFO config" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/fifo.json" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
mkdir "$TMP_ROOT/config/directory.json"
expect_failure "directory config" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/directory.json" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
cp "$TMP_ROOT/config/preserve.json" "$TMP_ROOT/config/hard-source.json"; ln "$TMP_ROOT/config/hard-source.json" "$TMP_ROOT/config/hard-link.json"
expect_failure "hard-linked config" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/hard-link.json" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
mkdir "$TMP_ROOT/real-parent"; ln -s "$TMP_ROOT/real-parent" "$TMP_ROOT/linked-parent"
expect_failure "symlink parent" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/linked-parent/config.json" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
if [ "$(id -u)" -eq 0 ]; then
  mkdir -p "$TMP_ROOT/foreign/owned"; chown 65534 "$TMP_ROOT/foreign"; chmod 700 "$TMP_ROOT/foreign"
  expect_failure "foreign-owned ancestor" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/foreign/owned/config.json" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
fi
log "unsafe files and untrusted directory chains rejected"

printf '%s\n' '{"mcpServers":{"keep":{"baseUrl":"https://example.invalid/mcp"}}}' >"$TMP_ROOT/config/add.json"
(umask 000; MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/add.json" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh" >/dev/null)
node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!v.mcpServers.keep||v.mcpServers.exa.baseUrl!=="https://mcp.exa.ai/mcp") process.exit(1)' "$TMP_ROOT/config/add.json"
assert_mode_600 "$TMP_ROOT/config/add.json"
log "missing Exa config merged privately"

(cd "$TMP_ROOT"; MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE='-dash/config.json' RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh" >/dev/null)
unicode_config="$TMP_ROOT/config 空间/配置.json"
MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$unicode_config" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh" >/dev/null
assert_mode_600 "$unicode_config"
log "leading-dash, spaced, and Unicode paths supported"

concurrent_config="$TMP_ROOT/config/concurrent.json"; pids=()
for index in 1 2; do MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$concurrent_config" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh" >"$TMP_ROOT/concurrent-$index.log" 2>&1 & pids+=("$!"); done
for pid in "${pids[@]}"; do wait "$pid" || fail "concurrent setup failed"; done
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$concurrent_config"
assert_mode_600 "$concurrent_config"
log "concurrent setup serialized safely"

call_log="$TMP_ROOT/calls.log"; : >"$call_log"
MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/add.json" CALL_LOG="$call_log" bash "$BASE_DIR/scripts/install.sh" >/dev/null
! grep -Fq 'call exa.web_search_exa' "$call_log" || fail "setup consumed live search quota"
MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/add.json" WARN_STDERR=1 SCHEMA_MODE=large SMOKE_MODE=valid RUN_SMOKE=1 MAX_OUTPUT_BYTES=4194304 bash "$BASE_DIR/scripts/check.sh" >/dev/null
log "structured large schema and separate stderr accepted"

for mode in missing spoof bad-query bad-fetch status-error; do
  expect_failure "schema mode $mode" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/add.json" SCHEMA_MODE="$mode" RUN_SMOKE=0 bash "$BASE_DIR/scripts/check.sh"
done
for mode in is-error nested-error error-field empty unwrapped invalid; do
  expect_failure "smoke mode $mode" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/add.json" SMOKE_MODE="$mode" RUN_SMOKE=1 bash "$BASE_DIR/scripts/check.sh"
done
expect_failure "oversize stdout" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/add.json" SCHEMA_MODE=oversize MAX_OUTPUT_BYTES=4096 bash "$BASE_DIR/scripts/check.sh"
expect_failure "oversize stderr" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/add.json" OVERSIZE_STDERR=1 MAX_OUTPUT_BYTES=4096 bash "$BASE_DIR/scripts/check.sh"
start="$(now_ms)"
expect_failure "schema hard timeout" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/add.json" SCHEMA_MODE=hang DISCOVERY_TIMEOUT_MS=100 bash "$BASE_DIR/scripts/check.sh"
[ $(( $(now_ms) - start )) -lt 3000 ] || fail "hard timeout was not enforced"
log "schema contracts, MCP errors, output caps, and hard timeout enforced"

hang_pid_file="$TMP_ROOT/hang.pid"
MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/add.json" SCHEMA_MODE=hang HANG_PID_FILE="$hang_pid_file" DISCOVERY_TIMEOUT_MS=30000 bash "$BASE_DIR/scripts/check.sh" >/dev/null 2>&1 & wrapper_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s "$hang_pid_file" ] && break; sleep 0.05; done
[ -s "$hang_pid_file" ] || fail "hang child did not start"
child_pid="$(cat "$hang_pid_file")"; kill -TERM "$wrapper_pid"
set +e; wait "$wrapper_pid"; wrapper_status=$?; set -e
[ "$wrapper_status" -eq 143 ] || fail "interrupted check returned $wrapper_status"
sleep 0.1
if kill -0 "$child_pid" 2>/dev/null; then kill -KILL "$child_pid" 2>/dev/null || true; fail "interrupted check left child alive"; fi
log "interrupt cleanup terminates the command process group"

: >"$call_log"
MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/add.json" CALL_LOG="$call_log" RUN_SMOKE=1 bash "$BASE_DIR/scripts/check.sh" >/dev/null
[ "$(grep -Fc 'call exa.web_search_exa' "$call_log")" = 1 ] || fail "smoke did not run exactly once"
: >"$call_log"
expect_failure "invalid smoke toggle" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/add.json" CALL_LOG="$call_log" RUN_SMOKE=invalid bash "$BASE_DIR/scripts/check.sh"
[ ! -s "$call_log" ] || fail "invalid toggle invoked mcporter"
log "explicit smoke and toggle validation correct"

cp "$TMP_ROOT/config/preserve.json" "$TMP_ROOT/config/race.json"; printf 'victim\n' >"$TMP_ROOT/config/victim.txt"; chmod 644 "$TMP_ROOT/config/victim.txt"
expect_failure "destination swap" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/race.json" SWAP_CONFIG_PATH="$TMP_ROOT/config/race.json" SWAP_VICTIM_PATH="$TMP_ROOT/config/victim.txt" SWAP_MARKER_PATH="$TMP_ROOT/swap.marker" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
[ -L "$TMP_ROOT/config/race.json" ] || fail "race did not replace live path"
[ "$(mode_of "$TMP_ROOT/config/victim.txt")" = 644 ] || fail "race changed victim mode"
[ "$(cat "$TMP_ROOT/config/victim.txt")" = victim ] || fail "race changed victim content"

cp "$TMP_ROOT/config/add.json" "$TMP_ROOT/config/failure.json"; failure_before="$(digest "$TMP_ROOT/config/failure.json")"
expect_failure "staged doctor failure" env MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$TMP_ROOT/config/failure.json" DOCTOR_FAIL=1 RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
[ "$failure_before" = "$(digest "$TMP_ROOT/config/failure.json")" ] || fail "failed transaction changed config"
leftover="$(find "$TMP_ROOT/config" -maxdepth 1 -name '.failure.json.*' -print -quit)"
[ -z "$leftover" ] || fail "failed transaction left staged data"
log "races and failed transactions preserve protected data"
log "selftest complete"
