#!/usr/bin/env node
import fs from "node:fs";
const NOFOLLOW = fs.constants.O_NOFOLLOW;
const NONBLOCK = fs.constants.O_NONBLOCK;
function fail(code) { process.exit(code); }
function parseLimit(input) {
  if (!/^\d+$/.test(input)) fail(72);
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0) fail(72);
  return value;
}
function sizeOf(filePath) {
  let fd;
  try { fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK); }
  catch { fail(72); }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid()) fail(72);
    return stat.size;
  } finally { fs.closeSync(fd); }
}
if (typeof NOFOLLOW !== "number" || typeof NONBLOCK !== "number" || typeof process.geteuid !== "function") fail(72);
const [maxInput, stdoutPath, stderrPath] = process.argv.slice(2);
const maxBytes = parseLimit(maxInput);
fail(sizeOf(stdoutPath) + sizeOf(stderrPath) <= maxBytes ? 0 : 70);
