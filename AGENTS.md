# modem-stack — AI routing & repo contract

Cellular modem control for CeraLive: a control library, a bench CLI, and ModemManager-stack
`.deb` packaging. **Phase A** — iterated standalone, no product wiring.

Canonical branch: `main`. Sole remote: `origin` → `https://github.com/CERALIVE/modem-stack`.

## THREE-ARTIFACT MAP

| Directory | Artifact | Role |
|-----------|----------|------|
| `control/` | `@ceralive/modem-control` (npm) | TypeScript control library — domain model, ModemManager D-Bus backend, NetworkManager adapter, desired-state reconciler, USB composition-mode model, data-usage sampler. Published to public npm under `@ceralive`. |
| `cli/` | `modem-control` (bench CLI) | The iteration surface: `probe`/`watch`/`apply`/`set-usb-mode`/`usage`/`certify`, compiled `arm64`+`amd64`, run against real modems. Not published to npm. |
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

## POLICY

`packaging/` is a **no-fork** effort: the first release carries zero quilt patches; adding a
patch later is an architecture gate (rationale + filed upstream MR + review);
udev/plugin/device-support improvements go **upstream first**. Full terms: `POLICY.md`.

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
under `packaging/ci/`.

## CI / CD

Follows the CeraLive CI/CD standard (concurrency, trigger hygiene, least privilege, pinned
major action versions, per-manager caches, weekly grouped Dependabot, test-before-publish).

- **`.github/workflows/ci-bun.yml`** — paths-filtered PR + push(`main`) lane for
  `control/**` and `cli/**`: `bun install` → Biome check → `tsc --noEmit` → `bun test`.
  `cancel-in-progress: true`.
- **`.github/workflows/ci-packaging.yml`** — paths-filtered PR + push(`main`) container lane
  for `packaging/**`: runs the packaging contract scripts in `debian:bookworm`. At this
  stage the contract lane is a stub (real recipes land in a later task).
  `cancel-in-progress: true`.
- **`.github/workflows/release.yml`** — the **single** release workflow, owns **both**
  artifacts. `workflow_dispatch` with a `tag` input. Job graph:
  1. **tag-guard** (`packaging/ci/tag-guard.sh`) — input must match `^v\d+\.\d+\.\d+$`;
     anything else (pre-release, build metadata, missing `v`) **fails closed** before any
     other job runs.
  2. **test** (needs tag-guard) — full bun lane + packaging contract lane
     (test-before-publish).
  3. **publish-npm** (needs test) — OIDC trusted publishing (`id-token: write`), verifies
     `control/package.json` version === tag, `npm publish --access public`.
  4. **build-deb** (needs test) — strips `v`, injects `<upstream>-<rev>~ceralive<X.Y.Z>`
     into each source's `debian/changelog` via `dch --force-bad-version`
     (`packaging/ci/inject-deb-version.sh`), uploads `.deb` artifacts + a release manifest.
     Non-tag runs use `~ceralive0.0.0~dev`.
  `cancel-in-progress: false` (never cancel a release/publish mid-run).

Action pins track the latest stable **major** (resolved via the `gh api` releases/latest
endpoint); Dependabot keeps them current. JS/TS CI runs on **Node 24**.

## DOCS DISCIPLINE (Rule A)

Any change to this repo's behavior or structure updates this `AGENTS.md`, the relevant
`README.md`, and `docs/` in the **same** change. Keep the three-artifact map, the versioning
contract, and the no-fork policy authoritative.
