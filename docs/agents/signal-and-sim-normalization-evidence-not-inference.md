<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## SIGNAL AND SIM NORMALIZATION — EVIDENCE, NOT INFERENCE

The observation layer's SIM and signal halves are finalized on top of todo 18.

- **`absent` is reachable through exactly ONE evidence kind.**
  `readSimPresence` (`hardware/router-parsers.ts`) returns the presence AND the
  `SimPresenceEvidence` that decided it; only `state-failed-reason` (mmcli's
  `sim-missing`) can produce `absent`. `NormalizedSim.presenceEvidence` and
  `ModemManagerSimState.presenceEvidence` carry it, so "there is no SIM" and "we could not
  tell" — read off the SAME empty fields — are separable by a consumer and by a test.
  ModemManager reports `Sim: '/'` while a modem is initializing and while a slot switch is
  in flight, so a blank object path proves nothing and stays `unknown`.
- **`decodeStateFailedReason` is what makes absence readable at all.**
  `Modem.StateFailedReason` is a `u` on D-Bus, while the migrated presence rule matches
  the mmcli STRING — so before this decoder the D-Bus path could never produce the one
  fact that proves absence. Both spellings are accepted; an unrecognized number decodes
  to `undefined` and proves nothing.
- **`ModemManagerSimState.present` is POSITIVE evidence only.** `true` means the modem
  exports an active SIM object path. `false` is NOT a claim of absence — `presence` is.
- **The router sources still claim no presence, and now say WHICH code they left alone.**
  `vendor-code-unclaimed` names HiLink's `SimStatus`, goform's `simcard_state` and HIMI's
  `simstate`. The field is NAMED in the evidence but deliberately NOT marked `consumed`,
  so it stays in the diagnostics block's `unmapped` set, verbatim, for the per-vendor
  provider that will one day decode it with evidence.
- **`Modem.CurrentModes` and `Modem.SignalQuality` are retained as their D-Bus STRUCTS.**
  The provider used to flatten `(uu)` and `(ub)` to their first member before handing them
  to normalization, which dropped the preferred mode and the measurement-recency flag
  before the diagnostics block ever saw them. `rawStructMember` / `rawNumberAt` /
  `rawBooleanAt` read either shape, so a pre-existing flattened fixture still decodes.
- **`NormalizedSignal.qualityRecent` claims the `(ub)` boolean.** It is a fact about when
  the MODEM last measured, which is a different question from the envelope's staleness
  (when WE last read). The router APIs have no such flag and answer `unsupported` — a
  capability claim, the `bars` / `maxBars` precedent.

### `Modem.Signal`'s per-RAT dicts — the detail the router dongles already carried

`NormalizedSignal.rsrp` / `rsrq` / `snr` / `sinr` are now claimed for MM-managed modems
too, from the `Modem.Signal` interface's own `a{sv}` properties. Five facts about that
path are load-bearing, and each is pinned by a test:

- **A dict member arrives WRAPPED, and used to be dropped.** An `a{sv}` decodes to
  `[key, variant][]`, so `snapshot.ts`'s `rawValue` kept the key and discarded the reading
  — `Signal.Lte` retained as `[['rsrp'], ['rsrq'], …]`. It now unwraps the variant, which
  is why the extended metrics are reachable at all. `signal-richness.test.ts` fails three
  ways with that unwrap removed, so the fix is not a silent one.
- **The dict is read by MEMBER, never flattened at retention.** `raw.ts`'s
  `rawDictMember` / `rawDictNumber` / `hasRawDictMember` read one member by name, so
  `error-rate`, `ecio`, `io` and `rscp` — every key the normalized model has no slot for —
  stay verbatim in the diagnostics block instead of being lost to make four metrics fit.
- **The RAT ladder is NEWEST FIRST, and provenance names which rung answered.** On an NSA
  attach `Nr5g` and `Lte` are both populated with genuinely different measurements (the NR
  leg and the LTE anchor), so one has to be the reported reading. `rsrp`/`rsrq`/`snr` take
  `Nr5g` then `Lte`; `dbm` takes `Lte → Umts → Gsm → Evdo → Cdma`. Nothing is merged and
  nothing is averaged — `MetricProvenance.rawFields` carries `Signal.Nr5g.rsrp` rather than
  a bare `Signal.rsrp`, and the unchosen dict is still in `raw`.
- **SINR comes from `Evdo` and from NOWHERE ELSE.** Checked against MM 1.24.2's own
  introspection rather than recalled: `sinr` is a member of the `Evdo` dict only — `Lte`
  and `Nr5g` publish `snr`, which is a different quantity and must never populate it (the
  same rule `backend/cell-info.ts` already enforces in the other direction). So an LTE/NR
  modem reporting no SINR answers **`not-reported`, not `unsupported`**: the source CAN
  express it, this modem did not. The former blanket `unsupported` was a false capability
  claim and is gone. The NR SINR a device may publish through `Modem.GetCellInfo` is a
  different call on a different interface and is deliberately NOT folded in here.
- **A dict-sourced metric consumes the whole property.** `consumed` must name a real raw
  key or `createObservationDiagnostics` drops it, so the entry is `Signal.Nr5g` while
  `rawFields` stays member-precise. An exported-but-silent `Modem.Signal` therefore yields
  five READ-class `not-reported` metrics carrying no `value` field at all, and a modem with
  no `Modem.Signal` interface yields `not-observed` — never a zero, in either case.

