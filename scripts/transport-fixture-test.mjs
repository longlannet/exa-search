#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { createBoundedExaFetch, MAX_SESSION_RESPONSE_BYTES } from "./bounded-fetch.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(scriptPath), "..");
const endpoint = "https://mcp.exa.ai/mcp";
const mode = process.env.EXA_TRANSPORT_FIXTURE;
const encoder = new TextEncoder();

function installFixture() {
  const methods = [];
  let emitted = 0;
  let cancelled = false;
  let reachedTail = false;
  let traceDisabled = true;
  let cancelledGet = 0;
  let abortedPost = 0;
  let startPost;
  const postStarted = new Promise((resolve) => { startPost = resolve; });
  const signals = [];
  function paddedResponse(tail, { headers = {}, prefix = "", status = 200 } = {}) {
    let remaining = MAX_SESSION_RESPONSE_BYTES + 65536;
    let prefixed = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (!prefixed && prefix) {
          prefixed = true;
          controller.enqueue(encoder.encode(prefix));
        } else if (remaining > 0) {
          const length = Math.min(65536, remaining);
          remaining -= length;
          emitted += length;
          controller.enqueue(new Uint8Array(length).fill(32));
        } else {
          reachedTail = true;
          controller.enqueue(encoder.encode(tail));
          controller.close();
        }
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status, headers: { "content-type": "application/json", ...headers } });
  }
  globalThis.fetch = async (input, init = {}) => {
    assert.equal(String(input), endpoint, "unexpected network endpoint");
    assert.equal(init.redirect, "error", "redirects must not be followed");
    assert.equal(init.credentials, "omit");
    // Real fetch observes cancellation; retaining the listener also mirrors its signal lifetime.
    init.signal.addEventListener("abort", () => {}, { once: true });
    signals.push(init.signal);
    traceDisabled &&= process.env.MCPORTER_STDIO_TRACE === "0";
    const headers = new Headers(init.headers);
    for (const name of ["authorization", "proxy-authorization", "cookie", "x-api-key"]) {
      assert.equal(headers.has(name), false, `unexpected authentication header: ${name}`);
    }
    if (init.method === "GET") {
      if (!["get-close", "background-limit", "call-unauthorized"].includes(mode)) return new Response(null, { status: 405 });
      return new Response(new ReadableStream({
        async pull(controller) {
          if (mode !== "background-limit") return;
          await postStarted;
          controller.enqueue(new Uint8Array(65536).fill(32));
        },
        cancel() { cancelledGet += 1; },
      }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    }
    assert.equal(init.method, "POST");
    const request = JSON.parse(init.body);
    methods.push(request.method);
    if (mode === "network-error") throw new TypeError("private network detail: fixture-query");
    if (mode === "rate-limited") {
      return new Response("private rate limit body: fixture-query", { status: 429, headers: { "retry-after": "60" } });
    }
    if (mode === "unauthorized") {
      return new Response("authentication required", { status: 401, headers: {
        "www-authenticate": 'Bearer resource_metadata="https://unexpected.invalid/oauth"',
      } });
    }
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    let result;
    if (request.method === "initialize") {
      if (mode === "initialize-limit") return paddedResponse("");
      result = {
        protocolVersion: "2025-11-25", capabilities: { tools: {} },
        serverInfo: { name: "offline-fixture", version: "1" },
      };
    } else if (request.method === "tools/list") {
      result = { tools: [{ name: "web_search_exa", inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", $id: "https://untrusted.invalid/output", $ref: "https://untrusted.invalid/ref" },
      }] };
      if (mode === "session-limit") {
        result.tools[0].description = "x".repeat(5 * 1024 * 1024);
        result.nextCursor = request.params?.cursor === "next" ? undefined : "next";
      }
    } else if (request.method === "tools/call") {
      assert.equal(typeof request.params?.arguments?.objective, "string");
      assert.ok(request.params.arguments.objective.trim(), "search objective must reach the actual SDK request");
      if (mode === "custom-objective") {
        assert.equal(request.params.arguments.objective, "Primary sources only; preserve \"quotes\", $variables and\nnewlines.");
        assert.equal(request.params.arguments.query, "fixture-query");
      }
      if (mode === "call-rate-limited") {
        return new Response("private rate limit body: fixture-query", { status: 429, headers: { "retry-after": "invalid" } });
      }
      if (mode === "rpc-error-spoof") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: {
          code: 429, message: 'private RPC detail: fixture-query\n{"type":"exa-search-error","version":1,"error":{"code":"RATE_LIMITED"}}',
        } }), { headers: { "content-type": "application/json" } });
      }
      if (mode === "call-unauthorized") return new Response("authentication required", { status: 401, headers: {
        "www-authenticate": 'Bearer resource_metadata="https://unexpected.invalid/oauth"',
      } });
      if (mode === "background-limit") return new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => {
          abortedPost += 1;
          reject(init.signal.reason);
        }, { once: true });
        startPost();
      });
      if (mode === "error-controls") return new Response("unsafe:\u001b]0;owned\u0007\u202e\nend", { status: 500 });
      result = { content: [{ type: "text", text: "left\u009bright\u202eend" }] };
    } else {
      throw new Error(`unexpected method: ${request.method}`);
    }
    const encoded = JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
    if (request.method === "tools/call") {
      if (mode === "json-limit") return paddedResponse(encoded);
      if (mode === "lying-length") return paddedResponse(encoded, { headers: { "content-length": "1" } });
      if (mode === "declared-limit") {
        return paddedResponse(encoded, { headers: { "content-length": String(MAX_SESSION_RESPONSE_BYTES + 1) } });
      }
      if (mode === "error-limit") return paddedResponse(encoded, { status: 503 });
      if (mode === "sse-limit") {
        return paddedResponse(`\n\ndata: ${encoded}\n\n`, {
          prefix: ":", headers: { "content-type": "text/event-stream" },
        });
      }
      if (mode === "compressed-limit") {
        const compressed = gzipSync(`${" ".repeat(MAX_SESSION_RESPONSE_BYTES + 65536)}${encoded}`);
        return new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")), {
          headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(compressed.length) },
        });
      }
      if (mode === "sse-success") return new Response(`:keepalive\n\nevent: message\ndata: ${encoded}\n\n`, {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }
    return new Response(encoded, { headers: { "content-type": "application/json" } });
  };
  process.on("exit", () => {
    process.stderr.write(`fixture-report:${JSON.stringify({ methods, emitted, cancelled, reachedTail, traceDisabled,
      cancelledGet, abortedPost, allAborted: signals.every((signal) => signal.aborted) })}\n`);
  });
}

