# Releasing exa-search

Release tags are the independent source-authenticity boundary for this repository. Never create a release from an unsigned or lightweight tag, never let GitHub create a tag implicitly, and never move or replace a published tag.

## Trust root

The allowed OpenPGP primary-key fingerprint is:

```text
C678256ACBFC6491BF5076655F3AE24999921FFC
```

The minimal public key is stored in `security/release-signing-key.asc`. `scripts/verify-release-tag.sh` imports only that file into an isolated temporary keyring and requires a `VALIDSIG` from this primary key or one of its certified signing subkeys. A successful signature from an unrelated key in the caller's normal keyring is not accepted.

The release workflow checks out the default-branch verifier and public key under `gate/`, then checks out the candidate tag separately under `candidate/`. It sets `RELEASE_REPOSITORY` so the trusted gate validates the candidate repository. The candidate's own copies of the verifier, workflow, and public key are never executed or trusted during publication.

Obtain and compare the fingerprint through an independent channel before treating a checkout as trusted. The repository copy alone cannot bootstrap trust in itself.

## Prepare

1. Work from a clean, protected `main` checkout whose required push CI has passed.
2. Update `package.json` and `package-lock.json` to the same stable `MAJOR.MINOR.PATCH` version.
3. Run the complete static, dependency, archive, and adversarial test suite documented by CI.
4. Sign the release commit with the allowed key. Do not rewrite earlier unsigned commits.
5. Enable GitHub release immutability. GitHub applies this setting only to future releases.
6. Create an active, no-bypass branch ruleset whose ref-name include list is exactly `~DEFAULT_BRANCH`. It must block deletion and non-fast-forward updates, require signed commits, and require the exact GitHub Actions checks `test (22.12.0)`, `test (22)`, and `test (24)` from integration ID `15368`. Required checks must be strict and enforced when the branch is created. Store the ruleset's numeric ID in the `release` environment variable `RELEASE_MAIN_RULESET_ID`.
7. Create an active, no-bypass tag ruleset whose ref-name include list is exactly `refs/tags/v*`. It must block both update and deletion while still allowing new tags to be created. Store its numeric ID in `RELEASE_TAG_RULESET_ID`.
8. Protect the GitHub Actions environment named `release` with one or more required reviewers, self-review prevention, administrator bypass disabled, and deployment limited to protected branches. Store a dedicated `RELEASE_ADMIN_TOKEN` environment secret that can read the immutable-release setting, environment protection, and the complete rulesets including `bypass_actors`. The token needs no Contents permission. The built-in `GITHUB_TOKEN` cannot perform these administration reads, so the workflow fails closed when the secret, variables, or protections are absent or insufficient.

The local signing configuration can be made explicit without storing a private key in the repository:

```bash
git config --local user.signingkey C678256ACBFC6491BF5076655F3AE24999921FFC
git config --local commit.gpgsign true
git config --local tag.gpgsign true
```

## Sign and verify the tag

Create an annotated signed tag only after all release changes and tests are final:

```bash
version=0.4.2
git tag -s -u C678256ACBFC6491BF5076655F3AE24999921FFC \
  -m "v$version" \
  -m "v0.4.1 tag object: 184871e28a2f52a04c532ea6aaee7752afdace12" \
  -m "v0.4.1 commit: bd0694edc9a4fc91816eb3575d2f6df094baaf9f" \
  "v$version"
bash scripts/verify-release-tag.sh "v$version" HEAD
git verify-tag --raw "v$version"
```

Every signed successor to `v0.4.1` must record these unchanged historical identities exactly once in the signed annotation, as in the command above. The verifier enforces both lines:

```text
v0.4.1 tag object: 184871e28a2f52a04c532ea6aaee7752afdace12
v0.4.1 commit: bd0694edc9a4fc91816eb3575d2f6df094baaf9f
```

This permanently anchors and endorses the exact historical objects without pretending that the `v0.4.1` tag itself was signed. The verifier also requires both the new annotated tag and its directly referenced commit to carry valid signatures from the pinned key.

Push the already-reviewed commit and tag without force:

```bash
git push origin main
git push origin "refs/tags/v$version"
```

Do not use `git tag -f`, a forced tag push, or `gh release create` before the signed tag exists remotely.

## Publish

Run the `Publish signed release` workflow from the default branch and enter the existing tag. Approval of the protected `release` environment is required before the write-capable job starts. The workflow:

