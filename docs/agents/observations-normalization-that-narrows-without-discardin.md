<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## OBSERVATIONS — NORMALIZATION THAT NARROWS WITHOUT DISCARDING

`control/src/observations/` sits directly on top of the parsers above and turns a raw
per-vendor payload into ONE `ObservationEnvelope<NormalizedModemObservation>`. It decodes
nothing itself — every value comes from `domain/mm-enums.ts`,
`domain/modem-presentation.ts` or `hardware/router-parsers.ts` — and adds exactly two
things those pure functions cannot carry: **where a value came from**, and **why a value
is missing**. It opens no transport; a provider performs the read, this layer explains the
result. Reachable through the package ROOT entry, deliberately not through a new subpath.

**FOUR STATES, NOT A VALUE PLUS A FLAG.** `readMetric` answers `fresh` | `stale` |
`unavailable` | `unknown`, and they differ in SHAPE rather than only in label:
`unavailable` and `unknown` carry no `value` field at all, and `unavailable` carries no
metric provenance because no metric was produced. So no consumer can read a value off a
state that has none.

- **`stale` KEEPS the value.** An aged reading is the last thing the device actually said;
  discarding it leaves an operator unable to tell "we lost contact" from "the modem reports
  nothing".
- **`unavailable` is terminal on re-evaluation and never becomes `stale`.** It carries no
  value, so there is nothing to age — re-classifying it would have to invent one.
- **Staleness is MONOTONIC.** `evaluateFreshness` returns an already-stale envelope
  unchanged, so its `since`/`reason` record the FIRST cause. Freshness comes from a new
  read, never from re-evaluating an old one. Trigger precedence when several apply:
  superseded generation → superseded source epoch → degraded source → TTL expiry; the first
  three state that reality overtook the reading, TTL expiry only says nobody looked.
- **A TTL expiry's `since` is `observedAt + ttlMs`, not the evaluation time** — otherwise a
  reading that expired an hour ago looks like it just went stale.

**`unknown` IS NEVER COERCED TO `unsupported`, and the reason class is what enforces it.**
`metricUnknownClass` splits `MetricUnknownReason` into `capability` (only `unsupported` — a
durable claim about the SOURCE) and `read` (`not-reported`, `not-observed`, `malformed`,
`auth-expired`, `refused`, `unreachable` — claims about ONE attempt). A consumer decides
whether to HIDE a control or show it pending by branching on that class, never on the bare
fact that a value is absent. The three distinctions this buys, all pinned by tests:

| Situation | Reason | Class |
|---|---|---|
| ModemManager exposes no bar scale, only a percentage | `unsupported` | capability |
| The `Sim` interface was never read | `not-observed` | read |
| `Modem.State` was absent from the payload | `not-reported` | read |
| `Sim.EsimStatus` was present but decoded to nothing | `malformed` | read |
| The HiLink session answered `125002` | `auth-expired` | read |

`metricUnknownReasonFromRouter` is a WIDENING, never a re-classification — every
`RouterSignalUnknownReason` member keeps its exact meaning.

**A PAYLOAD THAT ARRIVED IS AN OBSERVATION, however little of it could be read.** A refused
HiLink session and an unparseable goform body both produce a FRESH envelope whose metrics
are `unknown` with a reason — not an `unavailable` one. That is not taxonomy for its own
sake: `ObservationEnvelope` pairs `unavailable` with `value: null`, so emitting it for a
payload we did hold would throw the diagnostics block away, and the raw vendor fields with
it. `unavailableObservation` is reserved for the case where there is no payload at all.

**NOTHING IS DROPPED — retention is structural, not a discipline.** Every normalizer builds
ONE flat `RawFieldRecord` keyed `<body>.<provider-native field>` and reads its metrics out
of that same record, so a field a metric consumed is necessarily a field the diagnostics
block already carries. `createObservationDiagnostics` DERIVES `unmapped` (raw keys minus
consumed) rather than accepting it, so a field no metric names lands there automatically
instead of vanishing. A repeated XML tag is kept as `Tag`, `Tag#2`, `Tag#3`; a nested JSON
object keeps its JSON text; `Modem.SimSlots`-style arrays stay arrays.

