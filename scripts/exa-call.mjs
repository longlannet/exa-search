#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadJsoncParser, loadMcporterModule } from "./mcporter-support.mjs";

process.umask(0o077);
const MAX_QUERY_BYTES = 8192;
const MAX_URL_BYTES = 4096;
const MAX_CONFIG_BYTES = 1024 * 1024;
const OFFICIAL_EXA_URL = "https://mcp.exa.ai/mcp";
const ALLOWED_TOOLS = Object.freeze(["web_search_exa", "web_fetch_exa"]);
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const NONBLOCK = fs.constants.O_NONBLOCK;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const blockedIpv4Addresses = new net.BlockList();
const blockedIpv6Addresses = new net.BlockList();
const publicIpv6Addresses = new net.BlockList();

for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blockedIpv4Addresses.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
  ["5f00::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blockedIpv6Addresses.addSubnet(address, prefix, "ipv6");
publicIpv6Addresses.addSubnet("2000::", 3, "ipv6");

function fail(message) { throw new Error(message); }
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function assertNoDuplicateProperties(node) {
  if (!node) return;
  if (node.type === "object") {
    const seen = new Set();
    for (const property of node.children ?? []) {
      const name = property.children?.[0]?.value;
      if (seen.has(name)) fail(`duplicate JSONC property is not allowed: ${name}`);
      seen.add(name);
    }
  }
  for (const child of node.children ?? []) assertNoDuplicateProperties(child);
}
function readAnonymousDefinition(configInput, mcporterBinary) {
  const configPath = path.resolve(configInput);
  let fd;
  try { fd = fs.openSync(configPath, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK); }
  catch { fail("Exa config could not be opened safely"); }
  let content;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid() || (stat.mode & 0o077) !== 0) {
      fail("Exa config must be a private regular file owned by the current user");
    }
    if (stat.size > MAX_CONFIG_BYTES) fail("Exa config is too large");
    try { content = utf8.decode(fs.readFileSync(fd)); }
    catch { fail("Exa config is not valid UTF-8"); }
  } finally { fs.closeSync(fd); }

  const parser = loadJsoncParser(mcporterBinary);
  const errors = [];
  const tree = parser.parseTree(content, errors, { allowTrailingComma: true, disallowComments: false });
  if (!tree || errors.length > 0) fail("Exa config is not valid JSON/JSONC");
  assertNoDuplicateProperties(tree);
  const value = parser.parse(content, [], { allowTrailingComma: true, disallowComments: false });
  if (!isPlainObject(value) || !Array.isArray(value.imports) || value.imports.length !== 0 ||
      !isPlainObject(value.mcpServers) || !isPlainObject(value.mcpServers.exa)) {
    fail("Exa config does not satisfy the anonymous policy");
  }
  const exa = value.mcpServers.exa;
  if (Object.keys(exa).sort().join("\0") !== ["allowedTools", "baseUrl"].sort().join("\0") ||
      exa.baseUrl !== OFFICIAL_EXA_URL || !Array.isArray(exa.allowedTools) ||
      exa.allowedTools.length !== ALLOWED_TOOLS.length ||
      !ALLOWED_TOOLS.every((tool, index) => exa.allowedTools[index] === tool)) {
    fail("Exa config must use only the official anonymous endpoint and supported tools");
  }
  return {
    name: "exa",
    command: {
      kind: "http",
      url: new URL(OFFICIAL_EXA_URL),
      headers: { accept: "application/json, text/event-stream" },
    },
    allowedTools: [...ALLOWED_TOOLS],
  };
}
function parseInteger(input, label, minimum, maximum) {
  if (!/^\d+$/.test(input ?? "")) fail(`${label} must be an integer`);
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
function assertPublicUrl(input) {
  if (Buffer.byteLength(input, "utf8") > MAX_URL_BYTES) fail("fetch URL is too long");
  let url;
  try { url = new URL(input); }
  catch { fail("fetch URL is invalid"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") fail("fetch URL must use HTTP or HTTPS");
  if (url.username || url.password) fail("fetch URL must not contain credentials");
  const rawHostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (/\.\.$/.test(rawHostname)) fail("fetch URL hostname has ambiguous trailing dots");
  const hostname = rawHostname.replace(/\.$/, "");
  if (!hostname || !hostname.includes(".") && net.isIP(hostname) === 0) fail("single-label or intranet hostnames are not allowed");
  if (hostname === "localhost" || hostname === "home.arpa" ||
      [".localhost", ".local", ".internal", ".home", ".lan", ".home.arpa", ".onion", ".test", ".invalid"].some((suffix) => hostname.endsWith(suffix))) {
    fail("local or intranet URLs are not allowed");
  }
  const ipVersion = net.isIP(hostname);
  const blockList = ipVersion === 4 ? blockedIpv4Addresses : blockedIpv6Addresses;
  if (ipVersion !== 0 && blockList.check(hostname, ipVersion === 4 ? "ipv4" : "ipv6")) {
    fail("private or reserved IP URLs are not allowed");
  }
  if (ipVersion === 6 && !publicIpv6Addresses.check(hostname, "ipv6")) {
    fail("private or reserved IP URLs are not allowed");
  }
  return url.href;
}
function assertSuccessfulEnvelope(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Exa MCP returned an invalid envelope");
  const envelopes = [raw, raw.raw, raw.raw?.result].filter((value) => value && typeof value === "object" && !Array.isArray(value));
  for (const envelope of envelopes) {
    if (envelope.isError === true || (Object.prototype.hasOwnProperty.call(envelope, "error") && envelope.error != null)) {
      fail("Exa MCP returned a tool error");
    }
  }
  if (!Array.isArray(raw.content) || !raw.content.some((item) =>
    item && typeof item === "object" && item.type === "text" && typeof item.text === "string" && item.text.trim())) {
    fail("Exa MCP returned empty content");
  }
}
function safeErrorMessage(error) {
  return String(error?.message ?? error).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (value) =>
    `\\x${value.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
export function safeJson(value) {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function buildRequest(timeoutInput, mode, inputs) {
  const timeoutMs = parseInteger(timeoutInput, "timeout", 1, 999999999);
  if (mode === "search") {
    if (inputs.length !== 2) fail("search requires NUM_RESULTS and QUERY");
    const numResults = parseInteger(inputs[0], "numResults", 1, 10);
    const query = inputs[1];
    if (!query.trim()) fail("search query must not be empty");
    if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) fail("search query is too long");
    return { timeoutMs, toolName: "web_search_exa", args: { query, numResults } };
  }
  if (mode === "fetch") {
    if (inputs.length < 2 || inputs.length > 4) fail("fetch requires MAX_CHARACTERS and 1-3 URLs");
    const maxCharacters = parseInteger(inputs[0], "maxCharacters", 1, 100000);
    const urls = inputs.slice(1).map(assertPublicUrl);
    return { timeoutMs, toolName: "web_fetch_exa", args: { urls, maxCharacters } };
  }
  fail("call mode must be search or fetch");
}

async function closeQuietly(resource) {
  try { await resource?.close?.(); }
  catch { /* Preserve the primary call result or error. */ }
}

export async function createAnonymousExaConnection(mcporterBinary, configInput) {
  if (typeof NOFOLLOW !== "number" || typeof NONBLOCK !== "number" || typeof process.geteuid !== "function") {
    fail("required Linux no-follow and ownership APIs are unavailable");
  }
  const definition = readAnonymousDefinition(configInput, mcporterBinary);
  const mcporter = await loadMcporterModule(mcporterBinary);
  const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
  const configPath = path.resolve(configInput);
  const runtime = await mcporter.createRuntime({
    servers: [definition],
    // mcporter prefers servers and never rereads configPath; retaining the path keeps API-compatible test runtimes working.
    configPath,
    rootDir: path.dirname(configPath),
    logger: silentLogger,
  });
  if (typeof runtime.connect !== "function") fail("mcporter runtime does not support anonymous connections");
  let connection;
  try {
    connection = await runtime.connect("exa", {
      maxOAuthAttempts: 0,
      skipCache: true,
      allowCachedAuth: false,
    });
    if (!connection?.client || typeof connection.client.callTool !== "function") {
      fail("mcporter returned an invalid anonymous connection");
    }
    if (connection.definition?.auth || connection.oauthSession) fail("authenticated Exa connections are disabled");
    const headers = connection.definition?.command?.headers ?? {};
    if (Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
      fail("authenticated Exa connections are disabled");
    }
    return { mcporter, runtime, connection };
  } catch (error) {
    await closeQuietly(connection?.client);
    await closeQuietly(connection?.transport);
    await closeQuietly(connection?.oauthSession);
    await runtime.close().catch(() => {});
    throw error;
  }
}

let runtime;
let connection;
async function main() {
let mcporter;
try {
  const [action, mcporterBinary, configInput, timeoutInput, mode, ...inputs] = process.argv.slice(2);
  if (!mcporterBinary || !configInput || !mode) fail("action, mcporter, config, timeout, and call mode are required");
  if (action !== "validate" && action !== "call") fail("action must be validate or call");
  const { timeoutMs, toolName, args } = buildRequest(timeoutInput, mode, inputs);
  if (action === "validate") process.exit(0);
  ({ mcporter, runtime, connection } = await createAnonymousExaConnection(mcporterBinary, configInput));
  const raw = await connection.client.callTool({ name: toolName, arguments: args }, undefined, {
    timeout: timeoutMs,
    resetTimeoutOnProgress: true,
    maxTotalTimeout: timeoutMs,
  });
  assertSuccessfulEnvelope(raw);
  const formatted = mcporter.createCallResult(raw).json();
  process.stdout.write(`${safeJson(formatted ?? raw)}\n`);
} catch (error) {
  process.stderr.write(`[exa-search] ERROR: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  await closeQuietly(connection?.client);
  await closeQuietly(connection?.transport);
  await closeQuietly(connection?.oauthSession);
  if (runtime) await runtime.close().catch(() => {});
}
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath || fileURLToPath(import.meta.url) === process.argv[1]) await main();
