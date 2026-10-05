#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "..");
const helper = path.join(root, "scripts", "configure.mjs");
const binary = path.join(root, "node_modules", ".bin", "mcporter");
const originalText = `${JSON.stringify({ imports: ["legacy"], mcpServers: { exa: {
  baseUrl: "https://mcp.exa.ai/mcp", allowedTools: ["web_search_exa", "web_fetch_exa"],
} }, preserved: "original" })}\n`;

function installHook() {
  const config = process.env.EXA_FIXTURE_CONFIG;
  const lock = path.join(path.dirname(config), `.${path.basename(config)}.exa-search.lock`);
  const boundary = process.env.EXA_FIXTURE_BOUNDARY;
  const action = process.env.EXA_FIXTURE_ACTION;
  const saved = Object.fromEntries(["openSync", "closeSync", "writeFileSync", "fsyncSync", "renameSync", "unlinkSync", "readFileSync"].map((name) => [name, fs[name].bind(fs)]));
  const descriptors = new Map();
  let injected = false;
  let published = false;
  let restored = false;
  let rollbackTriggered = false;
  const isRecovery = (value) => typeof value === "string" && value.includes(".exa-search-recovery.");
  function observe() {
    if (process.env.EXA_FIXTURE_OBSERVE === "1") {
      const value = JSON.parse(saved.readFileSync(config, "utf8"));
      assert.equal(value.preserved, "original", "live config was missing or incompletely written");
    }
  }
  function inject(point) {
    observe();
    if (injected || point !== boundary) return;
    injected = true;
    if (point === "stale-reaper") {
      const competitor = spawnSync(process.execPath, [helper, "prepare", config, String(process.pid)], {
        encoding: "utf8", timeout: 8000, env: { ...process.env, EXA_CONFIG_FIXTURE_HOOK: "0" },
      });
      assert.equal(competitor.status, 75, `competing stale-lock reaper entered the critical section: ${competitor.stderr}`);
      assert.match(competitor.stderr, /another Exa config transaction is in progress/);
      assert.equal(saved.readFileSync(lock, "utf8"), "2147483647\n");
      process.stderr.write("[exa-search] competing stale-lock reaper was blocked\n");
    }
    if (action === "edit") fs.appendFileSync(config, "\n// concurrent editor retained\n");
    else if (action === "kill") process.kill(process.pid, "SIGKILL");
    else if (["throw", "nospace"].includes(action)) throw Object.assign(new Error(`injected failure: ${point}`), { code: action === "nospace" ? "ENOSPC" : "EIO" });
    else if (action === "vanish") saved.unlinkSync(lock);
  }
  fs.openSync = function (file, ...args) {
    if (file === lock && (args[0] & fs.constants.O_CREAT) === 0) inject("lock-read");
    if (isRecovery(file) && (args[0] & fs.constants.O_CREAT) !== 0) inject("copy-before");
    const fd = saved.openSync(file, ...args);
    descriptors.set(fd, file);
    if (isRecovery(file) && (args[0] & fs.constants.O_CREAT) !== 0) inject("copy-empty");
    return fd;
  };
  fs.closeSync = function (fd) { descriptors.delete(fd); return saved.closeSync(fd); };
  fs.writeFileSync = function (file, ...args) {
    if (isRecovery(descriptors.get(file)) && boundary === "copy-partial" && !injected) {
      saved.writeFileSync(file, Buffer.from(args[0]).subarray(0, 13));
      inject("copy-partial");
    }
    const result = saved.writeFileSync(file, ...args);
    if (isRecovery(descriptors.get(file))) inject("copy-written");
    return result;
  };
  fs.fsyncSync = function (fd) {
    const result = saved.fsyncSync(fd);
    if (isRecovery(descriptors.get(fd))) inject("copy-fsync");
    if (descriptors.get(fd) === path.dirname(config) && published && !restored) {
      if (boundary === "rollback-fsync" && !rollbackTriggered) {
        rollbackTriggered = true;
        throw Object.assign(new Error("injected failure before rollback"), { code: "EIO" });
      }
      inject("publish-fsync");
    }
    if (descriptors.get(fd) === path.dirname(config) && restored) inject("rollback-fsync");
    observe();
    return result;
  };
  fs.renameSync = function (from, to) {
    if (to === config && !isRecovery(from)) inject("publish-before");
    const result = saved.renameSync(from, to);
    if (to.endsWith(".meta")) {
      const metadata = JSON.parse(saved.readFileSync(to, "utf8"));
      if (metadata.aborted) inject("abort-metadata");
      else if (metadata.recoveryMode === "copy") inject(metadata.recovery ? "copy-metadata" : metadata.recoveryStarted ? "copy-start-metadata" : "plan-metadata");
    }
    if (to === config) {
      if (isRecovery(from)) restored = true;
      else { published = true; inject("publish-after"); }
    }
    observe();
    return result;
  };
  fs.unlinkSync = function (file) {
    if (file === lock) inject("stale-reaper");
    const result = saved.unlinkSync(file);
    if (isRecovery(file)) inject("backup-remove");
    else if (file === process.env.EXA_FIXTURE_STAGE) inject("stage-remove");
    observe();
    return result;
  };
}

