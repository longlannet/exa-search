#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function fail(message) { throw new Error(message); }

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(skillRoot, "scripts", "find-release-id.sh");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "exa-search-release-lookup-"));
const fakeGh = path.join(temporary, "gh");
const invocationLog = path.join(temporary, "invocations");

try {
  fs.writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s %s\\n' "$1" "$2" >>"$GH_INVOCATION_LOG"
[ "$1" = api ] && [ "$2" = graphql ]
case "$*" in *'release(tagName: $tag) { databaseId }'*) ;; *) exit 91 ;; esac
case "$GH_LOOKUP_FIXTURE" in
  absent) printf '%s\\n' '{"data":{"repository":{"release":null}}}' ;;
  draft) printf '%s\\n' '{"data":{"repository":{"release":{"databaseId":123}}}}' ;;
  empty-errors) printf '%s\\n' '{"errors":[],"data":{"repository":{"release":{"databaseId":456}}}}' ;;
  api-error) exit 1 ;;
  graphql-error) printf '%s\\n' '{"errors":[{"message":"denied"}],"data":{"repository":{"release":null}}}' ;;
  missing-repository) printf '%s\\n' '{"data":{"repository":null}}' ;;
  fractional-id) printf '%s\\n' '{"data":{"repository":{"release":{"databaseId":1.5}}}}' ;;
  string-id) printf '%s\\n' '{"data":{"repository":{"release":{"databaseId":"123"}}}}' ;;
  *) exit 92 ;;
esac
`, { mode: 0o700 });

  function run(fixture, repository = "owner/repository", tag = "v0.4.2") {
    return spawnSync("bash", [helper, repository, tag], {
      encoding: "utf8",
      env: {
        ...process.env,
        GH_BIN: fakeGh,
        GH_INVOCATION_LOG: invocationLog,
        GH_LOOKUP_FIXTURE: fixture,
      },
      timeout: 10_000,
    });
  }
  function expectSuccess(fixture, output) {
    const result = run(fixture);
    if (result.error || result.status !== 0 || result.stdout.trim() !== output) {
      fail(`${fixture} did not return ${JSON.stringify(output)}: ${result.error?.message ?? result.stderr}`);
    }
  }
  function expectFailure(fixture, repository, tag) {
    const result = run(fixture, repository, tag);
    if (result.error || result.status === 0) {
      fail(`${fixture} was not rejected: ${result.error?.message ?? result.stdout}`);
    }
  }

  expectSuccess("absent", "");
  expectSuccess("draft", "123");
  expectSuccess("empty-errors", "456");
  for (const fixture of ["api-error", "graphql-error", "missing-repository", "fractional-id", "string-id"]) {
    expectFailure(fixture);
  }
  expectFailure("absent", "owner/repository/extra", "v0.4.2");
  expectFailure("absent", "owner/repository", "v01.2.3");

  const invocations = fs.readFileSync(invocationLog, "utf8").trim().split("\n");
  if (invocations.length !== 8 || !invocations.every((line) => line === "api graphql")) {
    fail("release lookup did not exclusively use the GraphQL API");
  }
  process.stdout.write("release lookup fixtures: OK\n");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
