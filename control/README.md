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

ESM only (`"type": "module"`). Node 26 and Bun 1.3 are the runtimes the published
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
session bus, a stateful `nmcli` harness). Those are unpublished and are not a reusable
surface.

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
