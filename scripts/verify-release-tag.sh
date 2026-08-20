#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C

readonly EXPECTED_PRIMARY_FINGERPRINT="C678256ACBFC6491BF5076655F3AE24999921FFC"
readonly HISTORICAL_TAG_LINE="v0.4.1 tag object: 184871e28a2f52a04c532ea6aaee7752afdace12"
readonly HISTORICAL_COMMIT_LINE="v0.4.1 commit: bd0694edc9a4fc91816eb3575d2f6df094baaf9f"
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)"
readonly SCRIPT_DIR
TRUST_ROOT="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel)"
readonly TRUST_ROOT
readonly TARGET_INPUT="${RELEASE_REPOSITORY:-$TRUST_ROOT}"
TARGET_ROOT="$(git -C "$TARGET_INPUT" rev-parse --show-toplevel)"
readonly TARGET_ROOT
readonly RELEASE_KEY="$TRUST_ROOT/security/release-signing-key.asc"

fail() {
  printf 'release tag verification failed: %s\n' "$*" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf 'usage: %s TAG [HEAD|FULL_COMMIT_OID]\n' "$0" >&2
  exit 64
fi

readonly RELEASE_TAG="$1"
readonly EXPECTED_COMMIT="${2:-HEAD}"

if [[ ! "$RELEASE_TAG" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  fail "tag must be a stable vMAJOR.MINOR.PATCH version"
fi

for command_name in awk git gpg mktemp node; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command is missing: $command_name"
done

cd -- "$TARGET_ROOT"

if [ ! -f "$RELEASE_KEY" ] || [ -L "$RELEASE_KEY" ]; then
  fail "release public key must be a regular non-symlink file"
fi

readonly TAG_REF="refs/tags/$RELEASE_TAG"
git show-ref --verify --quiet "$TAG_REF" || fail "tag does not exist: $RELEASE_TAG"

tag_metadata="$(git for-each-ref \
  --format='%(objecttype)|%(tag)|%(*objecttype)|%(*objectname)' "$TAG_REF")"
IFS='|' read -r object_type embedded_tag target_type peeled_commit extra_metadata <<<"$tag_metadata"

[ -z "${extra_metadata:-}" ] || fail "unexpected tag metadata"
[ "$object_type" = "tag" ] || fail "tag is not annotated: $RELEASE_TAG"
[ "$embedded_tag" = "$RELEASE_TAG" ] || fail "annotated tag name does not match its ref"
[ "$target_type" = "commit" ] || fail "annotated tag does not directly reference a commit"
[[ "$peeled_commit" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || fail "tag has an invalid commit object ID"

tag_subject="$(git for-each-ref --format='%(contents:subject)' "$TAG_REF")"
tag_contents="$(git for-each-ref --format='%(contents)' "$TAG_REF")"
[ "$tag_subject" = "$RELEASE_TAG" ] || fail "signed tag subject must exactly match the tag name"
historical_tag_count="$(awk -v expected="$HISTORICAL_TAG_LINE" '$0 == expected { count++ }
  END { print count + 0 }' <<<"$tag_contents")"
historical_commit_count="$(awk -v expected="$HISTORICAL_COMMIT_LINE" '$0 == expected { count++ }
  END { print count + 0 }' <<<"$tag_contents")"
[ "$historical_tag_count" = 1 ] || fail "signed tag must contain the exact v0.4.1 tag-object identity"
[ "$historical_commit_count" = 1 ] || fail "signed tag must contain the exact v0.4.1 commit identity"

package_version="$(
  git show "$TAG_REF:package.json" |
    node -e '
      const fs = require("node:fs");
      const value = JSON.parse(fs.readFileSync(0, "utf8"));
      if (typeof value.version !== "string" || value.version.length === 0 || /[\r\n]/u.test(value.version)) {
        throw new Error("package.json version must be a non-empty single-line string");
      }
      process.stdout.write(value.version);
    '
)" || fail "could not read package.json version from the tagged tree"

[ "$RELEASE_TAG" = "v$package_version" ] || \
  fail "tag $RELEASE_TAG does not match package.json version $package_version"

if [ "$EXPECTED_COMMIT" = "HEAD" ]; then
  expected_oid="$(git rev-parse --verify 'HEAD^{commit}')" || fail "HEAD is not a commit"
elif [[ "$EXPECTED_COMMIT" =~ ^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$ ]]; then
  expected_oid="$(git rev-parse --verify "$EXPECTED_COMMIT^{commit}")" || \
    fail "expected commit does not exist: $EXPECTED_COMMIT"
else
  fail "expected commit must be HEAD or a full object ID"
fi

[ "$peeled_commit" = "$expected_oid" ] || \
  fail "tag commit $peeled_commit does not match expected commit $expected_oid"

keyring_dir="$(mktemp -d "${TMPDIR:-/tmp}/exa-search-release-keyring.XXXXXXXX")" || \
  fail "could not create an isolated keyring"
chmod 700 "$keyring_dir"
cleanup() {
  rm -rf -- "$keyring_dir"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

export GNUPGHOME="$keyring_dir"
gpg --batch --quiet --import-options import-minimal --import "$RELEASE_KEY" >/dev/null 2>&1 || \
  fail "could not import the release public key"

key_listing="$(gpg --batch --with-colons --fingerprint --list-keys)" || \
  fail "the expected release key is not present"
public_key_count="$(awk -F: '$1 == "pub" { count++ } END { print count + 0 }' <<<"$key_listing")"
actual_primary_fingerprint="$(awk -F: '$1 == "fpr" { print toupper($10); exit }' <<<"$key_listing")"

[ "$public_key_count" = "1" ] || fail "release key file must contain exactly one primary key"
[ "$actual_primary_fingerprint" = "$EXPECTED_PRIMARY_FINGERPRINT" ] || \
  fail "release key fingerprint does not match the pinned fingerprint"

GPG_BIN="$(command -v gpg)"
readonly GPG_BIN
verify_pinned_signature() {
  local object_kind="$1" object_ref="$2" verify_status validsig_count signature_matches_primary
  case "$object_kind" in
    tag)
      if ! verify_status="$(git -c gpg.format=openpgp -c gpg.program="$GPG_BIN" \
        verify-tag --raw "$object_ref" 2>&1)"; then
        fail "git verify-tag rejected $object_ref"
      fi
      ;;
    commit)
      if ! verify_status="$(git -c gpg.format=openpgp -c gpg.program="$GPG_BIN" \
        verify-commit --raw "$object_ref" 2>&1)"; then
        fail "git verify-commit rejected $object_ref"
      fi
      ;;
    *) fail "internal signature object type is invalid" ;;
  esac

  if awk '$1 == "[GNUPG:]" && $2 ~ /^(BADSIG|ERRSIG|EXPKEYSIG|EXPSIG|NO_PUBKEY|REVKEYSIG)$/ { found = 1 }
    END { exit(found ? 0 : 1) }' <<<"$verify_status"; then
    fail "GnuPG reported an invalid or unusable $object_kind signature"
  fi

  validsig_count="$(awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" { count++ }
    END { print count + 0 }' <<<"$verify_status")"
  [ "$validsig_count" = 1 ] || fail "expected exactly one valid $object_kind signature"

  signature_matches_primary="$(awk -v expected="$EXPECTED_PRIMARY_FINGERPRINT" '
    $1 == "[GNUPG:]" && $2 == "VALIDSIG" {
      signer = toupper($3)
      primary = signer
      candidate = toupper($NF)
      if (candidate ~ /^[[:xdigit:]]+$/ && (length(candidate) == 40 || length(candidate) == 64)) {
        primary = candidate
      }
      if (signer == expected || primary == expected) print "yes"
    }
  ' <<<"$verify_status")"
  [ "$signature_matches_primary" = yes ] || \
    fail "$object_kind signature was not made by the pinned primary key or one of its signing subkeys"
}

verify_pinned_signature tag "$TAG_REF"
verify_pinned_signature commit "$peeled_commit"

printf 'verified signed release tag and commit %s at %s with primary key %s\n' \
  "$RELEASE_TAG" "$peeled_commit" "$EXPECTED_PRIMARY_FINGERPRINT"
