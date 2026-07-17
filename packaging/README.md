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
> the bootstrap-order container build (`ci/build-bookworm.sh`, amd64 + QEMU arm64), and the
> package **contract suite** (`ci/test-package-contract.sh`) + **daemon smoke**
> (`ci/daemon-smoke.sh`) all landed. Both arches build clean with the exact 9-package runtime
> closure; the contract suite is green on amd64 (full) and arm64 (metadata). The
> deb-artifact + per-release-manifest job runs inside `release.yml`'s `build-deb`.

## Recipes & build

Each source's `debian/` dir is checked in at `<Source>/debian/` (`ModemManager`, `libmbim`,
`libqmi`, `libqrtr-glib`), copied byte-for-byte from its pinned salsa commit
([`upstream-pins.yaml`](upstream-pins.yaml) `salsa_commit_sha`) with **zero source patches**.
All four sources carry one shared bookworm adaptation — the GObject-introspection build-deps
are swapped from the sid GI-1.80 set (`gir1.2-*-2.0-dev` + `gobject-introspection (>= 1.80)`)
to bookworm's GI-1.74 equivalent (`gobject-introspection` + `libgirepository1.0-dev`), mirroring
stock bookworm's own packaging of each source. ModemManager additionally carries three
adaptations (debhelper relax, `systemd-dev → udev`, and systemd/udev install-dir pins) — all
documented, with rationale, stock-bookworm citation, and diff shape, in
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
tag and its matching Debian (salsa) packaging tag, and records a four-link chain:

1. **Lineage** — the upstream git tag object + peeled commit SHA (re-resolved by
   `git ls-remote`; the tag is never byte-compared to a git archive).
2. **Authority** — the signed Debian `.dsc`, GPG-verified against a pinned signer
   fingerprint whose armored key lives in [`keys/`](keys/) (acquisition documented in
   [`keys/README.md`](keys/README.md)). A verified `.dsc` is the authority for its tarball
   checksums.
3. **Artifact** — the `.orig.tar`, whose sha256 must equal the pin, which equals the
   `.dsc`'s own `Checksums-Sha256` entry (copied verbatim into the manifest).
4. **Packaging** — the `.debian.tar.xz`, whose sha256 equals its `.dsc` `Checksums-Sha256`
   entry, and whose extracted `debian/` tree is proven byte-identical to the pinned salsa
   tag's `debian/` tree via a canonical metadata manifest (path, file type, executable bit,
   symlink target, content sha256 per entry — stronger than `diff -r`, which misses exec-bit
   and symlink drift).

