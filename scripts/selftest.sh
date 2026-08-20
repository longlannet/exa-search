#!/usr/bin/env bash
set -euo pipefail
umask 077

SCRIPT_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
BASE_DIR="$(cd "$(dirname -- "$SCRIPT_PATH")/.." && pwd -P)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/exa-search-selftest.XXXXXX")"
cleanup() {
  rm -r -- "$TMP_ROOT"
}
trap cleanup EXIT

log() { printf '[exa-search:selftest] %s\n' "$*"; }
fail() { printf '[exa-search:selftest] ERROR: %s\n' "$*" >&2; exit 1; }
expect_failure() {
  local label="$1" expected_status="$2" expected_pattern="$3" status failure_output
  shift 3
  set +e
  "$@" >"$TMP_ROOT/expected-failure.log" 2>&1
  status=$?
  set -e
  [ "$status" -eq "$expected_status" ] || {
    sed -n '1,80p' "$TMP_ROOT/expected-failure.log" >&2
    fail "$label returned $status, expected $expected_status"
  }
  failure_output="$(<"$TMP_ROOT/expected-failure.log")"
  [[ "$failure_output" =~ $expected_pattern ]] || {
    sed -n '1,80p' "$TMP_ROOT/expected-failure.log" >&2
    fail "$label did not report the expected failure"
  }
}
digest() { sha256sum -- "$1" | cut -d' ' -f1; }
mode_of() { stat -c '%a' -- "$1"; }
assert_mode_600() { [ "$(mode_of "$1")" = 600 ] || fail "config mode is not 600: $1"; }
assert_no_transaction_files() {
  local directory base leftover
  directory="$(dirname -- "$1")"
  base="$(basename -- "$1")"
  leftover="$(find "$directory" -maxdepth 1 -name ".$base.exa-search.*" -print -quit)"
  [ -z "$leftover" ] || fail "transaction artifact remains: $leftover"
}

DEFAULT_MCPORTER="$BASE_DIR/node_modules/.bin/mcporter"
if [ ! -x "$DEFAULT_MCPORTER" ]; then DEFAULT_MCPORTER="$(command -v mcporter 2>/dev/null || true)"; fi
REAL_MCPORTER="${MCPORTER_BIN:-$DEFAULT_MCPORTER}"
if [ -z "$REAL_MCPORTER" ] || [ ! -x "$REAL_MCPORTER" ]; then fail "mcporter not found"; fi
REAL_MCPORTER="$(readlink -f -- "$REAL_MCPORTER")"
REAL_PACKAGE_ROOT="$(node --input-type=module - "$REAL_MCPORTER" "$BASE_DIR/scripts/mcporter-support.mjs" <<'NODE'
import { pathToFileURL } from "node:url";
const { findMcporterPackage } = await import(pathToFileURL(process.argv[3]).href);
process.stdout.write(findMcporterPackage(process.argv[2]).root);
NODE
)"
REAL_JSONC_ROOT="$(node --input-type=module - "$REAL_PACKAGE_ROOT/package.json" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
let current = path.dirname(createRequire(process.argv[2]).resolve("jsonc-parser"));
while (true) {
  const manifestPath = path.join(current, "package.json");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.name === "jsonc-parser") {
      process.stdout.write(current);
      break;
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  const parent = path.dirname(current);
  if (parent === current) throw new Error("jsonc-parser package root was not found");
  current = parent;
}
NODE
)"

mkdir -p "$TMP_ROOT/home" "$TMP_ROOT/config" \
  "$TMP_ROOT/fake-mcporter/dist" "$TMP_ROOT/fake-mcporter/node_modules" \
  "$TMP_ROOT/drifted-mcporter/dist" "$TMP_ROOT/drifted-mcporter/node_modules"
printf 'BASHRC_KEEP\n' >"$TMP_ROOT/home/.bashrc"
printf 'PROFILE_KEEP\n' >"$TMP_ROOT/home/.profile"
shell_digest="$(digest "$TMP_ROOT/home/.bashrc")$(digest "$TMP_ROOT/home/.profile")"
node --input-type=module - "$REAL_PACKAGE_ROOT/package.json" \
  "$TMP_ROOT/fake-mcporter/package.json" "$TMP_ROOT/fake-mcporter/node_modules" \
  "$TMP_ROOT/drifted-mcporter/package.json" "$TMP_ROOT/drifted-mcporter/node_modules" <<'NODE'
