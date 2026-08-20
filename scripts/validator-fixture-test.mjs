#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function fail(message) { throw new Error(message); }

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "exa-search-validator-"));
const fixture = path.join(temporary, "skill");

function runValidator() {
  return spawnSync(process.execPath, [
    path.join(fixture, "scripts", "validate-skill.mjs"),
    path.join(fixture, "SKILL.md"),
  ], { encoding: "utf8", timeout: 30_000 });
}

function resultDetail(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-2000);
}

function expectRejected(label) {
  const result = runValidator();
  if (result.error) fail(`${label}: validator could not run: ${result.error.message}`);
  if (result.status === 0) fail(`${label}: validator accepted the mutation`);
}

function mutate(relativePath, before, after, label, replaceAll = false) {
  const filePath = path.join(fixture, relativePath);
  const original = fs.readFileSync(filePath, "utf8");
  const occurrences = original.split(before).length - 1;
  if (occurrences === 0) fail(`${label}: mutation target is missing`);
  const changed = replaceAll ? original.replaceAll(before, after) : original.replace(before, after);
  fs.writeFileSync(filePath, changed);
  try { expectRejected(label); }
  finally { fs.writeFileSync(filePath, original); }
}

try {
  fs.cpSync(sourceRoot, fixture, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceRoot, source);
      const first = relative.split(path.sep, 1)[0];
      return first !== ".git" && first !== "node_modules" && relative !== path.join("config", "mcporter.json");
    },
  });
  fs.symlinkSync(path.join(sourceRoot, "node_modules"), path.join(fixture, "node_modules"), "dir");

  const baseline = runValidator();
  if (baseline.error || baseline.status !== 0) {
    fail(`baseline validator failed: ${baseline.error?.message ?? resultDetail(baseline)}`);
  }

  mutate("SKILL.md", '"os": ["linux"],',
    '"os": ["linux"], "primaryEnv": "EXA_API_KEY",', "API-key metadata");
  mutate("config/mcporter.json.example", '"baseUrl": "https://mcp.exa.ai/mcp",',
    '"baseUrl": "https://mcp.exa.ai/mcp", "headers": { "Authorization": "Bearer forbidden" },',
    "authenticated MCP config");
  mutate("scripts/verify-release-tag.sh", "C678256ACBFC6491BF5076655F3AE24999921FFC",
    "0000000000000000000000000000000000000000", "release fingerprint", true);
  mutate("scripts/install-gh-cli.sh",
    "a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "GitHub CLI archive hash");
  mutate(".github/workflows/ci.yml", "name: test (${{ matrix.node }})",
    "name: mutable test (${{ matrix.node }})", "required CI context name");
  mutate(".github/workflows/release.yml", "  verify:\n    name: Verify signed tag",
    "  verify:\n    if: github.ref == 'refs/heads/main'\n    name: Verify signed tag",
    "skipped non-default dispatch");
  mutate(".github/workflows/release.yml", 'test "$GITHUB_REF" = "refs/heads/$DEFAULT_BRANCH"',
    'test "$GITHUB_REF" != "refs/heads/$DEFAULT_BRANCH"', "explicit default-branch dispatch failure");
  mutate(".github/workflows/release.yml", ".can_admins_bypass == false",
    ".can_admins_bypass == true", "administrator environment bypass");
  mutate(".github/workflows/release.yml", ".strict_required_status_checks_policy == true",
    ".strict_required_status_checks_policy == false", "strict required checks");
  mutate(".github/workflows/release.yml", ".do_not_enforce_on_create == false",
    ".do_not_enforce_on_create == true", "required checks on branch creation");
  mutate(".github/workflows/release.yml",
    'context: "test (22.12.0)", integration_id: 15368',
    'context: "test (22.12.0)", integration_id: 1', "required GitHub Actions identity");
  mutate(".github/workflows/release.yml", 'test "$candidate_commit" = "$GITHUB_SHA"',
    'test "$candidate_commit" != "$GITHUB_SHA"', "exact release commit", true);
  mutate(".github/workflows/release.yml",
    '.commit.verification.verified == true and .commit.verification.reason == "valid"',
    '.commit.verification.verified == true', "GitHub commit signature status", true);
  mutate("scripts/find-release-id.sh",
    '((.errors | type) == "array" and ((.errors | length) == 0))',
    '((.errors | type) == "array" and ((.errors | length) >= 0))', "GraphQL release lookup errors");
  mutate("scripts/find-release-id.sh", ".data.repository.release == null",
    ".data.repository.release != null", "GraphQL absent release state");
  mutate(".github/workflows/release.yml", 'GH_TOKEN="$RELEASE_ADMIN_TOKEN"',
    'GH_TOKEN="$GH_TOKEN"', "immutable-setting recheck token");
  mutate(".github/workflows/release.yml", '.body == $body',
    '.body != $body', "release notes integrity", true);
  mutate(".github/workflows/release.yml", '.prerelease == false',
    '.prerelease == true', "release prerelease state", true);
  mutate(".github/workflows/release.yml", "draft: false",
    "draft: true", "release publication draft transition");
  mutate(".github/workflows/release.yml", 'make_latest: "true"',
    'make_latest: "false"', "release Latest transition");
  mutate(".github/workflows/release.yml", 'test "$release_id" = "$latest_id"',
    'test "$release_id" != "$latest_id"', "final Latest verification", true);
  mutate(".github/workflows/release.yml", '.immutable == false and .draft == false',
    '.immutable == false and .draft == true', "release immutability propagation polling", true);
  mutate(".github/workflows/release.yml",
    '.immutable == false and (.draft == true or .draft == false)',
    '.immutable == false and .draft == false', "post-publication stale-draft polling");
  mutate(".github/workflows/release.yml", '.author.login == "github-actions[bot]"',
    '.author.login == "attacker"', "release author identity", true);
  mutate(".github/workflows/release.yml", '"Deterministic source archive"',
    '"Untrusted source archive"', "release asset label", true);

  const workflowYml = path.join(fixture, ".github", "workflows", "release.yml");
  const workflowYaml = path.join(fixture, ".github", "workflows", "release.yaml");
  fs.renameSync(workflowYml, workflowYaml);
  try { expectRejected("alternate workflow extension"); }
  finally { fs.renameSync(workflowYaml, workflowYml); }

  process.stdout.write("validator mutation fixtures: OK\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
