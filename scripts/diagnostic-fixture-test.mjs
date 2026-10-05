#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ERROR_MESSAGES } from "./errors.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderer = path.join(root, "scripts", "render-error.mjs");
const runner = path.join(root, "scripts", "run-capped.sh");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "exa-search-diagnostic-fixture."));
const secret = "private-query private-objective https://private.example/path?secret=do-not-print remote-secret-body";
const record = {
  type: "exa-search-error", version: 1,
  error: { code: "RATE_LIMITED", message: ERROR_MESSAGES.RATE_LIMITED, http_status: 429, retry_after_seconds: 30 },
};
const line = `${JSON.stringify(record)}\n`;
const child = `
  const fs = require("node:fs");
  const spec = JSON.parse(process.argv[1]);
  if (spec.stderr) fs.writeSync(2, spec.stderr);
  if (spec.stdout) fs.writeSync(1, spec.stdout);
  if (spec.extraStderrBytes) fs.writeFileSync(2, Buffer.alloc(spec.extraStderrBytes, 120));
  if (spec.extraStdoutBytes) fs.writeFileSync(1, Buffer.alloc(spec.extraStdoutBytes, 120));
  if (spec.signal) process.kill(process.pid, spec.signal);
  else if (spec.hang) setInterval(() => {}, 1000);
  else process.exit(spec.status ?? 1);
`;
function runCapture(spec, { limit = 8192, timeout = 3000, diagnostic = false } = {}) {
  return spawnSync("bash", [runner, "fixture call", String(timeout), String(limit), "--", process.execPath, "-e", child, JSON.stringify(spec)], {
    encoding: "utf8", timeout: timeout + 5000, maxBuffer: 65536,
    env: { ...process.env, NODE_BIN: process.execPath, SHOW_ERROR_OUTPUT: diagnostic ? "1" : "0" },
  });
}
function renderFile(file, execArgs = []) {
  return spawnSync(process.execPath, [...execArgs, renderer, file], { encoding: "utf8", timeout: 3000, maxBuffer: 65536 });
}
function status(result, expected, label) {
  assert.equal(result.status, expected, `${label}: ${result.error?.message ?? result.stderr ?? result.signal}`);
}
function assertPrivateFailure(result, label) {
  status(result, 1, label);
  assert.equal(result.stdout, "", `${label}: failed call leaked stdout`);
  for (const value of ["private-query", "private-objective", "private.example", "remote-secret-body"]) {
    assert.ok(!result.stderr.includes(value), `${label}: default error leaked ${value}`);
  }
}