import fs from "node:fs";
import path from "node:path";
const [realManifestPath, fakeManifestPath, fakeNodeModules, driftedManifestPath, driftedNodeModules] = process.argv.slice(2);
const realManifest = JSON.parse(fs.readFileSync(realManifestPath, "utf8"));
const fakeManifest = `${JSON.stringify({
  name: realManifest.name,
  version: realManifest.version,
  type: "module",
  bin: { mcporter: "dist/cli.js" },
  dependencies: realManifest.dependencies,
}, null, 2)}\n`;
fs.writeFileSync(fakeManifestPath, fakeManifest);
fs.writeFileSync(driftedManifestPath, fakeManifest);
for (const name of Object.keys(realManifest.dependencies ?? {})) {
  let current = path.dirname(realManifestPath);
  let packageRoot;
  while (true) {
    const candidate = path.join(current, "node_modules", name, "package.json");
    try {
      const manifestPath = fs.realpathSync(candidate);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name === name) {
        packageRoot = path.dirname(manifestPath);
        break;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`dependency package root was not found: ${name}`);
    current = parent;
  }
  const target = path.join(fakeNodeModules, ...name.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(packageRoot, target, "dir");
  const driftedTarget = path.join(driftedNodeModules, ...name.split("/"));
  fs.mkdirSync(path.dirname(driftedTarget), { recursive: true });
  if (name === "jsonc-parser") {
    fs.mkdirSync(driftedTarget);
    fs.writeFileSync(path.join(driftedTarget, "package.json"), '{"name":"jsonc-parser","version":"0.0.0"}\n');
  } else {
    fs.symlinkSync(packageRoot, driftedTarget, "dir");
  }
}
NODE
cat >"$TMP_ROOT/fake-mcporter/dist/cli.js" <<'NODE'
#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
const jsonc = createRequire(import.meta.url)("jsonc-parser");
const argv = process.argv.slice(2);
const configIndex = argv.indexOf("--config");
if (configIndex < 0 || !argv[configIndex + 1]) process.exit(2);
const configPath = argv[configIndex + 1];
const args = argv.filter((_, index) => index !== configIndex && index !== configIndex + 1);
if (process.env.CLI_LOG) {
  fs.appendFileSync(process.env.CLI_LOG, `${JSON.stringify({ configPath, args, execArgv: process.execArgv })}\n`);
}
function config() {
  const errors = [];
  const value = jsonc.parse(fs.readFileSync(configPath, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length || !value || !Array.isArray(value.imports) || value.imports.length !== 0) process.exit(20);
  const exa = value.mcpServers?.exa;
  if (!exa || exa.baseUrl !== "https://mcp.exa.ai/mcp" ||
      JSON.stringify(exa.allowedTools) !== JSON.stringify(["web_search_exa", "web_fetch_exa"])) process.exit(21);
  return value;
}
if (args[0] === "config" && args[1] === "doctor") {
  config();
  if (process.env.DOCTOR_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, Number(process.env.DOCTOR_DELAY_MS)));
  if (process.env.SWAP_CONFIG_PATH && !fs.existsSync(process.env.SWAP_MARKER_PATH)) {
    fs.writeFileSync(process.env.SWAP_MARKER_PATH, "swapped\n");
    fs.unlinkSync(process.env.SWAP_CONFIG_PATH);
    fs.symlinkSync(process.env.SWAP_VICTIM_PATH, process.env.SWAP_CONFIG_PATH);
  }
  if (process.env.DOCTOR_FAIL === "1") process.exit(31);
  process.stdout.write("Config looks good.\n");
} else {
  process.exit(2);
}
NODE
cat >"$TMP_ROOT/fake-mcporter/dist/index.js" <<'NODE'
import fs from "node:fs";
import { createRequire } from "node:module";
const jsonc = createRequire(import.meta.url)("jsonc-parser");
function readConfig(configPath) {
  const errors = [];
  const value = jsonc.parse(fs.readFileSync(configPath, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length || !value?.mcpServers?.exa || value.imports?.length !== 0) throw new Error("invalid test config");
}
function schema(mode) {
  const tools = [
    { name: "web_search_exa", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#",
      type: "object", additionalProperties: false, properties: {
      query: { type: "string", minLength: 1 }, numResults: { type: "number", minimum: 1, maximum: 10 },
    }, required: ["query"] } },
    { name: "web_fetch_exa", inputSchema: { type: "object", additionalProperties: false, properties: {
      urls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
      maxCharacters: { type: "number", minimum: 1, maximum: 100000 },
    }, required: ["urls"] } },
  ];
  if (mode === "missing") return [];
  if (mode === "extra") tools.push({ name: "unexpected_tool", inputSchema: { type: "object", properties: {} } });
  if (mode === "bad-query") tools[0].inputSchema.properties.query.type = "number";
  if (mode === "extra-required") tools[0].inputSchema.required.push("extra");
  if (mode === "narrow-results") tools[0].inputSchema.properties.numResults.maximum = 1;
  if (mode === "fixed-enum") tools[0].inputSchema.properties.numResults.enum = [1];
  if (mode === "query-pattern") tools[0].inputSchema.properties.query.pattern = "^fixed$";
  if (mode === "query-min-length") tools[0].inputSchema.properties.query.minLength = 2;
  if (mode === "query-max-length") tools[0].inputSchema.properties.query.maxLength = 8191;
  if (mode === "root-all-of") tools[0].inputSchema.allOf = [false];
  if (mode === "root-dialect") tools[0].inputSchema.$schema = "https://json-schema.org/draft/2020-12/schema";
  if (mode === "root-recursive-ref") tools[0].inputSchema.$recursiveRef = "https://example.invalid/false-schema";
  if (mode === "root-const") tools[0].inputSchema.const = {};
  if (mode === "dependent-required") tools[0].inputSchema.dependentRequired = { query: ["extra"] };
  if (mode === "pattern-properties") tools[0].inputSchema.patternProperties = { ".*": false };
  if (mode === "invalid-additional-null") tools[0].inputSchema.additionalProperties = null;
  if (mode === "invalid-additional-array") tools[0].inputSchema.additionalProperties = [];
  if (mode === "invalid-additional-number") tools[0].inputSchema.additionalProperties = 0;
  if (mode === "invalid-additional-string") tools[0].inputSchema.additionalProperties = "false";
  if (mode === "negative-min-properties") tools[0].inputSchema.minProperties = -1;
  if (mode === "min-properties") tools[0].inputSchema.minProperties = 3;
  if (mode === "max-properties") tools[0].inputSchema.maxProperties = 1;
  if (mode === "query-ref") tools[0].inputSchema.properties.query.$ref = "https://example.invalid/false-schema";
  if (mode === "results-conditional") {
    tools[0].inputSchema.properties.numResults.if = true;
    tools[0].inputSchema.properties.numResults.then = false;
  }
  if (mode === "narrow-urls") tools[1].inputSchema.properties.urls.maxItems = 2;
  if (mode === "negative-min-items") tools[1].inputSchema.properties.urls.minItems = -1;
  if (mode === "fractional-min-items") tools[1].inputSchema.properties.urls.minItems = 0.5;
  if (mode === "fractional-max-items") tools[1].inputSchema.properties.urls.maxItems = 3.5;
  if (mode === "unique-urls") tools[1].inputSchema.properties.urls.uniqueItems = true;
  if (mode === "urls-ref") tools[1].inputSchema.properties.urls.$ref = "https://example.invalid/false-schema";
  if (mode === "url-items-conditional") {
    tools[1].inputSchema.properties.urls.items.if = true;
    tools[1].inputSchema.properties.urls.items.then = false;
  }
  if (mode === "exclusive-characters") tools[1].inputSchema.properties.maxCharacters.exclusiveMinimum = 1;
  if (mode === "characters-ref") {
    tools[1].inputSchema.properties.maxCharacters.$dynamicRef = "https://example.invalid/false-schema";
  }
  if (mode === "oversize") tools[0].inputSchema.title = "x".repeat(65536);
  return tools;
}
async function hang(mode) {
  if (process.env.HANG_PID_FILE) fs.writeFileSync(process.env.HANG_PID_FILE, `${process.pid}\n`);
  if (mode === "stubborn") {
    process.on("SIGTERM", () => {});
    if (process.env.STUBBORN_READY_FILE) fs.writeFileSync(process.env.STUBBORN_READY_FILE, "ready\n");
  }
  await new Promise(() => setInterval(() => {}, 1000));
}
export async function createRuntime(options) {
  readConfig(options.configPath);
  return {
    async connect(server, connectOptions) {
      if (connectOptions?.maxOAuthAttempts !== 0 || connectOptions?.skipCache !== true ||
          connectOptions?.allowCachedAuth !== false) {
        throw new Error("anonymous connection options are required");
      }
      if (process.env.MCP_HTTP_LOG) fs.appendFileSync(process.env.MCP_HTTP_LOG, "connect\n");
      return {
        definition: { command: { headers: { accept: "application/json, text/event-stream" } } },
        client: {
          async listTools(params) {
            const mode = process.env.SCHEMA_MODE ?? "valid";
            if (process.env.OVERSIZE_STDERR === "1") process.stderr.write("e".repeat(65536));
            if (mode === "hang" || mode === "stubborn") await hang(mode);
            if (mode === "paged") {
              if (params && Object.prototype.hasOwnProperty.call(params, "cursor")) {
                if (params.cursor !== "") throw new Error("unexpected pagination cursor");
                return { tools: [schema(mode)[1]] };
              }
              return { tools: [schema(mode)[0]], nextCursor: "" };
            }
            if (mode === "paged-extra") {
              if (params?.cursor === "extra") {
                return { tools: [{ name: "unexpected_tool", inputSchema: { type: "object", properties: {} } }] };
              }
              return { tools: schema(mode), nextCursor: "extra" };
            }
            if (mode === "repeated-cursor") return { tools: [], nextCursor: "repeat" };
            if (mode === "cursor-cycle") {
              if (params?.cursor === "A") return { tools: [], nextCursor: "B" };
              if (params?.cursor === "B") return { tools: [], nextCursor: "A" };
              return { tools: [], nextCursor: "A" };
            }
            if (mode === "invalid-cursor") return { tools: [], nextCursor: 1 };
            if (mode === "oversized-cursor") return { tools: [], nextCursor: "x".repeat(4097) };
            if (mode === "tool-limit") {
              return { tools: Array.from({ length: 65 }, (_, index) => ({
                name: `tool_${index}`,
                inputSchema: { type: "object", properties: {} },
              })) };
            }
            if (mode === "page-limit") {
              const page = params === undefined ? 0 : Number(params.cursor);
              return { tools: [], nextCursor: String(page + 1) };
            }
            if (mode === "exact-page-limit") {
              const page = params === undefined ? 0 : Number(params.cursor);
              return page === 31 ? { tools: schema(mode) } :
                { tools: [], nextCursor: String(page + 1) };
            }
            if (mode === "exact-tool-limit") {
              return { tools: Array.from({ length: 64 }, (_, index) => ({
                name: `tool_${index}`,
                inputSchema: { type: "object", properties: {} },
              })) };
            }
            if (mode === "cross-page-tool-limit") {
              if (params?.cursor === "overflow") {
                return { tools: [{ name: "tool_64", inputSchema: { type: "object", properties: {} } }] };
              }
              return {
                tools: Array.from({ length: 64 }, (_, index) => ({
                  name: `tool_${index}`,
                  inputSchema: { type: "object", properties: {} },
                })),
                nextCursor: "overflow",
              };
            }
            if (mode === "schema-byte-limit") {
              const value = schema(mode);
              value[0].inputSchema.title = "x".repeat(2 * 1024 * 1024);
              return { tools: value };
            }
            return { tools: schema(mode) };
          },
          async callTool(request) {
            if (process.env.MCP_CALL_LOG) {
              fs.appendFileSync(process.env.MCP_CALL_LOG, `${JSON.stringify({
                server, tool: request.name, args: request.arguments,
              })}\n`);
            }
            const mode = process.env.MCP_MODE ?? "valid";
            if (mode === "stderr") {
              process.stderr.write("unsafe:\u001b]0;owned\u0007end\n");
              throw new Error("runtime \u202efailed\ninjected");
            }
            if (mode === "hang" || mode === "stubborn") await hang(mode);
            if (mode === "is-error") return { isError: true, content: [{ type: "text", text: "rate limited" }] };
            if (mode === "nested-error") return { raw: { result: { isError: true } }, content: [{ type: "text", text: "failed" }] };
            if (mode === "error-field") return { error: { message: "failed" }, content: [{ type: "text", text: "failed" }] };
            if (mode === "empty") return { isError: false, content: [{ type: "text", text: "   " }] };
            if (mode === "invalid") return { results: [{ title: "not an MCP envelope" }] };
            const text = mode === "oversize" ? "x".repeat(65536) :
              mode === "success-control" ? "left\u009bright\u202eend" : "ok";
            return { isError: false, content: [{ type: "text", text }] };
          },
          async close() {},
        },
        transport: { async close() {} },
      };
    },
    async close() {},
  };
}
export function createCallResult(raw) {
  return { json() { return { content: raw.content }; } };
}
NODE
chmod 700 "$TMP_ROOT/fake-mcporter/dist/cli.js"
cp -- "$TMP_ROOT/fake-mcporter/dist/cli.js" "$TMP_ROOT/fake-mcporter/dist/not-cli.js"
chmod 700 "$TMP_ROOT/fake-mcporter/dist/not-cli.js"
cp -- "$TMP_ROOT/fake-mcporter/dist/cli.js" "$TMP_ROOT/drifted-mcporter/dist/cli.js"
chmod 700 "$TMP_ROOT/drifted-mcporter/dist/cli.js"
FAKE_MCPORTER="$TMP_ROOT/fake-mcporter/dist/cli.js"
FAKE_OTHER_BIN="$TMP_ROOT/fake-mcporter/dist/not-cli.js"
DRIFTED_MCPORTER="$TMP_ROOT/drifted-mcporter/dist/cli.js"

expect_failure "drifted dependency closure" 1 'unsupported mcporter dependency version: jsonc-parser@0\.0\.0' \
  node --input-type=module - "$DRIFTED_MCPORTER" "$BASE_DIR/scripts/mcporter-support.mjs" <<'NODE'
import { pathToFileURL } from "node:url";
const { findMcporterPackage } = await import(pathToFileURL(process.argv[3]).href);
findMcporterPackage(process.argv[2]);
NODE
log "locked dependency graph accepted and deliberately drifted closure rejected"

cat >"$TMP_ROOT/config/preserve.jsonc" <<'JSONC'
{
  // keep this comment
  "imports": ["cursor"],
  "customTop": { "preserve": true },
  "mcpServers": {
    "keep": { "baseUrl": "https://example.invalid/mcp" },
    "exaa": { "command": "/bin/false" },
  },
}
JSONC
CLI_LOG="$TMP_ROOT/cli.log" HOME="$TMP_ROOT/home" MCPORTER_BIN="$FAKE_MCPORTER" \
  CONFIG_FILE="$TMP_ROOT/config/preserve.jsonc" RUN_CHECK=1 bash "$BASE_DIR/scripts/install.sh" >/dev/null
[[ "$(<"$TMP_ROOT/config/preserve.jsonc")" == *"keep this comment"* ]] || fail "JSONC comment was lost"
node - "$TMP_ROOT/config/preserve.jsonc" "$REAL_JSONC_ROOT" <<'NODE'
const fs = require("fs");
const parser = require(process.argv[3]);
const errors = [];
const value = parser.parse(fs.readFileSync(process.argv[2], "utf8"), errors, { allowTrailingComma: true });
if (errors.length || value.imports.length !== 0 || !value.customTop.preserve || !value.mcpServers.keep || !value.mcpServers.exaa) process.exit(1);
const exa = value.mcpServers.exa;
if (exa.baseUrl !== "https://mcp.exa.ai/mcp" || exa.allowedTools.join(",") !== "web_search_exa,web_fetch_exa") process.exit(1);
NODE
assert_mode_600 "$TMP_ROOT/config/preserve.jsonc"
[ "$shell_digest" = "$(digest "$TMP_ROOT/home/.bashrc")$(digest "$TMP_ROOT/home/.profile")" ] || fail "shell startup files changed"
node - "$TMP_ROOT/cli.log" "$TMP_ROOT/config/preserve.jsonc" <<'NODE'
const fs = require("fs");
const [logPath, livePath] = process.argv.slice(2);
for (const line of fs.readFileSync(logPath, "utf8").trim().split("\n")) {
  const entry = JSON.parse(line);
  if (entry.configPath === livePath ||
      JSON.stringify(entry.execArgv) !== JSON.stringify(["--max-old-space-size=128"])) process.exit(1);
}
NODE
log "JSONC, unknown fields, other servers, exact naming, and staged-only validation passed"

for fixture in authenticated custom duplicate; do
  path="$TMP_ROOT/config/$fixture.jsonc"
  case "$fixture" in
    authenticated) printf '%s\n' '{"mcpServers":{"exa":{"baseUrl":"https://mcp.exa.ai/mcp","headers":{"x-api-key":"secret"}}}}' >"$path" ;;
    custom) printf '%s\n' '{"mcpServers":{"exa":{"baseUrl":"https://custom.invalid/mcp"}}}' >"$path" ;;
    duplicate) printf '%s\n' '{"mcpServers":{"exa":{"baseUrl":"https://mcp.exa.ai/mcp"}},"mcpServers":{}}' >"$path" ;;
  esac
  chmod 600 "$path"
  before="$(digest "$path")"
  expect_failure "$fixture config" 1 'refusing|duplicate JSONC property' env MCPORTER_BIN="$FAKE_MCPORTER" \
    CONFIG_FILE="$path" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
  [ "$before" = "$(digest "$path")" ] || fail "$fixture config changed on rejection"
  assert_no_transaction_files "$path"
