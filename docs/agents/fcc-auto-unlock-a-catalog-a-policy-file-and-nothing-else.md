<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FCC AUTO-UNLOCK — A CATALOG, A POLICY FILE, AND NOTHING ELSE

`control/src/fcc/` implements NO unlock procedure and ships NO unlock script. It
records which `<vid>:<pid>` MODELS an operator opted in for, so
`ceralive-fcc-reconcile` can re-derive ModemManager's own admin-tier symlinks from
that record on every boot. The unlocking is ModemManager's dispatcher's job, start
to finish. Full model, matrix and certification status:
[`docs/FCC-UNLOCK-COVERAGE.md`](../FCC-UNLOCK-COVERAGE.md).

The coverage mirror names its exact provenance in `MM_FCC_UNLOCK_SOURCE`: ModemManager
1.24.2 commit `f2b9ab1ad78d322f32134a444b5b54c6e8160e19`,
`data/dispatcher-fcc-unlock/meson.build`, installed into the inert
`fcc-unlock.available.d` tier. Its four Sierra entries are `03f0:4e1d`, `1199:9079`,
`413c:81a3`, and `413c:81a8`; another well-formed Sierra PID is positively `absent`, not
guessed covered. This classifier-side mirror does not create or own any packaging link.

- **`<vid>:<pid>` is the ONLY correct key.** `mm-dispatcher-fcc-unlock.c` builds
  exactly `g_strdup_printf("%04x:%04x", vid, pid)` and opens no other name, so a
  vendor-only file is never a dispatcher target — it exists only as what the
  available tier's `<vid>:<pid>` symlinks point at. A vendor-keyed rule would also
  be wrong twice over: Sierra silicon ships under THREE vendor ids (`1199` its own,
  `03f0` HP-branded, `413c` Dell-branded), so keying on the vendor misses two of the
  three, and keying on the model misses the OEM rebrands.
- **Three tiers, and the reconciler owns exactly one.** available
  (`/usr/share/ModemManager/fcc-unlock.available.d`, ModemManager's, inert) →
  enabled-admin (`/etc/ModemManager/fcc-unlock.d`, **ours, opt-in only**) →
  enabled-package (`${libdir}/ModemManager/fcc-unlock.d`, a distribution's; CeraLive
  writes there never). Writing into the wrong one is SILENT — the link is simply
  never opened.
- **The `/data` file is the record; the symlink is derived.** `/etc` rides the
  rootfs, which is exactly what a RAUC slot swap REPLACES, so an opt-in written only
  as a symlink survives a reboot and not an OTA. `/data/ceralive/fcc-unlock-policy.json`
  (0600, atomic temp→chmod→rename) is what persists, and the oneshot re-materializes
  the link before ModemManager probes a radio.
- **Coverage is a TRI-STATE, and `unknown` is not `absent`.**
  `resolveFccUnlockCoverage` answers `present` (MM ships a procedure), `absent` (the
  ids are well-formed and are NOT in the mapping — a positive statement about the
  device) or `unknown` (we could not read the ids, a statement about the READ).
  Folding the third into the second would hide the module on hardware that may be
  covered.
- **The coverage check is part of the WRITE, not a UI nicety.** Persisting `true`
  for an uncovered model leaves an enabled toggle that provably cannot act — the
  reconciler would skip it forever, silently. `setFccUnlockPolicy` rejects it
  `not-covered`. Disabling is deliberately NOT coverage-checked: a fail-closed
  opt-OUT is not a thing.
- **Corruption is fail-SAFE and the bytes are KEPT.** Unlike
  `backend/usage/policy-store.ts`, which rewrites a fresh file, this store leaves a
  damaged policy on disk and simply refuses to act on it. Enabling a
  regulatory-unlock procedure is not something to infer from a file we could not
  read, and replacing the evidence would make the next diagnosis impossible.
- **The toggle is per MODEL and the UI must say so.** The mechanism is a
  `<vid>:<pid>` symlink, so it applies to EVERY attached device matching it — the
  bench's two identical HiLink twins are the shape of the problem. No per-unit
  refinement exists without changing ModemManager.
- **Enabling is not retroactive.** The dispatcher runs during modem
  INITIALIZATION, so an already-enumerated modem needs a re-probe
  (`mmcli -m <id> --disable && --enable`, or a replug). `SetFccUnlockPolicyResult`
  carries `changed` precisely so an unchanged write does not cost one.

Coverage: `control/src/fcc/{coverage,policy}.test.ts` plus
[`packaging/ci/test-fcc-reconcile.sh`](../../packaging/ci/test-fcc-reconcile.sh) (the
shell reconciler's behaviour on any host) and `packaging/ci/test-companion-chroot.sh`
§ 6 (the same logic from its PACKAGED location after a real `dpkg` install).