try {
  const capture = path.join(temporary, "stderr");
  fs.writeFileSync(capture, line, { mode: 0o600 });
  const valid = renderFile(capture);
  status(valid, 0, "valid first-line diagnostic");
  assert.equal(valid.stdout, "");
  assert.match(valid.stderr, /\[RATE_LIMITED\]/);
  assert.match(valid.stderr, /retry_after_seconds=30/);

  const hostileMessage = structuredClone(record);
  hostileMessage.error.message = `${secret}\n${JSON.stringify(record)}\u001b]0;unsafe\u0007`;
  const hostileLine = `${JSON.stringify(hostileMessage)}\n`;
  fs.writeFileSync(capture, hostileLine);
  const renderedHostile = renderFile(capture);
  status(renderedHostile, 0, "message is never rendered");
  assert.equal(renderedHostile.stderr, valid.stderr);

  const invalid = [
    ["missing LF", line.trimEnd()],
    ["earlier log line", `SDK log\n${line}`],
    ["whitespace before JSON", ` ${line}`],
    ["trailing whitespace", `${line.trimEnd()} \n`],
    ["duplicate keys", line.replace('"version":1', '"version":1,"version":1')],
    ["line beyond read budget", `${" ".repeat(2048)}${line}`],
    ["canonical line beyond read budget", `${JSON.stringify({ ...record, error: { ...record.error, message: "x".repeat(2100) } })}\n`],
    ["UTF-8 BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(line)])],
    ["invalid UTF-8", Buffer.concat([Buffer.from([0xff]), Buffer.from(line)])],
    ["wrong namespace", `${JSON.stringify({ ...record, type: "remote-error" })}\n`],
    ["wrong version", `${JSON.stringify({ ...record, version: 2 })}\n`],
    ["extra top-level key", `${JSON.stringify({ ...record, detail: secret })}\n`],
    ["extra error key", `${JSON.stringify({ ...record, error: { ...record.error, detail: secret } })}\n`],
    ["unknown code", `${JSON.stringify({ ...record, error: { ...record.error, code: secret } })}\n`],
    ["non-string message", `${JSON.stringify({ ...record, error: { ...record.error, message: {} } })}\n`],
    ["string retry", `${JSON.stringify({ ...record, error: { ...record.error, retry_after_seconds: "30" } })}\n`],
    ["negative retry", `${JSON.stringify({ ...record, error: { ...record.error, retry_after_seconds: -1 } })}\n`],
    ["fractional retry", `${JSON.stringify({ ...record, error: { ...record.error, retry_after_seconds: 0.5 } })}\n`],
    ["unsafe retry", `${JSON.stringify({ ...record, error: { ...record.error, retry_after_seconds: Number.MAX_SAFE_INTEGER + 1 } })}\n`],
    ["invalid status", `${JSON.stringify({ ...record, error: { ...record.error, http_status: 999 } })}\n`],
    ["retry on unrelated code", `${JSON.stringify({ ...record, error: { ...record.error, code: "CONFIG_ERROR" } })}\n`],
  ];
  for (const [label, content] of invalid) {
    fs.writeFileSync(capture, content);
    const result = renderFile(capture);
    status(result, 1, label);
    assert.equal(result.stdout + result.stderr, "", `${label}: invalid record was echoed`);
  }

  fs.writeFileSync(capture, line);
  const symlink = path.join(temporary, "symlink");
  const hardlink = path.join(temporary, "hardlink");
  const fifo = path.join(temporary, "fifo");
  fs.symlinkSync(capture, symlink);
  fs.linkSync(capture, hardlink);
  status(spawnSync("mkfifo", [fifo], { encoding: "utf8" }), 0, "create FIFO fixture");
  for (const unsafe of [symlink, hardlink, fifo, temporary, path.join(temporary, "missing")]) {
    const result = renderFile(unsafe);
    status(result, 1, "unsafe capture rejected");
    assert.equal(result.stdout + result.stderr, "");
  }
  fs.unlinkSync(hardlink);
  fs.chmodSync(capture, 0o644);
  status(renderFile(capture), 1, "public capture rejected");
  fs.chmodSync(capture, 0o600);

  const sparse = path.join(temporary, "large-stderr");
  const sparseFd = fs.openSync(sparse, "wx", 0o600);
  try {
    fs.writeSync(sparseFd, line);
    fs.ftruncateSync(sparseFd, 128 * 1024 * 1024);
  } finally { fs.closeSync(sparseFd); }
  const boundedReadHook = `
    import fs from "node:fs";
    const target = ${JSON.stringify(sparse)};
    const open = fs.openSync.bind(fs), read = fs.readSync.bind(fs), readFile = fs.readFileSync.bind(fs);
    const tracked = new Set();
    let total = 0;
    fs.openSync = function(file, ...args) {
      const fd = open(file, ...args);
      if (file === target) tracked.add(fd);
      return fd;
    };
    fs.readSync = function(fd, buffer, offset, length, position) {
      if (tracked.has(fd) && total + length > 2048) throw new Error("capture read exceeded its prefix budget");
      const count = read(fd, buffer, offset, length, position);
      if (tracked.has(fd)) total += count;
      return count;
    };
    fs.readFileSync = function(file, ...args) {
      if (file === target || tracked.has(file)) throw new Error("capture was read without a byte bound");
      return readFile(file, ...args);
    };
    process.on("exit", () => { if (total < 1 || total > 2048) process.exitCode = 1; });
  `;
  const bounded = renderFile(sparse, ["--import", `data:text/javascript,${encodeURIComponent(boundedReadHook)}`]);
  status(bounded, 0, "large capture only needs a bounded prefix");
  assert.equal(bounded.stderr, valid.stderr);

  const classified = runCapture({ stderr: `${hostileLine}${secret}\n`, stdout: secret });
  assertPrivateFailure(classified, "classified failure");
  assert.equal(classified.stderr, valid.stderr);

  const minimum = runCapture({ stderr: line }, { limit: 2048 });
  assertPrivateFailure(minimum, "minimum output limit");
  assert.match(minimum.stderr, /\[RATE_LIMITED\]/);

  for (const stderr of [`remote text: ${secret}\n${line}`, line.trimEnd(), line.replace('"version":1', '"version":1,"version":1')]) {
    const result = runCapture({ stderr, stdout: secret });
    assertPrivateFailure(result, "unrecognized child stderr");
    assert.doesNotMatch(result.stderr, /\[RATE_LIMITED\]|retry_after_seconds/);
  }

  const success = runCapture({ stderr: `${line}${secret}\n`, stdout: '{"ok":true}\n', status: 0 });
  status(success, 0, "success ignores captured diagnostic text");
  assert.equal(success.stdout, '{"ok":true}\n');
  assert.equal(success.stderr, "");

  for (const field of ["extraStderrBytes", "extraStdoutBytes"]) {
    const result = runCapture({ stderr: line, [field]: 8192 }, { limit: 2048 });
    assertPrivateFailure(result, "output cap overrides diagnostic");
    assert.match(result.stderr, /MAX_OUTPUT_BYTES|truncated|OUTPUT_LIMIT/);
    assert.doesNotMatch(result.stderr, /\[RATE_LIMITED\]|retry_after_seconds/);
  }
  const timedOut = runCapture({ stderr: line, hang: true }, { timeout: 300 });
  assertPrivateFailure(timedOut, "deadline overrides diagnostic");
  assert.match(timedOut.stderr, /timed out|deadline|TIMEOUT/);
  assert.doesNotMatch(timedOut.stderr, /\[RATE_LIMITED\]|retry_after_seconds/);

  for (const childStatus of [2, 124]) {
    const result = runCapture({ stderr: line, status: childStatus });
    assertPrivateFailure(result, `status ${childStatus} is not reclassified`);
    assert.doesNotMatch(result.stderr, /\[RATE_LIMITED\]|retry_after_seconds/);
  }
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    const result = runCapture({ stderr: line, signal });
    assertPrivateFailure(result, `${signal} overrides diagnostic`);
    assert.doesNotMatch(result.stderr, /\[RATE_LIMITED\]|retry_after_seconds/);
  }

  const verbose = runCapture({ stderr: `${line}${secret}\u001b]0;unsafe\u0007\u202e\n` }, { diagnostic: true });
  status(verbose, 1, "explicit diagnostics");
  assert.equal(verbose.stdout, "");
  assert.match(verbose.stderr, /captured stderr tail/);
  assert.match(verbose.stderr, /remote-secret-body/);
  assert.match(verbose.stderr, /\\x1b.*\\x07/);
  assert.match(verbose.stderr, /\\u202e/);
  assert.doesNotMatch(verbose.stderr, /[\u001b\u0007\u202e]/);
  assert.match(verbose.stderr, /\[RATE_LIMITED\]/);
  process.stdout.write("[exa-search] diagnostic fixtures passed\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