done
expect_failure "EXA_URL override" 1 'EXA_URL is unsupported' env EXA_URL=/bin/true MCPORTER_BIN="$FAKE_MCPORTER" \
  CONFIG_FILE="$TMP_ROOT/config/preserve.jsonc" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
expect_failure "smoke without check" 1 'RUN_SMOKE=1 requires RUN_CHECK=1' env MCPORTER_BIN="$FAKE_MCPORTER" \
  CONFIG_FILE="$TMP_ROOT/config/preserve.jsonc" RUN_CHECK=0 RUN_SMOKE=1 bash "$BASE_DIR/scripts/install.sh"
expect_failure "undeclared package binary" 1 'not the CLI declared' env MCPORTER_BIN="$FAKE_OTHER_BIN" \
  CONFIG_FILE="$TMP_ROOT/config/preserve.jsonc" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
log "API-key, custom endpoint, duplicate-key, executable override, and fake binary paths rejected unchanged"

control_path="$TMP_ROOT/config/"$'control\nname.json'
expect_failure "control character config path" 1 'control or bidirectional formatting characters' env \
  MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$control_path" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
[ ! -e "$control_path" ] || fail "control-character config path was created"
log "ambiguous control-character config paths rejected"

permissions_config="$TMP_ROOT/config/permissions.json"
printf '%s\n' '{"imports":[],"mcpServers":{"exa":{"baseUrl":"https://mcp.exa.ai/mcp","allowedTools":["web_search_exa","web_fetch_exa"]}}}' >"$permissions_config"
chmod 644 "$permissions_config"
expect_failure "standalone exposed permissions" 1 'permissions expose group/other' env MCPORTER_BIN="$FAKE_MCPORTER" \
  CONFIG_FILE="$permissions_config" bash "$BASE_DIR/scripts/check.sh"
MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$permissions_config" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh" >/dev/null
assert_mode_600 "$permissions_config"
log "standalone checks reject exposed permissions and setup normalizes them to 0600"

failure_config="$TMP_ROOT/config/validation-failure.json"
printf '%s\n' '{"imports":[],"mcpServers":{"exa":{"baseUrl":"https://mcp.exa.ai/mcp","allowedTools":["web_search_exa","web_fetch_exa"]}}}' >"$failure_config"
chmod 600 "$failure_config"
before="$(digest "$failure_config")"
expect_failure "doctor before commit" 1 'staged configuration validation failed' env DOCTOR_FAIL=1 MCPORTER_BIN="$FAKE_MCPORTER" \
  CONFIG_FILE="$failure_config" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
[ "$before" = "$(digest "$failure_config")" ] || fail "doctor failure changed live config"
assert_no_transaction_files "$failure_config"
expect_failure "schema before commit" 1 'schema response validation failed' env SCHEMA_MODE=bad-query MCPORTER_BIN="$FAKE_MCPORTER" \
  CONFIG_FILE="$failure_config" RUN_CHECK=1 bash "$BASE_DIR/scripts/install.sh"
[ "$before" = "$(digest "$failure_config")" ] || fail "schema failure changed live config"
assert_no_transaction_files "$failure_config"
log "doctor and schema failures occur before commit and clean their stages"