- checks out the default-branch gate and `refs/tags/TAG` into separate directories, then verifies the candidate twice using only the gate-side verifier and public key;
- requires the annotated tag name and subject, historical `v0.4.1` identities, `package.json` version read from the tagged tree, peeled commit, pinned GPG signatures on both tag and commit, remote tag object, and GitHub signature status to agree;
- requires the candidate to be exactly the `main` commit that dispatched the workflow, repeatedly checks the remote default branch immediately before and after publication, and requires a successful push CI run on `main`; this exact binding avoids scanning attacker-controlled tag lists and detects a stale signed release attempt if `main` advances;
- refuses every write unless the protected environment, both exact no-bypass rulesets, and immutable releases are active;
- installs GitHub CLI 2.97.0 from its fixed official archive only after verifying SHA-256 `a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112`;
- creates a deterministic source archive and `SHA256SUMS`;
- creates or resumes only a `github-actions[bot]` draft with `--verify-tag`, uploads only missing byte-identical assets, then rechecks the tag and the exact two-asset name/label/digest allowlist immediately before publishing that exact release ID;
- uses a fail-closed GraphQL lookup to distinguish a genuinely absent release from API errors, then binds all REST reads to the returned draft release ID; it rechecks the immutable-release setting immediately before publishing the draft;
- safely reuses an already immutable, byte-identical release after an interrupted verification instead of trying to recreate it;
- verifies Latest state, the immutable release attestation, both uploaded assets, and the now-locked remote tag object.

The workflow has read-only repository and Actions permission during initial verification. Only the protected publication job receives `contents: write`, plus read-only Actions and attestation access. The separate administration token is used only for fail-closed GET requests. No private signing material is stored in GitHub Actions. GitHub does not offer a conditional, atomic transition from a validated draft to an immutable published release or an atomic binding to the moving default branch. Freeze pushes to `main` and all other Contents writers from environment approval until final verification. Every account, app, or workflow with Contents write access remains inside the publication trust boundary; keep that set minimal and fully trusted. The final ref, attestation, and byte checks detect a race, but cannot undo an immutable release after publication.

## Independently verify

After publication, keep the verifier checkout separate from the candidate tag and use freshly downloaded assets:

```bash
version=0.4.2
git clone https://github.com/longlannet/exa-search.git release-verify
git -C release-verify fetch origin "refs/tags/v$version:refs/tags/v$version"
git -C release-verify worktree add --detach ../release-candidate "v$version^{commit}"
candidate_commit="$(git -C release-candidate rev-parse 'HEAD^{commit}')"
RELEASE_REPOSITORY="$PWD/release-candidate" \
  bash release-verify/scripts/verify-release-tag.sh "v$version" "$candidate_commit"
gh release verify "v$version" --repo longlannet/exa-search
gh release download "v$version" --repo longlannet/exa-search --dir release-assets
gh release verify-asset "v$version" release-assets/"exa-search-v$version.tar.gz" \
  --repo longlannet/exa-search
gh release verify-asset "v$version" release-assets/SHA256SUMS \
  --repo longlannet/exa-search
mkdir -p release-expected
git -C release-verify archive --format=tar \
  --prefix="exa-search-v$version/" "refs/tags/v$version" |
  gzip -n -9 >"release-expected/exa-search-v$version.tar.gz"
(
  cd release-expected
  sha256sum "exa-search-v$version.tar.gz" >SHA256SUMS
)
cmp --silent "release-expected/exa-search-v$version.tar.gz" \
  "release-assets/exa-search-v$version.tar.gz"
cmp --silent release-expected/SHA256SUMS release-assets/SHA256SUMS
```

Rebuilding both files is what binds the downloadable assets to the signed tag; the release attestation and a self-consistent downloaded checksum file alone do not prove that derivation. Also use the GitHub API to require that the release author is `github-actions[bot]` with ID `41898282`, its name equals the tag, its body equals the signed tag annotation with the signature block removed, it is not a prerelease, and the asset allowlist is exactly `exa-search-v$version.tar.gz` labeled `Deterministic source archive` plus `SHA256SUMS` labeled `SHA-256 checksums`. Require the tag signature to be verified, the release to be Latest, and `immutable` to be `true`. A failed check is a stop condition; do not publish an unsigned fallback.
