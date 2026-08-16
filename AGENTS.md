# modem-stack — AI routing & repo contract

Cellular modem control for CeraLive: a control library, a bench CLI, and ModemManager-stack
`.deb` packaging. Through `v0.2.0` this repository was **Phase A** — iterated standalone, no
product wiring. **Phase B adoption (CeraUI / device-image / apt integration) is authorized
starting at the `v1.0.0` release tag** — see `POLICY.md` §4. Each downstream integration
remains its own explicit, reviewed change in the receiving repository.

Canonical branch: `main`. Sole remote: `origin` → `https://github.com/CERALIVE/modem-stack`.

## THREE-ARTIFACT MAP

| Directory | Artifact | Role |
|-----------|----------|------|
| `control/` | `@ceralive/modem-control` (npm) | TypeScript control library — domain model, ModemManager D-Bus backend, NetworkManager adapter, desired-state reconciler, recovery ladder + the `usb-hub-port-cycle` **uhubctl PowerHook** (see § below), USB composition-mode model + evidence-bundle **ingestion seam**, data-usage sampler. Published to public npm under `@ceralive`. |
| `cli/` | `modem-control` (bench CLI) | The iteration surface: `probe`/`watch`/`apply`/`set-usb-mode`/`usage`/`certify`/`hil-cycle`, compiled `arm64`+`amd64`, run against real modems. Not published to npm. |
| `packaging/` | ModemManager stack `.deb`s | Bookworm rebuilds of ModemManager + libmbim + libqmi + libqrtr-glib — packaging only, zero source patches (see `POLICY.md`). Bench installs from CI artifacts. |

`control/` + `cli/` are one **Bun** workspace. `packaging/` builds in a bookworm container.

## RULE D — SELF-CONTAINED (load-bearing)

**This repo builds, tests, and releases standalone in CI. The CeraLive workspace parent
does not exist there.** Therefore:

- **No tracked file may reference a path above this checkout root** — no relative
  parent-directory escape, no reference to the workspace parent directory, no sibling-repo
  `link:` / `file:` / relative-path dependency. Cross-repo CeraLive packages
  (`@ceralive/biome-config`, and in future `@ceralive/modem-control` consumers) are used
  **registry-only**, resolved through npm identically whether or not any sibling repo is
  checked out.
- Test artifacts and QA evidence go to the repo-local, gitignored `test-results/`.
- The local orchestration scratch dir (`.omo/`) is gitignored and must appear in no other
  tracked file.
- Config that a child package needs is resolved by package name (Biome via
  `@ceralive/biome-config`) or from a single repo-root `tsconfig.json` that covers both
  workspace members — never by climbing out of the repo.

If a build step needs something from outside the repo, that is a design error: surface it,
do not reach up the tree.

## VERSIONING

SemVer, **not** CalVer — this repo is the documented exception (alongside `srtla-send-rs`).
ONE unified tag `vX.Y.Z` releases **both** artifacts: `@ceralive/modem-control@X.Y.Z` on
npm and the `.deb` set. `.deb` versions encode the tag as `<upstream>-<rev>~ceralive<X.Y.Z>`
(upstream-ordered, apt-safe; injected with `dch --force-bad-version`). Non-tag CI builds use
`~ceralive0.0.0~dev`. Full contract: `docs/VERSIONING.md`.

## PROVENANCE PINS (packaging)

The four rebuilt sources are pinned in `packaging/upstream-pins.yaml`, re-verified end-to-end
by `packaging/ci/verify-upstream-pins.sh` in an isolated `GNUPGHOME`. Current pins:

| Source | Upstream | Salsa packaging tag |
|--------|----------|---------------------|
| ModemManager | 1.24.2 | `debian/1.24.2-2` |
| libmbim | 1.34.0 | `debian/1.34.0-1` |
| libqmi | 1.38.0 | `debian/1.38.0-1` |
| libqrtr-glib | 1.4.0 | `debian/1.4.0-1` |

