#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'release lookup failed: %s\n' "$*" >&2
  exit 1
}

if [ "$#" -ne 2 ]; then
  printf 'usage: %s OWNER/REPOSITORY TAG\n' "$0" >&2
  exit 64
fi

readonly REPOSITORY="$1"
readonly RELEASE_TAG="$2"
IFS=/ read -r repo_owner repo_name extra <<<"$REPOSITORY"
if [ -z "$repo_owner" ] || [ -z "$repo_name" ] || [ -n "${extra:-}" ]; then
  fail "repository must be OWNER/REPOSITORY"
fi
[[ "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || \
  fail "tag must be a stable version"

gh_input="${GH_BIN:-gh}"
if [[ "$gh_input" == */* ]]; then
  gh_bin="$(readlink -f -- "$gh_input")" || fail "GH_BIN could not be resolved"
else
  gh_bin="$(command -v "$gh_input" 2>/dev/null)" || fail "GitHub CLI is unavailable"
fi
[ -x "$gh_bin" ] || fail "GitHub CLI is not executable"
command -v jq >/dev/null 2>&1 || fail "jq is unavailable"

# shellcheck disable=SC2016 # GraphQL variables are expanded by GitHub, not Bash.
if ! lookup="$("$gh_bin" api graphql \
  -f owner="$repo_owner" -f name="$repo_name" -f tag="$RELEASE_TAG" \
  -f query='query($owner: String!, $name: String!, $tag: String!) {
    repository(owner: $owner, name: $name) {
      release(tagName: $tag) { databaseId }
    }
  }')"; then
  fail "GitHub GraphQL request failed"
fi

if ! jq -e '
  (.errors == null or
    ((.errors | type) == "array" and ((.errors | length) == 0))) and
  ((.data.repository | type) == "object") and
  (
    .data.repository.release == null or
    (.data.repository.release.databaseId as $id |
      ($id | type) == "number" and $id > 0 and $id == ($id | floor))
  )
' <<<"$lookup" >/dev/null; then
  fail "GitHub GraphQL response is invalid or contains errors"
fi

jq -r '.data.repository.release.databaseId // empty' <<<"$lookup" || \
  fail "could not extract the release ID"