stale_config="$TMP_ROOT/config/stale.json"
lock_path="$TMP_ROOT/config/.stale.json.exa-search.lock"
printf '999999999\n' >"$lock_path"
chmod 600 "$lock_path"
MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$stale_config" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh" >/dev/null
[ ! -e "$lock_path" ] || fail "legacy stale lock was not recovered"
crash_stage="$TMP_ROOT/config/.stale.json.exa-search.999999999.crash.json"
printf 'stale\n' >"$crash_stage"
printf '{"configPath":"%s","original":null,"pid":999999999,"startToken":null}\n' "$stale_config" >"$crash_stage.meta"
chmod 600 "$crash_stage" "$crash_stage.meta"
MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$stale_config" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh" >/dev/null
if [ -e "$crash_stage" ] || [ -e "$crash_stage.meta" ]; then fail "crashed stage was not recovered"; fi
log "legacy stale locks and crashed stages recovered"

replacement_config="$TMP_ROOT/config/staged-replacement.json"
cp -- "$failure_config" "$replacement_config"
replacement_stage="$(node "$BASE_DIR/scripts/configure.mjs" prepare "$replacement_config" "$$")"
node "$BASE_DIR/scripts/configure.mjs" normalize "$replacement_config" "$replacement_stage" "$FAKE_MCPORTER" >/dev/null
replacement_meta="$replacement_stage.meta"
rm -- "$replacement_stage"
printf '%s\n' '{"imports":[],"mcpServers":{"exa":{"baseUrl":"https://mcp.exa.ai/mcp","allowedTools":["web_search_exa","web_fetch_exa"]}}}' >"$replacement_stage"
chmod 600 "$replacement_stage"
expect_failure "staged inode replacement" 75 'staged config changed concurrently' \
  node "$BASE_DIR/scripts/configure.mjs" commit "$replacement_config" "$replacement_stage" "$FAKE_MCPORTER"
rm -- "$replacement_stage" "$replacement_meta"

zombie_config="$TMP_ROOT/config/zombie-lock.json"
zombie_lock="$TMP_ROOT/config/.zombie-lock.json.exa-search.lock"
printf '{"pid":%s,"startToken":"definitely-not-this-process"}\n' "$$" >"$zombie_lock"
chmod 600 "$zombie_lock"
MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$zombie_config" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh" >/dev/null
[ ! -e "$zombie_lock" ] || fail "PID-reuse-resistant zombie lock was not recovered"
log "staged inode replacement rejected and zombie locks recovered by PID start identity"

for unsafe in symlink fifo hardlink; do
  source="$TMP_ROOT/config/$unsafe-source.json"
  target="$TMP_ROOT/config/$unsafe.json"
  printf '{}\n' >"$source"
  case "$unsafe" in
    symlink) ln -s -- "$source" "$target" ;;
    fifo) mkfifo "$target" ;;
    hardlink) ln -- "$source" "$target" ;;
  esac
  expect_failure "$unsafe config" 1 'symlink|regular file|hard-linked' env MCPORTER_BIN="$FAKE_MCPORTER" \
    CONFIG_FILE="$target" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
done
mkdir "$TMP_ROOT/real-parent"
ln -s -- "$TMP_ROOT/real-parent" "$TMP_ROOT/linked-parent"
expect_failure "symlink parent" 1 'symlink directory' env MCPORTER_BIN="$FAKE_MCPORTER" \
  CONFIG_FILE="$TMP_ROOT/linked-parent/config.json" RUN_CHECK=0 bash "$BASE_DIR/scripts/install.sh"
log "unsafe files and directory chains rejected"

race_config="$TMP_ROOT/config/race.json"
cp -- "$failure_config" "$race_config"
victim="$TMP_ROOT/config/victim.txt"
printf 'victim\n' >"$victim"
chmod 644 "$victim"
expect_failure "destination swap" 1 'failed to commit Exa config safely|refusing symlink config' env \
  MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$race_config" RUN_CHECK=0 \
  SWAP_CONFIG_PATH="$race_config" SWAP_VICTIM_PATH="$victim" SWAP_MARKER_PATH="$TMP_ROOT/swap.marker" \
  bash "$BASE_DIR/scripts/install.sh"
[ -L "$race_config" ] || fail "destination swap did not execute"
if [ "$(mode_of "$victim")" != 644 ] || [ "$(sed -n '1p' "$victim")" != victim ]; then
  fail "destination swap changed victim"
fi
rm -- "$race_config"

