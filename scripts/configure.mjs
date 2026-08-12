#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import { loadJsoncParser } from "./mcporter-support.mjs";

process.umask(0o077);
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const COMMIT_LOCK_WAIT_MS = 5000;
const COMMIT_LOCK_POLL_MS = 25;
const ORPHAN_STAGE_MAX_AGE_MS = 5 * 60 * 1000;
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const NONBLOCK = fs.constants.O_NONBLOCK;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const SKILL_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const OFFICIAL_EXA_URL = "https://mcp.exa.ai/mcp";
const ALLOWED_TOOLS = Object.freeze(["web_search_exa", "web_fetch_exa"]);
const CANONICAL_EXA = Object.freeze({ baseUrl: OFFICIAL_EXA_URL, allowedTools: ALLOWED_TOOLS });
const URL_KEYS = Object.freeze(["baseUrl", "base_url", "url", "serverUrl", "server_url"]);
const SAFE_LEGACY_EXA_KEYS = new Set([...URL_KEYS, "allowedTools", "allowed_tools"]);
const pauseBuffer = new Int32Array(new SharedArrayBuffer(4));
const utf8 = new TextDecoder("utf-8", { fatal: true });

function fail(message, code) { const error = new Error(message); if (code) error.code = code; throw error; }
function resolvedPath(input, label) {
  if (!input) fail(`${label} is required`);
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(input)) {
    fail(`${label} must not contain control or bidirectional formatting characters`);
  }
  return path.resolve(input);
}
function isPlainObject(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function identityOf(stat) {
  return {
    dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
    mtimeMs: String(stat.mtimeMs), ctimeMs: String(stat.ctimeMs),
  };
}
function identityMatches(stat, identity) {
  return Boolean(identity) && String(stat.dev) === identity.dev && String(stat.ino) === identity.ino &&
    String(stat.size) === identity.size && String(stat.mtimeMs) === identity.mtimeMs &&
    String(stat.ctimeMs) === identity.ctimeMs;
}
function inodeMatches(stat, identity) {
  return Boolean(identity) && String(stat.dev) === identity.dev && String(stat.ino) === identity.ino;
}
function renamedIdentityMatches(stat, identity) {
  return inodeMatches(stat, identity) && String(stat.size) === identity.size &&
    String(stat.mtimeMs) === identity.mtimeMs;
}
function isFileIdentity(value) {
  return isPlainObject(value) && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) =>
    typeof value[key] === "string");
}
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function inspectDirectory(directory, euid) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) fail(`refusing symlink directory: ${directory}`);
  if (!stat.isDirectory()) fail(`config parent is not a directory: ${directory}`);
  const mode = stat.mode & 0o7777;
  if (stat.uid !== euid && stat.uid !== 0) fail(`untrusted directory owner: ${directory}`);
  if ((mode & 0o022) !== 0 && !((mode & 0o1000) !== 0 && stat.uid === 0)) {
    fail(`config path crosses an untrusted writable directory: ${directory}`);
  }
  return stat;
}
function assertDirectoryChain(directory, requireFinalOwner = true) {
  if (typeof process.geteuid !== "function") fail("effective user checks are unavailable");
  const euid = process.geteuid();
  const parsed = path.parse(directory);
  const trustedRoot = isWithin(SKILL_ROOT, directory) ? SKILL_ROOT : parsed.root;
  let current = trustedRoot;
  let finalStat = inspectDirectory(current, euid);
  const relative = path.relative(trustedRoot, directory);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    finalStat = inspectDirectory(current, euid);
  }
  if (requireFinalOwner && finalStat.uid !== euid) fail(`config parent is not owned by the current user: ${directory}`);
  if (requireFinalOwner && (finalStat.mode & 0o022) !== 0) fail(`config parent is writable by group/other: ${directory}`);
}
function ensureSafeParent(directory) {
  let existing = directory;
  while (true) {
    try { fs.lstatSync(existing); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
  assertDirectoryChain(existing, false);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertDirectoryChain(directory, true);
}
function readPrivateFile(filePath, required, maxBytes) {
  let fd;
  try { fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK); }
  catch (error) {
    if (error.code === "ENOENT" && !required) return null;
    if (error.code === "ELOOP") fail(`refusing symlink file: ${filePath}`);
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail(`not a regular file: ${filePath}`);
    if (stat.nlink !== 1) fail(`refusing hard-linked file: ${filePath}`);
    if (stat.uid !== process.geteuid()) fail(`file ownership changed: ${filePath}`);
    if (stat.size > maxBytes) fail(`file exceeds ${maxBytes} bytes: ${filePath}`);
    return { content: fs.readFileSync(fd), identity: identityOf(stat), mode: stat.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
function createPrivateFile(filePath, content) {
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    return identityOf(fs.fstatSync(fd));
  } finally { fs.closeSync(fd); }
}
function rewritePrivateFile(filePath, content, expectedIdentity) {
  if (content.length > MAX_CONFIG_BYTES) fail(`updated config exceeds ${MAX_CONFIG_BYTES} bytes`);
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | NOFOLLOW | NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid()) fail("staged config is unsafe");
    if (!identityMatches(stat, expectedIdentity)) fail("staged config changed concurrently", "CONFIG_CHANGED");
    fs.ftruncateSync(fd, 0);
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    return identityOf(fs.fstatSync(fd));
  } finally { fs.closeSync(fd); }
}
function safeUnlink(filePath) {
  try { const stat = fs.lstatSync(filePath); if (stat.isDirectory()) fail(`refusing to remove directory: ${filePath}`); fs.unlinkSync(filePath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
function safeUnlinkIfMatches(filePath, identity) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid()) {
    fail(`refusing unsafe cleanup target: ${filePath}`);
  }
  if (!identityMatches(stat, identity)) return false;
  fs.unlinkSync(filePath);
  return true;
}
function safeUnlinkIfRenamedIdentityMatches(filePath, identity) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid()) {
    fail(`refusing unsafe cleanup target: ${filePath}`);
  }
  if (!renamedIdentityMatches(stat, identity)) return false;
  fs.unlinkSync(filePath);
  return true;
}
function stagePrefix(configPath) { return `.${path.basename(configPath)}.exa-search.`; }
function recoveryPrefix(configPath) { return `.${path.basename(configPath)}.exa-search-recovery.`; }
function assertStagePath(configPath, stagedInput) {
  const stagedPath = resolvedPath(stagedInput, "staged config path");
  if (path.dirname(stagedPath) !== path.dirname(configPath)) fail("staged config is outside the config directory");
  const extension = path.extname(configPath) || ".json";
  const basename = path.basename(stagedPath);
  const suffix = basename.slice(stagePrefix(configPath).length, -extension.length);
  if (!basename.startsWith(stagePrefix(configPath)) || !basename.endsWith(extension) ||
      !/^\d+\.[0-9a-f]{24}$/.test(suffix)) {
    fail("staged config name is invalid");
  }
  return stagedPath;
}
function assertRecoveryPath(configPath, recoveryInput) {
  const recoveryPath = resolvedPath(recoveryInput, "recovery path");
  if (path.dirname(recoveryPath) !== path.dirname(configPath)) fail("recovery file is outside the config directory");
  const suffix = path.basename(recoveryPath).slice(recoveryPrefix(configPath).length);
  if (!path.basename(recoveryPath).startsWith(recoveryPrefix(configPath)) || !/^\d+\.[0-9a-f]{24}$/.test(suffix)) {
    fail("recovery file name is invalid");
  }
  return recoveryPath;
}
function processInfo(pid) {
  if (process.platform !== "linux") return null;
  try {
    const value = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closing = value.lastIndexOf(")");
    if (closing < 0) return null;
    const fields = value.slice(closing + 1).trim().split(/\s+/);
    return { state: fields[0] ?? null, startToken: fields[19] ?? null };
  } catch { return null; }
}
function processStartToken(pid) { return processInfo(pid)?.startToken ?? null; }
function processMatches(pid, startToken) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code !== "EPERM") throw error; }
  const info = processInfo(pid);
  if (info && ["Z", "X"].includes(info.state)) return false;
  const currentToken = info?.startToken ?? null;
  return !startToken || !currentToken || currentToken === startToken;
}
function cleanupStaleStages(configPath) {
  const directory = path.dirname(configPath);
  const prefix = stagePrefix(configPath);
  const recoveryNamePrefix = recoveryPrefix(configPath);
  const lockName = path.basename(commitLockPath(configPath));
  const names = fs.readdirSync(directory).filter((name) => name.startsWith(prefix) &&
    !name.startsWith(recoveryNamePrefix) && name !== lockName);
  const metadataNames = new Set(names.filter((name) => name.endsWith(".meta")));
  for (const metaName of metadataNames) {
    const metadataPath = path.join(directory, metaName);
    let rawMetadata;
    try {
      const record = readPrivateFile(metadataPath, true, MAX_METADATA_BYTES);
      const stagedPath = metadataPath.slice(0, -5);
      try { rawMetadata = JSON.parse(record.content.toString("utf8")); }
      catch { continue; }
      const hasRecoveryPlan = Object.prototype.hasOwnProperty.call(rawMetadata ?? {}, "recoveryPath");
      try {
        if (!hasRecoveryPlan && isPlainObject(rawMetadata) && rawMetadata.configPath === configPath &&
            !Object.prototype.hasOwnProperty.call(rawMetadata, "staged") &&
            (rawMetadata.original === null || isFileIdentity(rawMetadata.original)) &&
            Number.isSafeInteger(rawMetadata.pid) && rawMetadata.pid > 0 &&
            (rawMetadata.startToken === null || typeof rawMetadata.startToken === "string") &&
            !processMatches(rawMetadata.pid, rawMetadata.startToken)) {
          const legacyStage = readPrivateFile(stagedPath, false, MAX_CONFIG_BYTES);
          if (legacyStage) {
            requireUnlinkMatch(stagedPath, legacyStage.identity);
            fsyncDirectory(directory);
          }
          requireUnlinkMatch(metadataPath, record.identity);
          continue;
        }
        const metadata = validateMetadata(configPath, stagedPath, rawMetadata);
        if (processMatches(metadata.pid, metadata.startToken)) continue;
        recoverTransaction(configPath, stagedPath, metadata, record.identity);
      } catch (error) {
        if (hasRecoveryPlan) throw error;
        // Legacy or malformed artifacts without a recovery plan are left for explicit inspection.
      }
    } catch (error) {
      if (Object.prototype.hasOwnProperty.call(rawMetadata ?? {}, "recoveryPath")) throw error;
    }
  }
  for (const name of names.filter((item) => !item.endsWith(".meta"))) {
    if (metadataNames.has(`${name}.meta`)) continue;
    const candidate = path.join(directory, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.geteuid()) continue;
      if (Date.now() - stat.mtimeMs < ORPHAN_STAGE_MAX_AGE_MS) continue;
      safeUnlinkIfMatches(candidate, identityOf(stat));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
function targetMatches(configPath, originalIdentity) {
  let stat;
  try { stat = fs.lstatSync(configPath); }
  catch (error) { if (error.code === "ENOENT") return originalIdentity === null; throw error; }
  if (stat.isSymbolicLink()) fail(`refusing symlink config: ${configPath}`);
  if (!stat.isFile()) fail(`config is not a regular file: ${configPath}`);
  if (stat.nlink !== 1) fail(`refusing hard-linked config: ${configPath}`);
  if (stat.uid !== process.geteuid()) fail(`config ownership changed: ${configPath}`);
  if (!originalIdentity) return false;
  return identityMatches(stat, originalIdentity);
}
function prepare(configPath, ownerInput) {
  if (!/^\d+$/.test(ownerInput ?? "") || !Number.isSafeInteger(Number(ownerInput)) || Number(ownerInput) <= 0) {
    fail("installer PID is required to prepare a transaction");
  }
  const ownerPid = Number(ownerInput);
  const ownerStartToken = processStartToken(ownerPid);
  if (!processMatches(ownerPid, ownerStartToken)) fail("installer process is not running");
  const directory = path.dirname(configPath);
  ensureSafeParent(directory);
  const lock = acquireCommitLock(configPath);
  let stagedPath;
  try {
    cleanupStaleStages(configPath);
    const original = readPrivateFile(configPath, false, MAX_CONFIG_BYTES);
    const extension = path.extname(configPath) || ".json";
    stagedPath = path.join(directory,
      `${stagePrefix(configPath)}${process.pid}.${crypto.randomBytes(12).toString("hex")}${extension}`);
    const metadataPath = `${stagedPath}.meta`;
    const initial = original?.content ?? Buffer.from(
      `${JSON.stringify({ imports: [], mcpServers: { exa: CANONICAL_EXA } }, null, 2)}\n`, "utf8");
    const metadata = {
      configPath,
      original: original?.identity ?? null,
      pid: ownerPid,
      startToken: ownerStartToken,
    };
    try {
      metadata.staged = createPrivateFile(stagedPath, initial);
      createPrivateFile(metadataPath, Buffer.from(JSON.stringify(metadata), "utf8"));
      fsyncDirectory(directory);
    } catch (error) { safeUnlink(stagedPath); safeUnlink(metadataPath); throw error; }
  } finally {
    requireUnlinkMatch(lock.path, lock.identity);
  }
  process.stdout.write(`${stagedPath}\n`);
}
function validateMetadata(configPath, stagedPath, value) {
  let recoveryPath;
  if (Object.prototype.hasOwnProperty.call(value ?? {}, "recoveryPath")) {
    if (typeof value.recoveryPath !== "string" || value.original === null) {
      fail("transaction recovery metadata is invalid");
    }
    recoveryPath = assertRecoveryPath(configPath, value.recoveryPath);
  }
  if (!isPlainObject(value) || value.configPath !== configPath ||
      (value.original !== null && !isFileIdentity(value.original)) || !isFileIdentity(value.staged) ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      (value.startToken !== null && typeof value.startToken !== "string")) {
    fail("transaction metadata does not match the config");
  }
  if (recoveryPath) value.recoveryPath = recoveryPath;
  if ([configPath, stagedPath, `${stagedPath}.meta`].includes(value.recoveryPath)) {
    fail("transaction recovery path conflicts with transaction files");
  }
  return value;
}
function readMetadataRecord(configPath, stagedPath) {
  const record = readPrivateFile(`${stagedPath}.meta`, true, MAX_METADATA_BYTES);
  let value;
  try { value = JSON.parse(record.content.toString("utf8")); }
  catch { fail("transaction metadata is invalid"); }
  return { value: validateMetadata(configPath, stagedPath, value), identity: record.identity };
}
function readMetadata(configPath, stagedPath) { return readMetadataRecord(configPath, stagedPath).value; }
function writeMetadataAtomic(configPath, stagedPath, metadata) {
  validateMetadata(configPath, stagedPath, metadata);
  const metadataPath = `${stagedPath}.meta`;
  const updatePath = `${metadataPath}.update.${crypto.randomBytes(12).toString("hex")}`;
  try {
    createPrivateFile(updatePath, Buffer.from(JSON.stringify(metadata), "utf8"));
    fs.renameSync(updatePath, metadataPath);
    fsyncDirectory(path.dirname(metadataPath));
  } finally { safeUnlink(updatePath); }
}
function updateStagedIdentity(configPath, stagedPath, stagedIdentity) {
  const metadata = readMetadata(configPath, stagedPath);
  metadata.staged = stagedIdentity;
  writeMetadataAtomic(configPath, stagedPath, metadata);
}
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
function parsePolicyDocument(content, mcporterBinary) {
  const parser = loadJsoncParser(mcporterBinary);
  let text;
  try { text = utf8.decode(content); }
  catch { fail("config is not valid UTF-8"); }
  const errors = [];
  const tree = parser.parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !tree) {
    const detail = errors[0] ? parser.printParseErrorCode(errors[0].error) : "empty document";
    fail(`config is not valid JSON/JSONC: ${detail}`);
  }
  assertNoDuplicateProperties(tree);
  const value = parser.parse(text, [], { allowTrailingComma: true, disallowComments: false });
  if (!isPlainObject(value)) fail("config root must be an object");
  return { parser, text, value };
}
function assertPolicy(value) {
  if (!Array.isArray(value.imports) || value.imports.length !== 0) fail("config imports must be an empty array");
  if (!isPlainObject(value.mcpServers)) fail("mcpServers must be an object");
  if (!Object.prototype.hasOwnProperty.call(value.mcpServers, "exa")) fail("exact local Exa config is missing");
  const exa = value.mcpServers.exa;
  if (!isPlainObject(exa)) fail("Exa config must be an object");
  const keys = Object.keys(exa).sort();
  if (keys.join("\0") !== ["allowedTools", "baseUrl"].sort().join("\0")) {
    fail("Exa config must contain only baseUrl and allowedTools; authentication and custom transports are unsupported");
  }
  if (exa.baseUrl !== OFFICIAL_EXA_URL) fail("Exa config must use the official anonymous MCP endpoint");
  if (!Array.isArray(exa.allowedTools) || exa.allowedTools.length !== ALLOWED_TOOLS.length ||
      !ALLOWED_TOOLS.every((tool, index) => exa.allowedTools[index] === tool)) {
    fail("Exa allowedTools must contain only the supported search and fetch tools");
  }
}
function formattingOptions(text) {
  return { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}
function applyModification(parser, text, jsonPath, value) {
  const edits = parser.modify(text, jsonPath, value, { formattingOptions: formattingOptions(text) });
  return parser.applyEdits(text, edits);
}
function normalize(configPath, stagedInput, mcporterBinary) {
  assertDirectoryChain(path.dirname(configPath), true);
  const stagedPath = assertStagePath(configPath, stagedInput);
  const record = readPrivateFile(stagedPath, true, MAX_CONFIG_BYTES);
  const document = parsePolicyDocument(record.content, mcporterBinary);
  let { text, value } = document;
  const { parser } = document;
  if (!Object.prototype.hasOwnProperty.call(value, "mcpServers")) {
    text = applyModification(parser, text, ["mcpServers"], {});
    value = parsePolicyDocument(Buffer.from(text), mcporterBinary).value;
  }
  if (!isPlainObject(value.mcpServers)) fail("mcpServers must be an object");
  const existing = value.mcpServers.exa;
  if (existing !== undefined) {
    if (!isPlainObject(existing)) fail("Exa config must be an object");
    const unsupported = Object.keys(existing).filter((key) => !SAFE_LEGACY_EXA_KEYS.has(key));
    if (unsupported.length > 0) {
      fail(`refusing unsupported or authenticated Exa fields: ${unsupported.sort().join(", ")}`);
    }
    const configuredUrls = URL_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(existing, key));
    if (configuredUrls.length !== 1 || existing[configuredUrls[0]] !== OFFICIAL_EXA_URL) {
      fail("refusing custom Exa endpoint or transport; only the official anonymous MCP endpoint is supported");
    }
    for (const key of URL_KEYS.filter((key) => key !== "baseUrl" && Object.prototype.hasOwnProperty.call(existing, key))) {
      text = applyModification(parser, text, ["mcpServers", "exa", key], undefined);
    }
    if (Object.prototype.hasOwnProperty.call(existing, "allowed_tools")) {
      text = applyModification(parser, text, ["mcpServers", "exa", "allowed_tools"], undefined);
    }
    text = applyModification(parser, text, ["mcpServers", "exa", "baseUrl"], OFFICIAL_EXA_URL);
    text = applyModification(parser, text, ["mcpServers", "exa", "allowedTools"], ALLOWED_TOOLS);
  } else {
    text = applyModification(parser, text, ["mcpServers", "exa"], CANONICAL_EXA);
  }
  text = applyModification(parser, text, ["imports"], []);
  const normalized = parsePolicyDocument(Buffer.from(text), mcporterBinary);
  assertPolicy(normalized.value);
  const stagedIdentity = text === document.text ? record.identity :
    rewritePrivateFile(stagedPath, Buffer.from(text, "utf8"), record.identity);
  updateStagedIdentity(configPath, stagedPath, stagedIdentity);
  process.stdout.write(text === document.text ? "unchanged\n" : "changed\n");
}
function verifySecurity(configPath) {
  assertDirectoryChain(path.dirname(configPath), true);
  const current = readPrivateFile(configPath, true, MAX_CONFIG_BYTES);
  if ((current.mode & 0o077) !== 0) fail(`config permissions expose group/other access: ${configPath}`);
  return current;
}
function verifyPolicy(configPath, mcporterBinary) {
  const current = verifySecurity(configPath);
  assertPolicy(parsePolicyDocument(current.content, mcporterBinary).value);
}
function openStageForCommit(stagedPath, expectedIdentity, mcporterBinary) {
  const fd = fs.openSync(stagedPath, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid()) fail("staged config is unsafe");
    if ((stat.mode & 0o077) !== 0) fail("staged config permissions expose group/other access");
    if (!identityMatches(stat, expectedIdentity)) fail("staged config changed concurrently", "CONFIG_CHANGED");
    if (stat.size > MAX_CONFIG_BYTES) fail(`staged config exceeds ${MAX_CONFIG_BYTES} bytes`);
    const content = fs.readFileSync(fd);
    assertPolicy(parsePolicyDocument(content, mcporterBinary).value);
    fs.fsyncSync(fd);
    const finalStat = fs.fstatSync(fd);
    if (!identityMatches(finalStat, expectedIdentity)) fail("staged config changed during validation", "CONFIG_CHANGED");
    return { fd, identity: expectedIdentity };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}
function fsyncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY); fs.fsyncSync(fd); }
  catch (error) { if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function commitLockPath(configPath) { return path.join(path.dirname(configPath), `.${path.basename(configPath)}.exa-search.lock`); }
function recoverStaleLock(lockPath) {
  const record = readPrivateFile(lockPath, true, MAX_METADATA_BYTES);
  let metadata;
  const text = record.content.toString("utf8");
  try { metadata = JSON.parse(text); }
  catch {
    const legacyPid = text.trim();
    if (!/^\d+$/.test(legacyPid) || !Number.isSafeInteger(Number(legacyPid))) {
      fail(`invalid Exa commit lock requires manual inspection: ${lockPath}`);
    }
    metadata = { pid: Number(legacyPid), startToken: null };
  }
  if (processMatches(metadata?.pid, metadata?.startToken)) return false;
  return safeUnlinkIfMatches(lockPath, record.identity);
}
function acquireCommitLock(configPath) {
  const lockPath = commitLockPath(configPath);
  const deadline = Date.now() + COMMIT_LOCK_WAIT_MS;
  while (true) {
    try {
      const identity = createPrivateFile(lockPath, Buffer.from(JSON.stringify({
        pid: process.pid,
        startToken: processStartToken(process.pid),
      }), "utf8"));
      return { path: lockPath, identity };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (recoverStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) fail("another Exa config commit is in progress", "CONFIG_CHANGED");
      Atomics.wait(pauseBuffer, 0, 0, COMMIT_LOCK_POLL_MS);
    }
  }
}
function backupPathFor(configPath) {
  return path.join(path.dirname(configPath),
    `.${path.basename(configPath)}.exa-search-recovery.${process.pid}.${crypto.randomBytes(12).toString("hex")}`);
}
function assertPathMissing(filePath) {
  try { fs.lstatSync(filePath); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  fail(`transaction recovery path already exists: ${filePath}`);
}
function readOriginalForCommit(configPath, originalIdentity) {
  if (originalIdentity === null) {
    let stat;
    try { stat = fs.lstatSync(configPath); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (stat) fail("config changed concurrently", "CONFIG_CHANGED");
  }
  const current = readPrivateFile(configPath, true, MAX_CONFIG_BYTES);
  if (!identityMatches({ ...current.identity }, originalIdentity)) {
    fail("config changed concurrently", "CONFIG_CHANGED");
  }
  return current;
}
function pathMatchesIdentity(filePath, identity, afterRename = false) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  return !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1 && stat.uid === process.geteuid() &&
    (afterRename ? renamedIdentityMatches(stat, identity) : identityMatches(stat, identity));
}
function inspectTransactionPath(filePath) {
  let stat;
  try { stat = fs.lstatSync(filePath); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid()) {
    fail(`unsafe transaction artifact requires manual inspection: ${filePath}`);
  }
  return stat;
}
function requireUnlinkMatch(filePath, identity, renamed = false) {
  const removed = renamed ? safeUnlinkIfRenamedIdentityMatches(filePath, identity) :
    safeUnlinkIfMatches(filePath, identity);
  if (!removed) fail(`transaction artifact changed before cleanup: ${filePath}`);
}
function recoverTransaction(configPath, stagedPath, metadata, metadataIdentity) {
  if (!metadata.recoveryPath) {
    const configStat = inspectTransactionPath(configPath);
    const stagedStat = inspectTransactionPath(stagedPath);
    const stageIsStaged = Boolean(stagedStat) && identityMatches(stagedStat, metadata.staged);
    const configIsPublished = Boolean(configStat) && renamedIdentityMatches(configStat, metadata.staged);
    const configIsOriginal = Boolean(configStat) && metadata.original !== null &&
      identityMatches(configStat, metadata.original);
    if (stageIsStaged) {
      requireUnlinkMatch(stagedPath, metadata.staged);
      fsyncDirectory(path.dirname(configPath));
      requireUnlinkMatch(`${stagedPath}.meta`, metadataIdentity);
      return;
    }
    if (!stagedStat && ((metadata.original === null && !configStat) || configIsOriginal)) {
      requireUnlinkMatch(`${stagedPath}.meta`, metadataIdentity);
      return;
    }
    if (configIsPublished && !stagedStat) {
      requireUnlinkMatch(`${stagedPath}.meta`, metadataIdentity);
      return;
    }
    fail(`ambiguous Exa config transaction requires manual inspection: ${stagedPath}`);
  }
  const directory = path.dirname(configPath);
  const configStat = inspectTransactionPath(configPath);
  const stagedStat = inspectTransactionPath(stagedPath);
  const recoveryStat = inspectTransactionPath(metadata.recoveryPath);
  const configIsOriginal = Boolean(configStat) && renamedIdentityMatches(configStat, metadata.original);
  const configIsPublished = Boolean(configStat) && renamedIdentityMatches(configStat, metadata.staged);
  const stageIsStaged = Boolean(stagedStat) && identityMatches(stagedStat, metadata.staged);
  const recoveryIsOriginal = Boolean(recoveryStat) && renamedIdentityMatches(recoveryStat, metadata.original);

  if (!recoveryStat && configIsOriginal && (stageIsStaged || !stagedStat)) {
    if (stageIsStaged) requireUnlinkMatch(stagedPath, metadata.staged);
    fsyncDirectory(directory);
    requireUnlinkMatch(`${stagedPath}.meta`, metadataIdentity);
    return;
  }
  if (recoveryIsOriginal && !configStat && stageIsStaged) {
    fs.renameSync(metadata.recoveryPath, configPath);
    fsyncDirectory(directory);
    requireUnlinkMatch(stagedPath, metadata.staged);
    fsyncDirectory(directory);
    requireUnlinkMatch(`${stagedPath}.meta`, metadataIdentity);
    return;
  }
  if (recoveryIsOriginal && configIsPublished && !stagedStat) {
    requireUnlinkMatch(metadata.recoveryPath, metadata.original, true);
    fsyncDirectory(directory);
    requireUnlinkMatch(`${stagedPath}.meta`, metadataIdentity);
    return;
  }
  if (!recoveryStat && configIsPublished && !stagedStat) {
    fsyncDirectory(directory);
    requireUnlinkMatch(`${stagedPath}.meta`, metadataIdentity);
    return;
  }
  fail(`ambiguous Exa config transaction requires manual inspection: ${stagedPath}`);
}
function restoreMovedOriginal(configPath, stagedPath, metadata, published) {
  if (published) {
    if (!pathMatchesIdentity(configPath, metadata.staged, true)) {
      fail("published config path changed before rollback; recovery retained for manual inspection");
    }
  } else {
    const current = inspectTransactionPath(configPath);
    if (current) fail("config path was recreated before rollback; recovery retained for manual inspection");
  }
  const recoveryStat = inspectTransactionPath(metadata.recoveryPath);
  if (!recoveryStat || !renamedIdentityMatches(recoveryStat, metadata.original)) {
    fail("config recovery file changed before rollback");
  }
  fs.renameSync(metadata.recoveryPath, configPath);
  fsyncDirectory(path.dirname(configPath));
}
function commit(configPath, stagedInput, mcporterBinary) {
  assertDirectoryChain(path.dirname(configPath), true);
  const stagedPath = assertStagePath(configPath, stagedInput);
  let lock;
  let stage;
  let metadata;
  let originalMoved = false;
  let published = false;
  let verified = false;
  try {
    lock = acquireCommitLock(configPath);
    metadata = readMetadata(configPath, stagedPath);
    readOriginalForCommit(configPath, metadata.original);
    stage = openStageForCommit(stagedPath, metadata.staged, mcporterBinary);
    if (!targetMatches(configPath, metadata.original)) fail("config changed concurrently", "CONFIG_CHANGED");
    if (!pathMatchesIdentity(stagedPath, stage.identity)) fail("staged config changed before commit", "CONFIG_CHANGED");
    if (metadata.original) {
      metadata.recoveryPath = backupPathFor(configPath);
      assertPathMissing(metadata.recoveryPath);
      writeMetadataAtomic(configPath, stagedPath, metadata);
      if (!targetMatches(configPath, metadata.original)) fail("config changed concurrently", "CONFIG_CHANGED");
      if (!pathMatchesIdentity(stagedPath, stage.identity)) fail("staged config changed before commit", "CONFIG_CHANGED");
      assertPathMissing(metadata.recoveryPath);
      fs.renameSync(configPath, metadata.recoveryPath);
      originalMoved = true;
      fsyncDirectory(path.dirname(configPath));
      if (!pathMatchesIdentity(metadata.recoveryPath, metadata.original, true)) {
        fail("config recovery identity is invalid");
      }
    }
    fs.renameSync(stagedPath, configPath);
    published = true;
    if (!pathMatchesIdentity(configPath, stage.identity, true)) fail("unexpected staged config was published");
    fsyncDirectory(path.dirname(configPath));
    verifyPolicy(configPath, mcporterBinary);
    verified = true;
  } catch (error) {
    if (originalMoved) {
      try { restoreMovedOriginal(configPath, stagedPath, metadata, published); }
      catch (rollbackError) {
        rollbackError.cause = error;
        throw rollbackError;
      }
    } else if (published) {
      try {
        if (!pathMatchesIdentity(configPath, metadata.staged, true)) fail("published config changed before rollback");
        requireUnlinkMatch(configPath, metadata.staged, true);
        fsyncDirectory(path.dirname(configPath));
      } catch (rollbackError) {
        rollbackError.cause = error;
        throw rollbackError;
      }
    }
    throw error;
  } finally {
    if (stage) fs.closeSync(stage.fd);
    if (!verified && lock) {
      try { safeUnlinkIfMatches(lock.path, lock.identity); }
      catch { /* A stale lock is recoverable by PID identity on the next transaction. */ }
    }
  }
  if (metadata.recoveryPath) {
    let recoveryRemovalDurable = false;
    try {
      requireUnlinkMatch(metadata.recoveryPath, metadata.original, true);
      fsyncDirectory(path.dirname(configPath));
      recoveryRemovalDurable = true;
    } catch { /* Retain metadata so the next prepare can finish or inspect recovery cleanup. */ }
    if (!recoveryRemovalDurable) {
      try { requireUnlinkMatch(lock.path, lock.identity); } catch { /* Stale lock recovery is safe after commit. */ }
      return;
    }
  }
  try {
    requireUnlinkMatch(lock.path, lock.identity);
    const metadataRecord = readMetadataRecord(configPath, stagedPath);
    requireUnlinkMatch(`${stagedPath}.meta`, metadataRecord.identity);
  } catch { /* A verified commit must not be reported as failed during artifact cleanup. */ }
}
function cleanup(configPath, stagedInput) {
  assertDirectoryChain(path.dirname(configPath), true);
  const stagedPath = assertStagePath(configPath, stagedInput);
  const lock = acquireCommitLock(configPath);
  try {
    let record;
    try { record = readMetadataRecord(configPath, stagedPath); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    recoverTransaction(configPath, stagedPath, record.value, record.identity);
  } finally {
    requireUnlinkMatch(lock.path, lock.identity);
  }
}
function safeErrorMessage(error) {
  return String(error?.message ?? error).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (value) =>
    `\\x${value.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

try {
  if (typeof NOFOLLOW !== "number" || typeof NONBLOCK !== "number" || typeof process.geteuid !== "function") {
    fail("required Linux no-follow and ownership APIs are unavailable");
  }
  const [command, configInput, stagedInput, mcporterBinary] = process.argv.slice(2);
  const configPath = resolvedPath(configInput, "config path");
  if (command === "resolve") process.stdout.write(`${configPath}\n`);
  else if (command === "prepare") prepare(configPath, stagedInput);
  else if (command === "normalize") normalize(configPath, stagedInput, mcporterBinary);
  else if (command === "commit") commit(configPath, stagedInput, mcporterBinary);
  else if (command === "cleanup") cleanup(configPath, stagedInput);
  else if (command === "verify") verifySecurity(configPath);
  else if (command === "verify-policy") verifyPolicy(configPath, stagedInput);
  else fail("usage: configure.mjs resolve|prepare|normalize|commit|cleanup|verify|verify-policy CONFIG_FILE [STAGED_FILE|INSTALLER_PID|MCPORTER_BIN] [MCPORTER_BIN]");
} catch (error) {
  process.stderr.write(`[exa-search] ERROR: ${safeErrorMessage(error)}\n`);
  process.exit(error.code === "CONFIG_CHANGED" ? 75 : 1);
}
