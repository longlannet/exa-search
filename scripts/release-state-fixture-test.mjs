#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "exa-search-release-state-"));
const tag = "v0.4.2";
const notes = "signed release notes\n";
const author = { login: "github-actions[bot]", id: 41898282 };

function fakeGh() {
  const fs = require("node:fs");
  const path = require("node:path");
  const { createHash } = require("node:crypto");
  const args = process.argv.slice(2);
  const statePath = process.env.EXA_FIXTURE_STATE;
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.appendFileSync(process.env.EXA_FIXTURE_LOG, `${JSON.stringify(args)}\n`);
  if (args[0] === "api" && args[1] === "graphql") {
    process.stdout.write(JSON.stringify({ data: { repository: {
      release: state === null ? null : { databaseId: 123 },
    } } }));
  } else if (args[0] === "api" && args[1] === "repos/owner/repository/releases/123") {
    process.stdout.write(JSON.stringify(state));
  } else if (args[0] === "release" && args[1] === "create") {
    if (state !== null || !args.includes("--draft") || !args.includes("--verify-tag")) process.exit(91);
    fs.writeFileSync(statePath, JSON.stringify({
      id: 123, tag_name: args[2], name: args[args.indexOf("--title") + 1],
      body: fs.readFileSync(args[args.indexOf("--notes-file") + 1], "utf8"),
      author: { login: "github-actions[bot]", id: 41898282 },
      draft: true, immutable: false, prerelease: false, assets: [],
    }));
  } else if (args[0] === "release" && args[1] === "upload") {
    if (!state?.draft || state.immutable) process.exit(92);
    const [file, label] = args[3].split("#");
    state.assets.push({
      name: path.basename(file), label,
      digest: `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}`,
    });
    if (process.env.EXA_FIXTURE_DRIFT === "1") state.author.login = "changed-after-upload";
    fs.writeFileSync(statePath, JSON.stringify(state));
  } else {
    process.stderr.write(`unexpected fixture command: ${JSON.stringify(args)}\n`);
    process.exit(93);
  }
}

try {
  fs.symlinkSync(root, path.join(temporary, "gate"), "dir");
  const gh = path.join(temporary, "gh");
  fs.writeFileSync(gh, `#!/usr/bin/env node\n(${fakeGh.toString()})();\n`, { mode: 0o700 });
  const archive = path.join(temporary, `exa-search-${tag}.tar.gz`);
  const checksums = path.join(temporary, "SHA256SUMS");
  const notesPath = path.join(temporary, "notes");
  fs.writeFileSync(archive, "source archive fixture\n");
  fs.writeFileSync(checksums, "checksums fixture\n");
  fs.writeFileSync(notesPath, notes);
  const expected = [[archive, "Deterministic source archive"], [checksums, "SHA-256 checksums"]]
    .map(([file, label]) => ({ name: path.basename(file), label,
      digest: `sha256:${createHash("sha256").update(fs.readFileSync(file)).digest("hex")}` }));
  const workflow = parseDocument(fs.readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8"),
    { uniqueKeys: true });
  assert.deepEqual(workflow.errors, []);
  const command = workflow.toJS({ maxAliasCount: 0 }).jobs.publish.steps.find((step) => step.id === "release_state").run;

  function run(label, modify, { status = 1, uploads = 0, creates = 0, absent = false, drift = false } = {}) {
    const statePath = path.join(temporary, "state.json");
    const logPath = path.join(temporary, "calls.jsonl");
    const outputPath = path.join(temporary, "output");
    const state = { id: 123, tag_name: tag, name: tag, body: notes, author: { ...author },
      draft: true, immutable: false, prerelease: false, assets: [] };
    modify?.(state);
    fs.writeFileSync(statePath, JSON.stringify(absent ? null : state));
    fs.writeFileSync(logPath, "");
    fs.writeFileSync(outputPath, "");
    const result = spawnSync("bash", ["-c", command], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${temporary}:${process.env.PATH}`, GH_BIN: gh, GH_TOKEN: "fixture-only",
        GITHUB_WORKSPACE: temporary, GITHUB_REPOSITORY: "owner/repository", GITHUB_OUTPUT: outputPath,
        RELEASE_TAG: tag, SOURCE_ARCHIVE: archive, SOURCE_CHECKSUMS: checksums, SOURCE_NOTES: notesPath,
        EXA_FIXTURE_STATE: statePath, EXA_FIXTURE_LOG: logPath, EXA_FIXTURE_DRIFT: drift ? "1" : "0" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, `${label}: ${result.stderr}`);
    const calls = fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const writes = calls.filter((args) => args[0] === "release");
    assert.equal(writes.filter((args) => args[1] === "upload").length, uploads, `${label}: uploads`);
    assert.equal(writes.filter((args) => args[1] === "create").length, creates, `${label}: creates`);
    if (uploads + creates === 0) assert.deepEqual(writes, [], `${label}: must be read-only`);
    const final = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (status === 0) {
      assert.deepEqual(final.assets.toSorted((a, b) => a.name.localeCompare(b.name)),
        expected.toSorted((a, b) => a.name.localeCompare(b.name)), label);
      assert.equal(fs.readFileSync(outputPath, "utf8"),
        `state=${state.immutable ? "immutable" : "draft"}\nrelease_id=123\n`, label);
    } else if (uploads + creates === 0) {
      assert.deepEqual(final, state, `${label}: rejected state must stay unchanged`);
    }
  }

  run("new draft", undefined, { status: 0, creates: 1, uploads: 2, absent: true });
  run("empty bot draft", undefined, { status: 0, uploads: 2 });
  for (const asset of expected) {
    run(`resume with ${asset.name}`, (state) => { state.assets = [{ ...asset }]; }, { status: 0, uploads: 1 });
  }
  run("complete draft", (state) => { state.assets = structuredClone(expected); }, { status: 0 });
  run("immutable reuse", (state) => {
    state.draft = false; state.immutable = true; state.assets = structuredClone(expected);
  }, { status: 0 });
  run("incomplete immutable", (state) => { state.draft = false; state.immutable = true; });
  for (const [field, value] of [["id", 124], ["tag_name", "v0.4.1"], ["name", "wrong"],
    ["body", "wrong"], ["prerelease", true]]) {
    run(`wrong ${field}`, (state) => { state[field] = value; });
  }
  run("human author", (state) => { state.author.login = "human-maintainer"; });
  run("wrong author ID", (state) => { state.author.id = 1; });
  run("unexpected asset", (state) => { state.assets = [{ ...expected[0], name: "unexpected" }]; });
  run("bad second asset digest before first upload", (state) => {
    state.assets = [{ ...expected[1], digest: "sha256:incorrect" }];
  });
  run("bad asset label", (state) => { state.assets = [{ ...expected[1], label: "wrong" }]; });
  run("duplicate assets", (state) => { state.assets = [expected[0], expected[0]]; });
  run("invalid assets", (state) => { state.assets = null; });
  run("drift after first upload", undefined, { uploads: 1, drift: true });
  process.stdout.write("release state fixtures: OK\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