concurrent="$TMP_ROOT/config/concurrent.json"
pids=()
for index in 1 2; do
  DOCTOR_DELAY_MS=200 MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$concurrent" RUN_CHECK=0 \
    bash "$BASE_DIR/scripts/install.sh" >"$TMP_ROOT/concurrent-$index.log" 2>&1 &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid" || fail "concurrent install failed"; done
node "$BASE_DIR/scripts/configure.mjs" verify-policy "$concurrent" "$FAKE_MCPORTER"
assert_mode_600 "$concurrent"
log "destination swap resisted and concurrent commits converged"

mkdir "$TMP_ROOT/hijack-root" "$TMP_ROOT/hijack-root/.cursor"
printf '%s\n' '{"mcpServers":{"evil":{"command":"/bin/false"},"exa":{"command":"/bin/false"}}}' >"$TMP_ROOT/hijack-root/.cursor/mcp.json"
cp -- "$failure_config" "$TMP_ROOT/hijack-root/mcporter.json"
node --input-type=module - "$BASE_DIR/scripts/mcporter-support.mjs" "$REAL_MCPORTER" "$TMP_ROOT/hijack-root/mcporter.json" "$TMP_ROOT/hijack-root" <<'NODE'
import { pathToFileURL } from "node:url";
const [supportPath, binary, configPath, rootDir] = process.argv.slice(2);
const { loadMcporterModule } = await import(pathToFileURL(supportPath).href);
const mcporter = await loadMcporterModule(binary);
const runtime = await mcporter.createRuntime({ configPath, rootDir, logger: { info() {}, warn() {}, error() {}, debug() {} } });
if (runtime.listServers().join(",") !== "exa") process.exit(1);
await runtime.close();
NODE
log "default editor imports disabled; hostile Cursor definitions were not loaded"

call_config="$TMP_ROOT/config/call.json"
cp -- "$failure_config" "$call_config"
call_log="$TMP_ROOT/mcp-calls.log"
query=$'semantic query with spaces, \047quotes\047, $dollar, and\nnewline'
MCP_CALL_LOG="$call_log" MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
  bash "$BASE_DIR/scripts/call.sh" search 3 "$query" >/dev/null
node - "$call_log" "$query" <<'NODE'
const value = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8").trim());
if (value.server !== "exa" || value.tool !== "web_search_exa" || value.args.query !== process.argv[3] || value.args.numResults !== 3) process.exit(1);
NODE
: >"$call_log"
for url in 'http://127.1/' 'http://240.0.0.1/' 'http://[::ffff:127.0.0.1]/' 'http://[2001::1]/' \
  'http://[fec0::1]/' 'http://[::127.0.0.1]/' 'http://[::ffff:0:127.0.0.1]/' \
  'http://[64:ff9b::127.0.0.1]/' \
  'http://host.local/' 'http://home.arpa/' 'http://localhost../' 'http://host.local../' \
  'http://127.0.0.1../' 'https://example.com../' 'https://user:pass@example.com/' 'file:///etc/passwd'; do
  expect_failure "private URL $url" 1 'private|local|credentials|HTTP or HTTPS|trailing dots' env MCP_CALL_LOG="$call_log" \
    MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" bash "$BASE_DIR/scripts/call.sh" fetch 1000 "$url"
done
[ ! -s "$call_log" ] || fail "rejected URL reached MCP runtime"
MCP_CALL_LOG="$call_log" MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
  bash "$BASE_DIR/scripts/call.sh" fetch 1000 'http://8.8.8.8/' 'https://[2606:4700:4700::1111]/' \
  'https://example.com./path?q=1' >/dev/null
node - "$call_log" <<'NODE'
const lines = require("fs").readFileSync(process.argv[2], "utf8").trim().split("\n");
const value = JSON.parse(lines.at(-1));
if (value.args.urls.join(",") !== "http://8.8.8.8/,https://[2606:4700:4700::1111]/,https://example.com./path?q=1") process.exit(1);
NODE
log "dynamic arguments preserved, public IPs and a single trailing dot accepted, and ambiguous/local targets rejected before MCP"

http_log="$TMP_ROOT/mcp-http.log"
for rejected_kind in authenticated custom; do
  rejected_config="$TMP_ROOT/config/preconnect-$rejected_kind.json"
  case "$rejected_kind" in
    authenticated)
      printf '%s\n' '{"imports":[],"mcpServers":{"exa":{"baseUrl":"https://mcp.exa.ai/mcp","headers":{"Authorization":"Bearer forbidden"},"allowedTools":["web_search_exa","web_fetch_exa"]}}}' >"$rejected_config"
      ;;
    custom)
      printf '%s\n' '{"imports":[],"mcpServers":{"exa":{"baseUrl":"http://127.0.0.1:1/mcp","allowedTools":["web_search_exa","web_fetch_exa"]}}}' >"$rejected_config"
      ;;
  esac
  chmod 600 "$rejected_config"
  expect_failure "pre-connect $rejected_kind config" 1 'official anonymous endpoint|official anonymous policy' \
    env MCP_HTTP_LOG="$http_log" node "$BASE_DIR/scripts/exa-call.mjs" call \
      "$FAKE_MCPORTER" "$rejected_config" 500 search 1 test
done
[ ! -e "$http_log" ] || [ ! -s "$http_log" ] || fail "rejected authentication or custom config reached MCP connect"
log "authentication and custom endpoints rejected before connect with zero HTTP activity"

for mode in is-error nested-error error-field empty invalid; do
  expect_failure "raw MCP $mode" 1 'tool error|empty content|invalid envelope' env MCP_MODE="$mode" SHOW_ERROR_OUTPUT=1 \
    MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" bash "$BASE_DIR/scripts/call.sh" search 1 test
done
expect_failure "call output cap" 1 'exceeded MAX_OUTPUT_BYTES|truncated' env MCP_MODE=oversize MAX_OUTPUT_BYTES=4096 \
  MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" bash "$BASE_DIR/scripts/call.sh" search 1 test
expect_failure "call timeout" 1 'timed out after 100 ms' env MCP_MODE=hang CALL_TIMEOUT_MS=100 \
  MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" bash "$BASE_DIR/scripts/call.sh" search 1 test