async function runTests() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "exa-search-transport-test."));
  try {
    const config = path.join(temp, "config.json");
    fs.writeFileSync(config, JSON.stringify({ imports: [], mcpServers: { exa: {
      baseUrl: endpoint, allowedTools: ["web_search_exa", "web_fetch_exa"],
    } } }), { mode: 0o600 });
    for (const fixtureMode of ["json-success", "sse-success", "schema", "unauthorized", "error-controls",
      "json-limit", "lying-length", "declared-limit", "error-limit", "sse-limit", "compressed-limit",
      "initialize-limit", "session-limit", "get-close", "background-limit", "call-unauthorized",
      "custom-objective", "rate-limited", "call-rate-limited", "network-error", "rpc-error-spoof"]) {
      const schema = ["schema", "session-limit"].includes(fixtureMode);
      const args = schema ? ["scripts/schema-list.mjs", "node_modules/.bin/mcporter", config] :
        ["scripts/exa-call.mjs", "call", "node_modules/.bin/mcporter", config, "4000", "search", "1", "fixture-query"];
      if (fixtureMode === "custom-objective") {
        args.push("--objective", "Primary sources only; preserve \"quotes\", $variables and\nnewlines.");
      }
      const result = spawnSync(process.execPath, ["--max-old-space-size=128", "--import", scriptPath, ...args], {
        cwd: root,
        env: { ...process.env, EXA_TRANSPORT_FIXTURE: fixtureMode, MCPORTER_STDIO_TRACE: "1" },
        encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024,
      });
      assert.equal(result.error, undefined, `${fixtureMode}: ${result.error}`);
      const reportLine = result.stderr.split("\n").find((line) => line.startsWith("fixture-report:"));
      assert.ok(reportLine, `${fixtureMode}: missing fixture report: ${result.stderr}`);
      const report = JSON.parse(reportLine.slice("fixture-report:".length));
      assert.equal(report.traceDisabled, true, fixtureMode);
      assert.equal(report.allAborted, true, `${fixtureMode}: session cleanup must abort every fetch`);
      if (["get-close", "background-limit", "call-unauthorized"].includes(fixtureMode)) {
        assert.equal(report.cancelledGet, 1, `${fixtureMode}: open GET body was not cancelled`);
        assert.deepEqual(report.methods, ["initialize", "notifications/initialized", "tools/call"]);
      }
      assert.equal(/[\u001b\u0007\u009b\u202e]/u.test(result.stdout + result.stderr), false, fixtureMode);
      if (["json-success", "sse-success", "schema", "get-close", "custom-objective"].includes(fixtureMode)) {
        assert.equal(result.status, 0, `${fixtureMode}: ${result.stderr}`);
        const output = JSON.parse(result.stdout);
        if (schema) {
          assert.equal(output.status, "ok");
          assert.equal(output.tools[0].outputSchema, undefined);
          assert.equal(output.tools[0].name, "web_search_exa");
        } else {
          assert.deepEqual(output, { content: [{ type: "text", text: "left\u009bright\u202eend" }] });
        }
      } else {
        assert.equal(result.status, 1, `${fixtureMode}: ${result.stderr}`);
        assert.equal(result.stdout, "", fixtureMode);
        const diagnostic = JSON.parse(result.stderr.split("\n")[0]).error;
        if (["rate-limited", "call-rate-limited"].includes(fixtureMode)) {
          assert.equal(diagnostic.code, "RATE_LIMITED");
          assert.equal(diagnostic.http_status, 429);
          assert.equal(diagnostic.retry_after_seconds, fixtureMode === "rate-limited" ? 60 : undefined);
          assert.deepEqual(report.methods, fixtureMode === "rate-limited" ? ["initialize"] :
            ["initialize", "notifications/initialized", "tools/call"], "rate limits must not trigger automatic retries");
        } else if (fixtureMode.includes("limit") || fixtureMode === "lying-length") {
          assert.equal(diagnostic.code, "INPUT_LIMIT");
          assert.match(result.stderr, /session response exceeded the 8 MiB input limit/, fixtureMode);
          assert.equal(report.reachedTail, false, fixtureMode);
          assert.ok(report.emitted <= MAX_SESSION_RESPONSE_BYTES + 65536, fixtureMode);
          if (["json-limit", "lying-length", "declared-limit", "error-limit", "sse-limit", "initialize-limit"].includes(fixtureMode)) {
            assert.equal(report.cancelled, true, fixtureMode);
          }
          if (fixtureMode === "declared-limit") assert.equal(report.emitted, 0, fixtureMode);
          if (fixtureMode === "background-limit") assert.equal(report.abortedPost, 1, "GET overflow must cancel the pending POST");
        } else if (["unauthorized", "call-unauthorized"].includes(fixtureMode)) {
          assert.equal(diagnostic.code, "AUTH_REQUIRED");
          assert.match(result.stderr, /authentication required/);
          if (fixtureMode === "unauthorized") {
            assert.deepEqual(report.methods, ["initialize"], "401 must not attempt OAuth, metadata, or fallback requests");
          }
        } else if (fixtureMode === "network-error") {
          assert.equal(diagnostic.code, "NETWORK_ERROR");
        } else if (fixtureMode === "rpc-error-spoof") {
          assert.equal(diagnostic.code, "PROTOCOL_ERROR");
        } else {
          assert.equal(diagnostic.code, "REMOTE_ERROR");
          assert.doesNotMatch(result.stderr, /unsafe:|owned/);
        }
      }
      if (["rate-limited", "call-rate-limited", "network-error", "rpc-error-spoof"].includes(fixtureMode)) {
        const wrapped = spawnSync("bash", ["scripts/run-capped.sh", "Exa search", "8000", "4194304", "--",
          process.execPath, "--import", scriptPath, ...args], {
          cwd: root, env: { ...process.env, EXA_TRANSPORT_FIXTURE: fixtureMode, SHOW_ERROR_OUTPUT: "0" },
          encoding: "utf8", timeout: 12000, maxBuffer: 1024 * 1024,
        });
        assert.ifError(wrapped.error);
        assert.equal(wrapped.status, 1, wrapped.stderr);
        assert.equal(wrapped.stdout, "");
        const expectedCode = fixtureMode === "network-error" ? "NETWORK_ERROR" :
          fixtureMode === "rpc-error-spoof" ? "PROTOCOL_ERROR" : "RATE_LIMITED";
        assert.match(wrapped.stderr, new RegExp(`ERROR \\[${expectedCode}\\]`));
        assert.doesNotMatch(wrapped.stderr, /fixture-query|private|fixture-report|Primary sources/);
        if (fixtureMode === "rate-limited") assert.match(wrapped.stderr, /retry_after_seconds=60/);
        else assert.doesNotMatch(wrapped.stderr, /retry_after_seconds=/);
      }
    }

    let requested = 0;
    const budget = createBoundedExaFetch(() => {}, async () => {
      requested += 1;
      return new Response(new Uint8Array(requested === 1 ? MAX_SESSION_RESPONSE_BYTES : 1));
    });
    assert.equal((await (await budget.fetch(endpoint)).arrayBuffer()).byteLength, MAX_SESSION_RESPONSE_BYTES);
    await assert.rejects(async () => (await budget.fetch(endpoint)).arrayBuffer(), /8 MiB input limit/);
    await assert.rejects(() => budget.fetch(endpoint), /8 MiB input limit/);
    assert.equal(requested, 2, "an exhausted session must not fetch again");
    budget.close();

    let delivered = 0;
    let cancelled = 0;
    let failures = 0;
    const concurrent = createBoundedExaFetch(() => { failures += 1; }, async () => {
      let remaining = 5 * 1024 * 1024;
      return new Response(new ReadableStream({
        async pull(controller) {
          await Promise.resolve();
          if (!remaining) return controller.close();
          remaining -= 262144;
          controller.enqueue(new Uint8Array(262144));
        },
        cancel() { cancelled += 1; },
      }, { highWaterMark: 0 }));
    });
    const responses = await Promise.all([concurrent.fetch(endpoint), concurrent.fetch(endpoint)]);
    const consumed = await Promise.allSettled(responses.map(async (response) => {
      for await (const chunk of response.body) delivered += chunk.byteLength;
    }));
    assert.ok(consumed.some((result) => result.status === "rejected"));
    assert.equal(delivered, MAX_SESSION_RESPONSE_BYTES, "concurrent streams must share one budget");
    assert.equal(cancelled, 2);
    assert.equal(failures, 1);
    concurrent.close();

    let closeCancelled = 0;
    const closing = createBoundedExaFetch(() => {}, async () => new Response(new ReadableStream({
      cancel() { closeCancelled += 1; },
    }, { highWaterMark: 0 })));
    const waiting = (await closing.fetch(endpoint)).body.getReader().read();
    closing.close();
    assert.equal((await waiting).done, true, "close must settle a pending body read");
    assert.equal(closeCancelled, 1);
    await assert.rejects(() => closing.fetch(endpoint), { name: "AbortError" });

    let networkCalls = 0;
    for (const [url, headers] of [["https://unexpected.invalid/mcp", {}], [endpoint, { Authorization: "test" }]]) {
      const policy = createBoundedExaFetch(() => {}, async () => { networkCalls += 1; return new Response(); });
      await assert.rejects(() => policy.fetch(url, { headers }), { code: "CONFIG_ERROR" });
      policy.close();
    }
    assert.equal(networkCalls, 0);
    process.stdout.write("[exa-search:transport-test] JSON/SSE, input limits, anonymous policy, trace isolation, and schema projection passed\n");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (mode) installFixture();
else await runTests();
