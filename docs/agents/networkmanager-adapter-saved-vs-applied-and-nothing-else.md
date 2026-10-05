<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## NETWORKMANAGER ADAPTER — SAVED vs APPLIED, AND NOTHING ELSE

`control/src/providers/network-manager/` is the thin `NetworkManagerAdapter`: desired
connection profiles, the applied bearer, and the interface that bearer landed on. It is the
**only bearer/APN authority surface in the package**, and it is deliberately narrow — no
radio, band, SIM or power operation appears in it, because those belong to the ModemManager
provider and a second expression of them would make two writers for one resource. It is
exported through the existing `./providers` and root entries; **no eighth package subpath**.

It COMPOSES rather than replaces the existing NM work: `NmcliNmPort`
(`control/src/backend/nmcli-nm-port.ts` — nine-field GSM write parity, device-exact
activation, atomic Auto-APN transitions, quiesce leases) is unchanged and remains the
`NetworkManagerPort` implementation this adapter is constructed with.

Six decisions are load-bearing, each pinned by a test that goes red when removed:

- **Observed state never writes the desired slot.** `observe()` may clear `applied` and
  always rewrites `observed`; it touches `desired` on no path. Reality overtaking a write
  does not un-ask the operator's question — and if it did, a re-enumeration would erase the
  configuration the controller exists to restore.
- **Desired records the REQUEST; applied records NM's READBACK.** Seeding desired from the
  readback would make a field NM silently rewrote (`gsm.auto-config` driving the APN is the
  real case) structurally unreportable, and asserting applied from the input would make a
  silently-rejected write look like it took.
- **`unbound` is a VALUE, not an unavailable observation.** "The device is here and idle" is
  a definite divergence from a desired bearer; "the device is gone" is not knowledge at all.
  An unavailable observation compares `indeterminate` against everything, which is right for
  the second and wrong for the first, so a present-but-idle device produces a FRESH envelope
  carrying `unbound` and only a MISSING device produces `unavailable` / `device-absent`.
- **A readout is an ENUMERATION, never a delta.** A device absent from `NmObservationInput.devices`
  is GONE. That is the only shape in which re-enumeration is detectable without depending on a
  removal event nobody guarantees will arrive.
- **A transitional device state is `pending`, not a loss.** A device in `prepare`/`ip-config`
  carrying our connection is coming UP; reporting that as a lost bearer would turn every
  ordinary activation into a false alarm. Loss is reported only for the four states that
  positively contradict the applied bearer: `interface-absent`, `interface-detached`,
  `connection-replaced`, `activation-failed` — and the loss retains `previous`, because the
  applied slot has just been cleared precisely because it no longer describes reality.
- **The adapter owns no identity and no credential.** Every slot is keyed by NM's own
  connection UUID, never a `PhysicalModemId`, so this can never become a second authority on
  which physical modem is which. `NmBearerBinding` also omits `username`/`password`: a state
  slot is compared and surfaced in divergence output, and `gsm.password` is the one profile
  field redaction masks everywhere else. There is likewise **no delete path** — profile
  removal is not in the port-tagged `NmOp` set, so the adapter cannot express it.

A superseded-generation readout is REFUSED rather than folded late, so a reply about a
previous enumeration cannot clear applied state belonging to the current one. Divergence is
reported through todo 18's `describeStateDivergence` — two independent comparisons, never one
verdict. Coverage is `network-manager-adapter.test.ts`, driven by the stateful `nmcli`
harness in `control/test-support/fake-nm/` (real readback, no bus, no subprocess); its scope
gate scans the module's comment-stripped source for radio/SIM/delete/identity identifiers and
proves the strip non-vacuous in both directions.

