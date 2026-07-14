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
Debian packaging tag. The authoritative pin manifest (`upstream-pins.yaml`) and the
provenance-verification script land in a later task; this directory currently holds the
CI scaffold only.

> **Status:** `[GREENFIELD]` — scaffold only. Real `debian/` recipes, the pin manifest,
> and the container build order arrive in the packaging wave.

## Versioning

`.deb` internal versions encode the repo's SemVer tag as `<upstream>-<rev>~ceralive<X.Y.Z>`
(upstream-ordered, apt-safe). Full contract: `docs/VERSIONING.md`.

## `ci/` scripts

| Script | Role |
|--------|------|
| [`ci/tag-guard.sh`](ci/tag-guard.sh) | The release-tag contract: accepts only `vX.Y.Z`, fails closed on pre-release / build-metadata / missing-`v`. Sourced by `release.yml` (job 1) and by the version-injection + test scripts. |
| [`ci/test-tag-guard.sh`](ci/test-tag-guard.sh) | Executable proof of the tag-guard negatives (`v1.0.0-rc.1`, `v1.0.0+build5`, `1.0.0`, …). Run in CI and locally. |
| [`ci/inject-deb-version.sh`](ci/inject-deb-version.sh) | Writes `<upstream>-<rev>~ceralive<X.Y.Z>` (or `~ceralive0.0.0~dev` for non-tag builds) into each source's `debian/changelog` top entry via `dch --force-bad-version`. Reads upstream versions from each source's changelog — never hardcoded here. |
| [`ci/contract.sh`](ci/contract.sh) | The packaging **container lane** (bookworm) entry point. Wave-A1 stub: asserts the scaffold is present and the tag-guard + version-injection scripts are wired. Real contract tests (metadata / closure / upgrade / rollback / ordering / daemon smoke) land with the recipes. |