Each pin carries a **four-link provenance chain**, all re-checked and failing closed with a
named field on any drift:

1. **Lineage** — the upstream git tag object + peeled commit SHA (`git ls-remote`; the tag is
   never byte-compared to a git archive).
2. **Authority** — the signed Debian `.dsc`, GPG-verified against a pinned signer fingerprint
   whose armored key lives in `packaging/keys/` (mapping in `packaging/keys/README.md`).
3. **Artifact** — the `.orig.tar`, whose sha256 equals the verified `.dsc`'s
   `Checksums-Sha256` entry.
4. **Packaging** — the `.debian.tar.xz`, whose sha256 equals the `.dsc`, and whose extracted
   `debian/` tree is proven byte-identical to the pinned salsa tag via a canonical metadata
   manifest (path, file type, exec-bit, symlink target, content sha256 per entry).

The container build additionally enforces the finalized **two-set package model** (declared
arch-dependent stanzas + enumerated `-dbgsym`) for exact per-source set **equality** via
`packaging/ci/check-package-sets.sh` (add/remove/rename fails closed). Full detail:
`packaging/README.md`.

## RECOVERY LADDER — uhubctl POWER HOOK (rung 4)

`control/src/backend/uhubctl-power-hook.ts` (`createUhubctlPowerHook`) is the first real
`PowerHook` implementation: the `usb-hub-port-cycle` capability backing recovery-ladder
rung 4. It cuts VBUS on one port of a per-port-power-switching (PPPS) USB hub via `uhubctl`
and reports `applied` only once the SAME modem (by udev `ID_PATH`) is observed back on the
bus — a zero exit from `uhubctl` is never treated as success on its own.

- **Config-mapped, never discovered.** A stable key is cyclable only if an operator wrote
  it into an explicit, Zod-validated port-map file: `{ [stableKey]: { hubLocation: string,
  port: number } }`. There is no default path and no probing/guessing — `hubLocation` is
  regex-pinned to the sysfs bus-port shape so a shell-metacharacter or flag cannot parse
  into it.
- **Argv-only, allowlisted, no shell.** The command is built as an argv array
  (`['-l', loc, '-p', port, '-a', 'cycle', '-d', '3']`) and every emitted token is
  re-checked against an allowlist before the injected runner is called.
- **Bounded + cancellable** (`commandTimeoutMs` + `enumerationTimeoutMs`, plus an optional
  `AbortSignal`); **serialised per modem** through the shared `ModemActor`, keyed on the
  stable key, so two overlapping cycles on one port cannot interleave power-on/power-off.
- **Disabled by default**, matching the existing recovery-ladder default
  (`RECOVERY_DISABLED: { enabled: false }` in `control/src/domain/policy.ts`) — this hook
  does not change that default; it is only reachable when an operator opts in.
- The HIL harness (`cli hil-cycle <slot> --hub-map <file>`, bench runbook
  [`docs/BENCH.md` RB-10](docs/BENCH.md)) orchestrates a full cycle end-to-end: pre-state
  capture → PowerHook cycle → USB-disappearance assertion → re-enumeration assertion → MM
  re-detection of the same `modem.generic.device` slot UID. See `cli/README.md` for the
  exact CLI contract and typed failure reasons.

## CERTIFICATION EVIDENCE → CATALOG (evidence-gated, human-reviewed)

A SKU reaches `control/src/usb-mode/certified-catalog.json` only through a captured
`certify` bundle and a human-reviewed commit. The path is documented in
[`docs/CATALOG-INGESTION.md`](docs/CATALOG-INGESTION.md) and implemented as a pure
transform in `control/src/usb-mode/{ingestion,promotion-review,usb-devices-parse}.ts`.

- **`synthetic: true` is REFUSED for catalog promotion by the code**, not by convention
  (`buildCatalogEntryCandidate` → typed `reason: 'synthetic-bundle'`). Classifier fixtures
  may be synthetic; their provenance says so. That asymmetry is the design.
