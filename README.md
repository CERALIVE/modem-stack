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
| [`control/`](control/) | **`@ceralive/modem-control`** (npm package) | The TypeScript control library: the [frozen v1.1 domain contracts](docs/DOMAIN-CONTRACTS.md), [provider registry and evidence-scored matcher](docs/PROVIDER-MATCHING.md), ModemManager D-Bus backend, NetworkManager adapter, desired-state reconciler, recovery ladder + the `usb-hub-port-cycle` **uhubctl PowerHook** (`control/src/backend/uhubctl-power-hook.ts`, config-mapped port map, disabled by default), USB composition-mode model + the [evidence-bundle ingestion seam](docs/CATALOG-INGESTION.md), data-usage sampler plus its `setUsagePolicy` write surface (`control/src/backend/usage/policy-write.ts` — a local 0600 policy file, because ModemManager exposes no data-usage API at all), and the **read-only SMS port** (`control/src/ports/sms.ts` + `control/src/sms/` — LIST/READ plus `Added`/`Deleted` observation, never a send or a delete, locked by `sms/readonly-gate.test.ts`). Published to the public npm registry under the `@ceralive` scope as **built ESM + `.d.ts`** across seven entry points — see [`control/README.md`](control/README.md). |
| [`cli/`](cli/) | **`modem-control`** (bench CLI) | The iteration surface: `probe`, `watch`, `apply`, `set-usb-mode`, `usage`, `certify`, `hil-cycle`. Compiled for `arm64` + `amd64` and run against real modems on a bench device to mature the package, capture per-SKU certification bundles, and prove hub VBUS port-cycling ([RB-10](docs/BENCH.md#rb-10--hub-vbus-verification-partial)). |
| [`packaging/`](packaging/) | **ModemManager stack `.deb`s** | Bookworm rebuilds of ModemManager + libmbim + libqmi + libqrtr-glib — **packaging only, not a fork, zero source patches** (see [`POLICY.md`](POLICY.md)). Provenance-verified upstream pins; installed on the bench from CI artifacts. |

The control package's existing `./hardware` entry point also exposes transport-free
SIM-presence and Huawei/ZTE/UFI response normalization. Device I/O, sessions, retries,
interface binding, caches, and writes remain outside those pure parsers. Its existing
root, `./domain`, and `./capabilities` surfaces also expose deterministic compatibility
helpers for portable modem identity, display naming, ModemManager enums, USB-network
classification, capability selection, and shadow-result comparison; these helpers perform
no discovery or transport and leave CeraUI integration to a separate cutover.

## Versioning at a glance

ONE unified **SemVer** tag `vX.Y.Z` releases **both** artifacts together: `v0.2.0` publishes
`@ceralive/modem-control@0.2.0` to npm **and** the `.deb` artifact set in the same release.
This repo deliberately does **not** use the CeraLive CalVer scheme. The `.deb` internal
`Version:` fields encode the tag as `<upstream>-<rev>~ceralive<X.Y.Z>` (e.g.
`1.24.2-2~ceralive0.2.0`) so apt ordering stays correct. Full contract:
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

`control/` and `cli/` form a single **Bun** workspace (Bun 1.3.14, strict TypeScript,
Biome via `@ceralive/biome-config`). `packaging/` is built in a bookworm container.

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
