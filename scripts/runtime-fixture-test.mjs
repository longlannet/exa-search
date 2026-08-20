#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { safeJson } from "./exa-call.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const callHelper = path.join(root, "scripts", "exa-call.mjs");
const schemaChecker = path.join(root, "scripts", "schema-check.mjs");
const mcporter = path.join(root, "node_modules", ".bin", "mcporter");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "exa-search-runtime-fixture."));

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}
function expectStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: ${result.stderr || result.stdout}`);
}
function schema(overrides = {}) {
  const value = {
    status: "ok",
    tools: [
      { name: "web_search_exa", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#",
        type: "object", additionalProperties: false, properties: {
        query: { type: "string", minLength: 1 }, numResults: { type: "number", minimum: 1, maximum: 10 },
      }, required: ["query"] } },
      { name: "web_fetch_exa", inputSchema: { type: "object", additionalProperties: false, properties: {
        urls: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        maxCharacters: { type: "number", minimum: 1, maximum: 100000 },
      }, required: ["urls"] } },
    ],
  };
  overrides.apply?.(value);
  return value;
}

try {
  for (const url of [
    "http://[fec0::1]/",
    "http://[::127.0.0.1]/",
    "http://[::ffff:0:127.0.0.1]/",
    "http://[64:ff9b::127.0.0.1]/",
  ]) {
    expectStatus(run(callHelper, ["validate", "unused", "unused", "1", "fetch", "1", url]), 1, url);
  }
  for (const url of ["http://8.8.8.8/", "https://[2606:4700:4700::1111]/"]) {
    expectStatus(run(callHelper, ["validate", "unused", "unused", "1", "fetch", "1", url]), 0, url);
  }

  const authenticated = path.join(temporary, "authenticated.json");
  fs.writeFileSync(authenticated, JSON.stringify({ imports: [], mcpServers: { exa: {
    baseUrl: "http://127.0.0.1:1/mcp",
    headers: { Authorization: "Bearer must-not-be-sent" },
    allowedTools: ["web_search_exa", "web_fetch_exa"],
  } } }), { mode: 0o600 });
  const rejected = run(callHelper, ["call", mcporter, authenticated, "100", "search", "1", "test"]);
  expectStatus(rejected, 1, "authenticated config");
  assert.match(rejected.stderr, /official anonymous endpoint/);
  assert.doesNotMatch(rejected.stderr, /ECONNREFUSED|connect/);

  const fixture = path.join(temporary, "schema.json");
  fs.writeFileSync(fixture, JSON.stringify(schema()));
  expectStatus(run(schemaChecker, [fixture]), 0, "compatible schema");
  for (const additionalProperties of [true, {}]) {
    fs.writeFileSync(fixture, JSON.stringify(schema({ apply(value) {
      value.tools[0].inputSchema.additionalProperties = additionalProperties;
      value.tools[0].inputSchema.minProperties = 2;
      value.tools[0].inputSchema.maxProperties = 2;
    } })));
    expectStatus(run(schemaChecker, [fixture]), 0, "compatible object constraints");
  }
  for (const apply of [
    (value) => value.tools[0].inputSchema.required.push("extra"),
    (value) => { value.tools[0].inputSchema.allOf = [{ required: ["query"] }]; },
    (value) => { value.tools[0].inputSchema.$recursiveRef = "https://example.invalid/false-schema"; },
    (value) => { value.tools[0].inputSchema.dependentRequired = { query: ["extra"] }; },
    (value) => { value.tools[0].inputSchema.patternProperties = { ".*": { const: null } }; },
    (value) => { value.tools[0].inputSchema.additionalProperties = null; },
    (value) => { value.tools[0].inputSchema.additionalProperties = []; },
    (value) => { value.tools[0].inputSchema.additionalProperties = 0; },
    (value) => { value.tools[0].inputSchema.additionalProperties = "false"; },
    (value) => { value.tools[0].inputSchema.minProperties = -1; },
    (value) => { value.tools[0].inputSchema.minProperties = 0.5; },
    (value) => { value.tools[0].inputSchema.minProperties = 3; },
    (value) => { value.tools[0].inputSchema.maxProperties = -1; },
    (value) => { value.tools[0].inputSchema.maxProperties = 2.5; },
    (value) => { value.tools[0].inputSchema.maxProperties = 1; },
    (value) => { value.tools[0].inputSchema.properties.numResults.maximum = 1; },
    (value) => { value.tools[0].inputSchema.properties.numResults.enum = [1]; },
    (value) => { value.tools[0].inputSchema.properties.query.pattern = "^fixed$"; },
    (value) => { value.tools[0].inputSchema.properties.query.minLength = 2; },
    (value) => { value.tools[0].inputSchema.properties.query.maxLength = 8191; },
    (value) => { value.tools[0].inputSchema.$schema = "https://json-schema.org/draft/2020-12/schema"; },
    (value) => { value.tools[0].inputSchema.properties.query.$ref = "https://example.invalid/false-schema"; },
    (value) => {
      value.tools[0].inputSchema.properties.numResults.if = true;
      value.tools[0].inputSchema.properties.numResults.then = false;
    },
    (value) => { value.tools[1].inputSchema.properties.urls.maxItems = 2; },
    (value) => { value.tools[1].inputSchema.properties.urls.minItems = -1; },
    (value) => { value.tools[1].inputSchema.properties.urls.minItems = 0.5; },
    (value) => { value.tools[1].inputSchema.properties.urls.maxItems = -1; },
    (value) => { value.tools[1].inputSchema.properties.urls.maxItems = 3.5; },
    (value) => { value.tools[1].inputSchema.properties.urls.uniqueItems = true; },
    (value) => { value.tools[1].inputSchema.properties.urls.$ref = "https://example.invalid/false-schema"; },
    (value) => {
      value.tools[1].inputSchema.properties.urls.items.if = true;
      value.tools[1].inputSchema.properties.urls.items.then = false;
    },
    (value) => { value.tools[1].inputSchema.properties.maxCharacters.exclusiveMinimum = 1; },
    (value) => {
      value.tools[1].inputSchema.properties.maxCharacters.$dynamicRef = "https://example.invalid/false-schema";
    },
  ]) {
    fs.writeFileSync(fixture, JSON.stringify(schema({ apply })));
    expectStatus(run(schemaChecker, [fixture]), 1, "incompatible schema");
  }

  const encoded = safeJson({ text: "left\u009bright\u202eend" });
  assert.equal(JSON.parse(encoded).text, "left\u009bright\u202eend");
  assert.match(encoded, /\\u009b/);
  assert.match(encoded, /\\u202e/);
  assert.doesNotMatch(encoded, /[\u0080-\u009f\u202a-\u202e\u2066-\u2069]/);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write("runtime fixture tests: OK\n");
