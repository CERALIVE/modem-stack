<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CI / CD

Follows the CeraLive CI/CD standard (concurrency, trigger hygiene, least privilege, pinned
major action versions, per-manager caches, weekly grouped Dependabot, test-before-publish).

- **`.github/workflows/ci-bun.yml`** — paths-filtered PR + push(`main`) lane for
  `control/**` and `cli/**`: `bun install` → Biome check → `tsc --noEmit` → `bun test` →
  `bun run verify:consumers` (the standalone Node 26 + Bun consumer fixtures against the
  packed tarball). Its `node-version` pin is load-bearing rather than incidental:
  `control/scripts/verify-consumers.ts` refuses any major but 26.
  `cancel-in-progress: true`.
- **`.github/workflows/ci-packaging.yml`** — paths-filtered PR + push(`main`) container lane
  for `packaging/**`: runs the packaging contract scripts in `debian:trixie`. The four
  `debian/` recipes and `build-stack.sh` now exist; the full contract suite (metadata /
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
  3. **build-deb** (needs [tag-guard, test]) — the **DIFFERENTIAL** `.deb` job. Steps, in file
     order: **Checkout the resolved commit** (`fetch-depth: 0` — load-bearing here and nowhere
     else, since the detector diffs `<prev-tag>..HEAD`; a shallow checkout would silently
     force-all forever) → **Assert checkout is pinned to the resolved SHA** → **Set up QEMU
     (arm64 emulation)** → **Resolve previous release + fetch its manifest (once)**
     (`id: prev-release`; `gh release list`, never `git describe` — the previous release is the
     latest PUBLISHED one; no release or no manifest asset leaves both outputs empty, which is
     the bootstrap case, not an error) → **Detect changed sources (per-source verdicts)**
     (`packaging/ci/detect-changed-sources.sh --out verdicts.txt`) → **Stage carry-forward debs
     (unchanged sources, sha256-verified)** (`packaging/ci/stage-carryforward-debs.sh`) →
     **Build the MM 1.24 stack (.deb) — amd64 + arm64** (`build-stack.sh amd64` /`arm64`,
     with `VERDICTS_FILE` + the already-resolved `PREV_MANIFEST_FILE`) → **Package contract
     suite** (amd64 full, arm64 metadata) → **Daemon smoke (amd64)** → **Build the first-party
     companion .deb (Architecture: all)** (UNCONDITIONAL — the companion is never detected and
     never carried) → **Companion package contract (clean Debian chroot)** → **Generate release
     manifest** (`packaging/ci/generate-release-manifest.sh`) → **Upload .deb artifacts +
     release manifest**.

     Three things about that order are load-bearing. The previous release is resolved and its
     manifest downloaded **exactly once**, and that one path feeds all three consumers
     (detection, carry-forward staging, per-source counter derivation). Carry-forward staging
     runs **strictly before any `build-stack.sh` call**, because carried debs are a build
     INPUT — `build-stack.sh` seeds its Pin-Priority-1001 local apt repo from
     `packaging/build/<arch>/`, so a changed source resolves its build-deps and gir typelibs
     against the carried `-dev`/`gir1.2-*` packages rather than the stock suite; staging late
     still goes green and silently reintroduces stock dependencies, which is why
     `packaging/ci/test-release-workflow-wiring.sh` pins the ordering statically. And a
     zero-build run starts no container at all yet still asserts the merged runtime closure
     over the carried set.

     Detection is **fail-SAFE toward rebuilding**: an absent previous release, a manifest with
     no `closure_version:` header (an absent header IS closure version 1), a shared-input
     change under `packaging/ci/**` or `packaging/SUITE-ADAPTATIONS.md`, or the operator's
     escape hatch all yield `mode=force-all`. That escape hatch is the `force_rebuild`
     `workflow_dispatch` boolean input (default `false`), mapped to the script's
     `FORCE_REBUILD=all` env via
     `${{ github.event.inputs.force_rebuild == 'true' && 'all' || '' }}` — defense in depth, since
     a shared-input change force-alls on its own.
  4. **publish-npm** (needs [tag-guard, build-deb]) — OIDC trusted publishing
     (`id-token: write`), verifies `control/package.json` version === tag, then an
     **integrity-idempotent** publish: `npm pack` → classify registry state (404 → publish;
     present+matching integrity → idempotent skip; present+differing → fail closed), with a
     last-instant `resolve-tag.sh` re-verification immediately before `npm publish`.
  5. **create-release** (needs [tag-guard, build-deb, publish-npm], `contents: write`) —
     pre-create moved-tag re-check, downloads the `.deb` + manifest artifact, assembles a flat
     asset dir, and reconciles it immutably via `packaging/ci/reconcile-release-assets.sh`
     (manifest-complete, staged sanitized `~`→`.` names, collision-rejected, existing assets
     integrity-compared and never overwritten). The flat assembly additionally REFUSES a
     duplicate RAW basename before any sanitization can mask it. It then **dispatches
     `apt-modem-closure` to `CERALIVE/apt-worker`** — last, so the manifest the publisher
     fetches already exists on the release. `CERALIVE_DISPATCH_TOKEN` must be a fine-grained
     PAT with **`Contents: read/write`** on the target repo; the repository-dispatch endpoint
     is gated on Contents, NOT on `Actions: write`.
- **`.github/workflows/apt-dispatch-preflight.yml`** — proves this repository's
  `CERALIVE_DISPATCH_TOKEN` can reach apt-worker's publisher without publishing anything. It
  sends `client_payload.preflight=true`, which apt-worker forces to DRY_RUN regardless of its
  live default; with no tag it exits before manifest resolution, so it is safe to run BEFORE
  the release exists. An operator's own `gh api` call would test the operator's CLI token and
  prove nothing about the repository secret — which is exactly why this lives here.
  `cancel-in-progress: false` (never cancel a release/publish mid-run).
- **`.github/workflows/upstream-watch.yml`** — the weekly **upstream freshness watch**
  (schedule + `workflow_dispatch`, `cancel-in-progress: false`). Runs
  `packaging/ci/check-upstream-freshness.sh`, which enumerates each source's upstream release
  tags and salsa `debian/*` packaging tags via `git ls-remote --tags`, filters out the
  development series, and compares the survivors to the pins. On `behind` it opens **or
  updates** ONE issue labelled `upstream-freshness`; when everything is current again it closes
  it. **Issue-only** — it never edits `packaging/upstream-pins.yaml` and never dispatches a
  build, which is why it is the ONLY workflow here that escalates `issues: write` and why it
  holds no dispatch token. The stable filter is the substance: all four projects publish their
  unstable train on the same tag namespace (ModemManager `1.25.95` → Debian *experimental*), so
  `-rc`/`-dev`, non-`X.Y.Z`, **odd-minor** and `.9x`-micro tags are rejected, as are `~`-bearing
  Debian revisions. A newer upstream release with no Debian packaging tag reports the distinct
  `upstream-ahead-no-packaging` — NOT `behind`, because with no `<upstream>-<rev>` pair there is
  no bump to recommend. `packaging/ci/test-check-upstream-freshness.sh` pins all of it offline
  through a fixture seam. NOTE: GitHub disables scheduled workflows after 60 days of repository
  inactivity — a silent watch reads exactly like an up-to-date one.

Action pins track the latest stable **major** (resolved via the `gh api` releases/latest
endpoint); Dependabot keeps them current. JS/TS CI runs on **Node 26** — the CeraLive CI
baseline, and the runtime the published tarball's consumer fixture asserts on.

