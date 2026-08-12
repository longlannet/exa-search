#!/usr/bin/env node
import fs from "node:fs";

const NOFOLLOW = fs.constants.O_NOFOLLOW;
const NONBLOCK = fs.constants.O_NONBLOCK;

function fail() { process.exit(72); }
const [filePath, maxInput = "8192"] = process.argv.slice(2);
if (!filePath || !/^\d+$/.test(maxInput)) fail();
const maxBytes = Number(maxInput);
if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || typeof process.geteuid !== "function") fail();

let fd;
try { fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK); }
catch { fail(); }
try {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid()) fail();
  const readBytes = Math.min(stat.size, maxBytes);
  const data = Buffer.allocUnsafe(readBytes);
  let bytesRead = 0;
  while (bytesRead < readBytes) {
    const count = fs.readSync(fd, data, bytesRead, readBytes - bytesRead, stat.size - readBytes + bytesRead);
    if (count === 0) break;
    bytesRead += count;
  }
  const tail = data.subarray(0, bytesRead).toString("utf8");
  const safe = tail
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (value) =>
      `\\x${value.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, (value) =>
      `\\u${value.charCodeAt(0).toString(16).padStart(4, "0")}`);
  process.stderr.write(safe);
  if (safe && !safe.endsWith("\n")) process.stderr.write("\n");
} finally { fs.closeSync(fd); }
