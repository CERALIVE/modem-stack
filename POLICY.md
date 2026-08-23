# POLICY — modem-stack

Binding engineering policy for this repository. Changes to this file are architecture
decisions and require review.

## 1. No-fork gate (packaging)

`packaging/` produces **bookworm rebuilds** of ModemManager, libmbim, libqmi, and
libqrtr-glib. It is a **repackaging** effort, **not a source fork**.

- **The first packaging release carries ZERO quilt patches.** Every source is rebuilt
  from its pinned, provenance-verified upstream release and its pinned Debian packaging
  tag, unmodified. `debian/patches/` is empty (or absent) for all four sources at the
  first release.
- **Adding a quilt patch later is an architecture gate.** A patch may only be introduced
  through an explicit architecture decision that records, in the PR:
  1. **Rationale** — the exact defect or gap the patch closes, and why a rebuild alone
     cannot.
  2. **Upstream MR** — a link to the merge request filed against the relevant upstream
     project (ModemManager / libmbim / libqmi / libqrtr-glib on freedesktop GitLab, or
     the Debian package on salsa). Carrying a patch downstream without having offered it
     upstream is not permitted.
  3. **Review** — sign-off from a second maintainer on this file's terms.
- Until all three exist, the patch does not land. A rebuild that needs a patch to build
  at all is a STOP-and-surface event, not a silent local fix.

**Narrow approved exception — FM350-GL, 2026-08-22.** The CeraLive project owner reviewed
[`ADR-FM350-RNDIS-BEARER.md`](docs/adr/ADR-FM350-RNDIS-BEARER.md) as the second maintainer and
approved its exact three-patch BELABOX-derived ModemManager 1.24.2 carry while the upstream
merge-request draft remains unfiled. Requirement 2 above is therefore still honestly
**not met**; the dated owner decision is an explicit exception for this series, not a claim
that an MR exists and not a general waiver of the upstream-first gate. Every patch must retain
the BELABOX author, originating commit SHA(s), rationale, and `Forwarded: no` status. The
series is hardware-verified on the carrier-mediated USB topology and must be retired when
upstream ships equivalent support.

## 2. Upstream-contribution-first

For anything that is genuinely a modem-support improvement — udev rules, ModemManager
plugins, device quirks, port-type hints — **the contribution goes upstream first**, except
for the single dated FM350-GL owner exception recorded in §1.

- New device support, mode-switch quirks, and plugin changes are proposed to upstream
  ModemManager / the Debian packaging, not accreted as local carry.
- This repository's role is to **pin and rebuild** known-good upstream releases and to
  **package** them for the bench, not to become a divergent downstream distribution.
- If upstream declines or is slow, the decision to carry anything locally re-enters the
  no-fork gate in §1 (rationale + filed MR + review).

## 3. Why

ModemManager's value is its enormous, well-maintained device database and its plugin
ecosystem. Every downstream patch we carry is a merge liability against that database and
a step away from `apt`-clean rebuilds. Keeping the patch surface zero by default and narrowly
attributed, reviewed, tested, and retired when an exception is unavoidable is what lets the
bench track current ModemManager (1.24 and beyond) without inheriting a fork's maintenance
debt.

## 4. Scope boundary (Phase A → Phase B, version-gated at v1.0.0)

Sections 1–3 (no-fork gate, upstream-contribution-first) bind this repository permanently
and are unaffected by phase.

**Through the `0.x` line — including this repository's releases up to and including
`v0.2.0` — this repository was Phase A only:** standalone iteration, bench installs from
CI artifacts, no product wiring. That scope did not authorize any change to CeraUI, the
device image, or the apt distribution.

**Phase B adoption is authorized starting at the `v1.0.0` release tag, not before.** From
that tag forward, this repository's artifacts — `@ceralive/modem-control` and the packaged
ModemManager-stack `.deb`s — may be integrated into CeraUI, the device image, and the apt
distribution. `v1.0.0` is the version gate, not an integration itself: it marks the control
library's public API and the packaging contract stable enough to build on. Each downstream
integration (CeraUI adopting the npm package, `image-building-pipeline` installing the
`.deb`s, `apt-worker` serving them) remains its own explicit, reviewed change in the
receiving repository — this section lifts the standing prohibition, it does not pre-approve
any specific integration PR.
