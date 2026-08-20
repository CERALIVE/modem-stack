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