- **Certification is two-stage** because `certify --transition` refuses a SKU that is not
  already in the catalog: stage 1 merges an entry with `permittedTransitions: []`, stage 2
  adds one transition carrying its own `evidenceBundleSha256`.
- **`canonicalMode` is a reviewer's stated claim, never inferred**; when transition evidence
  exists the seam cross-checks it against the captured `transition.from`.
- Per-SKU capture runbooks are `docs/BENCH.md` **RB-11 … RB-15** (RB-16 is the FM350
  USB-vs-PCIe probe — its 2026-08-16 bench run found the unit not connected, so
  `docs/FM350-DECISION.md`'s three-gate ledger stays OPEN with the probe evidence recorded;
  RB-17 is modem-flap resilience). All are `[PARTIAL]` — four named blockers
  (`usbutils` absent from the board and its archive; the enumerator not populating `ifname`;
  no AT transport on the bench; an empty real-SKU catalog) are recorded in `docs/BENCH.md`
  § "Per-SKU certification". No SKU is certified and no matrix row is promoted.
- The full bench-runbook ladder, RB-1 through RB-17, lives in `docs/BENCH.md`: RB-9 is the
  fleet-inventory capture (one identity bundle per acquired physical unit), RB-10 is the
  hub VBUS port-cycle verification backing the PowerHook above, RB-11..15/17 are the
  per-SKU/flap-resilience captures documented above, RB-16 is the FM350 probe.

## eSIM (investigate-only, implementation deferred)

`docs/ESIM-DECISION.md` records the full eSIM investigation: SGP.22 profile-binding makes
cross-device profile "copying" cryptographically impossible; the workable paths are
removable eUICC, carrier reissue, or multi-profile remote switching; `lpac` (external LPA)
is assessed but not adopted (AGPL-3.0 core, AT backend is demo-only, needs MM
inhibit-coordination). Implementation is **deferred by user decision (2026-08-13)** — this
doc is the exit artifact, not a task list. No eSIM code exists in this repository.

## POLICY

`packaging/` is a **no-fork** effort: the first release carries zero quilt patches; adding a
patch later is an architecture gate (rationale + filed upstream MR + review);
udev/plugin/device-support improvements go **upstream first** — this binds permanently,
independent of phase. The Phase A → Phase B scope boundary is **version-gated at
`v1.0.0`**: CeraUI / device-image / apt integration is out of scope through `v0.2.0` and
authorized from the `v1.0.0` tag forward. Full terms: `POLICY.md` §4.
The Fibocom **FM350** modem (PCIe / `mtk_t7xx`) is documented-**deferred**, not supported —
rationale, source cites, and the open gates are recorded in `docs/FM350-DECISION.md`.

## WORKSPACE / TOOLCHAIN

- **Bun 1.3.14** (`.bun-version`, `packageManager` in `package.json`). `control/` + `cli/`
  are Bun workspace members.
- **Strict TypeScript** incl. `exactOptionalPropertyTypes` — a single repo-root
  `tsconfig.json` covers both members (`bun run typecheck` → `tsc --noEmit`).
- **Biome** via `@ceralive/biome-config` (repo-root `biome.json` extends it). `bun run lint`.
- **Bun test** (`bun test`) discovers `*.test.ts` across both members.

```sh
bun install
bun test          # workspace tests
bun run lint      # biome check .
bun run typecheck # tsc --noEmit (strict + exactOptionalPropertyTypes)
```

`packaging/` runs in a `debian:bookworm` container; its contract/verification scripts live
under `packaging/ci/`. The four sources' `debian/` recipes are checked in at
`packaging/<Source>/debian/` (`ModemManager`, `libmbim`, `libqmi`, `libqrtr-glib` —
byte-identical to their pinned salsa commits except the bookworm adaptations documented in
`packaging/BOOKWORM-ADAPTATIONS.md`). `packaging/ci/build-bookworm.sh <amd64|arm64>` rebuilds
them from source in the mandatory bootstrap order (`libqrtr-glib → libmbim → libqmi →
modemmanager`) via a temporary local apt repo, on native amd64 or full-system-QEMU arm64
(never cross-built), and asserts the 9-package runtime closure. `.deb` output lands in the
gitignored `packaging/build/<arch>/`.

