# `@ceralive/modem-control`

Cellular modem control for CeraLive: the frozen v1.1 domain contracts, the provider
registry and evidence-scored matcher, the ModemManager D-Bus backend, the
NetworkManager adapter, the desired-state reconciler, the USB composition-mode model,
the data-usage sampler, and the gated capability modules.

**This package is a LIBRARY.** It ships no `bin`, no systemd unit, no shebang, and
nothing that opens a listening socket — it is imported by a controller, it is not one.
That claim is checked against the real `bun pm pack` output, not against the source
tree; see [Shape gate](#shape-gate).

## Install

```sh
npm install @ceralive/modem-control     # or: bun add @ceralive/modem-control
```

ESM only (`"type": "module"`). Node 26 and Bun 1.4 are the runtimes the published
tarball is exercised against on every CI run.

## Public entry points

Seven specifiers, and nothing else. Every other module is internal and reachable only
through the root entry, so an internal reorganisation is not a breaking change.

| Specifier | What it carries |
|-----------|-----------------|
| `@ceralive/modem-control` | Everything below plus the ports, backend, reconciler, redaction, SMS, USSD, location and FCC modules |
| `@ceralive/modem-control/domain` | Frozen v1.1 contracts: `PhysicalModemId`, `DeviceGeneration`, `ObservationEnvelope`, `OperationDescriptor` / `OperationResult` |
| `@ceralive/modem-control/providers` | `ProviderDefinition`, the registry, and the evidence-scored matcher |
| `@ceralive/modem-control/capabilities` | The five-state support-claim taxonomy and per-modem capability detection |
| `@ceralive/modem-control/hardware` | The per-SKU hardware model: USB composition modes + certified catalog, and the band vocabulary + band-lock certification |
| `@ceralive/modem-control/transport` | The D-Bus transport seam (no underlying-library type is re-exported) |
| `@ceralive/modem-control/testing` | Public **contract fakes** for consumers' own tests |

The `./hardware` surface also owns the transport-free response parsers migrated
from CeraUI: SIM-presence evidence plus normalized Huawei HiLink, ZTE goform,
and Qualcomm UFI/HIMI signal, detail, and capability reads. They accept response
bodies only; HTTP sessions, interface binding, retries, caches, and writes remain
consumer-owned.

The root entry also carries the **observation layer** built on those parsers. It turns a raw
per-vendor payload into one `ObservationEnvelope<NormalizedModemObservation>` in which every
metric records which source produced it and when, and in which a missing value carries a
reason that says whether the source *cannot* report it (`unsupported`) or merely *did not*
on this read. `fresh`, `stale`, `unavailable` and `unknown` are four distinct shapes rather
than a value plus a flag: stale keeps its value, unavailable carries none and never ages into
stale, and unknown says which field is missing and why. Nothing the provider sent is
discarded — every provider-native field is retained verbatim in a typed diagnostics block,
with `unmapped` derived rather than declared. Desired, applied and observed state stay in
three separate slots.

The migration surface is broader than response parsing but remains pure: the root and
existing `./domain`, `./capabilities`, and `./hardware` entries expose portable physical
identity/link-id derivation, modem presentation rules, ModemManager enum decoding,
USB-network classification and labels, capability-module selection, and shadow-backend
divergence folding. Every helper consumes caller-supplied values or snapshots; none discovers
devices, opens a transport, persists state, or performs a modem write.

USB snapshots retain the udev `P:` record as an absolute `sysfsPath`, allowing consumers to
correlate ModemManager `Device`/`Physdev` paths to the most-specific USB parent without relying
on a network-interface name.

### Typed ModemManager provider

`createModemManagerProvider({ transport })` returns the concrete `ModemManagerProvider` and its
provider-registry `definition`. Matching is based on the live ObjectManager tree, not a certified
model allowlist, so unknown future modems retain generic mode, signal, SIM, and power controls when
their runtime interfaces/properties advertise them. Its normalized `observe` result uses the root
observation envelope; its lifecycle `start` / `observe` / `stop` methods reuse the epoch-scoped
signal observer.

### Huawei HiLink provider

`createHuaweiHiLinkDefinition()` exposes exact E3372H firmware profiles for password types 3 and
4. Firmware plus `SesTokInfo` evidence chooses one profile, and `state-login` must confirm that
profile's password type before the provider makes its only login attempt. Every request is bound to
the injected network interface with redirects disabled. Mode and mobile-data writes acquire
`router-session`, probe their own capability, and require a new authenticated readback before they
can report `applied`; no Wi-Fi write exists. Credentials and session material remain private to the
provider runtime. See [`../docs/HUAWEI-HILINK-PROVIDER.md`](../docs/HUAWEI-HILINK-PROVIDER.md).

### ZTE goform provider

`createZteGoformDefinition()` exposes three incompatible authentication profiles without
fallback between them: MF79U legacy base64 under `LOGIN`, MF79U `LD`-salted SHA-256 under
the same bare `LOGIN`, and MF266 salted SHA-256 under `LOGIN_MULTI_USER`. One batched
pre-auth evidence GET selects the exact shape and refuses a reported lockout before any
credential POST. MF266 derives `AD` from the probed version data and `RD`. Session material stays
in memory. Unknown ZTE firmware is fingerprinted into a read-only telemetry profile, and
Wi-Fi writes are absent from every operation surface. See
[`../docs/MF79U-DIAGNOSIS.md`](../docs/MF79U-DIAGNOSIS.md).

### UFI / HIMI provider — read-only by construction

`createUfiHimiDefinition()` normalizes the Qualcomm UFI/HIMI telemetry over the vendor's
single `POST /himiapi/json` endpoint. Because that API puts its verb in the request
body's `cmdid` rather than in the HTTP method, read-only is enforced as a **frozen
command vocabulary** — seven `get*` reads plus `login` — so a write command cannot be
expressed at all. `operations()` returns `ProviderReadOperations` entries verbatim and
exposes zero write descriptors.

The prohibited Qualcomm operations — NV, EFS, identity and calibration writes, firmware
flashing, EDL automation, blind driver/interface retries, DIAG writes, the DIAG info
probe, and shell transport fallback — are inert table entries with **no implementation
anywhere**. `planUfiOperation()` answers each with a typed reason and takes no transport
parameter, so the refusal provably precedes any device contact; the same ids driven
through `OperationEngine` are refused before execution too.

`05c6:9024` is evidence of an RNDIS+ADB composition, not a permission. `05c6:9091` is a
firmware-chosen product id and is **not** proof of DIAG — only an interface descriptor is,
and production access stays `prohibited` regardless. The supervised, read-only, bench-only
probe is documented in [`../docs/UFI-DIAG-PROBE.md`](../docs/UFI-DIAG-PROBE.md).

### NetworkManager adapter — saved vs applied

`new NetworkManagerAdapter({ port })` is the bearer/APN authority, and the only one. It holds
three separate slots per NM connection: the **desired** profile (what an operator asked for,
recorded from the request), the **applied** bearer (what NM actually put into force, recorded
from NM's readback, together with the interface it landed on), and the **observed** device
state. `observe()` folds one complete NM readout and reports a typed applied-state LOSS —
`interface-absent`, `interface-detached`, `connection-replaced`, or `activation-failed` — while
leaving the desired profile untouched, so a modem that re-enumerates costs you the bearer and
never the configuration. A device still settling is reported `pending` rather than lost, and a
readout from a superseded generation is refused rather than folded late.

It composes the existing `NmcliNmPort` rather than replacing it, performs no radio, band, SIM
or power operation, keys every slot by NM's connection UUID rather than by a physical modem
identity, mirrors no credential into a state slot, and has no profile-delete path.

The operation surface composes the existing radio/band backend, GPS location adapter and bounded
fix-state machine, read-only SMS port, USSD session adapter, and FCC coverage catalog. Generic band
reads are always runtime-driven; disruptive band writes additionally require a certification
catalog entry for the device's SKU. It contains no bearer/APN authority and no command-line
fallback. The provider never invokes `mmcli`, `qmicli`, or `mbimcli`—those remain operator
diagnostics only.

### Radio capability truth — the modem's own catalog, unedited

The root export also carries the mode/band **capability truth** layer. `SupportedModes`
and `CurrentModes` are decoded without loss: a combination whose preferred mask is 0
reads `preferred: 'none'` — a value, not a missing field — and reaches
`descriptor.constraints.values` exactly as the modem stated it. A mode bit this build
does not name round-trips as `mode-bit-<n>`, its combination is classified
`unknown-combination`, and it stays **offered**; a catalog member that is not a `(uu)`
pair is retained in `undecodable` rather than dropped, so decoded plus undecodable is
always the member count the modem sent. A selection the modem never advertised is
refused, never rounded to the nearest one.

`modes` and `bands` are typed write operations with **required readback**: the daemon
accepting `SetCurrentModes` / `SetCurrentBands` only proves the call was accepted, so
the applied value is re-read and compared before either reports success. `bands`
additionally carries `mutationImpact: 'disruptive'`, a `band-certification-present`
live precondition, and an availability that is `refused` with
`band-certification-required` unless the device's SKU resolves to an entry in the
band-lock certification catalog — which ships empty, so that is today's answer for every
device. Supply `bandSku` to `createModemManagerProvider` to resolve one;
ModemManager exposes no USB `vid:pid`, so the package cannot build a `BandSku` alone.

Both operations expose `describe(context)` alongside their static `descriptor`, because
a static descriptor cannot carry a device's own catalog or its certification state.

### SIM presence is evidence, never inference

`readSimPresence` returns the presence together with the `SimPresenceEvidence` that
decided it, and `absent` is reachable through exactly one evidence kind — ModemManager's
own `StateFailedReason: sim-missing`. A blank `Sim` object path proves nothing (MM
reports `/` while a modem initializes and while a slot switch is in flight) and reads
`unknown`. `ModemManagerSimState.present` is positive evidence only: `false` is not a
claim of absence. The Huawei, ZTE and UFI sources still claim no presence at all and now
NAME the vendor code they left undecoded, which stays verbatim in the diagnostics block.

`Modem.CurrentModes` and `Modem.SignalQuality` are retained as the D-Bus structs they
are, so the preferred mode and the measurement-recency flag survive normalization;
`NormalizedSignal.qualityRecent` claims that flag, and the router sources answer
`unsupported` for it.

### Mutation safety ports

The root export includes `MutationAdmissionPort`, `ResourceOwnershipPort`,
`ModemManagerInhibitPort`, and `UhubctlPort`. Admission remains consumer-owned: a required
mutation without an injected admission port is refused as `admission-port-missing`; this
package does not know or infer why the consumer refused it.

File stores, router sessions, and USB-hub access use acquire-or-refuse exclusive ownership.
`createFlockResourceOwnershipPort({ lockPath })` is the Linux adapter: non-blocking `flock`,
holder PID/start-time metadata, and clean release when the holder process dies. The lock path
is mandatory input; `DEFAULT_MODEM_CONTROL_LOCK_PATH` is only a conventional value callers
may select. There is no pass-through ownership implementation.

One `createModemControlCompositionRoot()` may be live per process. A second construction
throws, and `actorFor(physicalModemId)` shares one actor for that modem across all callers in
the root. `UhubctlPort` has no control-package implementation; an embedding process must
inject one and own its executable policy.

### Descriptor-gated operation engine

`createOperationEngine()` executes `OperationDescriptor` contracts through that composition
root. Every mutation enters the root's shared physical-modem actor before its live preconditions
and admission are checked. Writes are therefore single-flight per physical modem, and a mutation
that waited in the queue cannot reuse facts checked before it waited. Reads do not occupy the
write queue; the engine retries only a failed read whose descriptor explicitly says
`idempotent-read`, once.

A stale-generation completion or a timed-out/dropped write reply is classified by the frozen
domain helper as `unknown-outcome`. The engine then closes a per-`PhysicalModemId` mutation gate:
subsequent mutations are refused as `reconciliation-required` without calling the provider.
`engine.reconcile()` uses the same actor and reopens the gate only when reconciliation finishes in
the requested current generation. Required readback, rollback, and journal hooks are checked before
execution and fired according to the descriptor; an unknown outcome is never treated as a definite
failure that is safe to roll back.

### Transaction journal — the path comes from you

`createFileJournalStore({ path })` and `createJournalEngine({ store })` are the durable
half of that reconciliation gate. The engine satisfies the operation engine's
`OperationJournalHook`, so it can be handed straight to an `OperationExecution` as its
`journal`, and `engine.recover()` reads the file back after a restart and reports which
operations were still `pending` and which ended `unknown-outcome` — the set a controller
must reconcile before it mutates those modems again.

**The path is required and this package has no default for it.** Where a journal lives is
a property of the system embedding this library, not of the library, so there is no
fallback location to accidentally write to. An empty path is refused with
`JournalPathError`.

The store is append-only and never truncates itself. A record it cannot decode is returned
as typed damage alongside every record that *did* decode — including the ones after it — so
a single corrupt line can never take the rest of the journal with it. Call
`assertJournalIntact(recovery)` to escalate that damage to a `JournalRecoveryError` once
you have seen what survived. Neither an operation's input nor its returned value is ever
written to disk.

`readLegacyCeraUiJournal({ dir })` reads an older per-modem snapshot journal into the same
recovery model, so a consumer migrating onto this package can enumerate outstanding work
from files written before it existed. It only ever reads.

### `./testing` is the contract-fakes surface

A consumer writing tests against this package needs valid instances of the domain and
provider contracts. Hand-rolling them is how a consumer's fixtures come to disagree
with the package — a hand-written `OperationResult` literal quietly stops matching what
`classifyOperationCompletion` actually returns. Every fake in `./testing` is built
through this package's own constructors and classifiers, so it cannot express a shape
the domain refuses.

```ts
import { createProviderMatcher, createProviderRegistry } from '@ceralive/modem-control/providers';
import { fakeProviderDefinition, fakeProviderMatchRequest } from '@ceralive/modem-control/testing';

const registry = createProviderRegistry();
registry.register(fakeProviderDefinition({ observation: { registered: true } }));

const result = await createProviderMatcher(registry).match(fakeProviderMatchRequest());
```

`./testing` is pure data and functions — no bus, no daemon, no process, no filesystem.
It is **not** the repository's `test-support/` directory, which holds the heavy
internals this package's own tests use (an MM-faithful fake D-Bus service on a private
session bus, a stateful `nmcli` harness, and the provider-matching conformance corpus).
Those are unpublished and are not a reusable surface.

### Provider-matching conformance matrix

`src/providers/conformance-matrix.test.ts` runs 20 cases — nine fleet profiles plus
eleven ambiguity / malformed / auth-expired / lockout / unknown-firmware /
wrong-interface / wrong-transport cases — with the ModemManager, Huawei HiLink, ZTE
goform and UFI/HIMI providers **all registered at once**, asserting the exact provider,
profile, writability and evidence score per case. A companion suite asserts the exact
per-firmware HTTP transcript (method, path, form/JSON/XML body, header order, cookie,
and request count), and a third is a **software upper-bound fixture at 16 concurrently
attached modems** — a fixture result, not a hardware claim; the bench-verified fleet
size remains 8. See [`../docs/PROVIDER-MATCHING.md`](../docs/PROVIDER-MATCHING.md).

## Build

```sh
bun run build             # tsc -> dist/ (ESM + .d.ts), then fully specify every relative specifier
bun run verify:tarball    # pack and assert the published artifact's shape
bun run verify:consumers  # install the tarball into standalone Node 26 + Bun projects and import every subpath
```

`dist/` mirrors `src/` one-to-one rather than being bundled. Bundling with code
splitting produced an entry whose `export { … }` list named symbols the file never
imported — accepted by one loader, a `SyntaxError` in another. Bundling *without*
splitting instead gives each subpath its own copy of the shared modules, which silently
breaks `instanceof` across two subpaths of the same package. A 1:1 emit has exactly one
instance of every module.

Because `tsc` never rewrites a specifier and this package's sources are written for
bundler resolution, `scripts/build.ts` rewrites each emitted `./x` into `./x.js` or
`./x/index.js` — resolved against the emit itself — and fails the build if one
extensionless specifier survives.

`prepack` runs the build, so `npm pack` / `bun pm pack` can never publish a stale `dist/`.

## Shape gate

`scripts/tarball-shape.ts` runs six rules over the extracted tarball, driven from
`bun test` (`scripts/tarball-shape.test.ts`) and from the CLI
(`scripts/assert-tarball-shape.ts`):

1. no raw source ships — the published surface is built output;
2. `dist/` actually contains JavaScript and declarations;
3. every declared public entry is in the exports map **and** its files are packed;
4. no subpath beyond the declared set — internal barrels stay internal;
5. no export target, `main` or `types` points outside `./dist/`;
6. the library-only proof: no `bin`, no systemd unit, no shebang, no listening-socket
   construct.

The declared entries live in `scripts/entries.ts` and the test additionally spells the
seven specifiers out as a literal, so a subpath cannot be dropped without a reviewable
change to the public contract.

## License

AGPL-3.0
