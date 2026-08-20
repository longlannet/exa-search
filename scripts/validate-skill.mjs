#!/usr/bin/env node
import { createHash } from "node:crypto";
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
    fail(`${label} does not match the repository contract`);
  }
}
function requireText(text, fragment, label) {
  if (!text.includes(fragment)) fail(`${label} is missing required content`);
}
function requireOccurrences(text, fragment, expected, label) {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(fragment, offset)) !== -1) {
    count += 1;
    offset += fragment.length;
  }
  if (count !== expected) fail(`${label} must contain ${JSON.stringify(fragment)} exactly ${expected} times`);
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
    "OpenClaw 显示 `Ready` 只表示这些主机命令存在",
    "本 Skill 不声明会产生错误可用性暗示的 OpenClaw installer",
    "OAuth token cache 和 Authorization",
    "远端服务或配额波动只影响 canary，不会成为 pull request 门禁",
    "`v0.4.1` 是一个已发布但未签名的历史 tag",
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
    engines: { node: ">=22.12.0 <23 || >=24.0.0 <25" },
    dependencies: { mcporter: "0.9.0" },
    devDependencies: { yaml: "2.9.0" },
  }, "package.json dependency policy");
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(packageJson.version)) {
    fail("package.json version must be a stable semantic version");
  }
  const packageLock = JSON.parse(fs.readFileSync(path.join(skillRoot, "package-lock.json"), "utf8"));
  requireExact({
    name: packageLock.name,
    version: packageLock.version,
    root: packageLock.packages?.[""],
  }, {
    name: packageJson.name,
    version: packageJson.version,
    root: {
      name: packageJson.name,
      version: packageJson.version,
      dependencies: packageJson.dependencies,
      devDependencies: packageJson.devDependencies,
      engines: packageJson.engines,
    },
  }, "package-lock.json root package policy");

  const workflowText = fs.readFileSync(path.join(skillRoot, ".github", "workflows", "ci.yml"), "utf8");
  requireExact(fs.readdirSync(path.join(skillRoot, ".github", "workflows")).sort(),
    ["ci.yml", "release.yml"], "GitHub workflow file allowlist");
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
  requireExact(testJob.strategy?.matrix?.node, ["22.12.0", 22, 24], "CI Node compatibility matrix");
  if (testJob?.name !== "test (${{ matrix.node }})") {
    fail("CI matrix job name must keep required status-check contexts stable");
  }
  const canaryCommands = (canaryJob.steps ?? []).map((step) => step?.run).filter(Boolean).join("\n");
  const testCommands = (testJob.steps ?? []).map((step) => step?.run).filter(Boolean).join("\n");
  requireText(testCommands, "node scripts/validator-fixture-test.mjs", "CI validator regressions");
  requireText(testCommands, "node scripts/release-lookup-fixture-test.mjs", "CI release lookup regressions");
  for (const command of [
    "bash scripts/check.sh",
    "bash scripts/call.sh search 1",
    "bash scripts/call.sh fetch 1000",
  ]) requireText(canaryCommands, command, "live Exa canary");

  const releaseWorkflowText = fs.readFileSync(
    path.join(skillRoot, ".github", "workflows", "release.yml"), "utf8",
  );
  const releaseWorkflow = parseDocument(releaseWorkflowText, { uniqueKeys: true });
  if (releaseWorkflow.errors.length > 0) {
    fail(`release workflow is invalid YAML: ${releaseWorkflow.errors[0].message}`);
  }
  const releaseValue = releaseWorkflow.toJS({ maxAliasCount: 0 });
  requireExact(Object.keys(releaseValue.on ?? {}), ["workflow_dispatch"], "release workflow triggers");
  const tagInput = releaseValue.on?.workflow_dispatch?.inputs?.tag;
  if (tagInput?.required !== true || tagInput?.type !== "string") {
    fail("release workflow must require an existing tag input");
  }
  requireExact(releaseValue.permissions, { actions: "read", contents: "read" },
    "release workflow default permissions");
  const verifyJob = releaseValue.jobs?.verify;
  const publishJob = releaseValue.jobs?.publish;
  if (verifyJob?.if !== undefined || publishJob?.if !== undefined ||
      publishJob?.needs !== "verify" || publishJob?.environment !== "release") {
    fail("release jobs must use the protected default-branch publication sequence");
  }
  const dispatchStep = verifyJob?.steps?.[0];
  requireExact(dispatchStep?.env, {
    DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
    RELEASE_TAG: "${{ inputs.tag }}",
  }, "release dispatch validation environment");
  if (dispatchStep?.name !== "Validate dispatch context" || dispatchStep?.shell !== "bash" ||
      dispatchStep?.["continue-on-error"] !== undefined ||
      !dispatchStep?.run?.includes('test "$GITHUB_REF" = "refs/heads/$DEFAULT_BRANCH"')) {
    fail("release verification must explicitly reject a non-default-branch dispatch");
  }
  requireExact(publishJob.permissions, { actions: "read", attestations: "read", contents: "write" },
    "release publication permissions");
  const checkoutAction = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
  const setupNodeAction = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020";
  const expectedReleaseActions = [{
    uses: checkoutAction,
    with: { "fetch-depth": 1, path: "gate", "persist-credentials": false, ref: "${{ github.sha }}" },
  }, {
    uses: checkoutAction,
    with: {
      "fetch-depth": 1,
      path: "candidate",
      "persist-credentials": false,
      ref: "refs/tags/${{ inputs.tag }}",
    },
  }, {
    uses: setupNodeAction,
    with: { "node-version": 24 },
  }];
  for (const [name, job] of [["verification", verifyJob], ["publication", publishJob]]) {
    const actions = (job.steps ?? []).filter((step) => step?.uses)
      .map((step) => ({ uses: step.uses, with: step.with }));
    requireExact(actions, expectedReleaseActions, `release ${name} action sequence`);
  }
  const releaseSteps = [...(verifyJob.steps ?? []), ...(publishJob.steps ?? [])];
  for (const step of releaseSteps) {
    if (step?.uses && !/^actions\/(checkout|setup-node)@[0-9a-f]{40}$/.test(step.uses)) {
      fail(`release workflow action is not pinned to a full commit: ${step.uses}`);
    }
  }
  const releaseCommands = releaseSteps.map((step) => step?.run).filter(Boolean).join("\n");
  const immutableStep = (publishJob.steps ?? [])
    .find((step) => step?.run?.includes("immutable-releases"));
  const publicationStep = (publishJob.steps ?? [])
    .find((step) => step?.run?.includes("gh release create"));
  if (immutableStep?.env?.GH_TOKEN !== "${{ secrets.RELEASE_ADMIN_TOKEN }}" ||
      immutableStep?.env?.MAIN_RULESET_ID !== "${{ vars.RELEASE_MAIN_RULESET_ID }}" ||
      immutableStep?.env?.TAG_RULESET_ID !== "${{ vars.RELEASE_TAG_RULESET_ID }}" ||
      publicationStep?.env?.GH_TOKEN !== "${{ github.token }}") {
    fail("release workflow does not separate the admin-read preflight token from publication credentials");
  }
  const verifierInvocations = releaseCommands.match(/gate\/scripts\/verify-release-tag\.sh/g) ?? [];
  if (verifierInvocations.length !== 2) {
    fail("release workflow must verify the candidate through the trusted gate in both jobs");
  }
  for (const fragment of [
    "gate/scripts/verify-release-tag.sh",
    "RELEASE_REPOSITORY=",
    "git -C \"$candidate\" ls-remote --exit-code --refs origin",
    'test "$candidate_commit" = "$GITHUB_SHA"',
    'main_ref="refs/heads/$DEFAULT_BRANCH"',
    'test "$remote_main_oid" = "$GITHUB_SHA"',
    "actions/workflows/ci.yml/runs",
    '.verification.verified == true and .verification.reason == "valid"',
    '.commit.verification.verified == true and .commit.verification.reason == "valid"',
    "secrets.RELEASE_ADMIN_TOKEN",
    "vars.RELEASE_MAIN_RULESET_ID",
    "vars.RELEASE_TAG_RULESET_ID",
    "bypass_actors",
    "can_admins_bypass == false",
    "deployment_branch_policy.protected_branches",
    "strict_required_status_checks_policy == true",
    "do_not_enforce_on_create == false",
    'context: "test (22.12.0)", integration_id: 15368',
    'context: "test (22)", integration_id: 15368',
    'context: "test (24)", integration_id: 15368',
    "immutable-releases",
    "gate/scripts/find-release-id.sh",
    'releases/$RELEASE_ID',
    'GH_TOKEN="$RELEASE_ADMIN_TOKEN"',
    '.author.login == "github-actions[bot]"',
    ".author.id == 41898282",
    "gzip -n -9",
    "gh release create",
    "gh release upload",
    'gh api --method PATCH "repos/$GITHUB_REPOSITORY/releases/$RELEASE_ID"',
    "draft: false",
    'make_latest: "true"',
    "published release did not become immutable",
    "verify_immutable_release",
    "--draft",
    "--notes-file",
    "--verify-tag",
    "gh release verify ",
    "gh release verify-asset ",
  ]) requireText(`${releaseWorkflowText}\n${releaseCommands}`, fragment, "release workflow");
  for (const forbidden of [
    "git tag ", "git push ", "--force", "--clobber", "--fail-on-no-commits",
    "--notes-from-tag", "gh release delete", "gh release edit",
  ]) {
    if (releaseCommands.includes(forbidden)) fail(`release workflow contains forbidden command: ${forbidden}`);
  }
  for (const [fragment, count] of [
    ['.body == $body', 3],
    ['.prerelease == false', 3],
    ['.author.login == "github-actions[bot]"', 3],
    ['.author.id == 41898282', 3],
    ['"Deterministic source archive"', 3],
    ['"SHA-256 checksums"', 3],
    ['.assets[] | { name, label, digest }', 2],
    ['gate/scripts/find-release-id.sh', 2],
    ['releases/$RELEASE_ID', 3],
    ['.immutable == false and .draft == false', 2],
    ['.immutable == false and (.draft == true or .draft == false)', 1],
    ['published release did not become immutable', 2],
    ["draft: false", 1],
    ["prerelease: false", 1],
    ['make_latest: "true"', 1],
    ['verify_immutable_release', 3],
    ['repos/$GITHUB_REPOSITORY/releases/latest', 2],
    ['test "$release_id" = "$latest_id"', 2],
    ['GH_TOKEN="$RELEASE_ADMIN_TOKEN"', 1],
    ['.verification.verified == true and .verification.reason == "valid"', 2],
    ['.commit.verification.verified == true and .commit.verification.reason == "valid"', 2],
  ]) requireOccurrences(releaseCommands, fragment, count, "release workflow");

  const callScript = fs.readFileSync(path.join(skillRoot, "scripts", "call.sh"), "utf8");
  const checkScript = fs.readFileSync(path.join(skillRoot, "scripts", "check.sh"), "utf8");
  requireOccurrences(callScript, "--max-old-space-size=128", 1, "call runtime heap limit");
  requireOccurrences(checkScript, "--max-old-space-size=128", 3, "check runtime heap limits");
  const installScript = fs.readFileSync(path.join(skillRoot, "scripts", "install.sh"), "utf8");
  requireOccurrences(installScript, "--max-old-space-size=128", 1, "installer runtime heap limit");

  const releaseLookupPath = path.join(skillRoot, "scripts", "find-release-id.sh");
  const releaseLookup = fs.readFileSync(releaseLookupPath, "utf8");
  for (const fragment of [
    "api graphql",
    "release(tagName: $tag) { databaseId }",
    '(.errors == null or',
    '((.errors | type) == "array" and ((.errors | length) == 0))',
    ".data.repository.release == null",
    "GitHub GraphQL request failed",
  ]) requireText(releaseLookup, fragment, "release lookup helper");
  if ((fs.statSync(releaseLookupPath).mode & 0o111) === 0) {
    fail("release lookup helper must be executable");
  }

  const releaseVerifier = fs.readFileSync(
    path.join(skillRoot, "scripts", "verify-release-tag.sh"), "utf8",
  );
  for (const fragment of [
    "C678256ACBFC6491BF5076655F3AE24999921FFC",
    "^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
    "verify-tag --raw",
    "verify-commit --raw",
    "VALIDSIG",
    "RELEASE_REPOSITORY",
    "security/release-signing-key.asc",
    "v0.4.1 tag object: 184871e28a2f52a04c532ea6aaee7752afdace12",
    "v0.4.1 commit: bd0694edc9a4fc91816eb3575d2f6df094baaf9f",
  ]) requireText(releaseVerifier, fragment, "release tag verifier");
  if ((fs.statSync(path.join(skillRoot, "scripts", "verify-release-tag.sh")).mode & 0o111) === 0) {
    fail("release tag verifier must be executable");
  }
  const ghInstallerPath = path.join(skillRoot, "scripts", "install-gh-cli.sh");
  const ghInstaller = fs.readFileSync(ghInstallerPath, "utf8");
  for (const fragment of [
    'GH_CLI_VERSION="2.97.0"',
    'GH_CLI_SHA256="a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112"',
    "https://github.com/cli/cli/releases/download/",
    "sha256sum --check --strict",
  ]) requireText(ghInstaller, fragment, "pinned GitHub CLI installer");
  if ((fs.statSync(ghInstallerPath).mode & 0o111) === 0) {
    fail("pinned GitHub CLI installer must be executable");
  }
  requireOccurrences(releaseCommands,
    'bash "$GITHUB_WORKSPACE/gate/scripts/install-gh-cli.sh"', 2, "release GitHub CLI setup");
  requireOccurrences(releaseCommands,
    'test "$(gh --version | awk \'NR == 1 { print $3 }\')" = 2.97.0', 2,
    "release GitHub CLI version checks");
  const releaseKey = fs.readFileSync(path.join(skillRoot, "security", "release-signing-key.asc"));
  const releaseKeyHash = createHash("sha256").update(releaseKey).digest("hex");
  if (releaseKeyHash !== "d32d3915ed09f9dedbe6bc3078a33530a2d69531f93e73716ba29ff48e760694") {
    fail("release public key does not match the pinned key material");
  }
  const releasing = fs.readFileSync(path.join(skillRoot, "RELEASING.md"), "utf8");
  for (const fragment of [
    "C678256ACBFC6491BF5076655F3AE24999921FFC",
    "RELEASE_ADMIN_TOKEN",
    "RELEASE_MAIN_RULESET_ID",
    "RELEASE_TAG_RULESET_ID",
    "administrator bypass disabled",
    "cmp --silent",
    "v0.4.1 tag object: 184871e28a2f52a04c532ea6aaee7752afdace12",
    "v0.4.1 commit: bd0694edc9a4fc91816eb3575d2f6df094baaf9f",
  ]) requireText(releasing, fragment, "release documentation");
} catch (error) {
  process.stderr.write(`[exa-search] ERROR: ${safeErrorMessage(error)}\n`);
  process.exit(1);
}