**`ObservationDiagnostics.raw` is a REDACTION-CLASS boundary.** The UFI overview endpoint
returns an IMSI and an ICCID, and they ARE retained — normalization does not get to decide
what a diagnostician may need. Anything that logs, serializes or files a diagnostics block
must route it through `redactObservationDiagnostics`, which runs the package's own key-based
`redact`, so the classes masked here are the classes masked everywhere else. Retention and
 disclosure are separate decisions; this layer only guarantees the first. The former B5
 gap is closed: the shared redactor masks `imei`, `EquipmentIdentifier`, separator variants,
 and dotted mmcli spellings. The raw diagnostics block still contains source values in
 memory, so every serialization boundary must continue to call the redactor.

**PER-METRIC PROVENANCE, INCLUDING PER-METRIC AUTHORITY.** One normalized observation folds
several provider reads together — HiLink answers `monitoring_status` and `device_signal`
separately, UFI answers three endpoints — so a single envelope-level `observedAt` would be a
claim about a reading no individual metric came from. Authority is per-metric for the same
reason a payload can mix classes: a router's RSRP is a measurement the modem reported and is
`authoritative`, while its bar count is a vendor rendering of that measurement and is
`derived`. This layer has no clock: `observedAt` and `sourceEpoch` are supplied by whoever
performed the read, so a normalizer cannot stamp a payload with a time it did not come from.

**SIM PRESENCE IS BINARY, and that is the point.** `deriveSimPresence` answers
`present | absent | unknown`; the third member is not a presence, it is the absence of an
answer, so it becomes the metric's `unknown` state with a reason. That is what stops "we
could not tell" from rendering beside "there is no SIM". For the three ROUTER sources SIM
presence is deliberately NOT claimed at all — each vendor reports its own presence code
(`SimStatus`, `simcard_state`, `simstate`) with vendor semantics and no migrated decoder
covers them, so the code stays verbatim in the diagnostics block for the per-vendor
providers to claim later with evidence. Guessing one would be exactly the invented reading
this layer exists to prevent.

**DESIRED, APPLIED AND OBSERVED ARE THREE THINGS AND STAY THREE THINGS.**
`state-separation.ts` follows NetworkManager's own split: a connection PROFILE is what an
operator asked for, an active connection's BEARER is what was put into force, and the
device's reported state is what the hardware is doing. All three are routinely different at
once, and a merged "current state" blob has to pick one and lose the other two — which makes
"did our write take effect", "is this the network's doing or ours" and "what do we roll back
TO" unanswerable. `ModemStateView` therefore has exactly three slots with three `kind`
discriminants and NO fourth merged field (an effective value is a rendering decision, and
computing one here would bake a policy every consumer would work around).
`describeStateDivergence` returns TWO independent comparisons — `desiredVsApplied` ("did our
write happen") and `appliedVsObserved` ("did it stick") — because one boolean cannot separate
a request that was never carried out from one the network undid a second later, and those
need opposite responses. An unavailable observation compares `indeterminate`, never
`aligned`: "we could not read it" is not evidence that it matches.

Coverage: `control/src/observations/{observation-states,normalization,state-separation}.test.ts`
against the canonical per-source fixtures in `control/test-support/observation-fixtures.ts`
(ModemManager, HiLink, ZTE goform, UFI/HIMI, plus the auth-expired and unparseable variants).
Each fixture deliberately carries vendor-specific fields the normalized model has no slot for
— `Modem.Ports`, `CurrentNetworkTypeEx`, `wan_lte_ca`, `cputemp` — and the round-trip
assertions are what prove those survive. Later provider work should reuse those fixtures
rather than re-invent them.

