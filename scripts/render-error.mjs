#!/usr/bin/env node
import fs from "node:fs";
import { TextDecoder } from "node:util";
import { renderDiagnostic } from "./errors.mjs";

const MAX_PREFIX_BYTES = 2048;
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const NONBLOCK = fs.constants.O_NONBLOCK;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function renderCapture() {
  if (process.argv.length !== 3 || typeof NOFOLLOW !== "number" || typeof NONBLOCK !== "number" ||
      typeof process.geteuid !== "function") return false;
  let fd;
  try {
    fd = fs.openSync(process.argv[2], fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.geteuid() ||
        (before.mode & 0o077) !== 0 || !Number.isSafeInteger(before.size) || before.size < 1) return false;
    const buffer = Buffer.alloc(Math.min(before.size, MAX_PREFIX_BYTES));
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(fd);
    if (["size", "mtimeMs", "ctimeMs"].some((key) => before[key] !== after[key])) return false;
    const newline = buffer.subarray(0, length).indexOf(0x0a);
    if (newline < 0) return false;
    const line = utf8.decode(buffer.subarray(0, newline));
    const record = JSON.parse(line);
    if (JSON.stringify(record) !== line) return false;
    const summary = renderDiagnostic(record);
    if (typeof summary !== "string" || summary.length === 0) return false;
    process.stderr.write(`${summary}\n`);
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* Keep invalid capture failures silent. */ }
    }
  }
}

process.exitCode = renderCapture() ? 0 : 1;
