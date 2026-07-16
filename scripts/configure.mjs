#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024;
const COMMIT_LOCK_WAIT_MS = 5000;
const COMMIT_LOCK_POLL_MS = 25;
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const NONBLOCK = fs.constants.O_NONBLOCK;
const DIRECTORY = fs.constants.O_DIRECTORY ?? 0;
const SKILL_ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const pauseBuffer = new Int32Array(new SharedArrayBuffer(4));
function fail(message, code) { const error = new Error(message); if (code) error.code = code; throw error; }
function resolvedPath(input, label) { if (!input) fail(`${label} is required`); return path.resolve(input); }
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
  if ((mode & 0o022) !== 0 && !((mode & 0o1000) !== 0 && stat.uid === 0)) fail(`config path crosses an untrusted writable directory: ${directory}`);
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
    return { content: fs.readFileSync(fd), identity: {
      dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size),
      mtimeMs: String(stat.mtimeMs), ctimeMs: String(stat.ctimeMs),
    }, mode: stat.mode & 0o777 };
  } finally { fs.closeSync(fd); }
}
function createPrivateFile(filePath, content) {
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, content); fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function safeUnlink(filePath) {
  try { const stat = fs.lstatSync(filePath); if (stat.isDirectory()) fail(`refusing to remove directory: ${filePath}`); fs.unlinkSync(filePath); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
function stagePrefix(configPath) { return `.${path.basename(configPath)}.exa-search.`; }
function assertStagePath(configPath, stagedInput) {
  const stagedPath = resolvedPath(stagedInput, "staged config path");
  if (path.dirname(stagedPath) !== path.dirname(configPath)) fail("staged config is outside the config directory");
  if (!path.basename(stagedPath).startsWith(stagePrefix(configPath))) fail("staged config name is invalid");
  return stagedPath;
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
  return String(stat.dev) === originalIdentity.dev && String(stat.ino) === originalIdentity.ino && String(stat.size) === originalIdentity.size &&
    String(stat.mtimeMs) === originalIdentity.mtimeMs && String(stat.ctimeMs) === originalIdentity.ctimeMs;
}
function prepare(configPath) {
  const directory = path.dirname(configPath);
  ensureSafeParent(directory);
  const original = readPrivateFile(configPath, false, MAX_CONFIG_BYTES);
  const extension = path.extname(configPath) || ".json";
  const stagedPath = path.join(directory, `${stagePrefix(configPath)}${process.pid}.${crypto.randomBytes(12).toString("hex")}${extension}`);
  const metadataPath = `${stagedPath}.meta`;
  const initial = original ? original.content : Buffer.from('{"mcpServers":{}}\n', "utf8");
  try {
    createPrivateFile(stagedPath, initial);
    createPrivateFile(metadataPath, Buffer.from(JSON.stringify({ configPath, original: original ? original.identity : null }), "utf8"));
  } catch (error) { safeUnlink(stagedPath); safeUnlink(metadataPath); throw error; }
  process.stdout.write(`${stagedPath}\n`);
}
function readMetadata(configPath, stagedPath) {
  const metadata = readPrivateFile(`${stagedPath}.meta`, true, MAX_METADATA_BYTES);
  let value;
  try { value = JSON.parse(metadata.content.toString("utf8")); }
  catch { fail("transaction metadata is invalid"); }
  if (!value || value.configPath !== configPath || (value.original !== null && typeof value.original !== "object")) fail("transaction metadata does not match the config");
  return value;
}
function prepareStageForCommit(stagedPath) {
  let fd;
  try { fd = fs.openSync(stagedPath, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK); }
  catch (error) { if (error.code === "ELOOP") fail("staged config became a symlink"); throw error; }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) fail("staged config is not a regular file");
    if (stat.nlink !== 1) fail("staged config became hard-linked");
    if (stat.uid !== process.geteuid()) fail("staged config ownership changed");
    if (stat.size > MAX_CONFIG_BYTES) fail(`staged config exceeds ${MAX_CONFIG_BYTES} bytes`);
    fs.fchmodSync(fd, 0o600); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function fsyncDirectory(directory) {
  let fd;
  try { fd = fs.openSync(directory, fs.constants.O_RDONLY | DIRECTORY); fs.fsyncSync(fd); }
  catch (error) { if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(error.code)) throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function commitLockPath(configPath) { return path.join(path.dirname(configPath), `.${path.basename(configPath)}.exa-search.lock`); }
function acquireCommitLock(configPath) {
  const lockPath = commitLockPath(configPath);
  const deadline = Date.now() + COMMIT_LOCK_WAIT_MS;
  while (true) {
    try { createPrivateFile(lockPath, Buffer.from(`${process.pid}\n`, "utf8")); return lockPath; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) fail("another Exa config commit is in progress", "CONFIG_CHANGED");
      Atomics.wait(pauseBuffer, 0, 0, COMMIT_LOCK_POLL_MS);
    }
  }
}
function verify(configPath) {
  assertDirectoryChain(path.dirname(configPath), true);
  const current = readPrivateFile(configPath, true, MAX_CONFIG_BYTES);
  if ((current.mode & 0o077) !== 0) fail(`config permissions expose group/other access: ${configPath}`);
}
function commit(configPath, stagedInput) {
  assertDirectoryChain(path.dirname(configPath), true);
  const stagedPath = assertStagePath(configPath, stagedInput);
  let lockPath;
  try {
    lockPath = acquireCommitLock(configPath);
    const metadata = readMetadata(configPath, stagedPath);
    prepareStageForCommit(stagedPath);
    if (!targetMatches(configPath, metadata.original)) fail("config changed concurrently", "CONFIG_CHANGED");
    fs.renameSync(stagedPath, configPath);
    safeUnlink(`${stagedPath}.meta`);
    fsyncDirectory(path.dirname(configPath));
    verify(configPath);
  } finally { if (lockPath) safeUnlink(lockPath); }
}
function cleanup(configPath, stagedInput) {
  const stagedPath = assertStagePath(configPath, stagedInput);
  safeUnlink(stagedPath); safeUnlink(`${stagedPath}.meta`);
}
try {
  if (typeof NOFOLLOW !== "number" || typeof NONBLOCK !== "number") fail("required no-follow file flags are unavailable");
  const [command, configInput, stagedInput] = process.argv.slice(2);
  const configPath = resolvedPath(configInput, "config path");
  if (command === "resolve") process.stdout.write(`${configPath}\n`);
  else if (command === "prepare") prepare(configPath);
  else if (command === "commit") commit(configPath, stagedInput);
  else if (command === "cleanup") cleanup(configPath, stagedInput);
  else if (command === "verify") verify(configPath);
  else fail("usage: configure.mjs resolve|prepare|commit|cleanup|verify CONFIG_FILE [STAGED_FILE]");
} catch (error) {
  process.stderr.write(`[exa-search] ERROR: ${error.message}\n`);
  process.exit(error.code === "CONFIG_CHANGED" ? 75 : 1);
}
