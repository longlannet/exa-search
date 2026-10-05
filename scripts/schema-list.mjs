#!/usr/bin/env node
import path from "node:path";
import { createAnonymousExaConnection, safeJson } from "./exa-call.mjs";
import { writeError } from "./errors.mjs";

const MAX_SCHEMA_PAGES = 32;
const MAX_SCHEMA_TOOLS = 64;
const MAX_SCHEMA_CURSOR_BYTES = 4096;
const MAX_SCHEMA_JSON_BYTES = 2 * 1024 * 1024;

function fail(message) { throw new Error(message); }
async function listAllTools(connection) {
  const tools = [];
  const seenCursors = new Set();
  let schemaBytes = 0;
  let cursor;
  for (let page = 0; page < MAX_SCHEMA_PAGES; page += 1) {
    const response = await connection.listTools(cursor === undefined ? undefined : { cursor });
    connection.assertHealthy();
    if (!Array.isArray(response?.tools)) fail("Exa MCP returned an invalid schema response");
    if (response.tools.length > MAX_SCHEMA_TOOLS - tools.length) {
      fail("Exa MCP schema response exposes too many tools");
    }
    for (const tool of response.tools) {
      const projected = {
        name: tool?.name,
        inputSchema: tool?.inputSchema,
      };
      let encoded;
      try { encoded = JSON.stringify(projected); }
      catch { fail("Exa MCP returned a schema that is not serializable"); }
      if (typeof encoded !== "string") fail("Exa MCP returned an invalid tool schema");
      schemaBytes += Buffer.byteLength(encoded, "utf8");
      if (schemaBytes > MAX_SCHEMA_JSON_BYTES) fail("Exa MCP schema response is too large");
      tools.push(projected);
    }
    if (response.nextCursor === undefined) return tools;
    if (typeof response.nextCursor !== "string") {
      fail("Exa MCP returned an invalid schema cursor");
    }
    if (Buffer.byteLength(response.nextCursor, "utf8") > MAX_SCHEMA_CURSOR_BYTES) {
      fail("Exa MCP returned an oversized schema cursor");
    }
    if (seenCursors.has(response.nextCursor)) fail("Exa MCP schema cursor repeated");
    seenCursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }
  fail("Exa MCP schema response exceeded the page limit");
}

let connection;
try {
  const [mcporterBinary, configInput] = process.argv.slice(2);
  if (!mcporterBinary || !configInput) fail("mcporter and config are required");
  ({ connection } = await createAnonymousExaConnection(mcporterBinary, path.resolve(configInput)));
  const tools = await listAllTools(connection);
  const output = `${safeJson({ status: "ok", tools })}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_SCHEMA_JSON_BYTES) {
    fail("Exa MCP schema output is too large");
  }
  process.stdout.write(output);
} catch (error) {
  writeError(connection?.failure ?? error, "SCHEMA_MISMATCH");
  process.exitCode = 1;
} finally {
  await connection?.close().catch(() => {});
}
