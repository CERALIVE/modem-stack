<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## PROVIDER REGISTRY + EVIDENCE MATCHER

`control/src/providers/` is the provider-neutral registration and selection layer built on the
frozen v1.1 domain contracts. The public contract and scoring details are documented in
[`docs/PROVIDER-MATCHING.md`](../PROVIDER-MATCHING.md).

- `ProviderDefinition` keeps each provider's profile version, declarative passive matchers,
  harmless unauthenticated probes, optional single owner-selected authentication algorithm,
  normalized `ObservationEnvelope` producer, provider-specific operations object and sanitized
  contract fixtures together. `ProviderReadOperations` and `ProviderWriteOperations` are
  composable capability subinterfaces; there is no package-wide vendor mega-interface.
- `createProviderMatcher` evaluates every registered provider in stage order: transport → passive
  facts → unauthenticated fingerprints → profile rank → at most one auth call → capability reads.
  Evidence is scored `unsupported → maybe → likely → supported`; only a unique `supported`
  candidate receives its operations object.
- Ties and weak candidates return `ambiguous`, with `provider`, `profile` and `operations` all
  `null`, `writable: false`, and the complete evidence/conflict ledger retained. Authentication is
  not attempted for tied candidates, so an ambiguous match cannot cycle algorithms or acquire a
  write surface.
- Selection is cached only for the same `PhysicalModemId`, `DeviceGeneration`, registry revision,
  firmware and composition. Any generation, firmware or composition change runs the full matcher
  again.

This layer registers no concrete provider. Huawei, ZTE, UFI/HIMI and other implementations remain
separate evidence-backed work.

### CONFORMANCE MATRIX — ALL FOUR PROVIDERS REGISTERED AT ONCE

`control/src/providers/conformance-matrix.test.ts` is where todo 5's matcher meets every real
provider simultaneously. Each provider suite runs with only itself in the registry, which cannot
answer whether a Huawei dongle stays a Huawei dongle while a ZTE provider and a UFI provider are
also asking. **20 cases** — 9 fleet profiles + 11 safety cases (ambiguous collision,
cross-profile refusal, 3 malformed, auth-expired, lockout, 2 unknown-firmware,
wrong-interface, wrong-transport) — each registering all four providers, expecting the EXACT
decision. Full behaviour: [`docs/PROVIDER-MATCHING.md`](../PROVIDER-MATCHING.md) §
"The conformance matrix".

- **The corpus is repo-local and unpublished** (`control/test-support/conformance/`) and REUSES
  `observation-fixtures.ts` rather than minting a second payload set that can drift from it.
  Sanitization is structural, not a review promise: a 14+ digit run anywhere in the corpus or in
  any recorded request FAILS the suite unless it is a declared member of
  `SANITIZED_SUBSCRIBER_IDENTIFIERS`, and the detector has a non-vacuity control.
- **`conformance-transcripts.test.ts` asserts the exact wire** per firmware — method, path,
  query, form/JSON/XML body, the header ARRAY in order, and the cookie — rebuilt from the
  protocol, never read back from the provider. A whole-array `toEqual` pins the request COUNT
  too, so an extra login or a stray probe fails even when the decision is unchanged.
- **`conformance-scale.test.ts` is a SOFTWARE UPPER BOUND at 16 concurrently attached modems.**
  It is a FIXTURE result: subscriptions stay fleet-wide (4, never per-modem), `Signal.Setup` is
  issued once per (epoch, modem) and re-applied to every survivor on a new epoch, an attachment
  burst is coalesced, and sixteen concurrent matches each answer about their own modem. **The
  hardware-verified figure remains the 8-device bench fleet** — 16 must never be reported as a
  bench measurement; a hardware claim comes from todo 42, on a real board.
- **`test-support/conformance/mm-transport.ts` is an in-memory `DbusTransport`** serving the SAME
  `fake-mm/object-model.ts` tree, so MM rows run without `dbus-run-session`. `fake-mm/service.ts`
  stays the right harness for codec/epoch proof on a real bus; a matrix whose MM rows SKIP where
  no session bus exists answers nothing, which is why the matrix uses this one.
- **The UFI fingerprint probe is fenced by USB evidence** (`usbEvidencePermitsProbe`) — this
  matrix is what found it. The HIMI fingerprint needs a session, so an unfenced probe spent the
  provider's single bounded login against every non-HIMI device in the registry. An ABSENT usb
  fact is still probed; a MISMATCHING one is not.

