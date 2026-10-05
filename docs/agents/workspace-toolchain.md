<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## WORKSPACE / TOOLCHAIN

**The language is a decided question, not a default.** A Rust migration (a `zbus` daemon
fronted by a thin TS client, the `srtla-send-rs` shape) was assessed and **rejected by the
project owner on 2026-08-24**. TypeScript on Bun stays, and the decision is final until one
of the named revisit triggers fires. That record also carries the idea-attribution for
`irlserver/modem-metrics`: MIT-licensed, concepts adopted, **no source code copied**. Read it
before proposing a rewrite or extending the telemetry surface:
[`docs/adr/ADR-STAY-TYPESCRIPT.md`](../adr/ADR-STAY-TYPESCRIPT.md).

- **Bun 1.4.2** (`.bun-version`, `packageManager` in `package.json`). `control/` + `cli/`
  are Bun workspace members.
- **Strict TypeScript 7.0.2** incl. `exactOptionalPropertyTypes` — the repo-root
  `tsconfig.json` is the workspace checker (`bun run typecheck` → `tsc --noEmit`) for both
  members. `control/tsconfig.json` extends it only to give editors the same types for the
  package's AST guard tests. The root config's explicit `types` entry preserves Bun globals;
  its DEV-ONLY `paths` map is resolved relative to that config and deliberately has no
  `baseUrl`, which TypeScript 7 removed.
- **AST guard compatibility:** `@typescript/typescript6` is a test-only compiler-API shim for
  source-shape guards. TypeScript 7's native `tsc` remains the workspace checker and emitted
  package compiler; the shim never reaches `control/dist` or the published tarball.
- **Biome** via `@ceralive/biome-config` (repo-root `biome.json` extends it). `bun run lint`.
- **Bun test** (`bun test`) discovers `*.test.ts` across both members.
- **Node 26** for the standalone consumer fixtures (`control/fixtures/`). Point
  `CERALIVE_NODE_BIN` at a Node 26 binary if it is not first on `PATH`.

```sh
bun install
bun test          # workspace tests (includes the tarball-shape gate)
bun run lint      # biome check .
bun run typecheck # tsc --noEmit (strict + exactOptionalPropertyTypes)
bun run build     # build @ceralive/modem-control into control/dist

cd control
bun run verify:tarball    # pack + assert the published artifact's shape
bun run verify:consumers  # install the tarball into standalone Node 26 + Bun projects
```

`packaging/` runs in a `debian:$TARGET_SUITE` container (default `trixie`); its contract/verification scripts live
under `packaging/ci/`. The four sources' `debian/` recipes are checked in at
`packaging/<Source>/debian/` (`ModemManager`, `libmbim`, `libqmi`, `libqrtr-glib` — matching
their pinned salsa commits except the suite adaptations and the approved ModemManager
FM350-GL series documented in `packaging/SUITE-ADAPTATIONS.md`).
`packaging/ci/build-stack.sh <amd64|arm64>` (suite-parameterized: `TARGET_SUITE`, default
`trixie`) rebuilds
them from source in the mandatory bootstrap order (`libqrtr-glib → libmbim → libqmi →
modemmanager`) via a temporary local apt repo, on native amd64 or full-system-QEMU arm64
(never cross-built), and asserts the 9-package runtime closure. `.deb` output lands in the
gitignored `packaging/build/<arch>/`.

**BUILD-SUITE PARITY IS A GATE.** The build container's own `VERSION_CODENAME` must equal
`TARGET_SUITE` or `build-stack.sh` REFUSES the build. This is not ceremony: a stack built
against a newer libc than the board ships fails at load with a `GLIBC_` symbol error that no
build step can observe, so the mismatch would otherwise surface only on a device. Overriding
`TARGET_SUITE` is for bisecting a suite-specific build break, never for cutting a release.

The suite move to trixie did NOT let the `debian/` adaptations be reverted, which is the
counter-intuitive part and is re-measured rather than assumed in
`packaging/SUITE-ADAPTATIONS.md`: trixie moved BOTH `udev.pc` and `systemd.pc` into
`systemd-dev`, so the `udev` build-dep supplies neither and the two meson install-dir pins
are *more* load-bearing than they were on bookworm. The GI substitution likewise still
resolves (`libgirepository1.0-dev` is current at `1.84.0-1`), so reverting it would re-open a
verified deviation surface for no gain.

