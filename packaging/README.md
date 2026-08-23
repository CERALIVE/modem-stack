# packaging

Bookworm rebuilds of the ModemManager stack — **packaging only, not a fork**. libmbim,
libqmi, and libqrtr-glib remain source-unmodified; ModemManager carries one owner-approved,
three-patch BELABOX-derived FM350-GL series (see `POLICY.md` and
[`ADR-FM350-RNDIS-BEARER.md`](../docs/adr/ADR-FM350-RNDIS-BEARER.md)). Bench devices install
the resulting `.deb`s from CI artifacts; nothing is published to `apt.ceralive.tv` yet — apt
publication is part of Phase B adoption, authorized from the `v1.0.0` release tag forward
(`POLICY.md` §4).

## Sources (4 upstream rebuilds + 1 first-party companion)

The four sources below remain pinned upstream rebuilds. Three carry no source patch;
ModemManager carries only the reviewed FM350-GL series described below. The first-party
[`ceralive-modem-support`](ceralive-modem-support/) companion keeps CeraLive-owned generic
system assets out of every upstream recipe — see
[First-party companion](#first-party-companion-ceralive-modem-support).


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
> deb-artifact + per-release-manifest job runs inside `release.yml`'s `build-deb`, which is
> now **differential** — see [The differential build flow](#the-differential-build-flow).

## Recipes & build

Each source's `debian/` dir is checked in at `<Source>/debian/` (`ModemManager`, `libmbim`,
`libqmi`, `libqrtr-glib`), based on its pinned salsa commit
([`upstream-pins.yaml`](upstream-pins.yaml) `salsa_commit_sha`). libmbim, libqmi, and
libqrtr-glib carry no source patches. ModemManager adds only the three entries in
`ModemManager/debian/patches/series`, each attributed to exact BELABOX commits and governed
by the accepted FM350 ADR.
All four sources carry one shared bookworm adaptation — the GObject-introspection build-deps
are swapped from the sid GI-1.80 set (`gir1.2-*-2.0-dev` + `gobject-introspection (>= 1.80)`)
to bookworm's GI-1.74 equivalent (`gobject-introspection` + `libgirepository1.0-dev`), mirroring
stock bookworm's own packaging of each source. ModemManager additionally carries three
adaptations (debhelper relax, `systemd-dev → udev`, and systemd/udev install-dir pins) — all
documented, with rationale, stock-bookworm citation, and diff shape, in
[`BOOKWORM-ADAPTATIONS.md`](BOOKWORM-ADAPTATIONS.md).

### Approved ModemManager source series

`ModemManager/debian/patches/series` is intentionally non-empty and contains exactly three
logical changes: the 1.24-native FM350-GL RNDIS bearer plus `+GTACT` mode support, the CPOL
crash-disable device row, and the standalone extended-`+COPS` parser fix with its regression
test. Each DEP-3-style header credits `rationalsa <belaboxproject@gmail.com>`, names the exact
BELABOX origin SHA(s), and records `Forwarded: no` because the upstream MR is drafted but not
filed. Project-owner approval is dated 2026-08-22 in the ADR and POLICY exception. The series
is build-tested and hardware-validated on the carrier-mediated USB topology; no PCIe support
claim exists until the production-topology board drill
proves plugin binding, bearer activation, and routable IPv4.

[`ci/build-bookworm.sh`](ci/build-bookworm.sh) `<amd64|arm64>` rebuilds the **selected**
sources in a `debian:bookworm` container in the mandatory bootstrap order
`libqrtr-glib → libmbim → libqmi → modemmanager`. Each source's freshly built `.deb`s feed a
temporary **local apt repo** so the next source resolves its build-deps against them (not the
older bookworm-main versions). Arches are **native** — amd64 directly, arm64 via full-system
QEMU (`--platform linux/arm64`) — never cross-built. On a dev run the script injects
`~ceralive0.0.0~dev` (via [`ci/inject-deb-version.sh`](ci/inject-deb-version.sh)), runs real
`dpkg-buildpackage`, and asserts the **9-package runtime closure** (drift ⇒ non-zero exit).
`.deb`s land in the gitignored `build/<arch>/`. Run with neither `VERDICTS_FILE` nor
`BUILD_SOURCES` set, it builds all four — the local-development default, and deliberately not
what CI relies on.

### The differential build flow

A release rebuilds **only the sources whose inputs actually moved**. Everything else is
carried forward byte-identically from the release that last built it. Builds are not
reproducible, so an unchanged source can never be re-created at its old version; reusing the
exact recorded artifacts is the only honest way to keep a release self-contained. The flow,
wired in `release.yml`'s `build-deb`:

1. **Resolve the previous release and fetch its manifest — ONCE.** The one resolved path
   feeds all three consumers below, so they cannot disagree. `gh release list`, never
   `git describe`: the previous release is the latest PUBLISHED release, which is a different
   question from "nearest tag".
2. **Detect** — [`ci/detect-changed-sources.sh`](ci/detect-changed-sources.sh) emits a
   `<pin-key>=changed|unchanged` line per source plus `mode=differential|force-all`. A source
   is `changed` when the diff touched its `packaging/<Source>/**` recipe or its own
   block-scoped entry in `upstream-pins.yaml`. It is **fail-SAFE toward rebuilding**: a shared
   input change (`packaging/ci/**`, `BOOKWORM-ADAPTATIONS.md`), an absent previous release or
   manifest, a v1-shaped manifest, or `FORCE_REBUILD=all` each force-all. A wrong `unchanged`
   would ship stale bytes; a wrong `changed` only costs build time.
3. **Stage the carry-forward** — [`ci/stage-carryforward-debs.sh`](ci/stage-carryforward-debs.sh)
   downloads every row of each `unchanged` source (runtime **and** aux — `-dbgsym`, `-dev`,
   `gir1.2-*`) from the previous release, reverses the uploader's `~`→`.` asset-name
   sanitization, sha256-verifies each file against its manifest row, and lands it under the
   canonical `~` name in `build/<arch>/`. Missing, ambiguous, or mismatching ⇒ fail closed
   naming the row. This step runs **strictly before any build**: the carried debs are a build
   INPUT, because the builder seeds its Pin-Priority-1001 local apt repo from `build/<arch>/`,
   so a changed source resolves its build-deps and gir typelibs against the carried
   `-dev`/`gir1.2-*` packages rather than stock bookworm. Staging late still goes green and
   silently reintroduces stock dependencies, which is why the ordering is pinned by
   [`ci/test-release-workflow-wiring.sh`](ci/test-release-workflow-wiring.sh).
4. **Build the selected set** — `VERDICTS_FILE` supplies the build set explicitly. Skipped
   sources' already-staged debs are seeded into the local repo before the first build; only
   stale `*.changes`/`*.buildinfo` and artifacts of the selected sources are removed. Each
   selected source gets one `inject-deb-version.sh` call which derives that source's next
   `~ceralive.N` counter from the already-resolved previous manifest.
5. **Assert the MERGED closure** — the 9-package runtime closure is asserted at the end of
   every run over built **plus** carried debs. A **zero-build run** starts no container at all
   and still performs that assertion.

The companion `ceralive-modem-support` sits outside all of it: never detected, never carried,
always rebuilt — see [First-party companion](#first-party-companion-ceralive-modem-support)
below.

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

## First-party companion: `ceralive-modem-support`

`ceralive-modem-support` is a **first-party, `Architecture: all`** package built from
[`ceralive-modem-support/`](ceralive-modem-support/). It owns CeraLive's UNCONDITIONAL,
generic, board-independent modem system assets. The companion still keeps CeraLive-owned
system assets out of all four upstream recipes. The reviewed ModemManager FM350-GL source
carry is a separate exception and moves none of those assets into ModemManager.

### Ownership boundary

| Asset class | Owner | Why |
|---|---|---|
| CeraLive modem udev rules (identification/tagging only) | **companion** | generic; exact VID:PID + interface predicates, no device mutation |
| usb-modeswitch Zero-CD device data | **companion** | generic; mass-storage → modem composition only |
| FCC policy-reconciliation helper + its oneshot unit | **companion** | generic; reads an operator policy at runtime |
| Active FCC-unlock scripts | **nobody (none ship)** | todo 33: authored scripts ship inactive and activate only via the opt-in symlink |
| M.2 SIM quirk rows (`CERALIVE_BOARD_QUIRKS`) | **device image** | consumes build-time board facts a generic package cannot know |
| Per-slot modem UID rules (`modem_ports.status=verified`) | **device image** | same — hardware-verified per-board `ID_PATH`s |
| modem node permission/group policy | **device image** | a generic package must not mutate device nodes |

### Installation table (per-asset, NOT a blanket `/usr/lib` rule)

| Asset | Packaged destination | Admin override tier |
|---|---|---|
| udev rules | `/usr/lib/udev/rules.d/60-ceralive-modem.rules` | `/etc/udev/rules.d/` |
| usb-modeswitch device data | `/usr/share/usb_modeswitch/<vid>:<pid>` | `/etc/usb_modeswitch.d/` |
| FCC reconcile helper | `/usr/lib/ceralive-modem-support/ceralive-fcc-reconcile` | — |
| FCC reconcile unit | `/usr/lib/systemd/system/ceralive-fcc-reconcile.service` | `/etc/systemd/system/` |
| legacy-override hash list | `/usr/share/ceralive-modem-support/` | — |

ModemManager 1.24 exposes **no vendor `conf.d` tier** — verified against the pinned Debian
packaging, whose only `/etc` surface is the D-Bus policy file. Its documented per-device
configuration mechanism is udev properties, so CeraLive's MM-directed configuration rides
the packaged rules file rather than a conf snippet. ModemManager's own available FCC-unlock
tier (`/usr/share/ModemManager/fcc-unlock.available.d`) receives nothing from this package.

### The FCC-unlock tiers, and which one the reconciler owns

ModemManager has THREE fcc-unlock directories and consults only two of them. Getting the
pair wrong is silent — a link in the wrong place is simply never opened:

| Tier | Path (Debian) | Who owns it |
|---|---|---|
| available | `/usr/share/ModemManager/fcc-unlock.available.d/` | ModemManager. Shipped-but-INERT; nothing here ever runs. |
| enabled — **admin** | `/etc/ModemManager/fcc-unlock.d/` | **this package's reconciler**, and only from an operator opt-in |
| enabled — package | `${libdir}/ModemManager/fcc-unlock.d/` (multiarch) | a distribution package. **CeraLive writes here never.** |

`src/mm-dispatcher-fcc-unlock.c` builds ONE filename, `g_strdup_printf("%04x:%04x", vid,
pid)`, and looks for it in the admin tier then the package tier. It opens no other name,
so a vendor-only file (`2c7c`) is never a dispatcher target — it exists only as what the
available tier's `<vid>:<pid>` symlinks point AT. The policy therefore keys on
`<vid>:<pid>` too, and the reconciler refuses a vendor-only key.

Full coverage matrix and the fleet verdicts: [`../docs/FCC-UNLOCK-COVERAGE.md`](../docs/FCC-UNLOCK-COVERAGE.md).

### The udev basename hazard (read before renaming anything)

udev resolves rules by **basename** across its search path, and a file in
`/etc/udev/rules.d` **shadows** a same-basename file in `/usr/lib/udev/rules.d` completely.
The shadowing file is owned by whatever wrote it, so `dpkg -S` on the packaged path keeps
naming this package and **the substitution is undetectable from package metadata**.

The device image owns `/etc/udev/rules.d/99-ceralive-hardware.rules` and
`78-mm-ceralive-slot-uid.rules`. The companion therefore uses the distinct, modem-only
basename `60-ceralive-modem.rules`, which no image-owned `/etc` file shares. The chroot QA
asserts both halves of this: the `/etc` copy wins precedence, and `dpkg -S` cannot see it.

The postinst removes a stale same-basename `/etc` override **only** when it is a KNOWN
legacy generated payload — marker header **and** a sha256 listed in
`debian/legacy-etc-overrides.sha256`. Anything unknown, or an operator's edit of a generated
file, is **preserved**; Debian admin-override semantics stand. Both branches are tested.

### Two-stage QA

A clean chroot has no sysfs devices and no running daemons, so the contract is split:

* **CHROOT stage** — [`ci/test-companion-chroot.sh`](ci/test-companion-chroot.sh), run in a
  clean `debian:trixie` container: fresh install, declared-inventory equality, chroot guard
  (with a non-vacuity leg), single-owner `dpkg -S`, `/etc` override precedence, both
  override-removal branches, the FCC absent/enabled/opt-out/malformed/foreign-file matrix
  (against the real `/etc` admin tier and `<vid>:<pid>` keys), upgrade with no
  conffile prompt, downgrade, and purge-with-zero-leftovers.
* **CONSUMER stage** — bench-board only: `udevadm test` against a real modem's sysfs path,
  `usb_modeswitch -c`, `systemd-analyze verify` + `systemctl is-enabled` + a real boot's
  journal proving `ceralive-migrate-data → fcc-reconcile → ModemManager`, and ModemManager's
  effective configuration listing. Not runnable in a container and deliberately not faked.

### Versioning

The companion is a **native** package versioned with the repo's SemVer tag verbatim
(`v1.1.0` → `1.1.0`). It does NOT use the upstream rebuilds' `<upstream>-<rev>~ceralive.N`
form: there is no upstream version to order against, no rebuild counter to carry, and a bare
SemVer sorts correctly on its own. Non-tag builds are `0.0.0~dev`.

It is **always rebuilt**, on every release, and that rationale survives the differential
pipeline intact — apt-worker's closure health check greps `^Version: <pin>$`, which only the
companion's bare tag version can satisfy, so a carried-forward companion at last release's
version would fail that check. It is therefore never enumerated by change detection, never
verdicted, and never staged as a carry-forward; a companion-only change correctly leaves all
four upstream sources `unchanged`.

It is built **exactly once** into `build/all/`. A per-arch build would produce two
byte-different files under one package/version key, which the APT publisher's immutable-key
rule refuses.

## Versioning

`.deb` internal versions carry a **per-source rebuild counter**,
`<upstream>-<rev>~ceralive.N` (upstream-ordered, apt-safe) — not the release tag. A rebuilt
source takes its previous counter + 1, derived from the previous release manifest's rows for
that source and accepted only if those rows are coherent; a carried-forward source keeps the
counter it already had. Two sources at different counters within one release is what a
differential release produces, and is accepted; a source disagreeing with **itself** fails
closed naming that source. The migration-continuity chain
`~ceralive0.2.0 < ~ceralive1.0.0 < ~ceralive1.1.0 < ~ceralive.1 < ~ceralive.2 < ~ceralive.10
< <upstream>-<rev>` is proven with real `dpkg --compare-versions` by the one sourced library
[`ci/suffix-contract.sh`](ci/suffix-contract.sh). The release manifest states
`suffix_scheme: per-source-counter` and carries no `deb_version_suffix:`. Full contract:
`docs/VERSIONING.md`.

## `ci/` scripts

| Script | Role |
|--------|------|
| [`ci/tag-guard.sh`](ci/tag-guard.sh) | The release-tag contract: accepts only `vX.Y.Z`, fails closed on pre-release / build-metadata / missing-`v`. Sourced by `release.yml` (job 1) and by the version-injection + test scripts. |
| [`ci/test-tag-guard.sh`](ci/test-tag-guard.sh) | Executable proof of the tag-guard negatives (`v1.0.0-rc.1`, `v1.0.0+build5`, `1.0.0`, …). Run in CI and locally. |
| [`ci/read-pin.sh`](ci/read-pin.sh) | The **shared pin reader**. `read-pin.sh <source> <field>` prints any scalar from `upstream-pins.yaml` (e.g. `read-pin.sh modemmanager upstream_tag` → `1.24.2`); `read-pin.sh <source> --base-version` prints the full Debian base `<upstream>-<rev>` (e.g. `1.24.2-2`) from that source's `debian/changelog` top entry, **cross-checked** to equal the pin's `salsa_tag` suffix (mismatch fails closed); `read-pin.sh --list-sources` prints the pinned source NAMES one per line, exposing the reader's own `yaml_sources` so an iterating caller (`check-upstream-freshness.sh`) needs no second copy of the YAML parser. bash+awk only — its YAML reader is byte-identical to `verify-upstream-pins.sh`'s. Sourced by `daemon-smoke.sh`, `test-package-contract.sh`, and `contract.sh` so every version assertion tracks the pins (no hardcoded literals). |
| [`ci/detect-changed-sources.sh`](ci/detect-changed-sources.sh) | **Step 1 of the differential pipeline.** Prints `<pin-key>=changed\|unchanged` for all four sources in bootstrap order plus `mode=differential\|force-all`; `--out <file>` also writes them for a later job step. A source is `changed` when the diff `<prev>..HEAD` touched `packaging/<Source>/**` or its own **block-scoped** entry in `upstream-pins.yaml` (so a comment edit or a neighbour's pin bump does not implicate it). Force-all — every source `changed`, reason logged — on a shared-input change (`packaging/ci/**`, `BOOKWORM-ADAPTATIONS.md`), an absent previous release or manifest, a **v1-shaped** manifest (no `closure_version:` header — an absent header IS version 1), or `FORCE_REBUILD=all`. Fail-SAFE means REBUILD EVERYTHING: a wrong `unchanged` ships stale bytes, a wrong `changed` only costs build time. The previous release is resolved with `gh release list`, never `git describe` (latest PUBLISHED release ≠ nearest tag). Offline seams: `PREV_TAG`, `PREV_MANIFEST_FILE`, `HEAD_REF`, `GH_REPO`. The companion is never enumerated — it always rebuilds. |
| [`ci/test-detect-changed-sources.sh`](ci/test-detect-changed-sources.sh) | The detector's contract — builds its own throwaway git repo and stubs `gh` on `PATH`, so no docker, no network and no built `.deb`. Runs in the lightweight PR lane. |
| [`ci/stage-carryforward-debs.sh`](ci/stage-carryforward-debs.sh) | **Step 2 of the differential pipeline.** Stages EVERY row of each `unchanged` source — runtime **and** aux (`-dbgsym`, `-dev`, `gir1.2-*`); the `role` column is deliberately not filtered on, or a release would silently drop ~36 debs — from the previous release into `build/<arch>/`, sha256-verified against its manifest row. Reads the verdict stream on stdin or `--verdicts <file>` rather than re-running detection, which must happen exactly once per run. It reverses the uploader's `~`→`.` asset-name sanitization by turning each `~` into a single-char `?` glob (a blanket `.`→`~` would hit legitimate dots) and requires EXACTLY ONE match; the staged file always lands under the canonical `~` name. Fails closed naming the offending row on a missing/ambiguous asset, a sha256 mismatch, an unknown source, an `unchanged` source with zero previous rows, a v1-shaped manifest, or a destination file with different bytes. The companion row is skipped explicitly. `mode=force-all` stages nothing and exits 0 without reading a manifest at all. |
| [`ci/test-stage-carryforward-debs.sh`](ci/test-stage-carryforward-debs.sh) | The stager's contract — builds its own fixture manifest + GitHub-mangled asset dir and drives the script through the `PREV_MANIFEST_FILE` / `CARRYFORWARD_ASSET_DIR` seams. No docker, no network, no built `.deb`. |
| [`ci/inject-deb-version.sh`](ci/inject-deb-version.sh) | Writes ONE selected source's rebuild version into its `debian/changelog` top entry via `dch --force-bad-version`. `--source <pin-key>` is required — injection may only touch a source actually being built. Release builds derive `<upstream>-<rev>~ceralive.N` from `PREV_MANIFEST_FILE`, the previous manifest the CALLER already resolved (this script never fetches a release): every row for that source is read across both arches and both roles, and the counter is accepted only if they agree. A disagreement, a counter/legacy mixture, or a malformed suffix **fails closed naming the source**; entirely-legacy rows, or no previous manifest during the force-all bootstrap, initialize at `.1`. `--dev` keeps the fixed `~ceralive0.0.0~dev`. Upstream versions come from the changelog — never hardcoded here. |
| [`ci/verify-upstream-pins.sh`](ci/verify-upstream-pins.sh) | Re-verifies every field of `upstream-pins.yaml` in an isolated `GNUPGHOME`: git-tag lineage (`git ls-remote`), `.dsc` GPG signature vs pinned signer, `.dsc` checksums vs manifest, the downloaded `.orig.tar` sha256, and — the 4th link — the `.debian.tar.xz` sha256 plus a canonical `debian/`-tree manifest compared against the pinned salsa tag (exec-bit + symlink-target aware). Exit 0 on success; non-zero with a NAMED failing field on any drift. |
| [`ci/test-verify-upstream-pins.sh`](ci/test-verify-upstream-pins.sh) | Offline fail-closed proof: runs the four [`ci/fixtures/`](ci/fixtures) tampers (wrong-signer / altered-`.dsc` / altered-`.orig.tar` / altered-salsa-tree) and asserts each is rejected on the correct named field. Run standalone; the packaging-wave container lane can adopt it. |
| [`ci/check-upstream-freshness.sh`](ci/check-upstream-freshness.sh) | The **upstream freshness watch** behind [`.github/workflows/upstream-watch.yml`](../.github/workflows/upstream-watch.yml). For every source it enumerates the upstream release tags and the salsa `debian/*` packaging tags with `git ls-remote --tags`, keeps only STABLE members, and compares them to the pins (read through `read-pin.sh` — it parses no YAML itself). Three verdicts: `current`, `behind (<v>)`, and the deliberately distinct `upstream-ahead-no-packaging (<v>)` — upstream released but Debian has not packaged it, so there is no `<upstream>-<rev>` pair to pin and no bump to recommend. The stable filter rejects `-rc`/`-dev`/`-alpha`/`-beta`/`-pre`, anything that is not a plain `X.Y.Z`, **odd-minor development series** (the GNOME/freedesktop convention all four projects follow — ModemManager `1.25.95` is the unstable train toward 1.26.0 and went to Debian *experimental*), `.9x` snapshot micros, and `~`-bearing Debian revisions. Exit `0` = no bump, `10` = at least one source behind. `--dry-run` prints the would-be issue body and makes no API call; **the script is issue-only and can neither edit a pin nor dispatch a build** (locked by a source-scan fence in its test). |
| [`ci/test-check-upstream-freshness.sh`](ci/test-check-upstream-freshness.sh) | The watch's **offline** contract — no network, no container. Drives the script through its documented `UPSTREAM_FRESHNESS_FIXTURE_DIR` seam, which swaps `git ls-remote` for verbatim fixture output so the tag parse under test is the real one. Cases: all-current ⇒ no issue body; upstream `1.26.0` + `debian/1.26.0-1` ⇒ `behind` with both versions named in the body; **only `1.25.95` ⇒ still `current`** (the real dev-series trap, proven on both the upstream tag and the `debian/1.25.95-1` experimental tag); newer upstream with no packaging tag ⇒ `upstream-ahead-no-packaging`, never `behind`; `-rc`/`-dev`/`.90`/`v`-prefixed noise ⇒ each rejected on its own named reason; packaging-only revision bump ⇒ `behind` naming the packaging tag; plus the issue-only source fence with a two-way non-vacuity control. |
| [`ci/build-bookworm.sh`](ci/build-bookworm.sh) | **Step 3 of the differential pipeline.** Rebuilds the SELECTED sources in a `debian:bookworm` container in bootstrap order via a temporary local apt repo. `build-bookworm.sh <amd64\|arm64>` — native amd64 or full-system-QEMU arm64, never cross-built. The build set comes from `VERDICTS_FILE` (the detector's output) or an explicit `BUILD_SOURCES` list; supplying both fails closed, supplying neither builds all four (the local-dev default, never what CI relies on). Before the first build it seeds the Pin-Priority-1001 local repo with every already-staged deb of each SKIPPED source, so a selected source resolves stack build-deps and gir typelibs against carried CeraLive packages rather than stock bookworm; carried debs are preserved and only stale `*.changes`/`*.buildinfo` plus the selected sources' own artifacts are removed. Release builds call `inject-deb-version.sh` once per selected source, passing the caller's already-resolved `PREV_MANIFEST_FILE`. The runtime closure is asserted from the **MERGED** staged set (built + carried), and a zero-source run starts no container yet still performs that assertion. Fetches + sha256-verifies each pinned `.orig.tar`, overlays the checked-in `debian/`, injects the version (`RELEASE_VERSION=vX.Y.Z` → that source's derived `~ceralive.N`; unset → `~ceralive0.0.0~dev`) into a **copy** of each changelog, installs the freshly-built `gir1.2-*-1.0` typelibs into the build env before each dependent source (so bookworm's GI-1.74 `dh_girepository` can resolve cross-namespace typelib deps — Qmi→Qrtr, MM→Qmi/Mbim/Qrtr), runs real `dpkg-buildpackage`, and asserts per-source package-set **equality** (via `ci/check-package-sets.sh`) from each freshly built source's `.changes` plus the 9-package runtime closure over the merged staged set (drift ⇒ non-zero). Output to gitignored `build/<arch>/`. |
| [`ci/test-build-bookworm-differential.sh`](ci/test-build-bookworm-differential.sh) | The differential builder's contract. Its `BUILD_BOOKWORM_STUB_DIR` seam replaces only the expensive source-build body with source-keyed fixture artifacts; build-set parsing, carry seeding, bootstrap dispatch, counter derivation, package-set checking and the merged-closure assertion all run through their production paths. No docker, no network. |
| [`ci/check-package-sets.sh`](ci/check-package-sets.sh) | Exact per-source package-set **equality** enforcement. `check-package-sets.sh <changes-dir> [expected-packages.txt]` asserts every `*.changes` binary set EQUALS its `[<source> all-artifact]` set in [`ci/expected-packages.txt`](ci/expected-packages.txt) (the finalized two-set model: declared arch-dependent stanzas + enumerated `-dbgsym`). Equality — not `≥`/count — so an add/remove/rename fails closed naming the offending package. Invoked by `build-bookworm.sh` in-container after the closure check, and standalone per-arch. |
| [`ci/contract.sh`](ci/contract.sh) | The packaging **PR lane** (bookworm container) entry point. Lightweight, needs no built `.deb`: asserts the scaffold, the tag-guard contract, that `dch` version-injection runs on a **copy** (the committed changelogs stay pristine), and the real `dpkg --compare-versions` tilde ordering. It also runs the registered offline suites for tag guarding, change detection, carry-forward staging, differential builds, suffix coherence, release wiring, upstream freshness, and the FM350 patch contract. The deb-consuming contract lives in `test-package-contract.sh` + `daemon-smoke.sh`. |
| [`ci/test-package-contract.sh`](ci/test-package-contract.sh) | The **package contract suite** over the A5.1 build output. `test-package-contract.sh <amd64\|arm64>` launches a `debian:bookworm` container and runs: metadata/arch over the 9-package closure (revision-exact — every deb's base must equal its `read-pin.sh` `<upstream>-<rev>`); clean-bookworm `apt-get install ./*.deb`; upgrade (stock 1.20.4 → ceralive set) with a **direction-aware** `--allow-downgrades` (computed per-package from real `dpkg --compare-versions` vs `madison` stock — post-bump every source sorts ABOVE stock, so the flag is dropped); rollback (`madison`-derived stock versions + `--allow-downgrades`); **per-source** coherence (one `~ceralive` suffix WITHIN each upstream source — two sources at different rebuild counters is what a differential release produces and is accepted; the retained negative is now a source disagreeing with ITSELF, and it fails closed naming that source); real ordering proofs including the migration-continuity chain; tag-guard negative; piuparts-style install→purge leftover-scan. All version literals are `read-pin.sh`-derived. amd64 = full; arm64 defaults to `metadata` mode (`CONTRACT_MODE=full` forces the apt scenarios under QEMU). |
| [`ci/daemon-smoke.sh`](ci/daemon-smoke.sh) | The **daemon smoke**. `daemon-smoke.sh <amd64\|arm64>` installs system D-Bus + polkit + NetworkManager (bookworm 1.42.4) and the built MM debs, starts a system `dbus-daemon` + `ModemManager`, then asserts: `busctl introspect` shows the root `ObjectManager`; `mmcli --version` matches the **pinned** ModemManager upstream version (via `ci/read-pin.sh`, never hardcoded); the udev-rules + FCC-unlock dispatcher dirs exist; and — **functional GI validation**, not presence-only (it installs `python3-gi valac build-essential pkg-config`) — the `gir1.2-modemmanager-1.0` typelib **loads** through PyGObject (`gi.require_version('ModemManager','1.0')` + a real `ModemManager.ModemCapability.LTE` enum read) and the `libmm-glib` `.vapi` **compiles+links** via `valac -C` → `cc $(pkg-config --cflags --libs mm-glib)` against a Vala program that genuinely calls a libmm-glib symbol (a broken/absent GI-1.74 adaptation fails closed here). amd64 by default. |
| [`ci/build-companion.sh`](ci/build-companion.sh) | Builds the first-party `ceralive-modem-support` companion `.deb` — ONCE, `Architecture: all`, into `build/all/`. Container by default (`debian:bookworm`), `--native` for the local QA loop. `RELEASE_VERSION=vX.Y.Z` → Version `X.Y.Z` (unset → `0.0.0~dev`), injected into a COPY of the changelog. Fails closed if the produced deb's `Architecture` is not `all` or its `Version` is not the requested one. |
| [`ci/test-fcc-reconcile.sh`](ci/test-fcc-reconcile.sh) | The FCC reconciler's **behaviour** contract, runnable on any host with no container and no root: every path is redirected into a scratch tree via `CERALIVE_FCC_{POLICY_FILE,AVAILABLE_DIR,ACTIVE_DIR}`. Covers absent/malformed/opt-out/idempotence, the one-model policy that must not parse as empty, the refused vendor-only key, an enabled model MM ships no script for, and both foreign-entry cases (a real file and a symlink pointing outside the available tier). Complements — never replaces — the chroot contract, which proves the same logic from the PACKAGED location after a real `dpkg` install. |
| [`ci/test-companion-chroot.sh`](ci/test-companion-chroot.sh) | The companion's **CHROOT-stage** contract in a clean `debian:trixie` container: install / declared-inventory equality / chroot guard (+ non-vacuity) / single-owner `dpkg -S` / `/etc` override precedence / both override-removal branches / FCC absent-enabled-malformed matrix / upgrade with no conffile prompt / downgrade / purge with zero leftovers. Builds 0.9.0 and 1.1.0 so the upgrade and downgrade legs exercise real dpkg. The consumer stage is bench-gated. |
| [`ci/companion-inventory.txt`](ci/companion-inventory.txt) | The companion's frozen declared file inventory, compared for EQUALITY by the chroot QA — an added, dropped or relocated asset fails the gate naming itself. |
| [`ci/generate-release-manifest.sh`](ci/generate-release-manifest.sh) | Emits the **manifest-complete per-release manifest** (`generate-release-manifest.sh <tag>` → `dist/release-manifest.txt`): a checksum row for **every** built deb (both arches), the 9-package runtime closure MARKED (`role=runtime`, the rest `role=aux`) — the `build_arch package source version role filename sha256` matrix Phase-B apt publication AND `create-release` asset reconciliation consume. Emits **`closure_version: 2`** — the versioned contract apt-worker validates against — which adds the `Architecture: all` companion as ONE row with `build_arch` `all`, alongside the unchanged 9 × 2 arch-dependent rows. Build architecture and index membership are separate: `all` enters EVERY index arch, anything else its own. Per-source equality is scoped by `[arch-all sources]` so `build/all` is checked against the companion only and `build/<arch>` against the four upstream sources only. Fails closed on any set drift. dpkg-free (filename parse + `sha256sum`), so it runs anywhere. Emits **`suffix_scheme: per-source-counter`** and NO `deb_version_suffix:` — under per-source rebuild counters no single suffix value is truthful, so the header states the scheme and each row keeps carrying its own version (apt-worker's validator reads neither field). |
| [`ci/suffix-contract.sh`](ci/suffix-contract.sh) | SOURCED library — the `~ceralive` suffix contract in ONE place. `assert_group_coherence <pkg>=<ver>…` groups packages by owning source (derived from `expected-packages.txt`, never a second frozen list) and asserts each source's OWN internal coherence, so differing counters ACROSS sources pass while a source disagreeing with itself fails closed naming it. `prove_chain_ordered <base>` runs the **migration-continuity chain** — `~ceralive0.2.0 < ~ceralive1.0.0 < ~ceralive1.1.0 < ~ceralive.1 < ~ceralive.2 < ~ceralive.10 < <upstream>-<rev>` — through real `dpkg --compare-versions`; its legacy members are every version that exists as a published artifact today, so the chain is the proof that every fleet device upgrades cleanly into the counter scheme. Sourced by `test-package-contract.sh` (CHECK 5/6) and `test-suffix-coherence-manifest.sh` so the container lane and the host lane cannot prove different rules. |
| [`ci/test-suffix-coherence-manifest.sh`](ci/test-suffix-coherence-manifest.sh) | The per-source-suffix + mixed-version-manifest contract — host-runnable, offline, **no docker**. Proves: sources at differing counters are accepted while an internally-mixed source fails closed naming itself; the full migration chain under real `dpkg` (with a non-vacuity control showing a lexical compare inverts `.2` vs `.10`); `generate-release-manifest.sh` over a MIXED staged set emits the new header, no `deb_version_suffix:`, and a row per staged deb at each source's own version; and a ZERO-UPSTREAM-BUILD set (only the companion fresh) keeps every upstream row at its carried counter with only the companion at the bare tag version. Every expected count is COUNTED from the fixture that produced it — no total is written down. |
| [`ci/test-release-workflow-wiring.sh`](ci/test-release-workflow-wiring.sh) | The **static** proof that `release.yml`'s `build-deb` is wired the way the differential pipeline needs. It reads the workflow text and never dispatches a run: step presence, the ordering chain (previous-release resolution → detection → carry-forward staging → **every** executable `build-bookworm.sh` mention, comment lines excluded), `fetch-depth: 0` inside the `build-deb` slice specifically, and an awk detector for any `${{ }}` interpolated into a `run:` body. It exists because the invariant it guards fails SILENTLY — staging after the build still produces a green release, built against stock bookworm dependencies. `RELEASE_WORKFLOW_FILE` points it at a scratch copy for failure demonstrations, so the tracked workflow is never mutated. |
| [`ci/test-fm350-patch-contract.sh`](ci/test-fm350-patch-contract.sh) | Static regression gate for the hardware-required FM350 first-enable override: the carried patch must install `enabling_modem_init`, send `Z0`, and never regress that override to core `Z` (which firmware `81600.0000.00.19.17.10` rejects with CME 59). |
| [`ci/resolve-tag.sh`](ci/resolve-tag.sh) | The **shared tag → peeled-commit-SHA resolver** used by `release.yml`. `resolve-tag.sh <repo-url> <tag>` asks the remote (`git ls-remote`, no clone) for both `refs/tags/<tag>` and `refs/tags/<tag>^{}`, prefers the **peeled** commit SHA (an annotated tag otherwise resolves to its tag object), prints it, and fails closed if the tag is absent or ambiguous. ONE script, called from tag-guard (pin every checkout), publish-npm (last-instant pre-publish TOCTOU re-check), and create-release (pre-create re-check) — no divergent copies. A caller detects a moved tag by comparing the output against the pinned SHA. |
| [`ci/reconcile-release-assets.sh`](ci/reconcile-release-assets.sh) | The **immutable, manifest-complete release-asset reconciler** used by `release.yml`'s `create-release`. `reconcile-release-assets.sh <tag> <assets-dir>` takes a flat dir of the raw built debs + the manifest and: verifies the deb set equals the manifest sha256-exactly (missing/extra/corrupt ⇒ fail closed); stages each asset under its **own sanitized basename** (`~` → `.`, never relying on GitHub's upload mapping) and rejects any name **collision**; creates the release if absent; then for each staged asset uploads it if MISSING or integrity-compares (download + sha256) if it already EXISTS — matching ⇒ skip (idempotent), differing ⇒ fail closed (published assets are never overwritten); and finally verifies the live asset set equals the staged set. `RECONCILE_RELEASE_DIR=<dir>` selects a local mock backend for standalone testing. |
