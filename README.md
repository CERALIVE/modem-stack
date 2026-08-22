# modem-stack

Cellular modem control for CeraLive streaming devices — the standalone home for
everything modem, iterated on a bench device before any product integration.

Through `v0.2.0` this repository was **Phase A**: it built, tested, and released on its
own, with zero changes to CeraUI, the device image, or apt-worker. **Phase B
adoption — integrating this repository's artifacts into CeraUI, the device image, and the
apt distribution — is authorized starting at the `v1.0.0` release tag** (see
[`POLICY.md`](POLICY.md) §4); each downstream integration is still its own explicit,
reviewed change in the receiving repository. Bench devices install the packaged `.deb`s
straight from CI artifacts; nothing is published to `apt.ceralive.tv` yet.

## Three artifacts, one repo

| Directory | Artifact | What it is |
|-----------|----------|------------|
| [`control/`](control/) | **`@ceralive/modem-control`** (npm package) | The TypeScript control library: the [frozen v1.1 domain contracts](docs/DOMAIN-CONTRACTS.md), [provider registry and evidence-scored matcher](docs/PROVIDER-MATCHING.md), concrete typed-D-Bus [`ModemManagerProvider`](docs/MODEMMANAGER-PROVIDER.md) (runtime-discovered generic controls; no CLI subprocess), NetworkManager adapter, desired-state reconciler, injected mutation-admission and exclusive-ownership ports, USB composition-mode model + the [evidence-bundle ingestion seam](docs/CATALOG-INGESTION.md), data-usage sampler plus its `setUsagePolicy` write surface (`control/src/backend/usage/policy-write.ts` — a local 0600 policy file, because ModemManager exposes no data-usage API at all), and the **read-only SMS port** (`control/src/ports/sms.ts` + `control/src/sms/` — LIST/READ plus `Added`/`Deleted` observation, never a send or a delete, locked by `sms/readonly-gate.test.ts`). The USB-hub actuator is port-only here; the bench CLI owns its HIL adapter. Published to the public npm registry under the `@ceralive` scope as **built ESM + `.d.ts`** across seven entry points — see [`control/README.md`](control/README.md). |
| [`cli/`](cli/) | **`modem-control`** (bench CLI) | The iteration surface: `probe`, `watch`, `apply`, `set-usb-mode`, `usage`, `certify`, `hil-cycle`. Compiled for `arm64` + `amd64` and run against real modems on a bench device to mature the package, capture per-SKU certification bundles, and prove hub VBUS port-cycling ([RB-10](docs/BENCH.md#rb-10--hub-vbus-verification-partial)). |
| [`packaging/`](packaging/) | **ModemManager stack `.deb`s** | Bookworm rebuilds of ModemManager + libmbim + libqmi + libqrtr-glib — **packaging only, not a fork, zero source patches** (see [`POLICY.md`](POLICY.md)). Provenance-verified upstream pins; installed on the bench from CI artifacts. |

The control package's existing `./hardware` entry point also exposes transport-free
SIM-presence and Huawei/ZTE/UFI response normalization. Device I/O, sessions, retries,
interface binding, caches, and writes remain outside those pure parsers. Its existing
root, `./domain`, and `./capabilities` surfaces also expose deterministic compatibility
helpers for portable modem identity, display naming, ModemManager enums, USB-network
classification, capability selection, and shadow-result comparison; these helpers perform
no discovery or transport and leave CeraUI integration to a separate cutover.

The ModemManager operation surface also exposes runtime USB-composition capability. Known
vendors are queried with exact reviewed READ/TEST forms, targets come from the device's own
enumeration only when it includes a return path, and writes retain the shared admission,
journal, rollback, readback, identity, and streaming-interlock fences. Reviewed catalog
descriptors remain the strongest success proof; otherwise a weaker post-switch device READ
must report the target. Band certification remains catalog-gated and unchanged.

## Versioning at a glance

ONE unified **SemVer** tag `vX.Y.Z` releases **both** artifacts together: `v1.1.0` publishes
`@ceralive/modem-control@1.1.0` to npm **and** the `.deb` artifact set in the same release.
This repo deliberately does **not** use the CeraLive CalVer scheme. The `.deb` internal
`Version:` fields encode the tag as `<upstream>-<rev>~ceralive<X.Y.Z>` (e.g.
`1.24.2-2~ceralive1.1.0`) so apt ordering stays correct. Full contract:
[`docs/VERSIONING.md`](docs/VERSIONING.md).

## Layout

```
modem-stack/
├── control/        @ceralive/modem-control — TS control library (Bun workspace member)
├── cli/            modem-control bench CLI  (Bun workspace member)
├── packaging/      ModemManager-stack .deb rebuilds + provenance/verification CI
├── docs/           BENCH.md runbooks, CATALOG-INGESTION.md, COMPOSITION-EVIDENCE.md,
│                   VERSIONING.md, FM350-DECISION.md, ESIM-DECISION.md
├── AGENTS.md       AI routing + repo contract (self-contained; see Rule D)
└── POLICY.md       no-fork gate + upstream-contribution-first policy
```

`control/` and `cli/` form a single **Bun** workspace (Bun 1.4.0, strict TypeScript 7.0.2,
Biome via `@ceralive/biome-config`). `packaging/` is built in a bookworm container.
The two AST-backed source-shape guard tests use the test-only TypeScript 6 compiler-API
compatibility package; workspace typechecking and package emit remain TypeScript 7.

## Develop

```sh
bun install        # install the workspace (control + cli)
bun test           # run the workspace test suite (includes the tarball-shape gate)
bun run lint       # Biome check
bun run typecheck  # tsc --noEmit (strict, exactOptionalPropertyTypes)
bun run build      # build @ceralive/modem-control into control/dist

cd control
bun run verify:tarball    # pack + assert the published artifact's shape
bun run verify:consumers  # standalone Node 26 + Bun consumers of the packed tarball
```

Every command runs from the repository root and needs nothing outside this checkout —
the repo is self-contained (see [`AGENTS.md`](AGENTS.md) → Rule D).

## License

AGPL-3.0

## Huawei HiLink provider (Todo 24)

`control/src/providers/huawei-hilink/` implements two exact firmware profiles: E3372H `22.200.05.00.1080` with password type 3 and E3372H `22.333.01.00.00` with password type 4. Firmware and `SesTokInfo` evidence select one profile; `state-login` must confirm its password type before one bounded login attempt, and a mismatch never falls through to another algorithm. Requests are interface-bound and redirect-disabled. Mode and data writes are independently capability-gated, acquire `router-session`, serialize by physical modem, and require a newly authenticated readback session before `applied`. Wi-Fi writes are absent. Credentials, derived hashes, cookies, and tokens remain memory-only and never enter errors or contract fixtures. See [`docs/HUAWEI-HILINK-PROVIDER.md`](docs/HUAWEI-HILINK-PROVIDER.md).

## ZTE goform provider (Todo 25)

`control/src/providers/zte-goform/` keeps MF79U base64, MF79U `LD`-salted-under-`LOGIN`,
and MF266 `LOGIN_MULTI_USER` authentication in separate evidence-selected profiles with
one bounded attempt and an in-memory-only `stok` session. A batched pre-auth probe refuses
known lockout before the credential POST. Unknown ZTE firmware retains read-only telemetry;
no ZTE profile exposes a Wi-Fi write. The executable MF79U one-attempt diagnosis is documented in
[`docs/MF79U-DIAGNOSIS.md`](docs/MF79U-DIAGNOSIS.md).

## UFI / HIMI provider (Todo 26)

`control/src/providers/ufi-himi/` is the Qualcomm UFI/HIMI provider: **read-only by
construction**. The HIMI command vocabulary is a frozen union of seven `get*` reads plus
`login`, so a write command cannot be expressed; `operations()` exposes zero write
descriptors; and the prohibited operations (NV/EFS/identity/calibration writes, firmware
flashing, EDL automation, blind driver/interface retries, DIAG writes, shell transport
fallback) are inert table entries with no implementation anywhere, each answering a typed
refusal before any transport call. `05c6:9024` proves an RNDIS+ADB composition and
`05c6:9091` proves nothing at all — only a DIAG interface descriptor does, and even then
production access stays prohibited. The supervised, read-only, bench-only DIAG info probe
is documented in [`docs/UFI-DIAG-PROBE.md`](docs/UFI-DIAG-PROBE.md).

## Radio capability truth + SIM evidence (Todo 28)

`control/src/radio/` carries ModemManager's mode and band answers to a consumer without
editing them. A combination whose preferred mask is 0 reads `preferred: 'none'` — the
bench Fibocom FM350-GL's actual answer — and survives verbatim into the mode-write
descriptor's allowed values; a mode bit this build cannot name round-trips as
`mode-bit-<n>` and stays **offered** rather than being coerced to unsupported; a catalog
member that is not a `(uu)` pair is retained rather than dropped. Mode and band writes are
readback-gated, and a band write additionally carries `mutationImpact: 'disruptive'` plus
the per-SKU certification gate from `control/src/band/` — whose catalog ships empty, so
band writes are refused on every fleet device today.

On the observation layer, SIM absence is EXPLICIT evidence: `absent` comes only from
ModemManager's own `StateFailedReason: sim-missing`, never from a blank `Sim` object path
(which MM also reports while a modem initializes and while a slot switch is in flight).
`Modem.CurrentModes` and `Modem.SignalQuality` are retained as their D-Bus structs, so the
preferred mode and the measurement-recency flag survive normalization.

## Provider-matching conformance matrix (Todo 27)

`control/src/providers/conformance-matrix.test.ts` registers all four providers at once and
runs 20 cases — nine fleet profiles (MM-managed Quectel / SIMCom / FM350-on-USB-carrier, both
HiLink firmwares, MF79U, MF266, both UFI USB ids) plus ambiguous-collision, cross-profile
refusal, malformed-response, auth-expired, lockout, unknown-firmware, wrong-interface
and wrong-transport cases — asserting the exact provider, profile, writability and evidence
score each device is entitled to. A tie between two write-capable providers resolves read-only
with both claimants in the evidence ledger and neither credential spent. Companion suites
assert the exact sanitized per-firmware HTTP transcript and a **software upper-bound fixture at
16 concurrently attached modems** (a fixture result — the hardware-verified fleet size remains
8). See [`docs/PROVIDER-MATCHING.md`](docs/PROVIDER-MATCHING.md).