## CI / CD

Follows the CeraLive CI/CD standard (concurrency, trigger hygiene, least privilege, pinned
major action versions, per-manager caches, weekly grouped Dependabot, test-before-publish).

- **`.github/workflows/ci-bun.yml`** — paths-filtered PR + push(`main`) lane for
  `control/**` and `cli/**`: `bun install` → Biome check → `tsc --noEmit` → `bun test`.
  `cancel-in-progress: true`.
- **`.github/workflows/ci-packaging.yml`** — paths-filtered PR + push(`main`) container lane
  for `packaging/**`: runs the packaging contract scripts in `debian:bookworm`. The four
  `debian/` recipes and `build-bookworm.sh` now exist; the full contract suite (metadata /
  closure / upgrade / rollback / daemon smoke) lands in a later task.
  `cancel-in-progress: true`.
- **`.github/workflows/release.yml`** — the **single** release workflow, owns **both**
  artifacts. `workflow_dispatch` with a `tag` input. **Strictly sequential** job graph
  `tag-guard → test → build-deb → publish-npm → create-release` (build-before-publish; npm
  never publishes before the `.deb` set builds green). Every downstream job checks out
  `ref: needs.tag-guard.outputs.sha` and re-asserts `git rev-parse HEAD` equals that peeled
  SHA; every dynamic input is routed through `env:` (no `${{ }}` in any `run:` body):
  1. **tag-guard** — resolves the tag to its **peeled commit SHA**
     (`packaging/ci/resolve-tag.sh`, `git ls-remote`, prefers `refs/tags/<tag>^{}`),
     re-checks out that SHA, asserts HEAD, then runs `packaging/ci/tag-guard.sh` (input must
     match `^v\d+\.\d+\.\d+$`; pre-release / build-metadata / missing-`v` **fails closed**
     before any other job). Exports `version` + `sha`.
  2. **test** (needs tag-guard) — full bun lane + packaging contract lane
     (test-before-publish).
  3. **build-deb** (needs [tag-guard, test]) — injects `<upstream>-<rev>~ceralive<X.Y.Z>`
     (non-tag runs `~ceralive0.0.0~dev`) via `packaging/ci/inject-deb-version.sh`, builds both
     arches, runs the package contract suite + daemon smoke, generates the manifest-complete
     release manifest (`packaging/ci/generate-release-manifest.sh`), and uploads the `.deb`
     artifacts + manifest.
  4. **publish-npm** (needs [tag-guard, build-deb]) — OIDC trusted publishing
     (`id-token: write`), verifies `control/package.json` version === tag, then an
     **integrity-idempotent** publish: `npm pack` → classify registry state (404 → publish;
     present+matching integrity → idempotent skip; present+differing → fail closed), with a
     last-instant `resolve-tag.sh` re-verification immediately before `npm publish`.
  5. **create-release** (needs [tag-guard, build-deb, publish-npm], `contents: write`) —
     pre-create moved-tag re-check, downloads the `.deb` + manifest artifact, assembles a flat
     asset dir, and reconciles it immutably via `packaging/ci/reconcile-release-assets.sh`
     (manifest-complete, staged sanitized `~`→`.` names, collision-rejected, existing assets
     integrity-compared and never overwritten).
  `cancel-in-progress: false` (never cancel a release/publish mid-run).

Action pins track the latest stable **major** (resolved via the `gh api` releases/latest
endpoint); Dependabot keeps them current. JS/TS CI runs on **Node 24**.

## DOCS DISCIPLINE (Rule A)

Any change to this repo's behavior or structure updates this `AGENTS.md`, the relevant
`README.md`, and `docs/` in the **same** change. Keep the three-artifact map, the versioning
contract, and the no-fork policy authoritative.