**The `Signal.Setup` rate is injected at three levels and defaults at all three.**
`SignalSetupManagerOptions.intervalSeconds` → `MmDbusBackendOptions.signalIntervalSeconds`
→ `ModemManagerProviderOptions.signalIntervalSeconds`, each resolving to
`DEFAULT_SIGNAL_INTERVAL_SECONDS` (5) when absent. The provider seam is the one this work
added: the backend had accepted the option since it was written, and the provider — which
is what an embedder actually constructs — had no way to pass it. `Setup` takes a `u`, so a
fractional or non-positive rate is REFUSED at construction rather than marshalled; a modem
silently polling at the wrong cadence is a defect nothing downstream can see. The
once-per-(epoch, modem) issue semantics are the conformance-scale pin and are untouched.

Coverage: `control/src/observations/sim-evidence.test.ts`, whose control case is a modem
with the identical blank fields and NO failure reason, asserting `unknown`;
`control/src/observations/normalization.test.ts` for the per-metric claims and the
absent-dict unknowns; `control/src/providers/modem-manager/signal-richness.test.ts` for
the same claims over the real provider wire; `control/src/backend/signal-setup-rate.test.ts`
for the injected rate and the once-per-(epoch, modem) issue count.

### REGISTRATION AND CELL CONTEXT — WHO WE ARE ATTACHED TO, AND TO WHICH CELL

`NormalizedRadio` gained `operatorName` / `operatorCode`, and `NormalizedModemObservation`
gained an additive `cell` block (`NormalizedCell`: `cellId` + `tac`). Every slot is a
`NormalizedMetric`, so the four-state model and the capability-vs-read reason split apply
unchanged. Five facts are load-bearing:

- **The operator comes from `Modem3gpp`, NEVER from `Sim`.** `Modem3gpp.OperatorName` is
  the operator the modem is REGISTERED with; `Sim.OperatorName` is the HOME operator
  written into the SIM. They agree on a home network and disagree for the entire time a
  device is roaming — which is exactly when an operator reads the field. `MM_FIXTURE`
  carries two DIFFERENT strings on purpose so reading the wrong interface fails a test
  rather than looking right.
- **`operatorCode` is TEXT and is never derived from parts.** The MNC is two OR three
  digits and the width is significant (`31001` ≠ `310001`). MM emits the code as one
  fixed-width string and splits it back apart at exactly three characters. The ZTE
  payload has `rmcc` and `rmnc` as separate UNPADDED fields, so joining them would name a
  different network whenever the leading zero matters — every router source therefore
  answers `not-reported` for the code while ZTE does claim the NAME.
- **TAC/CID come from the EXISTING `3gpp-lac-ci` source, and the GNSS fence is untouched.**
  `decode3gppLacCi` (`domain/mm-enums.ts`) parses MM's own five-token string — verified
  against 1.24.2's `libmm-glib/mm-location-3gpp.c`, whose serializer is
  `g_strdup_printf ("%.3s,%s,%lX,%lX,%lX", …)`: MCC, MNC, then LAC/CI/TAC in uppercase
  HEX. Values stay as that text; parsing the hex to decimal would render an identifier
  matching nothing `mmcli` shows. A token count other than five decodes to NOTHING rather
  than a partial record, and both `cellId` and `tac` fail together. `signal_location`
  stays `false`, `3gpp-lac-ci` stays OUTSIDE `GNSS_SOURCES`, coarse cell context stays
  outside the GNSS redaction class, and nothing on this path enables a location source.
- **Nothing supplies `location` today, and that is the fence rather than an oversight.**
  MM masks the `Location` PROPERTY unless `Location.Setup` was called with
  `signal_location = true` — permanently forbidden here — so the value must come from an
  explicit `GetLocation()` call, which the provider's snapshot path does not make. An MM
  observation therefore reads `not-observed` for `cell`: nobody looked. Cell identity that
  IS wired runs through `Modem.GetCellInfo` → `backend/cell-info.ts`, a different method
  needing no location source. `CellReading` gained `tac` there, and its cell identifier now
  reads MM's REAL key `ci` first (`PROPERTY_CI` in `mm-cell-info-{lte,nr5g}.c`) with the
  older `cell-id` spelling kept behind it as a fallback.
- **NO EARFCN IS CLAIMED ANYWHERE, and none may be added from these sources.** MM
  publishes no generic ARFCN on `Modem`, `Modem3gpp` or `Location`; the only occurrences
  are inside PER-CELL `GetCellInfo` dicts under two DIFFERENT keys for two different
  quantities — `earfcn` (LTE) and `nrarfcn` (5GNR). A single normalized slot would have to
  merge them or silently pick a RAT, so `NormalizedCell` and `CellReading` both make no
  ARFCN claim and the raw keys stay available to a caller that needs them.

Router sources claim only what a MIGRATED parser already decoded: ZTE claims the operator
name and `cell_id`, UFI claims `cell_id`, and HiLink claims neither — its `<cell_id>` tag
is retained verbatim in the diagnostics block's `unmapped` set rather than lifted into a
claim, the same rule that keeps `SimStatus` out of `sim.presence`. `tac` reads
`not-reported` for all three, never `unsupported`: no migrated parser decodes one, which
is a fact about this package, not a claim about the vendor's firmware.

Coverage: `control/src/observations/registration-context.test.ts` (the decoder's token
rules, the Modem3gpp-vs-Sim distinction, the four unknown reasons, and the per-source
claims) plus the `ci` / `tac` / no-ARFCN cases in `control/src/backend/cell-info.test.ts`.