function run(command, config, stage, hook = {}) {
  const args = [helper, command, config];
  if (stage !== undefined) args.push(stage);
  if (["normalize", "commit"].includes(command)) args.push(binary);
  if (Object.keys(hook).length > 0) args.unshift("--import", script);
  return spawnSync(process.execPath, args, {
    encoding: "utf8", timeout: 12000,
    env: { ...process.env, EXA_CONFIG_FIXTURE_HOOK: Object.keys(hook).length ? "1" : "0",
      EXA_FIXTURE_CONFIG: config, EXA_FIXTURE_STAGE: stage ?? "", ...hook },
  });
}
function expect(result, status, label) {
  assert.equal(result.status, status, `${label}: ${result.error?.message ?? result.stderr ?? result.signal}`);
}
function prepare(config, owner = process.pid) {
  fs.writeFileSync(config, originalText, { mode: 0o600 });
  const result = run("prepare", config, String(owner));
  expect(result, 0, "prepare");
  const stage = result.stdout.trim();
  expect(run("normalize", config, stage), 0, "normalize");
  return stage;
}
function assertClean(config) {
  const artifacts = fs.readdirSync(path.dirname(config)).filter((name) => name.startsWith(`.${path.basename(config)}.exa-search`));
  assert.deepEqual(artifacts, [], `transaction artifacts remain: ${artifacts.join(", ")}`);
}
function identity(file) {
  const stat = fs.statSync(file);
  return Object.fromEntries(["dev", "ino", "size", "mtimeMs", "ctimeMs"].map((key) => [key, String(stat[key])]));
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

async function fixtures() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "exa-search-config-fixture."));
  let owner;
  try {
    for (const boundary of ["plan-metadata", "copy-written", "copy-metadata"]) {
      const config = path.join(temporary, `editor-${boundary}.json`);
      owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
      const stage = prepare(config, owner.pid);
      expect(run("commit", config, stage, { EXA_FIXTURE_BOUNDARY: boundary, EXA_FIXTURE_ACTION: "edit" }), 75, boundary);
      expect(run("cleanup", config, stage), 0, "concurrent editor cleanup");
      assert.match(fs.readFileSync(config, "utf8"), /concurrent editor retained/);
      assertClean(config);
      await stop(owner);
      owner = undefined;
      const next = run("prepare", config, String(process.pid));
      expect(next, 0, "subsequent owner prepares successfully");
      expect(run("cleanup", config, next.stdout.trim()), 0, "next cleanup");
      assertClean(config);
    }

    const orphaned = path.join(temporary, "exited-editor-owner.json");
    owner = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
    const orphanedStage = prepare(orphaned, owner.pid);
    expect(run("commit", orphaned, orphanedStage, { EXA_FIXTURE_BOUNDARY: "copy-metadata", EXA_FIXTURE_ACTION: "edit" }), 75, "owner exits without cleanup");
    await stop(owner);
    owner = undefined;
    const recovered = run("prepare", orphaned, String(process.pid));
    expect(recovered, 0, "new installer recovers exited editor owner");
    assert.match(fs.readFileSync(orphaned, "utf8"), /concurrent editor retained/);
    expect(run("cleanup", orphaned, recovered.stdout.trim()), 0, "recovered installer cleanup");
    assertClean(orphaned);

    for (const boundary of ["plan-metadata", "copy-before", "copy-empty", "copy-start-metadata", "copy-partial", "copy-written", "copy-fsync", "copy-metadata", "publish-before", "publish-after", "publish-fsync", "rollback-fsync", "backup-remove"]) {
      for (const action of ["kill", boundary === "copy-partial" ? "nospace" : "throw"]) {
        const config = path.join(temporary, `${action}-${boundary}.json`);
        const stage = prepare(config);
        const committed = run("commit", config, stage, {
          EXA_FIXTURE_BOUNDARY: boundary, EXA_FIXTURE_ACTION: action, EXA_FIXTURE_OBSERVE: "1",
        });
        if (action === "kill") assert.equal(committed.signal, "SIGKILL", `${boundary}: ${committed.stderr}`);
        else expect(committed, boundary === "backup-remove" ? 0 : 1, boundary);
        assert.equal(JSON.parse(fs.readFileSync(config, "utf8")).preserved, "original");
        expect(run("cleanup", config, stage), 0, `recover ${action} at ${boundary}`);
        const current = fs.readFileSync(config, "utf8");
        const published = ["publish-after", "publish-fsync", "backup-remove"].includes(boundary);
        if (published && (action === "kill" || boundary === "backup-remove")) {
          assert.deepEqual(JSON.parse(current).imports, []);
        } else assert.equal(current, originalText, `original bytes were not preserved at ${action}-${boundary}`);
        assertClean(config);
      }
    }

    for (const boundary of ["abort-metadata", "stage-remove"]) {
      const config = path.join(temporary, `abort-${boundary}.json`);
      const stage = prepare(config);
      expect(run("commit", config, stage, { EXA_FIXTURE_BOUNDARY: "copy-metadata", EXA_FIXTURE_ACTION: "edit" }), 75, "edit before abort");
      const interrupted = run("cleanup", config, stage, { EXA_FIXTURE_BOUNDARY: boundary, EXA_FIXTURE_ACTION: "kill" });
      assert.equal(interrupted.signal, "SIGKILL");
      expect(run("cleanup", config, stage), 0, "resume interrupted cleanup");
      assert.match(fs.readFileSync(config, "utf8"), /concurrent editor retained/);
      assertClean(config);
    }

    const visible = path.join(temporary, "reader.json");
    const visibleStage = prepare(visible);
    expect(run("commit", visible, visibleStage, { EXA_FIXTURE_OBSERVE: "1" }), 0, "readers always see complete config");
    assertClean(visible);

    for (const boundary of ["publish-before", "publish-after", "publish-fsync"]) {
      for (const action of ["kill", "throw"]) {
        const config = path.join(temporary, `fresh-${action}-${boundary}.json`);
        const prepared = run("prepare", config, String(process.pid));
        expect(prepared, 0, "fresh prepare");
        const stage = prepared.stdout.trim();
        const committed = run("commit", config, stage, { EXA_FIXTURE_BOUNDARY: boundary, EXA_FIXTURE_ACTION: action });
        if (action === "kill") assert.equal(committed.signal, "SIGKILL");
        else expect(committed, 1, `fresh ${boundary}`);
        expect(run("cleanup", config, stage), 0, `fresh recovery ${action}-${boundary}`);
        assert.equal(fs.existsSync(config), action === "kill" && boundary !== "publish-before");
        assertClean(config);
      }
    }

    for (const state of ["planned", "moved", "published", "cleaned"]) {
      const config = path.join(temporary, `legacy-${state}.json`);
      const stage = prepare(config);
      const metadata = JSON.parse(fs.readFileSync(`${stage}.meta`, "utf8"));
      const recovery = path.join(temporary, `.${path.basename(config)}.exa-search-recovery.${process.pid}.${"1".repeat(24)}`);
      metadata.recoveryPath = recovery;
      fs.writeFileSync(`${stage}.meta`, JSON.stringify(metadata));
      if (state !== "planned") fs.renameSync(config, recovery);
      if (["published", "cleaned"].includes(state)) fs.renameSync(stage, config);
      if (state === "cleaned") fs.unlinkSync(recovery);
      expect(run("cleanup", config, stage), 0, `legacy ${state}`);
      if (["planned", "moved"].includes(state)) assert.equal(fs.readFileSync(config, "utf8"), originalText);
      else assert.deepEqual(JSON.parse(fs.readFileSync(config, "utf8")).imports, []);
      assertClean(config);
    }

    const conflict = path.join(temporary, "conflict.json");
    const conflictStage = prepare(conflict);
    expect(run("commit", conflict, conflictStage, { EXA_FIXTURE_BOUNDARY: "copy-metadata", EXA_FIXTURE_ACTION: "edit" }), 75, "conflict setup");
    const conflictMetadata = JSON.parse(fs.readFileSync(`${conflictStage}.meta`, "utf8"));
    fs.writeFileSync(conflictMetadata.recoveryPath, "unrecognized recovery content\n");
    expect(run("cleanup", conflict, conflictStage), 1, "changed backup is retained");
    assert.equal(fs.readFileSync(conflictMetadata.recoveryPath, "utf8"), "unrecognized recovery content\n");
    assert.ok(fs.existsSync(`${conflictStage}.meta`));
    assert.match(fs.readFileSync(conflict, "utf8"), /concurrent editor retained/);

    const replaced = path.join(temporary, "replaced-incomplete-backup.json");
    const replacedStage = prepare(replaced);
    const partial = run("commit", replaced, replacedStage, { EXA_FIXTURE_BOUNDARY: "copy-partial", EXA_FIXTURE_ACTION: "kill" });
    assert.equal(partial.signal, "SIGKILL");
    const replacedMetadata = JSON.parse(fs.readFileSync(`${replacedStage}.meta`, "utf8"));
    const different = path.join(temporary, "replacement-backup");
    fs.writeFileSync(different, "unrecognized replacement inode\n", { mode: 0o600 });
    fs.renameSync(different, replacedMetadata.recoveryPath);
    expect(run("cleanup", replaced, replacedStage), 1, "unknown incomplete backup replacement is retained");
    assert.equal(fs.readFileSync(replacedMetadata.recoveryPath, "utf8"), "unrecognized replacement inode\n");
    assert.equal(fs.readFileSync(replaced, "utf8"), originalText);
    assert.ok(fs.existsSync(`${replacedStage}.meta`));

    for (const kind of ["live-legacy", "dead-legacy", "reused-pid", "malformed", "vanished"]) {
      const config = path.join(temporary, `lock-${kind}.json`);
      const lock = path.join(temporary, `.${path.basename(config)}.exa-search.lock`);
      const content = kind === "live-legacy" ? `${process.pid}\n` : kind === "malformed" ? "{}" :
        kind === "reused-pid" ? JSON.stringify({ pid: process.pid, startToken: "different-start-token" }) : "2147483647\n";
      fs.writeFileSync(lock, content, { mode: 0o600 });
      const before = identity(lock);
      const prepared = run("prepare", config, String(process.pid), kind === "vanished" ? {
        EXA_FIXTURE_BOUNDARY: "lock-read", EXA_FIXTURE_ACTION: "vanish",
      } : {});
      if (["live-legacy", "malformed"].includes(kind)) {
        expect(prepared, kind === "live-legacy" ? 75 : 1, kind);
        assert.deepEqual(identity(lock), before);
      } else {
        expect(prepared, 0, kind);
        expect(run("cleanup", config, prepared.stdout.trim()), 0, `${kind} cleanup`);
        assertClean(config);
      }
    }

    for (const action of ["compete", "kill"]) {
      const config = path.join(temporary, `stale-reaper-${action}.json`);
      const lock = path.join(temporary, `.${path.basename(config)}.exa-search.lock`);
      fs.writeFileSync(lock, "2147483647\n", { mode: 0o600 });
      const first = run("prepare", config, String(process.pid), { EXA_FIXTURE_BOUNDARY: "stale-reaper", EXA_FIXTURE_ACTION: action });
      assert.match(first.stderr, /competing stale-lock reaper was blocked/);
      if (action === "kill") {
        assert.equal(first.signal, "SIGKILL");
        const next = run("prepare", config, String(process.pid));
        expect(next, 0, "kernel directory lock releases after owner is killed");
        expect(run("cleanup", config, next.stdout.trim()), 0, "killed reaper cleanup");
      } else {
        expect(first, 0, "stale reapers are serialized by the kernel");
        expect(run("cleanup", config, first.stdout.trim()), 0, "serialized reaper cleanup");
      }
      assertClean(config);
    }
    for (const flockBinary of ["/bin/false", path.join(temporary, "missing-flock")]) {
      const unavailable = path.join(temporary, "unavailable-flock.json");
      const noFlock = run("prepare", unavailable, String(process.pid), { FLOCK_BIN: flockBinary });
      expect(noFlock, 1, "failed or missing kernel lock must fail closed");
      assert.match(noFlock.stderr, /working util-linux flock is required/);
      assertClean(unavailable);
    }

    const initializing = path.join(temporary, "lock-initializing.json");
    const initializingLock = path.join(temporary, `.${path.basename(initializing)}.exa-search.lock`);
    owner = spawn(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs";
      const lock = process.argv[1];
      fs.writeFileSync(lock, "", { mode: 0o600 });
      process.stdout.write("ready\\n");
      setTimeout(() => fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startToken: null })), 150);
      setTimeout(() => fs.unlinkSync(lock), 300);
    `, initializingLock], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise((resolve, reject) => { owner.stdout.once("data", resolve); owner.once("error", reject); });
    const initialized = run("prepare", initializing, String(process.pid));
    expect(initialized, 0, "empty lock initializes and is released");
    expect(run("cleanup", initializing, initialized.stdout.trim()), 0, "initializing cleanup");
    assertClean(initializing);
    await stop(owner);
    owner = undefined;
    process.stdout.write("[exa-search] config transaction fixtures passed\n");
  } finally {
    if (owner) await stop(owner);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.env.EXA_CONFIG_FIXTURE_HOOK === "1") installHook();
else await fixtures();