stubborn_ready="$TMP_ROOT/stubborn-call.ready"
stubborn_output="$TMP_ROOT/stubborn-call.log"
MCP_MODE=stubborn STUBBORN_READY_FILE="$stubborn_ready" CALL_TIMEOUT_MS=1000 \
  MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
  bash "$BASE_DIR/scripts/call.sh" search 1 test >"$stubborn_output" 2>&1 &
stubborn_pid=$!
for _ in {1..40}; do [ -s "$stubborn_ready" ] && break; sleep 0.05; done
if [ ! -s "$stubborn_ready" ]; then
  kill -KILL "$stubborn_pid" 2>/dev/null || true
  wait "$stubborn_pid" 2>/dev/null || true
  fail "stubborn call did not become ready before its deadline"
fi
set +e
wait "$stubborn_pid"
stubborn_status=$?
set -e
[ "$stubborn_status" -eq 1 ] || fail "stubborn call returned $stubborn_status"
grep -q 'killed with SIGKILL' "$stubborn_output" || {
  sed -n '1,80p' "$stubborn_output" >&2
  fail "stubborn call did not report SIGKILL escalation"
}
expect_failure "child status 124" 1 'failed with status 124' \
  "$BASE_DIR/scripts/run-capped.sh" "child status" 1000 4096 -- bash -c 'exit 124'
expect_failure "schema output cap" 1 'exceeded MAX_OUTPUT_BYTES|truncated' env SCHEMA_MODE=oversize MAX_OUTPUT_BYTES=4096 \
  MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" bash "$BASE_DIR/scripts/check.sh"
expect_failure "schema stderr cap" 1 'exceeded MAX_OUTPUT_BYTES|truncated' env OVERSIZE_STDERR=1 MAX_OUTPUT_BYTES=4096 \
  MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" bash "$BASE_DIR/scripts/check.sh"
expect_failure "schema timeout" 1 'timed out after 100 ms' env SCHEMA_MODE=hang DISCOVERY_TIMEOUT_MS=100 \
  MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" bash "$BASE_DIR/scripts/check.sh"
schema_stubborn_ready="$TMP_ROOT/stubborn-schema.ready"
schema_stubborn_output="$TMP_ROOT/stubborn-schema.log"
SCHEMA_MODE=stubborn STUBBORN_READY_FILE="$schema_stubborn_ready" DISCOVERY_TIMEOUT_MS=1000 \
  MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
  bash "$BASE_DIR/scripts/check.sh" >"$schema_stubborn_output" 2>&1 &
schema_stubborn_pid=$!
for _ in {1..40}; do [ -s "$schema_stubborn_ready" ] && break; sleep 0.05; done
if [ ! -s "$schema_stubborn_ready" ]; then
  kill -KILL "$schema_stubborn_pid" 2>/dev/null || true
  wait "$schema_stubborn_pid" 2>/dev/null || true
  fail "stubborn schema discovery did not become ready before its deadline"
fi
set +e
wait "$schema_stubborn_pid"
schema_stubborn_status=$?
set -e
[ "$schema_stubborn_status" -eq 1 ] || fail "stubborn schema discovery returned $schema_stubborn_status"
grep -q 'killed with SIGKILL' "$schema_stubborn_output" || {
  sed -n '1,80p' "$schema_stubborn_output" >&2
  fail "stubborn schema discovery did not report SIGKILL escalation"
}
for schema_mode in missing extra bad-query extra-required narrow-results fixed-enum \
  query-pattern query-min-length query-max-length root-all-of root-dialect root-recursive-ref \
  root-const dependent-required pattern-properties invalid-additional-null invalid-additional-array \
  invalid-additional-number invalid-additional-string negative-min-properties \
  min-properties max-properties query-ref results-conditional narrow-urls negative-min-items \
  fractional-min-items fractional-max-items unique-urls \
  urls-ref url-items-conditional exclusive-characters characters-ref; do
  expect_failure "invalid schema $schema_mode" 1 'schema response validation failed' env SCHEMA_MODE="$schema_mode" \
    MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" bash "$BASE_DIR/scripts/check.sh"
done
SCHEMA_MODE=paged MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
  bash "$BASE_DIR/scripts/check.sh" >/dev/null
SCHEMA_MODE=exact-page-limit MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
  bash "$BASE_DIR/scripts/check.sh" >/dev/null
expect_failure "exactly 64 schema tools pass discovery" 1 'schema response validation failed' env \
  SCHEMA_MODE=exact-tool-limit MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
  bash "$BASE_DIR/scripts/check.sh"
expect_failure "extra tool on a later schema page" 1 'schema response validation failed' env \
  SCHEMA_MODE=paged-extra MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
  bash "$BASE_DIR/scripts/check.sh"
for pagination_mode in repeated-cursor cursor-cycle invalid-cursor oversized-cursor tool-limit \
  cross-page-tool-limit page-limit schema-byte-limit; do
  expect_failure "invalid schema pagination $pagination_mode" 1 'schema discovery failed' env \
    SCHEMA_MODE="$pagination_mode" MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
    bash "$BASE_DIR/scripts/check.sh"
done
smoke_log="$TMP_ROOT/smoke-calls.log"
MCP_CALL_LOG="$smoke_log" RUN_SMOKE=1 MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
  bash "$BASE_DIR/scripts/check.sh" >/dev/null
[ "$(wc -l <"$smoke_log")" -eq 1 ] || fail "explicit smoke did not make exactly one tool call"
expect_failure "invalid smoke toggle" 1 'RUN_SMOKE must be 0 or 1' env RUN_SMOKE=invalid \
  MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" bash "$BASE_DIR/scripts/check.sh"

success_control_output="$TMP_ROOT/success-control.json"
MCP_MODE=success-control MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
  bash "$BASE_DIR/scripts/call.sh" search 1 test >"$success_control_output"
