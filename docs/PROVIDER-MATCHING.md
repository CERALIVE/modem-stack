# Provider registration and evidence matching

`control/src/providers/` is the provider-neutral selection layer for
`@ceralive/modem-control`. It contains no Huawei, ZTE, UFI/HIMI or other concrete provider.

## Registration contract

Each `ProviderDefinition` declares:

- a stable `id` and `profileVersion`;
- eligible transports and passive USB, PCI, interface, driver, gateway, model and firmware facts;
- harmless unauthenticated fingerprint probes;
- optionally, one owner-selected authentication algorithm with `attemptLimit: 1`;
- capability evidence readers;
- `observe()` returning generation-fenced `ObservationEnvelope<T>` values;
- `operations()` returning that provider's own capability-specific operations object; and
- sanitized request/response `contractFixtures` keyed by profile.

Providers compose `ProviderReadOperations<O>` and `ProviderWriteOperations<I, O>` into their own
named operation surfaces. The registry sees only the common `access` marker. This preserves each
provider's distinctions instead of forcing unrelated capabilities into a universal interface.

## Ordered matching

`createProviderMatcher(registry).match(request)` always evaluates these stages in order:

1. transport eligibility;
2. passive facts;
3. unauthenticated fingerprints;
4. profile candidate ranking;
5. at most one authentication call, using the registered algorithm; and
6. capability reads.

Evidence strengths contribute `weak = 1`, `moderate = 2`, and `strong = 3`. Totals map to
`unsupported` (0), `maybe` (1), `likely` (2), and `supported` (3 or more). Transport eligibility
is a gate, not identity evidence. The result always exposes its evidence and conflicts.

Only one unique `supported` candidate is selected. A tied top score or a candidate that remains
`maybe`/`likely` returns `ambiguous`; its provider, profile and operations are `null` and
`writable` is false. Ties stop before authentication, so matching never tries several providers'
credentials and never cycles algorithms after a failure.

## Generation scope

Selections are cached by physical modem plus registry revision, `DeviceGeneration`, transport,
passive facts, firmware and composition. Re-enumeration/reboot advances the generation; a firmware
or composition change changes the cache signature. Each case re-runs the complete evidence pipeline.

## Conformance

`control/src/providers/conformance.test.ts` is the generic provider conformance skeleton, backed by
the internal `control/test-support/provider-conformance-fixture.ts` fixture. It covers unsupported,
selected, weak, tied/read-only, colliding writable-provider, auth ordering and generation
re-evaluation paths without registering a real vendor implementation.

### The conformance matrix — every real provider, registered at once

The skeleton above uses a synthetic provider, and each concrete provider's own suite runs with
only itself in the registry. Neither shape can answer the question a fleet poses: with
ModemManager, Huawei HiLink, ZTE goform and UFI/HIMI **all registered**, does every device reach
exactly the provider and profile it is entitled to — and does no device reach one it is not?

`control/src/providers/conformance-matrix.test.ts` is that matrix. **20 cases**: nine fleet
profiles (MM-managed Quectel / SIMCom / FM350-on-USB-carrier, both HiLink firmwares, MF79U,
MF266, and both UFI USB ids) plus eleven safety cases — ambiguous collision, cross-profile
refusal, three malformed-response cases, auth-expired, lockout, two unknown-firmware
cases, wrong-interface and wrong-transport. Every case registers all four providers and scripts
the three the device does not belong to as devices that answer nothing they understand. The
expectation is the exact decision — provider, profile, writability and evidence score.

Three invariants hold across the whole matrix and are asserted as such:

- **No case outside `fleet-profile` is ever writable.** Ambiguity, malformed input, an expired
  session, a lockout and a misrouted request all resolve read-only or unresolved.
- **An unresolved decision carries no provider, no profile and no operations surface**, and its
  evidence ledger is never empty.
- **No matcher result carries the credential the wire carried**, even though the transcript does.

Two companion suites sit beside it:

- `conformance-transcripts.test.ts` asserts the exact per-firmware wire — method, path, query,
  form/JSON/XML body, the header ARRAY in order, and the cookie — rebuilt from the protocol in
  `control/test-support/conformance/transcripts.ts` rather than read back from the provider. A
  whole-array `toEqual` additionally pins the request COUNT, so a second login or a stray probe
  fails even when the decision is unchanged.
- `conformance-scale.test.ts` is a **software upper-bound fixture at 16 concurrently attached
  modems** — subscriptions stay fleet-wide, `Signal.Setup` is issued once per (epoch, modem) and
  re-applied to every survivor on a new epoch, a burst of attachments is coalesced, and sixteen
  concurrent matches each answer about their own modem. **The hardware-verified fleet size
  remains 8**; 16 is a fixture result and must never be reported as a bench measurement.

The corpus lives in `control/test-support/conformance/` (repo-local, unpublished) and reuses the
payload fixtures from `observation-fixtures.ts` rather than minting a second set. Sanitization is
structural: every credential is a declared literal that says it is not real, and any 14+ digit run
in the corpus or in a recorded request fails the suite unless it is a declared member of
`SANITIZED_SUBSCRIBER_IDENTIFIERS`. The matrix summary artifact is written to the gitignored
`test-results/provider-conformance-matrix.{md,json}`.
