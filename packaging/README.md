# packaging

Bookworm rebuilds of the ModemManager stack — **packaging only, not a fork, zero source
patches** (see `POLICY.md` at the repo root). Bench devices install the resulting `.deb`s
from CI artifacts; nothing is published to `apt.ceralive.tv` in Phase A.

## Sources (4)

| Source | Provides |
|--------|----------|
| ModemManager | the modem daemon (`org.freedesktop.ModemManager1`) |
| libmbim | MBIM protocol library + `mbimcli` |
| libqmi | QMI protocol library + `qmicli` |
| libqrtr-glib | QRTR (IPC router) GLib bindings |

Each is rebuilt from its pinned, provenance-verified upstream release and its pinned
Debian packaging tag. The authoritative pin manifest is [`upstream-pins.yaml`](upstream-pins.yaml),
re-verified end-to-end by [`ci/verify-upstream-pins.sh`](ci/verify-upstream-pins.sh).

> **Status:** `[EXISTS]` — provenance pin manifest + verifier, the four `debian/` recipes,
> and the bootstrap-order container build (`ci/build-bookworm.sh`, amd64 + QEMU arm64) all
> landed. Both arches build clean with the exact 9-package runtime closure. The package
> **contract suite** (metadata / upgrade / rollback / daemon smoke) is the next task.

## Recipes & build

Each source's `debian/` dir is checked in at `<Source>/debian/` (`ModemManager`, `libmbim`,
`libqmi`, `libqrtr-glib`), copied byte-for-byte from its pinned salsa commit
([`upstream-pins.yaml`](upstream-pins.yaml) `salsa_commit_sha`) with **zero source patches**.
Only ModemManager carries bookworm adaptations (debhelper relax, `systemd-dev → udev`, and
systemd/udev install-dir pins) — all documented, with rationale, in
[`BOOKWORM-ADAPTATIONS.md`](BOOKWORM-ADAPTATIONS.md).

[`ci/build-bookworm.sh`](ci/build-bookworm.sh) `<amd64|arm64>` rebuilds all four in a
`debian:bookworm` container in the mandatory bootstrap order
`libqrtr-glib → libmbim → libqmi → modemmanager`. Each source's freshly built `.deb`s feed a
temporary **local apt repo** so the next source resolves its build-deps against them (not the
older bookworm-main versions). Arches are **native** — amd64 directly, arm64 via full-system
QEMU (`--platform linux/arm64`) — never cross-built. The script injects
`~ceralive0.0.0~dev` (via [`ci/inject-deb-version.sh`](ci/inject-deb-version.sh)), runs real
`dpkg-buildpackage`, and asserts the **9-package runtime closure** from the `.changes`
(drift ⇒ non-zero exit). `.deb`s land in the gitignored `build/<arch>/`.

## Provenance pins

[`upstream-pins.yaml`](upstream-pins.yaml) pins each source to an exact upstream release
tag and its matching Debian (salsa) packaging tag, and records a three-link chain:

1. **Lineage** — the upstream git tag object + peeled commit SHA (re-resolved by
   `git ls-remote`; the tag is never byte-compared to a git archive).
2. **Authority** — the signed Debian `.dsc`, GPG-verified against a pinned signer
   fingerprint whose armored key lives in [`keys/`](keys/) (acquisition documented in
   [`keys/README.md`](keys/README.md)). A verified `.dsc` is the authority for its tarball
   checksums.
3. **Artifact** — the `.orig.tar`, whose sha256 must equal the pin, which equals the
   `.dsc`'s own `Checksums-Sha256` entry (copied verbatim into the manifest).

`ci/verify-upstream-pins.sh` re-checks all of it in an **isolated** `GNUPGHOME` (never the
caller's `~/.gnupg`) and fails closed with a NAMED field on any drift. The current pins are
ModemManager 1.24.0, libmbim 1.32.0, libqmi 1.36.0, libqrtr-glib 1.2.2 (salsa
`debian/<ver>-1`).

## Versioning

`.deb` internal versions encode the repo's SemVer tag as `<upstream>-<rev>~ceralive<X.Y.Z>`
(upstream-ordered, apt-safe). Full contract: `docs/VERSIONING.md`.

## `ci/` scripts

| Script | Role |
|--------|------|
| [`ci/tag-guard.sh`](ci/tag-guard.sh) | The release-tag contract: accepts only `vX.Y.Z`, fails closed on pre-release / build-metadata / missing-`v`. Sourced by `release.yml` (job 1) and by the version-injection + test scripts. |
| [`ci/test-tag-guard.sh`](ci/test-tag-guard.sh) | Executable proof of the tag-guard negatives (`v1.0.0-rc.1`, `v1.0.0+build5`, `1.0.0`, …). Run in CI and locally. |
| [`ci/inject-deb-version.sh`](ci/inject-deb-version.sh) | Writes `<upstream>-<rev>~ceralive<X.Y.Z>` (or `~ceralive0.0.0~dev` for non-tag builds) into each source's `debian/changelog` top entry via `dch --force-bad-version`. Reads upstream versions from each source's changelog — never hardcoded here. |
| [`ci/verify-upstream-pins.sh`](ci/verify-upstream-pins.sh) | Re-verifies every field of `upstream-pins.yaml` in an isolated `GNUPGHOME`: git-tag lineage (`git ls-remote`), `.dsc` GPG signature vs pinned signer, `.dsc` checksums vs manifest, and the downloaded `.orig.tar` sha256. Exit 0 on success; non-zero with a NAMED failing field on any drift. |
| [`ci/test-verify-upstream-pins.sh`](ci/test-verify-upstream-pins.sh) | Offline fail-closed proof: runs the three [`ci/fixtures/`](ci/fixtures) tampers (wrong-signer / altered-`.dsc` / altered-`.orig.tar`) and asserts each is rejected on the correct named field. Run standalone; the packaging-wave container lane can adopt it. |
| [`ci/build-bookworm.sh`](ci/build-bookworm.sh) | Rebuilds all four sources in a `debian:bookworm` container in bootstrap order via a temporary local apt repo. `build-bookworm.sh <amd64\|arm64>` — native amd64 or full-system-QEMU arm64, never cross-built. Fetches + sha256-verifies each pinned `.orig.tar`, overlays the checked-in `debian/`, injects `~ceralive0.0.0~dev`, runs real `dpkg-buildpackage`, and asserts the 9-package runtime closure from the `.changes` (drift ⇒ non-zero). Output to gitignored `build/<arch>/`. |
| [`ci/contract.sh`](ci/contract.sh) | The packaging **container lane** (bookworm) entry point. Wave-A1 stub: asserts the scaffold is present and the tag-guard + version-injection scripts are wired. Real contract tests (metadata / closure / upgrade / rollback / ordering / daemon smoke) land with the recipes. |
