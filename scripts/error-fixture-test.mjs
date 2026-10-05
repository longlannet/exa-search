#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createBoundedExaFetch, MAX_SESSION_RESPONSE_BYTES } from "./bounded-fetch.mjs";
import { ERROR_MESSAGES, ExaError, classifyError, errorDiagnostic, httpError, parseRetryAfter, renderDiagnostic } from "./errors.mjs";

const endpoint = "https://mcp.exa.ai/mcp";
const now = Date.parse("Sat, 03 Oct 2026 12:00:00 GMT");
for (const [value, expected] of [
  ["0", 0], ["005", 5], [" 10\t", 10], [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ["Sat, 03 Oct 2026 12:00:09 GMT", 9], ["Sat, 03 Oct 2026 11:59:59 GMT", 0],
]) assert.equal(parseRetryAfter(value, now), expected, value);
assert.equal(parseRetryAfter("Sat, 03 Oct 2026 12:00:09 GMT", now + 500), 9);
for (const value of [undefined, null, 10, "", " ", "-1", "+1", "1.5", "1e3", "Infinity", "NaN", "10\n",
  "10, 20", "9007199254740992", "2026-10-03T12:00:10Z", "Sat, 03 Oct 2026 12:00:10 UTC",
  "Fri, 03 Oct 2026 12:00:10 GMT", "Tue, 31 Feb 2026 12:00:10 GMT", "Sat, 03 Oct 2026 25:00:10 GMT",
  "Sat, 03 Oct 2026 12:00:60 GMT", "Saturday, 03-Oct-26 12:00:10 GMT", "9".repeat(129)]) {
  assert.equal(parseRetryAfter(value, now), undefined, String(value));
}

for (const [status, code] of [[401, "AUTH_REQUIRED"], [403, "AUTH_REQUIRED"], [429, "RATE_LIMITED"], [500, "REMOTE_ERROR"], [503, "REMOTE_ERROR"]]) {
  const error = httpError(status, "20", now);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert.equal(error.retryAfterSeconds, code === "AUTH_REQUIRED" ? undefined : 20);
  assert.equal(error.cause, undefined, "HTTP body must not be retained as an error cause");
}
assert.equal(classifyError({ code: -32001 }).code, "TIMEOUT");
assert.equal(classifyError({ code: 429, message: "retry-after: 1", data: { status: 429 } }).code, "PROTOCOL_ERROR");
assert.equal(classifyError({ code: "RATE_LIMITED" }).code, "PROCESS_ERROR");
assert.equal(classifyError({ status: 429, statusCode: 429 }).code, "PROCESS_ERROR");
assert.equal(classifyError(new Error("HTTP 429 timeout authentication required"), "REMOTE_ERROR").code, "REMOTE_ERROR");
assert.equal(classifyError(new TypeError("private URL", { cause: { code: "ENOTFOUND" } })).code, "NETWORK_ERROR");
assert.equal(classifyError(new DOMException("deadline", "TimeoutError")).code, "TIMEOUT");
assert.equal(classifyError(new DOMException("cancelled", "AbortError")).code, "INTERRUPTED");
const typed = new ExaError("INPUT_LIMIT");
assert.equal(classifyError(typed), typed);

for (const code of Object.keys(ERROR_MESSAGES)) {
  const diagnostic = errorDiagnostic(new ExaError(code, { status: 503, retryAfterSeconds: 30 }));
  assert.equal(Buffer.byteLength(JSON.stringify(diagnostic)) < 384, true, code);
  assert.match(renderDiagnostic(diagnostic), new RegExp(`ERROR \\[${code}\\]:`));
  diagnostic.error.message = "private query https://private.invalid/ \u001b\n";
  assert.doesNotMatch(renderDiagnostic(diagnostic), /private|\u001b|\n/);
}
assert.equal(renderDiagnostic({ type: "exa-search-error", version: 1, error: { code: "RATE_LIMITED", message: "ignored", extra: 1 } }), null);
assert.equal(renderDiagnostic({ type: "exa-search-error", version: 1, error: { code: "AUTH_REQUIRED", message: "ignored", retry_after_seconds: 1 } }), null);

const written = spawnSync(process.execPath, ["--input-type=module", "-"], {
  input: `import { writeError } from ${JSON.stringify(new URL("./errors.mjs", import.meta.url).href)};
    writeError(new Error("private detail\\n\\u001b\\u009b\\u202e" + "\\u754c".repeat(10000)), "INVALID_ARGUMENT");`,
  encoding: "utf8", timeout: 5000,
});
assert.equal(written.status, 0, written.stderr);
assert.equal(written.stdout, "");
const [summary, detail, trailing] = written.stderr.split("\n");
assert.equal(trailing, "");
assert.equal(JSON.parse(summary).error.code, "INVALID_ARGUMENT");
assert.doesNotMatch(summary, /private/);
assert.match(detail, /private detail\\x0a\\x1b\\x9b\\x202e/);
assert.equal(Buffer.byteLength(detail.slice("[exa-search] ERROR: ".length)) <= 512, true);
assert.equal(Buffer.byteLength(written.stderr) < 1024, true);
assert.doesNotMatch(detail, /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069\ufffd]/u);

for (const [status, code] of [[401, "AUTH_REQUIRED"], [403, "AUTH_REQUIRED"], [429, "RATE_LIMITED"], [404, "REMOTE_ERROR"], [503, "REMOTE_ERROR"]]) {
  let requests = 0;
  let stopped;
  const transport = createBoundedExaFetch((error) => { stopped = error; }, async () => {
    requests += 1;
    return new Response("private query https://private.invalid/ \u001b", { status, headers: { "retry-after": "30" } });
  });
  await assert.rejects(() => transport.fetch(endpoint, { method: "POST" }), (error) => {
    assert.equal(error, stopped);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.retryAfterSeconds, code === "AUTH_REQUIRED" ? undefined : 30);
    assert.doesNotMatch(JSON.stringify(errorDiagnostic(error)) + error.message, /private|\u001b/);
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(() => transport.fetch(endpoint), (error) => error === stopped);
  assert.equal(requests, 1, "failed requests must not be retried automatically");
  transport.close();
}
for (const method of ["GET", "DELETE"]) {
  const transport = createBoundedExaFetch(() => assert.fail("405 is supported for this method"), async () => new Response(null, { status: 405 }));
  assert.equal((await transport.fetch(endpoint, { method })).status, 405);
  transport.close();
}
for (const status of [401, 429, 503]) {
  let cancelled = false;
  let emitted = 0;
  const transport = createBoundedExaFetch(() => {}, async () => new Response(new ReadableStream({
    pull(controller) {
      emitted += 65536;
      controller.enqueue(new Uint8Array(65536));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status }));
  await assert.rejects(() => transport.fetch(endpoint, { method: "POST" }), (error) => error.code === "INPUT_LIMIT");
  assert.equal(cancelled, true);
  assert.equal(emitted, MAX_SESSION_RESPONSE_BYTES + 65536);
  transport.close();
}
const network = createBoundedExaFetch(() => {}, async () => { throw new TypeError("private URL in fetch failure"); });
await assert.rejects(() => network.fetch(endpoint), (error) => error.code === "NETWORK_ERROR" && !error.message.includes("private"));
network.close();

process.stdout.write("[exa-search:error-test] HTTP classification, retry hints, diagnostic privacy, and input-limit precedence passed\n");
