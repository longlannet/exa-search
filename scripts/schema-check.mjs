#!/usr/bin/env node
import fs from "node:fs";

function fail(message) { throw new Error(message); }
const ANNOTATION_KEYWORDS = Object.freeze([
  "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly",
]);
const SUPPORTED_SCHEMA_DIALECT = "http://json-schema.org/draft-07/schema#";
function requireOnlyKeywords(schema, name, keywords) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) fail(`${name} must be a schema object`);
  const allowed = new Set([...ANNOTATION_KEYWORDS, ...keywords]);
  for (const keyword of Object.keys(schema)) {
    if (!allowed.has(keyword)) fail(`${name} uses unsupported schema keyword: ${keyword}`);
  }
}
function schemaFor(tools, name) {
  const schema = tools.get(name)?.inputSchema;
  if (!schema || schema.type !== "object" || !schema.properties || Array.isArray(schema.properties)) {
    fail(`${name} has no object inputSchema`);
  }
  return schema;
}
function requireExactRequired(schema, expected) {
  if (!Array.isArray(schema.required) || schema.required.length !== expected.length ||
      !expected.every((property) => schema.required.includes(property))) {
    fail(`required properties must be exactly: ${expected.join(", ")}`);
  }
}
function rejectConstraints(property, name, constraints) {
  for (const constraint of constraints) {
    if (Object.prototype.hasOwnProperty.call(property, constraint)) {
      fail(`${name} uses unsupported narrowing constraint: ${constraint}`);
    }
  }
}
function requireCompatibleObject(schema, name, propertyCount) {
  requireOnlyKeywords(schema, name, [
    "$schema", "type", "properties", "required", "additionalProperties", "minProperties", "maxProperties",
  ]);
  if (schema.$schema !== undefined && schema.$schema !== SUPPORTED_SCHEMA_DIALECT) {
    fail(`${name} uses an unsupported JSON Schema dialect`);
  }
  if (schema.minProperties !== undefined &&
      (!Number.isSafeInteger(schema.minProperties) || schema.minProperties > propertyCount)) {
    fail(`${name} minProperties is incompatible with the wrapper`);
  }
  if (schema.maxProperties !== undefined &&
      (!Number.isSafeInteger(schema.maxProperties) || schema.maxProperties < propertyCount)) {
    fail(`${name} maxProperties is incompatible with the wrapper`);
  }
}
function requireCompatibleString(property, name, minimumLength, maximumLength) {
  if (property?.type !== "string") fail(`${name} must be a string`);
  requireOnlyKeywords(property, name, ["type", "minLength", "maxLength"]);
  if (property.minLength !== undefined &&
      (!Number.isSafeInteger(property.minLength) || property.minLength < 0 || property.minLength > minimumLength)) {
    fail(`${name} minLength is incompatible with the wrapper`);
  }
  if (property.maxLength !== undefined &&
      (!Number.isSafeInteger(property.maxLength) || property.maxLength < maximumLength)) {
    fail(`${name} maxLength is incompatible with the wrapper`);
  }
}
function requireCompatibleRange(property, name, minimum, maximum) {
  if (property?.type !== "number") fail(`${name} must be a number`);
  requireOnlyKeywords(property, name, [
    "type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
  ]);
  if (property.minimum !== undefined && (!Number.isFinite(property.minimum) || property.minimum > minimum)) {
    fail(`${name} minimum is incompatible with the wrapper`);
  }
  if (property.maximum !== undefined && (!Number.isFinite(property.maximum) || property.maximum < maximum)) {
    fail(`${name} maximum is incompatible with the wrapper`);
  }
  if (property.exclusiveMinimum !== undefined &&
      (!Number.isFinite(property.exclusiveMinimum) || property.exclusiveMinimum >= minimum)) {
    fail(`${name} exclusiveMinimum is incompatible with the wrapper`);
  }
  if (property.exclusiveMaximum !== undefined &&
      (!Number.isFinite(property.exclusiveMaximum) || property.exclusiveMaximum <= maximum)) {
    fail(`${name} exclusiveMaximum is incompatible with the wrapper`);
  }
}

try {
  const [filePath] = process.argv.slice(2);
  if (!filePath) fail("schema output path is required");
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || value.status !== "ok") {
    fail("schema response status is not ok");
  }
  const entries = Array.isArray(value.tools) ? value.tools : [];
  const names = entries.map((tool) => tool?.name);
  if (names.length !== 2 || new Set(names).size !== 2 ||
      !["web_search_exa", "web_fetch_exa"].every((name) => names.includes(name))) {
    fail("schema response must expose exactly the supported search and fetch tools");
  }
  const tools = new Map(entries
    .filter((tool) => tool && typeof tool === "object" && typeof tool.name === "string")
    .map((tool) => [tool.name, tool]));
  const search = schemaFor(tools, "web_search_exa");
  requireCompatibleObject(search, "web_search_exa input", 2);
  requireExactRequired(search, ["query"]);
  requireCompatibleString(search.properties.query, "query", 1, 8192);
  requireCompatibleRange(search.properties.numResults, "numResults", 1, 10);
  const fetch = schemaFor(tools, "web_fetch_exa");
  requireCompatibleObject(fetch, "web_fetch_exa input", 2);
  requireExactRequired(fetch, ["urls"]);
  if (fetch.properties.urls?.type !== "array" || fetch.properties.urls?.items?.type !== "string") {
    fail("urls must be an array of strings");
  }
  const urls = fetch.properties.urls;
  requireOnlyKeywords(urls, "urls", ["type", "items", "minItems", "maxItems"]);
  requireOnlyKeywords(urls.items, "urls items", ["type"]);
  if (urls.minItems !== undefined && (!Number.isFinite(urls.minItems) || urls.minItems > 1)) {
    fail("urls minItems is incompatible with the wrapper");
  }
  if (urls.maxItems !== undefined && (!Number.isFinite(urls.maxItems) || urls.maxItems < 3)) {
    fail("urls maxItems is incompatible with the wrapper");
  }
  requireCompatibleRange(fetch.properties.maxCharacters, "maxCharacters", 1, 100000);
} catch (error) {
  const message = String(error?.message ?? error).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (value) =>
    `\\x${value.charCodeAt(0).toString(16).padStart(2, "0")}`);
  process.stderr.write(`[exa-search] ERROR: ${message}\n`);
  process.exit(1);
}
