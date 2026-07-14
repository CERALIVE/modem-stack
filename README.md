# modem-stack

Cellular modem control for CeraLive streaming devices — the standalone home for
everything modem, iterated on a bench device before any product integration.

This repository is **Phase A**: it builds, tests, and releases on its own, with **zero
changes to CeraUI, the device image, or apt-worker**. Bench devices install the packaged
`.deb`s straight from CI artifacts; nothing is published to `apt.ceralive.tv` yet.

## Three artifacts, one repo

| Directory | Artifact | What it is |
|-----------|----------|------------|
| [`control/`](control/) | **`@ceralive/modem-control`** (npm package) | The TypeScript control library: modem domain model, ModemManager D-Bus backend, NetworkManager adapter, desired-state reconciler, USB composition-mode model, data-usage sampler. Published to the public npm registry under the `@ceralive` scope. |
| [`cli/`](cli/) | **`modem-control`** (bench CLI) | The iteration surface: `probe`, `watch`, `apply`, `set-usb-mode`, `usage`, `certify`. Compiled for `arm64` + `amd64` and run against real modems on a bench device to mature the package and capture per-SKU certification bundles. |
| [`packaging/`](packaging/) | **ModemManager stack `.deb`s** | Bookworm rebuilds of ModemManager + libmbim + libqmi + libqrtr-glib — **packaging only, not a fork, zero source patches** (see [`POLICY.md`](POLICY.md)). Provenance-verified upstream pins; installed on the bench from CI artifacts. |

## Versioning at a glance

ONE unified **SemVer** tag `vX.Y.Z` releases **both** artifacts together: `v0.1.0` publishes
`@ceralive/modem-control@0.1.0` to npm **and** the `.deb` artifact set in the same release.
This repo deliberately does **not** use the CeraLive CalVer scheme. The `.deb` internal
`Version:` fields encode the tag as `<upstream>-<rev>~ceralive<X.Y.Z>` (e.g.
`1.24.0-1~ceralive0.1.0`) so apt ordering stays correct. Full contract:
[`docs/VERSIONING.md`](docs/VERSIONING.md).

## Layout

```
modem-stack/
├── control/        @ceralive/modem-control — TS control library (Bun workspace member)
├── cli/            modem-control bench CLI  (Bun workspace member)
├── packaging/      ModemManager-stack .deb rebuilds + provenance/verification CI
├── docs/           VERSIONING.md and other engineering docs
├── AGENTS.md       AI routing + repo contract (self-contained; see Rule D)
└── POLICY.md       no-fork gate + upstream-contribution-first policy
```

`control/` and `cli/` form a single **Bun** workspace (Bun 1.3.14, strict TypeScript,
Biome via `@ceralive/biome-config`). `packaging/` is built in a bookworm container.

## Develop

```sh
bun install        # install the workspace (control + cli)
bun test           # run the workspace test suite
bun run lint       # Biome check
bun run typecheck  # tsc --noEmit (strict, exactOptionalPropertyTypes)
```

Every command runs from the repository root and needs nothing outside this checkout —
the repo is self-contained (see [`AGENTS.md`](AGENTS.md) → Rule D).

## License

AGPL-3.0