`ci/verify-upstream-pins.sh` re-checks all of it in an **isolated** `GNUPGHOME` (never the
caller's `~/.gnupg`) and fails closed with a NAMED field on any drift. The current pins are
ModemManager 1.24.2, libmbim 1.34.0, libqmi 1.38.0, libqrtr-glib 1.4.0 (salsa
`debian/1.24.2-2`, `debian/1.34.0-1`, `debian/1.38.0-1`, `debian/1.4.0-1`).

## Versioning

`.deb` internal versions encode the repo's SemVer tag as `<upstream>-<rev>~ceralive<X.Y.Z>`
(upstream-ordered, apt-safe). Full contract: `docs/VERSIONING.md`.

## `ci/` scripts

| Script | Role |
|--------|------|
| [`ci/tag-guard.sh`](ci/tag-guard.sh) | The release-tag contract: accepts only `vX.Y.Z`, fails closed on pre-release / build-metadata / missing-`v`. Sourced by `release.yml` (job 1) and by the version-injection + test scripts. |
| [`ci/test-tag-guard.sh`](ci/test-tag-guard.sh) | Executable proof of the tag-guard negatives (`v1.0.0-rc.1`, `v1.0.0+build5`, `1.0.0`, …). Run in CI and locally. |
| [`ci/read-pin.sh`](ci/read-pin.sh) | The **shared pin reader**. `read-pin.sh <source> <field>` prints any scalar from `upstream-pins.yaml` (e.g. `read-pin.sh modemmanager upstream_tag` → `1.24.2`); `read-pin.sh <source> --base-version` prints the full Debian base `<upstream>-<rev>` (e.g. `1.24.2-2`) from that source's `debian/changelog` top entry, **cross-checked** to equal the pin's `salsa_tag` suffix (mismatch fails closed). bash+awk only — its YAML reader is byte-identical to `verify-upstream-pins.sh`'s. Sourced by `daemon-smoke.sh`, `test-package-contract.sh`, and `contract.sh` so every version assertion tracks the pins (no hardcoded literals). |
| [`ci/inject-deb-version.sh`](ci/inject-deb-version.sh) | Writes `<upstream>-<rev>~ceralive<X.Y.Z>` (or `~ceralive0.0.0~dev` for non-tag builds) into each source's `debian/changelog` top entry via `dch --force-bad-version`. Reads upstream versions from each source's changelog — never hardcoded here. |
| [`ci/verify-upstream-pins.sh`](ci/verify-upstream-pins.sh) | Re-verifies every field of `upstream-pins.yaml` in an isolated `GNUPGHOME`: git-tag lineage (`git ls-remote`), `.dsc` GPG signature vs pinned signer, `.dsc` checksums vs manifest, the downloaded `.orig.tar` sha256, and — the 4th link — the `.debian.tar.xz` sha256 plus a canonical `debian/`-tree manifest compared against the pinned salsa tag (exec-bit + symlink-target aware). Exit 0 on success; non-zero with a NAMED failing field on any drift. |
| [`ci/test-verify-upstream-pins.sh`](ci/test-verify-upstream-pins.sh) | Offline fail-closed proof: runs the four [`ci/fixtures/`](ci/fixtures) tampers (wrong-signer / altered-`.dsc` / altered-`.orig.tar` / altered-salsa-tree) and asserts each is rejected on the correct named field. Run standalone; the packaging-wave container lane can adopt it. |
| [`ci/build-bookworm.sh`](ci/build-bookworm.sh) | Rebuilds all four sources in a `debian:bookworm` container in bootstrap order via a temporary local apt repo. `build-bookworm.sh <amd64\|arm64>` — native amd64 or full-system-QEMU arm64, never cross-built. Fetches + sha256-verifies each pinned `.orig.tar`, overlays the checked-in `debian/`, injects the version (`RELEASE_VERSION=vX.Y.Z` → `~ceraliveX.Y.Z`; unset → `~ceralive0.0.0~dev`) into a **copy** of each changelog, installs the freshly-built `gir1.2-*-1.0` typelibs into the build env before each dependent source (so bookworm's GI-1.74 `dh_girepository` can resolve cross-namespace typelib deps — Qmi→Qrtr, MM→Qmi/Mbim/Qrtr), runs real `dpkg-buildpackage`, and asserts BOTH the 9-package runtime closure AND per-source package-set **equality** (via `ci/check-package-sets.sh`) from the `.changes` (drift ⇒ non-zero). Output to gitignored `build/<arch>/`. |
| [`ci/check-package-sets.sh`](ci/check-package-sets.sh) | Exact per-source package-set **equality** enforcement. `check-package-sets.sh <changes-dir> [expected-packages.txt]` asserts every `*.changes` binary set EQUALS its `[<source> all-artifact]` set in [`ci/expected-packages.txt`](ci/expected-packages.txt) (the finalized two-set model: declared arch-dependent stanzas + enumerated `-dbgsym`). Equality — not `≥`/count — so an add/remove/rename fails closed naming the offending package. Invoked by `build-bookworm.sh` in-container after the closure check, and standalone per-arch. |
| [`ci/contract.sh`](ci/contract.sh) | The packaging **PR lane** (bookworm container) entry point. Lightweight, needs no built `.deb`: asserts the scaffold, the tag-guard contract, that `dch` version-injection runs on a **copy** (the committed changelogs stay pristine), and the real `dpkg --compare-versions` tilde ordering. The deb-consuming contract lives in the two scripts below. |
| [`ci/test-package-contract.sh`](ci/test-package-contract.sh) | The **package contract suite** over the A5.1 build output. `test-package-contract.sh <amd64\|arm64>` launches a `debian:bookworm` container and runs: metadata/arch over the 9-package closure (revision-exact — every deb's base must equal its `read-pin.sh` `<upstream>-<rev>`); clean-bookworm `apt-get install ./*.deb`; upgrade (stock 1.20.4 → ceralive set) with a **direction-aware** `--allow-downgrades` (computed per-package from real `dpkg --compare-versions` vs `madison` stock — post-bump every source sorts ABOVE stock, so the flag is dropped); rollback (`madison`-derived stock versions + `--allow-downgrades`); coherence (identical `~ceralive` suffix + mismatched-libqmi negative); real ordering proofs; tag-guard negative; piuparts-style install→purge leftover-scan. All version literals are `read-pin.sh`-derived. amd64 = full; arm64 defaults to `metadata` mode (`CONTRACT_MODE=full` forces the apt scenarios under QEMU). |
| [`ci/daemon-smoke.sh`](ci/daemon-smoke.sh) | The **daemon smoke**. `daemon-smoke.sh <amd64\|arm64>` installs system D-Bus + polkit + NetworkManager (bookworm 1.42.4) and the built MM debs, starts a system `dbus-daemon` + `ModemManager`, then asserts: `busctl introspect` shows the root `ObjectManager`; `mmcli --version` matches the **pinned** ModemManager upstream version (via `ci/read-pin.sh`, never hardcoded); the udev-rules + FCC-unlock dispatcher dirs exist; and — **functional GI validation**, not presence-only (it installs `python3-gi valac build-essential pkg-config`) — the `gir1.2-modemmanager-1.0` typelib **loads** through PyGObject (`gi.require_version('ModemManager','1.0')` + a real `ModemManager.ModemCapability.LTE` enum read) and the `libmm-glib` `.vapi` **compiles+links** via `valac -C` → `cc $(pkg-config --cflags --libs mm-glib)` against a Vala program that genuinely calls a libmm-glib symbol (a broken/absent GI-1.74 adaptation fails closed here). amd64 by default. |
| [`ci/generate-release-manifest.sh`](ci/generate-release-manifest.sh) | Emits the **manifest-complete per-release manifest** (`generate-release-manifest.sh <tag>` → `dist/release-manifest.txt`): a checksum row for **every** built deb (both arches), the 9-package runtime closure MARKED (`role=runtime`, the rest `role=aux`) — the `arch package source version role filename sha256` matrix Phase-B apt publication AND `create-release` asset reconciliation consume. Fails closed if the produced set (per source, per arch) is not exactly the frozen `[<source> all-artifact]` set in [`ci/expected-packages.txt`](ci/expected-packages.txt). dpkg-free (filename parse + `sha256sum`), so it runs anywhere. |
| [`ci/resolve-tag.sh`](ci/resolve-tag.sh) | The **shared tag → peeled-commit-SHA resolver** used by `release.yml`. `resolve-tag.sh <repo-url> <tag>` asks the remote (`git ls-remote`, no clone) for both `refs/tags/<tag>` and `refs/tags/<tag>^{}`, prefers the **peeled** commit SHA (an annotated tag otherwise resolves to its tag object), prints it, and fails closed if the tag is absent or ambiguous. ONE script, called from tag-guard (pin every checkout), publish-npm (last-instant pre-publish TOCTOU re-check), and create-release (pre-create re-check) — no divergent copies. A caller detects a moved tag by comparing the output against the pinned SHA. |
| [`ci/reconcile-release-assets.sh`](ci/reconcile-release-assets.sh) | The **immutable, manifest-complete release-asset reconciler** used by `release.yml`'s `create-release`. `reconcile-release-assets.sh <tag> <assets-dir>` takes a flat dir of the raw built debs + the manifest and: verifies the deb set equals the manifest sha256-exactly (missing/extra/corrupt ⇒ fail closed); stages each asset under its **own sanitized basename** (`~` → `.`, never relying on GitHub's upload mapping) and rejects any name **collision**; creates the release if absent; then for each staged asset uploads it if MISSING or integrity-compares (download + sha256) if it already EXISTS — matching ⇒ skip (idempotent), differing ⇒ fail closed (published assets are never overwritten); and finally verifies the live asset set equals the staged set. `RECONCILE_RELEASE_DIR=<dir>` selects a local mock backend for standalone testing. |
