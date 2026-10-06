<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CAPABILITY MODULES — TAXONOMY AND DETECTION, NOT IMPLEMENTATION

`control/src/capability/` carries the FIVE-STATE support-claim taxonomy and the
per-modem capability detection the seven gated capability modules (band-lock, SMS,
5G-pref, FCC-auto-unlock, GPS, USSD, eSIM) resolve against. **No module is
implemented here**, and none may be surfaced or claimed until its own change lands
with its probe and its evidence.

The taxonomy exists because "supported" was one word doing four jobs — the code
exists, an operator turned it on, the modem advertises it, and somebody proved it
on this firmware. `resolveSupportClaim` answers with the highest rung reached:
`unavailable` (not shipped, or the modem positively lacks it) → `implemented`
(gate OFF, the default everywhere) → `enabled` (gate ON, capability UNKNOWN) →
`capable` (gate ON, modem advertises it — the floor for offering a control) →
`certified` (proven on this exact model+firmware — the ONLY rung a support matrix
may claim).

**It is a Rule-D MIRROR of CeraUI's `@ceraui/rpc` ladder, never a shared import**
— the same relationship `usb-net-classifier.ts` has with `device-classifier.ts` in
the other direction. The two halves are kept honest by their tests, not by a path.

`detect.ts` follows `backend/features.ts` exactly: it PROBES the observed surface
rather than matching a version whitelist, never throws, and treats `unknown` as a
first-class result — a property set nobody observed says nothing about the device,
and the ladder stops at `enabled` for it. Two facts are worth knowing before
extending it:

- **SMS / USSD / GPS are advertised as INTERFACES, not properties**, so
  `MmPropertyProbe` alone cannot see them; `ModuleCapabilityProbe` adds the modem
  object's interface set. The `Location` interface being exported is separately NOT
  a GNSS claim — MM exports it for 3GPP-LAC/CID-only devices too, so a GNSS source
  must appear in `Location.Capabilities`.
- **`fcc-auto-unlock` is always `unknown`, deliberately.** FCC unlock is carried out
  by a ModemManager PLUGIN keyed on the device, and nothing on the modem's own
  D-Bus surface says whether one applies. `absent` would hide the module on
  supported hardware; `present` would promise a plugin that may not be installed.
  Evidence for it comes from the catalog instead — `control/src/fcc/coverage.ts`,
  see the section below.

### `five-g-pref` — a MODEL, not just a probe [IMPLEMENTED, UNCERTIFIED]

`control/src/capability/five-g-preference.ts` is pure and total: it maps four
named postures (`5g-only` / `prefer-5g` / `prefer-4g` / `5g-off`) onto the
`(allowed, preferred)` pair `MmMutations.setRadioModes` already writes, and
refuses to name one the modem never advertised. It opens NO new transport —
`setRadioModes` owns the `SetCurrentModes` call, the per-modem serialization and
the quiesce — and a test greps its executable source to keep it that way.

**Why it exists at all, given `setRadioModes` already writes modes.** That
surface's vocabulary is the ALLOWED SET, and two genuinely different postures
share one: "allow 4G and 5G, prefer 5G" and "allow 4G and 5G, prefer 4G" differ
only in the PREFERRED mode. An operator on a marginal 5G cell wants exactly that
distinction, and an allowed-set selector structurally cannot express it.
`prefer-5g` and `prefer-4g` therefore emit an IDENTICAL allowed set — so nothing
on this path may decide "no write is needed" by diffing allowed sets, and nothing
may confirm a restore by comparing them either.

Three refusals are load-bearing:

- **A modem with no 5G is offered NOTHING, `5g-off` included.** "Turn 5G off" on a
  radio that has none is a control that cannot change anything, which is worse
  than an absent one because it invites an operator to act.
- **A posture the modem cannot express resolves `undefined`, never a neighbour.**
  Substituting is how "prefer 4G" on a marginal cell silently becomes 5G-first.
- **A current pair no posture names reads `undefined`, never the nearest one.**
  Rounding would show an operator a selection they never made and cannot get back to.

**SA/NSA is REPORTED unsupported, with a reason.** Checked against MM 1.24.2's own
surface rather than recalled: the only NR-specific member on a modem object is
`Modem3gpp.SetNr5gRegistrationSettings`, whose keys are `mico-mode` and
`drx-cycle` — power-saving registration parameters, not a standalone-vs
non-standalone selector. Vendors expose the selector through their own AT commands
(Quectel `AT+QNWPREFCFG="mode_pref"`, one per vendor after that), which is exactly
the uncertified per-SKU write the evidence gate keeps out. A missing field would
read as "nobody asked"; the stated `not-exposed-by-modemmanager` tells an operator
hunting for an SA toggle why there is none.

**`detect.ts`'s `five-g-pref` verdict NARROWS when the caller decoded the mode
catalog.** Every ModemManager modem exports `SupportedModes`, including a 4G-only
one, so the property NAME alone resolves `present` on hardware with no 5G. The
optional `ModuleCapabilityProbe.supportedRats` narrows the verdict to whether the
catalog actually names 5GNR; ABSENT it, the property-name answer stands verbatim.
A strict narrowing, never a new way to claim a capability.

**Status: `implemented-but-uncertified`.** No 5G SIM/plan and no verified 5G
coverage exist at the bench (`docs/BENCH.md` per-SKU blockers; the CeraLive-side
record is todo 2's BLOCKER B3), so the readback/registration/data/fallback drill
on the RM530N-GL has not run. Every claim above is fixture-proven only.

