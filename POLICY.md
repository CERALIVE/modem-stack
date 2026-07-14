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

## 2. Upstream-contribution-first

For anything that is genuinely a modem-support improvement — udev rules, ModemManager
plugins, device quirks, port-type hints — **the contribution goes upstream first**.

- New device support, mode-switch quirks, and plugin changes are proposed to upstream
  ModemManager / the Debian packaging, not accreted as local carry.
- This repository's role is to **pin and rebuild** known-good upstream releases and to
  **package** them for the bench, not to become a divergent downstream distribution.
- If upstream declines or is slow, the decision to carry anything locally re-enters the
  no-fork gate in §1 (rationale + filed MR + review).

## 3. Why

ModemManager's value is its enormous, well-maintained device database and its plugin
ecosystem. Every downstream patch we carry is a merge liability against that database and
a step away from `apt`-clean rebuilds. Keeping the packaging patch-free — and pushing real
fixes upstream — is what lets the bench track current ModemManager (1.24 and beyond)
without inheriting a fork's maintenance debt.

## 4. Scope reminder (Phase A)

This policy governs Phase A only: standalone iteration, bench installs from CI artifacts,
no product wiring. It does not authorize any change to CeraUI, the device image, or the
apt distribution. Those are out of scope until Phase B is explicitly triggered.