node - "$success_control_output" <<'NODE'
const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const value = JSON.parse(text);
if (value.content?.[0]?.text !== "left\u009bright\u202eend") process.exit(1);
if (/[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/.test(text) ||
    !text.includes("\\u009b") || !text.includes("\\u202e")) process.exit(1);
NODE
[ -f "$BASE_DIR/scripts/runtime-fixture-test.mjs" ] || fail "runtime fixture regression test is missing"
node "$BASE_DIR/scripts/runtime-fixture-test.mjs" >/dev/null
log "raw MCP errors, malicious schemas, safe successful output, caps, TERM deadlines, and SIGKILL escalation enforced"

hang_pid_file="$TMP_ROOT/hang.pid"
MCP_MODE=hang HANG_PID_FILE="$hang_pid_file" MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" \
  CALL_TIMEOUT_MS=30000 bash "$BASE_DIR/scripts/call.sh" search 1 test >/dev/null 2>&1 &
outer_pid=$!
for _ in {1..200}; do [ -s "$hang_pid_file" ] && break; sleep 0.05; done
if [ ! -s "$hang_pid_file" ]; then
  kill -TERM "$outer_pid" 2>/dev/null || true
  wait "$outer_pid" 2>/dev/null || true
  fail "interrupt test child did not start"
fi
child_pid="$(sed -n '1p' "$hang_pid_file")"
kill -TERM "$outer_pid"
set +e
wait "$outer_pid"
outer_status=$?
set -e
[ "$outer_status" -eq 143 ] || fail "interrupted call returned $outer_status"
sleep 0.1
if kill -0 "$child_pid" 2>/dev/null; then
  kill -KILL "$child_pid" 2>/dev/null || true
  fail "interrupted call left its MCP child alive"
fi

install_interrupt="$TMP_ROOT/config/install-interrupt.json"
cp -- "$failure_config" "$install_interrupt"
before="$(digest "$install_interrupt")"
: >"$hang_pid_file"
SCHEMA_MODE=hang HANG_PID_FILE="$hang_pid_file" MCPORTER_BIN="$FAKE_MCPORTER" \
  CONFIG_FILE="$install_interrupt" RUN_CHECK=1 COMMAND_TIMEOUT_MS=30000 \
  bash "$BASE_DIR/scripts/install.sh" >/dev/null 2>&1 &
outer_pid=$!
for _ in {1..200}; do [ -s "$hang_pid_file" ] && break; sleep 0.05; done
if [ ! -s "$hang_pid_file" ]; then
  kill -TERM "$outer_pid" 2>/dev/null || true
  wait "$outer_pid" 2>/dev/null || true
  fail "install interrupt child did not start"
fi
child_pid="$(sed -n '1p' "$hang_pid_file")"
kill -TERM "$outer_pid"
set +e
wait "$outer_pid"
outer_status=$?
set -e
[ "$outer_status" -eq 143 ] || fail "interrupted install returned $outer_status"
sleep 0.1
if kill -0 "$child_pid" 2>/dev/null; then
  kill -KILL "$child_pid" 2>/dev/null || true
  fail "interrupted install left its schema child alive"
fi
[ "$before" = "$(digest "$install_interrupt")" ] || fail "interrupted install changed live config"
assert_no_transaction_files "$install_interrupt"
log "outer interruptions cascade through call/check/install and clean children and stages"

expect_failure "sanitized stderr" 1 '\\x1b.*\\x07' env MCP_MODE=stderr SHOW_ERROR_OUTPUT=1 \
  MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$call_config" bash "$BASE_DIR/scripts/call.sh" search 1 test
failure_output="$(<"$TMP_ROOT/expected-failure.log")"
if [[ "$failure_output" == *$'\033'* || "$failure_output" == *$'\007'* ]]; then fail "terminal control byte was emitted"; fi
if [[ "$failure_output" == *$'\u202e'* || "$failure_output" != *'\x202e'* || "$failure_output" != *'\x0a'* ]]; then
  fail "bidirectional or multiline error text was not safely escaped"
fi

large_tail_file="$TMP_ROOT/large-stderr"
large_tail_output="$TMP_ROOT/large-stderr-tail"
node - "$large_tail_file" <<'NODE'
const fs = require("fs");
const size = 64 * 1024 * 1024;
const marker = Buffer.from("large-tail-marker\n");
const fd = fs.openSync(process.argv[2], "w", 0o600);
fs.ftruncateSync(fd, size);
fs.writeSync(fd, marker, 0, marker.length, size - marker.length);
fs.closeSync(fd);
NODE
node "$BASE_DIR/scripts/safe-tail.mjs" "$large_tail_file" 64 2>"$large_tail_output"
[[ "$(<"$large_tail_output")" == *"large-tail-marker"* ]] || fail "bounded stderr tail lost the file suffix"
[ "$(wc -c <"$large_tail_output")" -le 512 ] || fail "bounded stderr tail emitted too much data"

mkdir "$TMP_ROOT/links"
ln -s -- "$BASE_DIR/scripts/install.sh" "$TMP_ROOT/links/install-link.sh"
symlink_config="$TMP_ROOT/config/symlink-invocation.json"
MCPORTER_BIN="$FAKE_MCPORTER" CONFIG_FILE="$symlink_config" RUN_CHECK=0 bash "$TMP_ROOT/links/install-link.sh" >/dev/null
node "$BASE_DIR/scripts/configure.mjs" verify-policy "$symlink_config" "$FAKE_MCPORTER"
log "stderr controls escaped and symlink invocation resolved the real skill root"

ignore_rule_found=0
while IFS= read -r line; do
  if [ "$line" = 'config/.*.exa-search.*' ]; then ignore_rule_found=1; break; fi
done <"$BASE_DIR/.gitignore"
[ "$ignore_rule_found" -eq 1 ] || fail "transaction artifacts are not ignored"
node_modules_ignored=0
while IFS= read -r line; do
  if [ "$line" = 'node_modules/' ]; then node_modules_ignored=1; break; fi
done <"$BASE_DIR/.gitignore"
[ "$node_modules_ignored" -eq 1 ] || fail "locked dependency installation artifacts are not ignored"
log "selftest complete"
