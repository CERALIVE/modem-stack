<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## eSIM — `blocked` on hardware, not deferred by choice (2026-08-18)

`docs/ESIM-DECISION.md` records the full eSIM investigation: SGP.22 profile-binding makes
cross-device profile "copying" cryptographically impossible; the workable paths are
removable eUICC, carrier reissue, or multi-profile remote switching; `lpac` (external LPA)
is assessed but not adopted (AGPL-3.0 core, AT backend is demo-only, needs MM
inhibit-coordination).

The 2026-08-13 **deferral was reversed** by user decision and eSIM re-entered scope as a
hardware-gated adoption spike. It closed **`blocked`** (§9): **no bench modem exposes an
eUICC** — the only SIM on the entire fleet reports no `eid` under MM 1.24.2, which is
positive evidence of a classic removable UICC, and RM530N-GL eUICC capability is unproven
for that unit. **`blocked` is not a NO-GO**: the spike's three hardware steps could not
start, so no verdict exists and none may be inferred.

**No eSIM code exists in this repository, and none may be written on the strength of this
record.** No `ceralive-lpac` `.deb`, no closure row, no manifest entry, no apt publication,
no image pin — the release manifest stays at `closure_version: 2` with its frozen matrix.

The **licensing half of the spike did complete** and binds any future adoption:

- lpac's program logic (`src/`, `driver/`, `utils/`) is **AGPL-3.0-only** — it may only ever
  be spawned as an EXTERNAL process over its CLI, never linked or embedded into
  `@ceralive/modem-control`, `cerastream`, or `CeraUI`.
- Redistributing it obliges **Corresponding Source from the same place** (AGPL-3.0 §6(d)).
  `apt.ceralive.tv` publishes binary indexes only — a source channel would have to exist
  BEFORE any lpac upload.
- AGPL §13 attaches to **modified** versions only, so the rule is *ship unmodified or not at
  all* — the same answer `POLICY.md`'s no-fork rule already gives.
- Shipping form on a hypothetical GO: a first-party target-suite rebuild in `packaging/`, pinned
  like the other four sources. The stock Debian package (`lpac` 2.3.0-1) exists but is in
  testing/unstable only — **not** bookworm, **not** trixie.

