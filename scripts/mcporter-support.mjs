#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED_MCPORTER_VERSION = "0.9.0";
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = path.join(SKILL_ROOT, "package-lock.json");
const LOCKED_MCPORTER_LOCATION = "node_modules/mcporter";

function fail(message) { throw new Error(message); }
function requireSupportedNode() {
  const [major, minor] = process.versions.node.split(".", 2).map(Number);
  if (!((major === 22 && minor >= 12) || major === 24)) {
    fail(`Node 22.12 or later in the 22.x line, or Node 24, is required; found ${process.versions.node}`);
  }
}
function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}
function stableObject(value) {
  return JSON.stringify(canonicalValue(value ?? {}));
}

requireSupportedNode();
function lockedDependencyPolicy() {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")); }
  catch { fail("the locked mcporter dependency policy is missing or invalid"); }
  const packages = lock?.packages;
  const lockedMcporter = packages?.[LOCKED_MCPORTER_LOCATION];
  if (!packages || typeof packages !== "object" || lockedMcporter?.version !== REQUIRED_MCPORTER_VERSION) {
    fail("package-lock.json does not lock the supported mcporter version");
  }
  return { packages, lockedMcporter };
}
function findLockedDependency(packages, parentLocation, dependencyName) {
  let current = parentLocation;
  while (true) {
    const candidate = path.posix.join(current, "node_modules", dependencyName);
    const record = packages[candidate];
    if (record && typeof record.version === "string") return { location: candidate, record };
    if (!current) return null;
    const parent = path.posix.dirname(current);
    current = parent === "." ? "" : parent;
  }
}
function verifyManifestRecord(manifest, record, label) {
  if (manifest.version !== record.version) {
    fail(`unsupported mcporter dependency version: ${label}@${manifest.version ?? "unknown"}; expected ${record.version}`);
  }
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta"]) {
    if (stableObject(manifest[key]) !== stableObject(record[key])) {
      fail(`mcporter dependency declarations do not match package-lock.json: ${label} ${key}`);
    }
  }
}
function findDependencyManifest(parentManifestPath, dependencyName) {
  let current = path.dirname(parentManifestPath);
  while (true) {
    const candidate = path.join(current, "node_modules", dependencyName, "package.json");
    try {
      const manifestPath = fs.realpathSync(candidate);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest?.name === dependencyName) return { manifest, manifestPath };
    } catch (error) {
      if (error instanceof SyntaxError) fail(`invalid dependency package manifest: ${candidate}`);
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
function verifyLockedDependencyClosure(rootManifest, rootManifestPath) {
  const { packages, lockedMcporter } = lockedDependencyPolicy();
  const pending = [{
    manifest: rootManifest,
    manifestPath: rootManifestPath,
    lockLocation: LOCKED_MCPORTER_LOCATION,
    lockRecord: lockedMcporter,
  }];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    const identity = fs.realpathSync(current.manifestPath);
    const visitKey = `${identity}\0${current.lockLocation}`;
    if (visited.has(visitKey)) continue;
    visited.add(visitKey);
    verifyManifestRecord(current.manifest, current.lockRecord, current.manifest.name ?? current.lockLocation);
    const optionalNames = new Set(Object.keys(current.manifest.optionalDependencies ?? {}));
    const dependencies = new Set([
      ...Object.keys(current.manifest.dependencies ?? {}),
      ...Object.keys(current.manifest.optionalDependencies ?? {}),
      ...Object.keys(current.manifest.peerDependencies ?? {}),
    ]);
    for (const name of dependencies) {
      const resolved = findDependencyManifest(current.manifestPath, name);
      const peerOptional = current.manifest.peerDependenciesMeta?.[name]?.optional === true;
      if (!resolved) {
        if (optionalNames.has(name) || peerOptional) continue;
        fail(`locked mcporter dependency is missing: ${name}`);
      }
      const locked = findLockedDependency(packages, current.lockLocation, name);
      if (!locked) fail(`mcporter dependency is absent from package-lock.json: ${name}`);
      if (resolved.manifest.version !== locked.record.version) {
        fail(`unsupported mcporter dependency version: ${name}@${resolved.manifest.version ?? "unknown"}; expected ${locked.record.version}`);
      }
      pending.push({ ...resolved, lockLocation: locked.location, lockRecord: locked.record });
    }
  }
}

export function findMcporterPackage(binaryInput) {
  if (!binaryInput) fail("mcporter binary is required");
  const binaryPath = fs.realpathSync(path.resolve(binaryInput));
  let current = path.dirname(binaryPath);
  while (true) {
    const manifestPath = path.join(current, "package.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest?.name === "mcporter") {
        if (manifest.version !== REQUIRED_MCPORTER_VERSION) {
          fail(`mcporter ${REQUIRED_MCPORTER_VERSION} is required; found ${manifest.version ?? "unknown"}`);
        }
        const declaredBin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.mcporter;
        if (typeof declaredBin !== "string" || !declaredBin) fail("mcporter package does not declare its CLI binary");
        let expectedBinary;
        try { expectedBinary = fs.realpathSync(path.resolve(current, declaredBin)); }
        catch { fail("mcporter package CLI binary is missing"); }
        if (binaryPath !== expectedBinary) fail("MCPORTER_BIN is not the CLI declared by the mcporter package");
        verifyLockedDependencyClosure(manifest, manifestPath);
        return { root: current, manifestPath };
      }
    } catch (error) {
      if (error instanceof SyntaxError) fail(`invalid mcporter package manifest: ${manifestPath}`);
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fail("mcporter must be the supported Node package installation");
}

export function loadJsoncParser(binaryInput) {
  const { manifestPath } = findMcporterPackage(binaryInput);
  const parser = createRequire(manifestPath)("jsonc-parser");
  for (const name of ["parse", "parseTree", "modify", "applyEdits", "printParseErrorCode"]) {
    if (typeof parser[name] !== "function") fail(`mcporter jsonc-parser is missing ${name}`);
  }
  return parser;
}

export async function loadMcporterModule(binaryInput) {
  const { root } = findMcporterPackage(binaryInput);
  const entry = path.join(root, "dist", "index.js");
  const stat = fs.statSync(entry);
  if (!stat.isFile()) fail("mcporter runtime entry is not a regular file");
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.createRuntime !== "function" || typeof module.createCallResult !== "function") {
    fail("mcporter runtime API is incomplete");
  }
  return module;
}
