<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## PUBLISHED PACKAGE SURFACE — BUILT ESM, SEVEN SUBPATHS, NO SERVICE

`@ceralive/modem-control` publishes **built output**: `files: ["dist"]`, and every
`exports` target resolves under `./dist/`. It shipped raw TypeScript through `v1.0.0`
(`exports` → `./src/index.ts`, `files: ["src"]`); that is gone. The public surface is
seven specifiers and no more — `.`, `./transport`, `./domain`, `./providers`,
`./capabilities`, `./hardware`, `./testing`. Full consumer-facing detail:
[`control/README.md`](../../control/README.md).

- **`control/scripts/entries.ts` is the single source of truth.** The build, the
  exports map and the shape gate all read it, so they cannot drift. Adding a row is a
  deliberate, permanent widening of the public API; internal barrels (`src/backend`,
  `src/ports`, `src/sms`, `src/ussd`, `src/location`, `src/fcc`, `src/redact`) are
  reachable only through the root entry and stay unexported on purpose.
- **`./capabilities` maps to `src/capability/` and `./hardware` to `src/band` +
  `src/usb-mode`.** The specifier is the contract; the directory layout behind it is not.
- **`./testing` is the PUBLIC contract-fakes surface, and `control/test-support/` is
  not.** The fakes are pure data and functions built through the package's own
  constructors and classifiers — `fakeOperationResult` routes through the real
  `classifyOperationCompletion`, so a consumer's fixture cannot drift from what the
  package returns, and `fakeUnavailableObservation` has no overload that could invent a
  value. `test-support/` keeps this repo's heavy internals (the MM-faithful fake D-Bus
  service on a private session bus, the stateful `nmcli` harness); it lives outside
  `src`, is unpublished, and must not become a subpath.
- **`dist/` is a 1:1 `tsc` emit, deliberately NOT a bundle.** `Bun.build --splitting`
  emitted an entry whose `export { … }` list named symbols it never imported — Bun's
  loader accepts it, Node answers `SyntaxError: Export 'BigIntRequiredError' is not
  defined in module`. Bundling without splitting instead gives each subpath its own copy
  of the shared modules, which breaks `instanceof DomainError` across two subpaths of
  one package. The 1:1 emit has one instance of every module.
- **`scripts/build.ts` rewrites every emitted relative specifier** into `./x.js` or
  `./x/index.js`, resolved against the emit itself, because the sources are written for
  `moduleResolution: bundler` and `tsc` never rewrites a specifier. The build FAILS if
  one extensionless specifier survives. `prepack` runs the build, so no pack can publish
  a stale `dist/`.
- **The repo-root `tsconfig.json` `paths` map `@ceralive/modem-control*` back to
  `control/src`.** This is DEV-ONLY and load-bearing: without it the workspace `cli`
  resolves the package through its exports map to `dist` while `control/test-support`
  resolves the same modules relatively, and `Brand`'s `unique symbol` turns every
  branded value crossing between them into a hard type error. It also means the
  workspace never needs `dist` to exist in order to typecheck or test. The published
  package is unaffected — consumers still resolve to `dist`.
- **The built artifact is proven by things that ignore that mapping.**
  `control/scripts/tarball-shape.test.ts` packs with `bun pm pack` and runs six rules
  over the extracted tarball (no raw source / built output present / every declared
  entry exported AND packed / no undeclared subpath / nothing pointing outside `./dist/`
  / **no `bin`, systemd unit, shebang or listening-socket construct** — the library-only
  proof). Every detector has a non-vacuity test that trips it with a synthetic artifact.
  `control/fixtures/` then holds two STANDALONE consumer projects — one Node, one Bun —
  which `bun run verify:consumers` installs the real `.tgz` into and imports all seven
  specifiers from. The Node fixture refuses to run on anything but Node 26.x, so a green
  result cannot come from an older Node on `PATH`.
- **Removing `./testing` cannot pass the gate.** It is a row in `entries.ts` AND a
  literal in the shape test's `EXPECTED_SUBPATHS`, so dropping it from `package.json`
  fails four tests and dropping it from `entries.ts` too fails a fifth.

