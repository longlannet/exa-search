#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

function fail(message) { throw new Error(message); }
function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
}
function safeErrorMessage(error) {
  return String(error?.message ?? error).replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (value) => "\\u" + value.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}
function requireExact(value, expected, label) {
  if (JSON.stringify(canonicalValue(value)) !== JSON.stringify(canonicalValue(expected))) {
    fail(`${label} does not match the anonymous-only contract`);
  }
}
function requireText(text, fragment, label) {
  if (!text.includes(fragment)) fail(`${label} is missing required anonymous-only guidance`);
}

try {
  const filePath = path.resolve(process.argv[2] ?? "SKILL.md");
  const skillRoot = path.dirname(filePath);
  const text = fs.readFileSync(filePath, "utf8").replaceAll("\r\n", "\n");
  if (!text.startsWith("---\n")) fail("SKILL.md must start with YAML frontmatter");
  const closing = text.indexOf("\n---\n", 4);
  if (closing < 0) fail("SKILL.md frontmatter is not closed");
  if (!text.slice(closing + 5).trim()) fail("SKILL.md body must not be empty");
  const document = parseDocument(text.slice(4, closing), { uniqueKeys: true });
  if (document.errors.length > 0) fail(document.errors[0].message);
  const value = document.toJS({ maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("frontmatter must be an object");
  requireExact(Object.keys(value).sort(), ["description", "metadata", "name"], "frontmatter keys");
  if (value.name !== "exa-search") fail("frontmatter name must be exa-search");
  requireString(value.description, "frontmatter description");
  if (value.description !== "Use Exa's anonymous hosted MCP endpoint for semantic web search, related-source discovery, and public-page extraction during research, technical documentation, and GitHub work.") {
    fail("frontmatter description must identify the anonymous hosted MCP contract");
  }
  const openclaw = value.metadata?.openclaw;
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) fail("OpenClaw metadata is required");
  requireExact(value.metadata, { openclaw: {
    emoji: "🔎",
    os: ["linux"],
    requires: { bins: ["bash", "node", "npm", "timeout", "readlink", "mktemp", "wc"] },
  } }, "OpenClaw metadata");

  const body = text.slice(closing + 5);
  for (const fragment of [
    "OpenClaw's `Ready` state checks these host prerequisites only",
    "intentionally declares no OpenClaw installer hint",
    "This skill has no API-key mode",
    "OAuth attempts and token-cache reuse disabled",
    "separate scheduled or manually dispatched live canary",
  ]) requireText(body, fragment, "SKILL.md");

  const readme = fs.readFileSync(path.join(skillRoot, "README.md"), "utf8").replaceAll("\r\n", "\n");
  for (const fragment of [
    "当前和未来都不支持 API Key、认证请求头、自定义端点或 stdio 传输",
    "OpenClaw 显示 `Ready` 只表示这些主机前置条件存在",
    "本 Skill 不声明会产生错误可用性暗示的 OpenClaw installer",
    "OAuth token cache 和 Authorization",
    "远端服务或配额波动只影响 canary，不会成为 pull request 门禁",
  ]) requireText(readme, fragment, "README.md");

  const config = JSON.parse(fs.readFileSync(path.join(skillRoot, "config", "mcporter.json.example"), "utf8"));
  requireExact(config, { imports: [], mcpServers: { exa: {
    baseUrl: "https://mcp.exa.ai/mcp",
    allowedTools: ["web_search_exa", "web_fetch_exa"],
  } } }, "example MCP config");

  const packageJson = JSON.parse(fs.readFileSync(path.join(skillRoot, "package.json"), "utf8"));
  requireExact({
    name: packageJson.name,
    private: packageJson.private,
    engines: packageJson.engines,
    dependencies: packageJson.dependencies,
    devDependencies: packageJson.devDependencies,
  }, {
    name: "exa-search-ci",
    private: true,
    engines: { node: "22 || 24" },
    dependencies: { mcporter: "0.9.0" },
    devDependencies: { yaml: "2.9.0" },
  }, "package.json dependency policy");

  const workflowText = fs.readFileSync(path.join(skillRoot, ".github", "workflows", "ci.yml"), "utf8");
  const workflow = parseDocument(workflowText, { uniqueKeys: true });
  if (workflow.errors.length > 0) fail(`CI workflow is invalid YAML: ${workflow.errors[0].message}`);
  const workflowValue = workflow.toJS({ maxAliasCount: 0 });
  const events = workflowValue?.on;
  if (!events || typeof events !== "object" || Array.isArray(events) ||
      !("push" in events) || !("pull_request" in events) || !("schedule" in events) || !("workflow_dispatch" in events)) {
    fail("CI workflow must separate push/pull-request regression from scheduled/manual live canaries");
  }
  const testJob = workflowValue.jobs?.test;
  const canaryJob = workflowValue.jobs?.["live-exa-canary"];
  if (testJob?.if !== "github.event_name == 'push' || github.event_name == 'pull_request'" ||
      canaryJob?.if !== "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'") {
    fail("CI job event isolation does not match the offline-regression/live-canary contract");
  }
  const canaryCommands = (canaryJob.steps ?? []).map((step) => step?.run).filter(Boolean).join("\n");
  for (const command of [
    "bash scripts/check.sh",
    "bash scripts/call.sh search 1",
    "bash scripts/call.sh fetch 1000",
  ]) requireText(canaryCommands, command, "live Exa canary");
} catch (error) {
  process.stderr.write(`[exa-search] ERROR: ${safeErrorMessage(error)}\n`);
  process.exit(1);
}
