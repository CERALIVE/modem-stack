<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## RADIO CAPABILITY TRUTH — THE MODEM'S OWN CATALOG, UNEDITED

`control/src/radio/` is the layer that carries ModemManager's `SupportedModes` /
`CurrentModes` / `SupportedBands` answers to a consumer **without editing them**, and
turns them into operation descriptors. Reachable through the package ROOT entry;
**no eighth subpath** (the todo 17/18/23 precedent). It sits BESIDE `src/band/` rather
than inside it — a mode change is disruptive-but-reversible, a band lock can strand a
radio where nothing registers, and the two safety models must not be merged.

- **`preferred: 0` is `none`, and `none` is a VALUE.** The bench FM350-GL advertises
  exactly one combination whose preferred mask is 0: the modem allows a set of modes and
  states NO preference within it. Substituting "the highest allowed mode" shows an
  operator a preference the modem never expressed and cannot be returned to. `none`
  therefore survives all the way into `descriptor.constraints.values`, and a test asserts
  it is not any of the allowed modes.
- **An unfamiliar mode bit stays OFFERED.** It round-trips as `mode-bit-<n>` (the
  `band-<n>` discipline from `band-names.ts`), the combination is classified
  `unknown-combination`, and the descriptor stays `available`. Hiding it would coerce
  `unknown` into `unsupported`, which is the first rule `support-claim.ts` exists to
  enforce.
- **Nothing is dropped, structurally.** `decodeSupportedModeCombinations` puts a member
  that is not a `(uu)` into `undecodable`, so `combinations.length + undecodable.length`
  is the member count the provider sent. A test asserts that identity rather than the
  contents.
- **A selection the modem never advertised is REFUSED, never rounded.** Same rule, same
  reason as `five-g-preference.ts`: substituting is how "prefer 4G" on a marginal cell
  silently becomes 5G-first.
- **`MmMutations.setModeCombination` exists because `setRadioModes` structurally cannot
  express `MM_MODEM_MODE_NONE`** — its preferred mask is derived from
  `preferenceOrdered[0]`. Both quiesce; both are one `SetCurrentModes` call.
- **Mode and band writes are readback-gated at the CALL PATH, not only in the
  descriptor.** `SetCurrentModes` / `SetCurrentBands` returning without an error only
  proves the daemon accepted the call; an accepted-but-ignored write looks like success
  from the call site, which is exactly the failure the catalog's own `readback` proof
  exists to catch.
- **The band-write gate is `band/certification.ts`, wired — not re-implemented.**
  `describeBandWriteCertification` reads `findBandCertification` + `offerableBands` and
  nothing else. `buildBandWriteDescriptor` then publishes `mutationImpact: 'disruptive'`,
  a `band-certification-present` live precondition, a required readback, and
  `availability: refused` / `support.write: false` carrying
  `band-certification-required`. Because the shipped catalog is EMPTY, that is the
  answer for every device on the fleet today. **The gate is deliberately DOUBLED** — the
  descriptor is what a consumer reads to decide whether to offer the control, the
  provider's own check is what refuses a call made anyway; a gate that exists in only one
  of the two is either advisory or invisible.
- **`ModemManagerProviderOptions.isBandControlCertified` is GONE, replaced by `bandSku` +
  `bandCertificationCatalog`.** An injected boolean let a caller assert certification
  without a catalog row, which the four-proof `z.literal(true)` schema exists to prevent.
  MM's `Modem` interface carries `Model` and `Revision` but no USB `vid:pid`, and
  `BandSku` needs all three — so the SKU resolver is injected and, with none supplied,
  there is no SKU, no entry, and no band write. Fail-closed in every direction.
- **A band reset readback is satisfied by `any` OR by the whole supported set** (MM
  reports either after `SetCurrentBands([ANY])`); a NARROWING lock must match exactly,
  because a superset is a different lock from the one that was asked for.

`ContextWriteOperation` gained `describe(context)` for this: a static descriptor cannot
carry a device's own catalog, so "which combinations does THIS modem advertise" and "is
THIS SKU's band lock certified" are read live instead of inferred from a capability flag.

Coverage: `control/src/radio/{mode-combinations,mode-truth,band-truth}.test.ts` (pure) and
`control/src/providers/modem-manager/capability-truth.test.ts` (the whole path, over the
in-memory MM transport, with FM350 / Quectel / SIMCom / unknown-combination / no-SIM
specs).

