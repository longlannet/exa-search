#!/usr/bin/env bash
set -euo pipefail
umask 077

readonly GH_CLI_VERSION="2.97.0"
readonly GH_CLI_SHA256="a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112"
readonly GH_CLI_ASSET="gh_${GH_CLI_VERSION}_linux_amd64.tar.gz"

fail() {
  printf 'GitHub CLI setup failed: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 0 ] || fail "this helper accepts no arguments"
[ "$(uname -s)" = Linux ] || fail "Linux is required"
[ "$(uname -m)" = x86_64 ] || fail "x86_64 is required"
if [ -z "${RUNNER_TEMP:-}" ] || [ ! -d "$RUNNER_TEMP" ]; then
  fail "RUNNER_TEMP is unavailable"
fi
[ -n "${GITHUB_PATH:-}" ] || fail "GITHUB_PATH is unavailable"
for command_name in curl mktemp sha256sum tar; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is missing: $command_name"
done

install_root="$(mktemp -d "$RUNNER_TEMP/exa-search-gh.XXXXXXXX")" || \
  fail "could not create a private GitHub CLI directory"
chmod 700 "$install_root"
archive="$install_root/$GH_CLI_ASSET"
curl --fail --silent --show-error --location \
  "https://github.com/cli/cli/releases/download/v${GH_CLI_VERSION}/${GH_CLI_ASSET}" \
  --output "$archive"
printf '%s  %s\n' "$GH_CLI_SHA256" "$archive" | sha256sum --check --strict
tar -xzf "$archive" -C "$install_root" --strip-components=2 \
  "gh_${GH_CLI_VERSION}_linux_amd64/bin/gh"
[ -x "$install_root/gh" ] || fail "pinned GitHub CLI executable is missing"
[ "$("$install_root/gh" --version | awk 'NR == 1 { print $3 }')" = "$GH_CLI_VERSION" ] || \
  fail "pinned GitHub CLI reported an unexpected version"
printf '%s\n' "$install_root" >>"$GITHUB_PATH"
