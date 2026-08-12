#!/usr/bin/env node
import path from "node:path";
import { createAnonymousExaConnection, safeJson } from "./exa-call.mjs";

function fail(message) { throw new Error(message); }
function safeErrorMessage(error) {
  return String(error?.message ?? error).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (value) =>
    `\\x${value.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

let runtime;
let connection;
try {
  const [mcporterBinary, configInput] = process.argv.slice(2);
  if (!mcporterBinary || !configInput) fail("mcporter and config are required");
  ({ runtime, connection } = await createAnonymousExaConnection(mcporterBinary, path.resolve(configInput)));
  if (typeof connection.client.listTools !== "function") fail("mcporter client does not support schema discovery");
  const response = await connection.client.listTools();
  const tools = Array.isArray(response?.tools) ? response.tools.map((tool) => ({
    name: tool?.name,
    description: tool?.description,
    inputSchema: tool?.inputSchema,
    outputSchema: tool?.outputSchema,
  })) : null;
  if (!tools) fail("Exa MCP returned an invalid schema response");
  process.stdout.write(`${safeJson({ status: "ok", tools })}\n`);
} catch (error) {
  process.stderr.write(`[exa-search] ERROR: ${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  await connection?.client?.close?.().catch(() => {});
  await connection?.transport?.close?.().catch(() => {});
  await connection?.oauthSession?.close?.().catch(() => {});
  if (runtime) await runtime.close().catch(() => {});
}
