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
| `control/` | `@ceralive/modem-control` (npm) | TypeScript control library — domain model, ModemManager D-Bus backend, NetworkManager adapter, desired-state reconciler, injected admission/ownership/USB-hub ports, USB composition-mode model + evidence-bundle **ingestion seam**, data-usage sampler + the **usage-policy write surface**, capability-module **support-claim taxonomy + detection**, and the **band-lock** vocabulary + certification catalog (see §§ below). Published to public npm under `@ceralive` as **built ESM + `.d.ts`** across seven entry points (see § PUBLISHED PACKAGE SURFACE). |
| `cli/` | `modem-control` (bench CLI) | The iteration surface: `probe`/`watch`/`apply`/`set-usb-mode`/`usage`/`certify`/`hil-cycle`, compiled `arm64`+`amd64`, run against real modems. Not published to npm. |
| `packaging/` | ModemManager stack `.deb`s **+ the first-party companion** | Bookworm rebuilds of ModemManager + libmbim + libqmi + libqrtr-glib — packaging only, not a fork. libmbim/libqmi/libqrtr-glib remain source-unmodified; ModemManager carries exactly three owner-approved, BELABOX-derived FM350-GL patches, hardware-validated on the carrier-mediated USB topology after restoring the original `ATZ0` first-enable override (see `POLICY.md` and `docs/adr/ADR-FM350-RNDIS-BEARER.md`) — PLUS `ceralive-modem-support`, the `Architecture: all` first-party companion that owns CeraLive's generic modem system assets. |

`control/` + `cli/` are one **Bun** workspace. `packaging/` builds in a bookworm container.

## FIRST-PARTY COMPANION — `ceralive-modem-support`

The first-party `ceralive-modem-support` package keeps CeraLive-owned system assets out of
all four upstream recipes; the ModemManager FM350-GL source series is a separate, narrowly
approved exception and owns no companion asset. The companion
(`packaging/ceralive-modem-support/`, `Architecture: all`) owns the UNCONDITIONAL, generic
modem system assets — CeraLive's identification-only udev rules, Zero-CD usb-modeswitch
device data, and the FCC policy-reconciliation helper plus its oneshot unit. It ships **no
FCC-unlock script at all**; an absent `/data/ceralive/fcc-unlock-policy.json` exits 0 and activates nothing,
which is also the correct behaviour on generic Debian with no CeraLive partition layout.

**Board-gated generated assets stay image-owned** — M.2 SIM quirk rows and per-slot modem UID
rules consume build-time board facts a generic package cannot know. Do not move them here.

**The udev basename is load-bearing.** udev resolves rules by BASENAME, and an
`/etc/udev/rules.d` file SHADOWS a same-basename `/usr/lib/udev/rules.d` file completely
while `dpkg -S` keeps naming the package as owner of the `/usr/lib` path — the substitution
is invisible to package tooling. The companion therefore uses the modem-only basename
`60-ceralive-modem.rules`, which no image-owned `/etc` file shares (the image owns
`99-ceralive-hardware.rules` and `78-mm-ceralive-slot-uid.rules`). Never rename it onto an
image-owned basename, and never ship an `/etc` copy from this package. A stale same-basename
`/etc` override is removed on upgrade ONLY when marker AND sha256 identify a known generated
payload; anything unknown or operator-modified is preserved.

QA is two-stage and the split is deliberate: `packaging/ci/test-companion-chroot.sh` proves
packaging SHAPE in a clean `debian:trixie` container, while the consumer proofs (`udevadm
test` against a real modem, `usb_modeswitch -c`, unit ordering against a real boot journal)
are BENCH-GATED and must not be faked in a container. Full detail: `packaging/README.md`.

The release manifest emits **`closure_version: 2`**, which adds this one `Architecture: all`
asset to the frozen 9 × 2 closure as a single row with `build_arch` `all`. It is ONE
immutable release asset with TWO index memberships; apt-worker's publisher indexes it into
both per-arch indexes. A per-arch build is forbidden — two byte-different files under one
package/version key break the immutable-key rule.

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
npm and the `.deb` set. Non-tag CI builds use `~ceralive0.0.0~dev`. Full contract:
`docs/VERSIONING.md`.

**`.deb` versions no longer encode the tag.** Releases are DIFFERENTIAL, so each upstream
source carries its own rebuild counter: `<upstream>-<rev>~ceralive.N` (upstream-ordered,
apt-safe; injected with `dch --force-bad-version`). A REBUILT source takes its previous
counter + 1, derived from the previous release manifest's rows for that source; an
UNTOUCHED source is carried forward byte-identically and keeps the counter it already had,
never re-stamped with the new tag. Two sources at different counters in one release is the
normal shape, not drift — coherence is a PER-SOURCE property, and a source disagreeing with
ITSELF fails closed naming that source. Derivation reads every row of a source (both arches,
runtime and aux) and refuses on a counter disagreement, a counter/legacy mixture, or a
malformed suffix; entirely-legacy rows and an absent previous manifest bootstrap at `.1`.

The pre-`v1.0.0` releases WERE built with one uniform `~ceralive<X.Y.Z>` suffix shared by all
four sources; those published artifacts are unchanged. No release mixes the two schemes — the
first differential release force-rebuilds every source at `.1`, because this effort's own
`packaging/ci/**` changes are a shared build input and force-all on their own. The
migration-continuity chain `~ceralive0.2.0 < ~ceralive1.0.0 < ~ceralive1.1.0 < ~ceralive.1 <
~ceralive.2 < ~ceralive.10 < <upstream>-<rev>` is proven with real `dpkg --compare-versions`
by the ONE sourced library `packaging/ci/suffix-contract.sh`, from both
`test-suffix-coherence-manifest.sh` (host) and `test-package-contract.sh` CHECK 5/6
(container). The release manifest states `suffix_scheme: per-source-counter` and carries **no
`deb_version_suffix:`** — under per-source counters no single suffix value is truthful. The
companion `ceralive-modem-support` stays outside this entirely: bare SemVer tag version, no
`~ceralive` suffix, and always rebuilt.

## FROZEN V1.1 DOMAIN CONTRACTS

`control/src/domain/` additively freezes the provider-neutral v1.1 foundation while the
published v1.0 package facade remains intact. The exact public shapes and safety rules are
documented in [`docs/DOMAIN-CONTRACTS.md`](docs/DOMAIN-CONTRACTS.md).

- `PhysicalModemId` / `StableKey` use serial → udev `ID_PATH` → a 128-character-bounded
  fallback. Their constructors refuse MM object paths, interface names, IP addresses, IMEI,
  and subscriber identifiers; none of those runtime or sensitive values can become the new
  physical identity.
- `DeviceGeneration` increments on re-enumeration or provider replacement and fences every
  async observation/operation completion. `ObservationEnvelope<T>` separately models fresh,
  stale, and unavailable data; unavailable carries `value: null`, never an invented value.
- `OperationDescriptor<I, O>` keeps read and write support independent and records authority,
  constraints, preconditions, availability, mutation impact, retry policy, transactional
  requirements, evidence, and confidence. `OperationResult<O>` maps stale completions and
  timed-out/dropped writes to `unknown-outcome` with mandatory reconciliation. Only explicitly
  classified idempotent reads may auto-retry.

This layer is pure data and functions: no daemon, socket, network endpoint, or CeraUI import.

## PROVIDER REGISTRY + EVIDENCE MATCHER

`control/src/providers/` is the provider-neutral registration and selection layer built on the
frozen v1.1 domain contracts. The public contract and scoring details are documented in
[`docs/PROVIDER-MATCHING.md`](docs/PROVIDER-MATCHING.md).

- `ProviderDefinition` keeps each provider's profile version, declarative passive matchers,
  harmless unauthenticated probes, optional single owner-selected authentication algorithm,
  normalized `ObservationEnvelope` producer, provider-specific operations object and sanitized
  contract fixtures together. `ProviderReadOperations` and `ProviderWriteOperations` are
  composable capability subinterfaces; there is no package-wide vendor mega-interface.
- `createProviderMatcher` evaluates every registered provider in stage order: transport → passive
  facts → unauthenticated fingerprints → profile rank → at most one auth call → capability reads.
  Evidence is scored `unsupported → maybe → likely → supported`; only a unique `supported`
  candidate receives its operations object.
- Ties and weak candidates return `ambiguous`, with `provider`, `profile` and `operations` all
  `null`, `writable: false`, and the complete evidence/conflict ledger retained. Authentication is
  not attempted for tied candidates, so an ambiguous match cannot cycle algorithms or acquire a
  write surface.
- Selection is cached only for the same `PhysicalModemId`, `DeviceGeneration`, registry revision,
  firmware and composition. Any generation, firmware or composition change runs the full matcher
  again.

This layer registers no concrete provider. Huawei, ZTE, UFI/HIMI and other implementations remain
separate evidence-backed work.

### CONFORMANCE MATRIX — ALL FOUR PROVIDERS REGISTERED AT ONCE

`control/src/providers/conformance-matrix.test.ts` is where todo 5's matcher meets every real
provider simultaneously. Each provider suite runs with only itself in the registry, which cannot
answer whether a Huawei dongle stays a Huawei dongle while a ZTE provider and a UFI provider are
also asking. **20 cases** — 9 fleet profiles + 11 safety cases (ambiguous collision,
cross-profile refusal, 3 malformed, auth-expired, lockout, 2 unknown-firmware,
wrong-interface, wrong-transport) — each registering all four providers, expecting the EXACT
decision. Full behaviour: [`docs/PROVIDER-MATCHING.md`](docs/PROVIDER-MATCHING.md) §
"The conformance matrix".

- **The corpus is repo-local and unpublished** (`control/test-support/conformance/`) and REUSES
  `observation-fixtures.ts` rather than minting a second payload set that can drift from it.
  Sanitization is structural, not a review promise: a 14+ digit run anywhere in the corpus or in
  any recorded request FAILS the suite unless it is a declared member of
  `SANITIZED_SUBSCRIBER_IDENTIFIERS`, and the detector has a non-vacuity control.
- **`conformance-transcripts.test.ts` asserts the exact wire** per firmware — method, path,
  query, form/JSON/XML body, the header ARRAY in order, and the cookie — rebuilt from the
  protocol, never read back from the provider. A whole-array `toEqual` pins the request COUNT
  too, so an extra login or a stray probe fails even when the decision is unchanged.
- **`conformance-scale.test.ts` is a SOFTWARE UPPER BOUND at 16 concurrently attached modems.**
  It is a FIXTURE result: subscriptions stay fleet-wide (4, never per-modem), `Signal.Setup` is
  issued once per (epoch, modem) and re-applied to every survivor on a new epoch, an attachment
  burst is coalesced, and sixteen concurrent matches each answer about their own modem. **The
  hardware-verified figure remains the 8-device bench fleet** — 16 must never be reported as a
  bench measurement; a hardware claim comes from todo 42, on a real board.
- **`test-support/conformance/mm-transport.ts` is an in-memory `DbusTransport`** serving the SAME
  `fake-mm/object-model.ts` tree, so MM rows run without `dbus-run-session`. `fake-mm/service.ts`
  stays the right harness for codec/epoch proof on a real bus; a matrix whose MM rows SKIP where
  no session bus exists answers nothing, which is why the matrix uses this one.
- **The UFI fingerprint probe is fenced by USB evidence** (`usbEvidencePermitsProbe`) — this
  matrix is what found it. The HIMI fingerprint needs a session, so an unfenced probe spent the
  provider's single bounded login against every non-HIMI device in the registry. An ABSENT usb
  fact is still probed; a MISMATCHING one is not.

## PUBLISHED PACKAGE SURFACE — BUILT ESM, SEVEN SUBPATHS, NO SERVICE

`@ceralive/modem-control` publishes **built output**: `files: ["dist"]`, and every
`exports` target resolves under `./dist/`. It shipped raw TypeScript through `v1.0.0`
(`exports` → `./src/index.ts`, `files: ["src"]`); that is gone. The public surface is
seven specifiers and no more — `.`, `./transport`, `./domain`, `./providers`,
`./capabilities`, `./hardware`, `./testing`. Full consumer-facing detail:
[`control/README.md`](control/README.md).

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

**The pins are watched, never auto-bumped.** `.github/workflows/upstream-watch.yml` runs
weekly (plus `workflow_dispatch`) and calls `packaging/ci/check-upstream-freshness.sh`, which
enumerates each source's upstream release tags and salsa `debian/*` packaging tags via
`git ls-remote --tags`, filters the development series out, and compares the survivors to the
four pins above. On `behind` it opens **or updates** ONE issue labelled `upstream-freshness`,
and closes it when everything is current again. It is **issue-only**: it never edits
`upstream-pins.yaml` and never dispatches a build, which is why it is the only workflow here
holding `issues: write` and no dispatch token. A newer upstream release with no matching
Debian packaging tag reports the distinct `upstream-ahead-no-packaging` — there is no
`<upstream>-<rev>` pair to pin, so there is no bump to recommend.

## MUTATION ADMISSION + EXCLUSIVE OWNERSHIP

`control/src/ports/mutation-admission.ts` defines `MutationAdmissionPort`. It is an injected
authority only: the package submits an operation id, physical modem id, mutation impact and
the descriptor's frozen `admission` requirement, then preserves the port's typed decision.
It contains no stream state or stream policy. A required admission with no injected port is
`{ status: 'refused', reason: 'admission-port-missing' }`, never an allow-all fallback.

`control/src/ports/resource-ownership.ts` defines the acquire-or-refuse
`ResourceOwnershipPort` used for file stores, router sessions and USB-hub access. The Linux
default adapter is `createFlockResourceOwnershipPort()` in `control/src/safety/`: it requires
an injected path, uses non-blocking `flock`, records the actual holder PID and start time,
and relies on kernel lock lifetime plus PID liveness to recover after holder death. The
conventional caller-selected path is `DEFAULT_MODEM_CONTROL_LOCK_PATH`; the adapter itself
has no hidden path and there is no no-op ownership implementation.

The lock holder is an external `/bin/cat` kept alive by a pipe round-trip after `flock`
acquires the inode. It deliberately does not re-execute `process.execPath`: in a Bun-compiled
CLI that path is the application binary, not an evaluator, so `-e` re-enters argument parsing
and falsely looks like lock contention. The integration suite pins the no-evaluator-argument
contract alongside real cross-process exclusion; the compiled CLI is covered by its arm64 and
amd64 build plus hardware smoke.

`createModemControlCompositionRoot()` fails if an ownership port is absent and throws
`CompositionRootAlreadyExistsError` for a second live root in the same process. Within one
root, `actorFor(PhysicalModemId)` returns the same `ModemActor` to every caller for that
physical modem. `ModemManagerInhibitPort` is the narrow MM inhibit/uninhibit contract used by
maintenance transactions. `UhubctlPort` is port-only in the control package: v1.1 ships no
provider, runner, argv builder or concrete `uhubctl` call. The bench CLI owns its existing
HIL-only adapter and acquires the same exclusive lock before using it.

## DESCRIPTOR-GATED OPERATION ENGINE

`control/src/operations/operation-engine.ts` executes the frozen `OperationDescriptor` and
`OperationResult` contracts. It takes a `ModemControlCompositionRoot`, so every mutation uses
todo 19's shared actor for its `PhysicalModemId`; live preconditions and admission are checked
inside that actor immediately before execution, never cached before queueing. Reads bypass the
write queue and only failed `idempotent-read` descriptors receive one automatic retry.

The behavioral uncertainty fence is a per-engine `Set<PhysicalModemId>`. A stale-generation
completion or timed-out/dropped write classifies `unknown-outcome` and inserts the modem into
that set. Every later mutation checks the set before calling admission or provider code and is
refused `reconciliation-required`. `OperationEngine.reconcile()` runs on the same actor and
removes the modem only after a successful reconciliation whose generation stayed current.
Required readback, rollback and journal hooks are checked before execution; rollback runs only
after a definite failure/readback mismatch, never after an unknown outcome. Public hook and
reconciliation types are in `control/src/operations/contracts.ts`; the module is exported through
the existing package root and adds no package subpath.

## TRANSACTION JOURNAL — PATH-PARAMETERIZED, APPEND-ONLY, NEVER SELF-TRUNCATING

`control/src/journal/` is the durable half of the uncertainty fence above. The operation
engine keeps "which modems need reconciling" in a `Set<PhysicalModemId>` on the engine
instance, so a process death drops it and the next mutation proceeds as if nothing were
outstanding. The journal writes the same two facts down. It is exported through the
existing package ROOT entry and adds **no** package subpath (todo 17/18 precedent).

**THE PATH IS INJECTED AND HAS NO DEFAULT — this package never names `/data`.**
`createFileJournalStore({ path })` REQUIRES the path and substitutes nothing; an empty
path throws `JournalPathError` rather than falling back. Same shape and same reason as
todo 19's `FlockResourceOwnershipOptions.lockPath`: an embedding process owns its
filesystem layout, and a library that guesses one writes to the wrong disk on a device it
has never seen. `journal-path-injection.test.ts` scans this directory's shipped source —
**comments stripped** — for absolute path literals and for `/data` / CeraUI-specific
location tokens, and fails the build on either. Prose naming a path stays legal (the
compat reader has to be able to explain the shape it reads); executable code producing one
does not. The strip is proven non-vacuous both ways.

**Three durability properties, each pinned by a test that goes red when removed:**

- **Append-only.** There is no verb that rewrites or truncates. A rewrite is the one
  operation that can lose an already-durable fact, and a journal that can lose a fact
  answers nothing after a crash.
- **A damaged record never discards its neighbours.** `read()` decodes every line
  independently and returns the survivors ALONGSIDE a typed `JournalDamageRecord[]`.
  Stopping at the first bad line — what a `for` loop with a throw does naturally —
  silently truncates the journal to its first corruption. Breaking this reddens 9 tests.
- **A torn trailing line is closed before the next append.** A process killed mid-write
  leaves a final line with no terminator; appending straight onto it would glue the new
  entry to the garbage and corrupt a SECOND record that was never in flight. The store
  probes the last byte once and emits a leading terminator when needed, so damage stays
  confined to the record that actually tore. The damaged bytes are PRESERVED, never
  rewritten away (the `fcc/policy-store.ts` fail-safe stance, not the usage store's
  rewrite-fresh one).

**The typed recovery error is `JournalRecoveryError`, raised by `assertJournalIntact`, and
it is deliberately NOT raised by `recover()`.** Recovery must be able to hand back the
survivors even when part of the file is unreadable, so the decision to refuse to proceed
belongs to the caller — after it has seen what did survive.

**Four dispositions, and only two of them mean "reconcile".** `pending` (a start with no
completion) and `unknown-outcome` (the engine's own classification) both populate
`reconciliationRequired`; `resolved` is a definite ending; `blocked` is a terminal state a
human must clear. `blocked` exists for the compat reader below — folding CeraUI's
`failed`/quarantine states into `resolved` would report an operator-blocked device as
healthy, and folding them into `unknown-outcome` would claim doubt about a known outcome.

**Neither the operation's INPUT nor its RETURNED VALUE is ever written to disk.** An input
is routinely a PIN, a PUK, or a USSD command carrying a voucher code; a returned value is
routinely a message body or a location fix — every one of them a class `redact.ts` masks
elsewhere. The journal records THAT an operation ran and HOW it ended, never what was sent
or read, and a test greps the written file for both. A caller needing a rollback payload
owns persisting it under its own redaction decision.

### CeraUI compatibility — a READER, because the two shapes genuinely differ

`journal/legacy-ceraui.ts` reads the mutation journal CeraUI already writes. The shapes are
not interchangeable and neither is being re-labelled: this package's journal is an
append-only EVENT LOG in one file, CeraUI's is a directory of per-modem LATEST-STATE
snapshot documents, rewritten whole on every transition. The bridge decodes CeraUI's shape
into the SAME `JournalOperationRecord` model, so a consumer enumerates pending and
unknown-outcome work across both **without CeraUI having to change its file format first**.

- **Nothing here writes.** No rewrite, no repair, no in-place migration, no delete.
  CeraUI's own reader leaves an unreadable slot on disk deliberately; a second reader that
  tidied up behind it would destroy evidence CeraUI kept on purpose.
- **The directory is injected**, exactly like the native store's path.
- **`armed` maps to `pending`, `executing` maps to `unknown-outcome`.** They are different
  facts: `armed` says the pre-state was captured and the write never dispatched, so the
  device is untouched; `executing` says it WAS dispatched and no terminal state was
  recorded — precisely this package's unknown outcome. Collapsing them either invents
  certainty about a dispatched write or manufactures doubt about one that never left.
- **A legacy `unknown-outcome` record carries NO outcome reason.** `JournalOutcome`'s
  unknown union is the frozen domain vocabulary and CeraUI's `executing` asserts none of
  its three members. The disposition carries the fact; the reason stays unclaimed.
- **`kind` is validated as a non-empty string, NOT against a frozen enum.** CeraUI spreads
  its capability-module mutation kinds into the runtime enum, so the vocabulary grows on
  CeraUI's release cycle — a frozen copy here would reject a valid file the day a module is
  added, and a compatibility reader that fails closed on new-but-valid input is worse than
  none.
- **`JournalOperationRecord.physicalModemId` is TEXT, and `origin` says which vocabulary it
  holds.** A legacy record carries CeraUI's `stableKey`, which `physicalModemId()` REFUSES
  by construction; coercing it would either throw on a valid legacy file or launder a
  foreign identity into a branded type that promises the serial/ID_PATH ladder.
- `legacyMutationSlotName(stableKey)` mirrors CeraUI's `<sha256-hex>.json` slot naming so a
  consumer can address one modem without scanning. **Rule-D MIRROR, never a shared
  import** — the same relationship the support-claim ladder and the redaction key sets
  already have with their CeraUI twins.

Coverage: `journal/journal-replay.test.ts` (write N, drop the engine with no shutdown,
reconstruct from disk, assert the pending/unknown enumeration), `journal-corruption.test.ts`
(trailing, mid-file, torn, wrong-version and missing-field damage), `legacy-ceraui.test.ts`,
and `journal-path-injection.test.ts`. Fixtures: `control/test-support/journal-fixture.ts`.

## DATA-USAGE POLICY — A LOCAL WRITE, BECAUSE MODEMMANAGER HAS NO SUCH API

`setUsagePolicy` (`control/src/backend/usage/policy-write.ts`) is the WRITE half of
the data-usage surface: it persists a slot's cycle day + advisory threshold and,
when a live `UsageSampler` is supplied, applies them to it in the same call. Until
it existed the package could only REPORT `cycleBytes` / `thresholdBytes` /
`thresholdExceeded` — `DesiredUsage` was a shape the planner echoed into a receipt,
with no persistence and no apply path.

**It writes a local file, never the modem, and that is a finding rather than a
shortcut.** Verified against a live ModemManager 1.24.2 (`mmcli --help-all` plus a
D-Bus introspection of a real `…/ModemManager1/Modem/N`): the only `Setup`/threshold
surface on the entire object is `Modem.Signal.Setup` /
`Modem.Signal.SetupThresholds`, whose keys are `rssi-threshold` and
`error-rate-threshold` — RADIO QUALITY, not bytes. The only byte counters MM offers
are the per-BEARER read-only `Stats` (`rx-bytes`/`tx-bytes`), which reset with every
connection and so cannot carry a monthly cycle. That is why the sampler counts
`/proc/net/dev` instead, and why `control/src/ports/README.md`'s ownership table
records usage policy as LOCAL-CONTROLLER owned. `Modem.Signal.Setup` is separately
forbidden outright by the shadow-mode mutation-freedom contract; nothing here goes
near it.

- **`createUsagePolicyFileStore`** mirrors `createUsageFileStore` exactly — versioned
  document, temp → chmod → atomic rename so the file is **mode 0600** regardless of
  umask, and **fail-soft on corruption**: an unparseable file logs METADATA ONLY
  (byte count + a named field, never the content) and is replaced by a fresh empty
  one. A row carries only an opaque slot id and two numbers, so the no-PII property
  of the counter store holds here by construction.
- **Typed results, never a throw on bad input** (the `PowerHook` precedent): an
  out-of-range day answers `{status:'rejected', reason:'invalid-cycle-day'}`. This is
  called from an RPC boundary, where a throw becomes an opaque 500.
- **Tri-state fields.** `undefined` leaves a persisted value ALONE; an explicit
  `null` CLEARS it. So a caller changing only the threshold cannot silently drop a
  cycle day it never mentioned, and a caller that cannot express `null` can never
  unset a policy. Clearing both fields REMOVES the row rather than storing an empty one.
- **Order is load → validate → persist → apply.** The store is the source of truth
  (the composition root rebuilds every `UsageObservation.usage` from it via
  `selectUsagePolicy`), so a live apply that landed while the write failed would
  leave the running process disagreeing with what a restart restores.
- **`UsageSampler.applyUsagePolicy` resets the window on a CHANGED cycle anchor and
  KEEPS the counter baseline.** Bytes already accrued were measured under the old
  window and there is no record of how they were distributed within it, so carrying
  them over would over-report the new one; keeping `lastObserved` means the next
  sample still attributes only genuinely new bytes, never a jump. A threshold-only
  change moves no anchor and resets nothing.
- **An applied policy OUTRANKS a later observation carrying the old one**, for the
  process lifetime. Without that, the next `sample()` would clobber a just-applied
  write with whatever the composition root had built its observation from, and the
  operator would watch their setting revert.

`SlotUsageSnapshot` gained an additive `cycleDay` so the read side reports the policy
in force, not only its consequences.

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
  RB-17 is modem-flap resilience). All are `[PARTIAL]` — the **six-entry** status ledger is
  in `docs/BENCH.md` § "Per-SKU certification". B1 is cleared; B3 is partially cleared
  (`socat` permits a manual query-only AT session, but `benchAtSender` still rejects sends);
  B4 remains open. The hardware-proven capture defects B2/B5/B6 were fixed in software on
  2026-08-20: USB snapshots retain their `/sys` path, `certify` correlates MM
  `Device`/`Physdev` to the most-specific USB parent, `skuOf` receives MM `Modem.Revision`
  rather than USB `ID_REVISION`, and the shared redactor masks MM/mmcli IMEI and equipment-
  identifier spellings while preserving model/vendor/SKU facts. Realistic RM530N tests pin
  `0504` versus `RM530NGLAAR05A01M4G`. The snapshot contract lives in
  `control/src/backend/usb-device-snapshot.ts` and remains re-exported by the classifier. The
  fixed build has **not** been rerun on the board, so no post-fix hardware bundle, certified
  SKU, or promoted matrix row is claimed.
- **Bench composition evidence** for the SIMCom SIM7600G-H and the carrier-mounted Fibocom
  FM350-GL is recorded in [`docs/COMPOSITION-EVIDENCE.md`](docs/COMPOSITION-EVIDENCE.md) —
  descriptors, driver bindings, firmware revisions, and the read-back state of each vendor's
  USB-mode command (`AT+CUSBPIDSWITCH`, `AT+GTUSBMODE`), captured **non-mutatingly**
  (bare-execute / READ `?` / TEST `=?` forms only; no SET form was ever sent). It certifies
  nothing: the SIMCom's PID→composition mapping is unproven so its target modes stay
  UNCERTIFIED and HIDDEN, and the FM350 gains **no** classifier entry for its `0e8d:7127`
  carrier id — `docs/FM350-DECISION.md` is unchanged.
- The full bench-runbook ladder, RB-1 through RB-18, lives in `docs/BENCH.md`: RB-9 is the
  fleet-inventory capture (one identity bundle per acquired physical unit), RB-10 is the
  hub VBUS port-cycle verification backing the PowerHook above, RB-11..15/17 are the
  per-SKU/flap-resilience captures documented above, RB-16 is the FM350 probe, and RB-18 is
  the Sierra identity/composition capture. Its 2026-08-25 run is an honest
  `device-not-present` skip: no Sierra VID was attached, `certify` was not invoked, and no
  bundle or certification claim exists.

### Sierra classifier groundwork — exact evidence, never a support claim

`backend/device-classifier.ts` carries exact application-mode Sierra family rows for
EM74xx, EM75xx, and EM919x-class devices, including Sierra's `1199` VID and the HP/Dell
rebrands represented in ModemManager's pinned FCC mapping. Rows are evidence-tiered:
`modemmanager-1.24.2-fcc` means the VID:PID occurs in the pinned release's available-tier
mapping; `mainline-kernel` means Linux's qmi_wwan/qcserial tables name that family. A row can
label a known family but cannot make a device `mm-managed` — live control-interface/driver
evidence remains the only authority for that class, and an unknown Sierra PID remains
unknown. Every classifier fixture is stamped `synthetic: true`, so it cannot cross the
catalog-promotion gate.

### Telit / u-blox / NETGEAR groundwork — and the mixed-VID trap

The same table carries ten exact Telit (`1bc7`) rows, six u-blox (`1546`) LARA-R6/LARA-L6
rows, and ONE NETGEAR (`0846`) row. `CELLULAR_MODEL_EVIDENCE_SOURCES` now pins each tier's
provenance so a reviewer can re-derive any row; a test asserts every tier a row uses has a
pin. **No provider was added for any of these vendors** — this is classifier and doc
groundwork only.

- **A third evidence tier exists: `usb-ids-registry`,** the weakest of the three. It is used
  ONLY where no kernel modem driver claims the id at all — which is itself the evidence
  that the device is a router appliance rather than a controllable module. The NETGEAR
  LB1120 (`0846:68e1`) is the sole row at that tier.
- **`CellularModelEvidence.familyKind` is an OPTIONAL, positive `router-webui` claim, and
  its ABSENCE IS NOT A CLAIM.** Silence does not mean "modem module"; it means nothing here
  asserts otherwise — the same tri-state discipline `fcc/coverage.ts` uses for `unknown`. A
  test pins that exactly one row carries it. It still decides no device class: NETGEAR
  classifies `router-mode` because its interfaces say so, and a test proves the class is
  unchanged when the same composition is presented under an unlisted PID.
- **`0846` is deliberately ABSENT from `CELLULAR_USB_VENDOR_IDS`, and that absence is
  load-bearing.** The USB ID Repository's `0846` block is dominated by NETGEAR Wi-Fi and
  Ethernet adapters — `68e1` is the only cellular entry — so a vendor-keyed rule would
  report a Wi-Fi dongle as a cellular uplink. `1546` has the same shape (u-blox GNSS
  receivers share it with cellular modules) but predates this work and stays; treat a
  vendor-only match on it as WEAK evidence. `1bc7` IS added, because that range is Telit
  cellular modules end to end. Consequence worth knowing: the LB1120 tether currently
  reads `wired-ethernet` from `classifyUsbNetDevice`, which is honest — a known gap, not a
  guess.

### `docs/VENDOR-QUIRKS.md` — sourced, and capped at `implemented`

[`docs/VENDOR-QUIRKS.md`](docs/VENDOR-QUIRKS.md) records the per-vendor behaviours that make
one module behave differently from another on Linux, with a citation for every claim
(pinned to MM `1.24.2`, a named Linux commit, `usb.ids` `2026.06.26`, OpenWrt's `qmi.sh`,
`usb-modeswitch-data`, and the BELABOX tutorial wiki). Two properties are the whole point:

- **No row sits above `implemented` on the five-state ladder, and none may.** `capable`
  needs a live probe and `certified` needs a hardware drill; a document can produce
  neither. Rows for surfaces this repo ships no code for read `unavailable`, which is
  BELOW `implemented`, not above it.
- **Nothing in it is on a write path, and nothing in it may be put on one.** A quirk is a
  description of somebody else's firmware. It may inform a classifier LABEL, a diagnostic
  READ, or a doc — never an AT command, a QMI/MBIM write, a composition switch, or a band
  lock. An unsourced operator report is recorded AS unsourced and claims nothing.

### `docs/COMPAT-MATRIX.md` — the one tracked support matrix

[`docs/COMPAT-MATRIX.md`](docs/COMPAT-MATRIX.md) is the single vendor × firmware ×
composition × operation matrix: 22 hardware rows (the six long-standing vendor families plus
the Sierra, Telit, u-blox and NETGEAR groundwork rows) against 18 operations spanning first
enumeration through a sustained bonded uplink.

- **Every claim cell is a member of the five-state ladder in `capability/support-claim.ts`,
  and there is no second status vocabulary.** No "partial", no "works", no tick-and-cross.
  198 cells, all of them `implemented` or `unavailable`; `enabled` / `capable` / `certified`
  appear in the matrix nowhere, for exactly the reason `VENDOR-QUIRKS.md` is capped the same
  way. It follows that **no combination in the repository is `certified`, so none may be
  described as supported.**
- **It states which claims are hardware-free and which are hardware-required**, and links
  each hardware-required operation to its RB runbook. `BENCH.md` remains the sole owner of
  per-runbook status; the matrix links and restates none of it. A cell is raised by a bench
  capture plus a reviewed commit, never by an edit to the matrix.
- **The NETGEAR LB1120 gap is recorded rather than smoothed over**: the row labels the
  family `router-webui`, but with no positive cellular evidence the tether classifies
  `wired-ethernet`, so no operation in this stack reaches it. Its column is mostly
  `unavailable` as a consequence, and the phone-tether row reads the same way for the same
  reason.
- It also records one discrepancy in `VENDOR-QUIRKS.md`: the Sierra row's "no `AT!` form
  exists anywhere in this repository" is true of the `providers/ufi-himi` gate it cites, but
  `usb-mode/runtime-capability.ts` carries Sierra's reviewed `AT!USBCOMP` forms, which is
  what makes the composition-switch operation `implemented` for Sierra.

## USB-COMPOSITION SWITCH — RUNTIME OFFER, TIERED PROOF

The ModemManager provider's `usbComposition` operation derives its targets from the
device's own vendor READ + TEST replies through `resolveRuntimeCompositionCapability`.
It never turns a model-catalog miss into `uncertified`. The only operator-facing
suppressions are the exact literals `unknown-vendor`, `no-return-path`,
`blocked-by-state`, and `provisioning-disabled`; every suppressed state carries zero
offerable targets. An unknown vendor, a disabled provisioning setting, or a live-state
block is decided before any AT transport call. A known device is offered only when its
enumeration contains its current mode, proving that the represented vocabulary includes
a return path.

The AT fence widened by name, not by pattern. `AT_RUNTIME_QUERY_ALLOWLIST` contains only
the four vendors' exact READ/TEST forms. `RUNTIME_COMPOSITION_SET_REGISTRY` builds one
validated SET form per vendor, and only the selected enumerated target is unioned into
the held lease. Capability reads send no SET form. The operation descriptor keeps the
shared mutation admission lease, durable journal, armed rollback, and required readback;
the existing transition still keeps fail-closed identity, the streaming interlock, MM
inhibit/uninhibit, and the bounded drop/re-enumeration wait.

Both READ/TEST replies must also carry `AtResponse.ok === true` before either raw body is
parsed. A failed current OR enumeration query is suppressed as `no-return-path` with no
current mode, no enumerated modes, and no offerable targets — even when its raw body contains
a syntactically valid vendor line before `ERROR`. Multiline response parsing may decode only
a transport-successful reply; it can never promote failed AT traffic into a write surface.

Success has two proof tiers. **Tier 1 remains strongest and unchanged:** when a reviewed
catalog transition matches the exact SET command, the re-enumerated canonical mode and
USB descriptors must both match its `expectedDescriptors`. **Tier 2 is explicitly
weaker:** when no reviewed transition exists, the re-enumerated device must report the
raw target through its own vendor READ. AT `OK` is proof in neither tier. The catalog
therefore remains valuable evidence without being a model allowlist for an interrogable
device. This change is composition-only; band writes retain their separate four-proof
certification gate.

## CAPABILITY MODULES — TAXONOMY AND DETECTION, NOT IMPLEMENTATION

`control/src/capability/` carries the FIVE-STATE support-claim taxonomy and the
per-modem capability detection the seven gated capability modules (band-lock, SMS,
5G-pref, FCC-auto-unlock, GPS, USSD, eSIM) resolve against. **No module is
implemented here**, and none may be surfaced or claimed until its own change lands
with its probe and its evidence.

The taxonomy exists because "supported" was one word doing four jobs — the code
exists, an operator turned it on, the modem advertises it, and somebody proved it
on this firmware. `resolveSupportClaim` answers with the highest rung reached:
`unavailable` (not shipped, or the modem positively lacks it) → `implemented`
(gate OFF, the default everywhere) → `enabled` (gate ON, capability UNKNOWN) →
`capable` (gate ON, modem advertises it — the floor for offering a control) →
`certified` (proven on this exact model+firmware — the ONLY rung a support matrix
may claim).

**It is a Rule-D MIRROR of CeraUI's `@ceraui/rpc` ladder, never a shared import**
— the same relationship `usb-net-classifier.ts` has with `device-classifier.ts` in
the other direction. The two halves are kept honest by their tests, not by a path.

`detect.ts` follows `backend/features.ts` exactly: it PROBES the observed surface
rather than matching a version whitelist, never throws, and treats `unknown` as a
first-class result — a property set nobody observed says nothing about the device,
and the ladder stops at `enabled` for it. Two facts are worth knowing before
extending it:

- **SMS / USSD / GPS are advertised as INTERFACES, not properties**, so
  `MmPropertyProbe` alone cannot see them; `ModuleCapabilityProbe` adds the modem
  object's interface set. The `Location` interface being exported is separately NOT
  a GNSS claim — MM exports it for 3GPP-LAC/CID-only devices too, so a GNSS source
  must appear in `Location.Capabilities`.
- **`fcc-auto-unlock` is always `unknown`, deliberately.** FCC unlock is carried out
  by a ModemManager PLUGIN keyed on the device, and nothing on the modem's own
  D-Bus surface says whether one applies. `absent` would hide the module on
  supported hardware; `present` would promise a plugin that may not be installed.
  Evidence for it comes from the catalog instead — `control/src/fcc/coverage.ts`,
  see the section below.

### `five-g-pref` — a MODEL, not just a probe [IMPLEMENTED, UNCERTIFIED]

`control/src/capability/five-g-preference.ts` is pure and total: it maps four
named postures (`5g-only` / `prefer-5g` / `prefer-4g` / `5g-off`) onto the
`(allowed, preferred)` pair `MmMutations.setRadioModes` already writes, and
refuses to name one the modem never advertised. It opens NO new transport —
`setRadioModes` owns the `SetCurrentModes` call, the per-modem serialization and
the quiesce — and a test greps its executable source to keep it that way.

**Why it exists at all, given `setRadioModes` already writes modes.** That
surface's vocabulary is the ALLOWED SET, and two genuinely different postures
share one: "allow 4G and 5G, prefer 5G" and "allow 4G and 5G, prefer 4G" differ
only in the PREFERRED mode. An operator on a marginal 5G cell wants exactly that
distinction, and an allowed-set selector structurally cannot express it.
`prefer-5g` and `prefer-4g` therefore emit an IDENTICAL allowed set — so nothing
on this path may decide "no write is needed" by diffing allowed sets, and nothing
may confirm a restore by comparing them either.

Three refusals are load-bearing:

- **A modem with no 5G is offered NOTHING, `5g-off` included.** "Turn 5G off" on a
  radio that has none is a control that cannot change anything, which is worse
  than an absent one because it invites an operator to act.
- **A posture the modem cannot express resolves `undefined`, never a neighbour.**
  Substituting is how "prefer 4G" on a marginal cell silently becomes 5G-first.
- **A current pair no posture names reads `undefined`, never the nearest one.**
  Rounding would show an operator a selection they never made and cannot get back to.

**SA/NSA is REPORTED unsupported, with a reason.** Checked against MM 1.24.2's own
surface rather than recalled: the only NR-specific member on a modem object is
`Modem3gpp.SetNr5gRegistrationSettings`, whose keys are `mico-mode` and
`drx-cycle` — power-saving registration parameters, not a standalone-vs
non-standalone selector. Vendors expose the selector through their own AT commands
(Quectel `AT+QNWPREFCFG="mode_pref"`, one per vendor after that), which is exactly
the uncertified per-SKU write the evidence gate keeps out. A missing field would
read as "nobody asked"; the stated `not-exposed-by-modemmanager` tells an operator
hunting for an SA toggle why there is none.

**`detect.ts`'s `five-g-pref` verdict NARROWS when the caller decoded the mode
catalog.** Every ModemManager modem exports `SupportedModes`, including a 4G-only
one, so the property NAME alone resolves `present` on hardware with no 5G. The
optional `ModuleCapabilityProbe.supportedRats` narrows the verdict to whether the
catalog actually names 5GNR; ABSENT it, the property-name answer stands verbatim.
A strict narrowing, never a new way to claim a capability.

**Status: `implemented-but-uncertified`.** No 5G SIM/plan and no verified 5G
coverage exist at the bench (`docs/BENCH.md` per-SKU blockers; the CeraLive-side
record is todo 2's BLOCKER B3), so the readback/registration/data/fallback drill
on the RM530N-GL has not run. Every claim above is fixture-proven only.

## PURE ROUTER RESPONSE PARSERS — TRANSPORT STAYS OUT

`control/src/hardware/router-parsers.ts` owns the pure CeraUI migration seam for
SIM-presence evidence and Huawei HiLink, ZTE goform, and Qualcomm UFI/HIMI response
normalization. It is exported through the existing root and `./hardware` entry points;
no new package subpath exists. Empty/refused/malformed readings remain explicit unknown
states, vendor placeholders are omitted, and HiLink capability refusal preserves the
device code. The module accepts response bodies only: HTTP, authentication, interface
binding, retries, caching, and every write remain outside it. CeraUI keeps its adapters
until the explicit cutover todo; this migration creates no sibling path dependency.

The same transport-free migration seam also owns the remaining pure CeraUI compatibility
rules: portable USB physical identity/link-id derivation, modem display-name sanitation,
ModemManager enum normalization, USB-network classification and labels, capability-module
selection, and shadow-backend divergence folding. These helpers accept snapshots, primitive
values, or already-normalized records and return deterministic values only. They do not read
udev, invoke ModemManager, persist state, or alter CeraUI; CeraUI keeps its local adapters and
copies until the explicit consumer cutover.

### `parseZteDetails` MUST stay a superset of the consumer it replaces

The seam only works if adopting a packaged parser is a no-op for the shipped
consumer. It was not: an overlay of the 1.1 candidate over CeraUI's own tree found
this parser both NARROWER than the reader it is meant to retire and in disagreement
with it about one key name. Both are fixed here, and both are pinned by tests:

- **`band` and `network_band` are two readings, not one key.** `lte_band` is the
  SERVING cell's band and `wan_active_band` is the band the WAN leg is active on;
  they disagree the moment carrier aggregation is up. This parser previously folded
  all three spellings onto `network_band`, so a consumer rendering the serving band
  got the WAN leg's — or nothing. They are now separate and neither falls back to
  the other.
- **The carrier composition and the dongle's own counters are carried.**
  `lte_ca_{p,s}cell_{arfcn,band,bandwidth}`, `monthly_{tx_bytes,rx_bytes,time}` +
  `date_month`, and the five `realtime_*` counters now emit as `pcell_*` / `scell_*`
  / `monthly_*` (with `monthly_period`) / `session_*`. The `realtime_*` → `session_*`
  rename is deliberate: three of those five are cumulative counters, and the vendor's
  own prefix reads as "live rate" for all five.
- **`stated()` drops every vendor placeholder**, not only the single dash — `--`,
  `n/a` and `N/A` are unset markers on these firmwares too, and echoing one puts a
  value on screen that reads like a reading. This widening applies to
  `parseUfiDetails` as well, which shares the helper.

**`parseUfiDetails` is still NARROWER than CeraUI's UFI reader and takes a different
input shape** (three bodies here, five there — no `status`/`networkMode`). No
consumer probes for it today, so nothing is broken; a future cutover must reconcile
it before pointing CeraUI's UFI path at this one.

## OBSERVATIONS — NORMALIZATION THAT NARROWS WITHOUT DISCARDING

`control/src/observations/` sits directly on top of the parsers above and turns a raw
per-vendor payload into ONE `ObservationEnvelope<NormalizedModemObservation>`. It decodes
nothing itself — every value comes from `domain/mm-enums.ts`,
`domain/modem-presentation.ts` or `hardware/router-parsers.ts` — and adds exactly two
things those pure functions cannot carry: **where a value came from**, and **why a value
is missing**. It opens no transport; a provider performs the read, this layer explains the
result. Reachable through the package ROOT entry, deliberately not through a new subpath.

**FOUR STATES, NOT A VALUE PLUS A FLAG.** `readMetric` answers `fresh` | `stale` |
`unavailable` | `unknown`, and they differ in SHAPE rather than only in label:
`unavailable` and `unknown` carry no `value` field at all, and `unavailable` carries no
metric provenance because no metric was produced. So no consumer can read a value off a
state that has none.

- **`stale` KEEPS the value.** An aged reading is the last thing the device actually said;
  discarding it leaves an operator unable to tell "we lost contact" from "the modem reports
  nothing".
- **`unavailable` is terminal on re-evaluation and never becomes `stale`.** It carries no
  value, so there is nothing to age — re-classifying it would have to invent one.
- **Staleness is MONOTONIC.** `evaluateFreshness` returns an already-stale envelope
  unchanged, so its `since`/`reason` record the FIRST cause. Freshness comes from a new
  read, never from re-evaluating an old one. Trigger precedence when several apply:
  superseded generation → superseded source epoch → degraded source → TTL expiry; the first
  three state that reality overtook the reading, TTL expiry only says nobody looked.
- **A TTL expiry's `since` is `observedAt + ttlMs`, not the evaluation time** — otherwise a
  reading that expired an hour ago looks like it just went stale.

**`unknown` IS NEVER COERCED TO `unsupported`, and the reason class is what enforces it.**
`metricUnknownClass` splits `MetricUnknownReason` into `capability` (only `unsupported` — a
durable claim about the SOURCE) and `read` (`not-reported`, `not-observed`, `malformed`,
`auth-expired`, `refused`, `unreachable` — claims about ONE attempt). A consumer decides
whether to HIDE a control or show it pending by branching on that class, never on the bare
fact that a value is absent. The three distinctions this buys, all pinned by tests:

| Situation | Reason | Class |
|---|---|---|
| ModemManager exposes no bar scale, only a percentage | `unsupported` | capability |
| The `Sim` interface was never read | `not-observed` | read |
| `Modem.State` was absent from the payload | `not-reported` | read |
| `Sim.EsimStatus` was present but decoded to nothing | `malformed` | read |
| The HiLink session answered `125002` | `auth-expired` | read |

`metricUnknownReasonFromRouter` is a WIDENING, never a re-classification — every
`RouterSignalUnknownReason` member keeps its exact meaning.

**A PAYLOAD THAT ARRIVED IS AN OBSERVATION, however little of it could be read.** A refused
HiLink session and an unparseable goform body both produce a FRESH envelope whose metrics
are `unknown` with a reason — not an `unavailable` one. That is not taxonomy for its own
sake: `ObservationEnvelope` pairs `unavailable` with `value: null`, so emitting it for a
payload we did hold would throw the diagnostics block away, and the raw vendor fields with
it. `unavailableObservation` is reserved for the case where there is no payload at all.

**NOTHING IS DROPPED — retention is structural, not a discipline.** Every normalizer builds
ONE flat `RawFieldRecord` keyed `<body>.<provider-native field>` and reads its metrics out
of that same record, so a field a metric consumed is necessarily a field the diagnostics
block already carries. `createObservationDiagnostics` DERIVES `unmapped` (raw keys minus
consumed) rather than accepting it, so a field no metric names lands there automatically
instead of vanishing. A repeated XML tag is kept as `Tag`, `Tag#2`, `Tag#3`; a nested JSON
object keeps its JSON text; `Modem.SimSlots`-style arrays stay arrays.

**`ObservationDiagnostics.raw` is a REDACTION-CLASS boundary.** The UFI overview endpoint
returns an IMSI and an ICCID, and they ARE retained — normalization does not get to decide
what a diagnostician may need. Anything that logs, serializes or files a diagnostics block
must route it through `redactObservationDiagnostics`, which runs the package's own key-based
`redact`, so the classes masked here are the classes masked everywhere else. Retention and
 disclosure are separate decisions; this layer only guarantees the first. The former B5
 gap is closed: the shared redactor masks `imei`, `EquipmentIdentifier`, separator variants,
 and dotted mmcli spellings. The raw diagnostics block still contains source values in
 memory, so every serialization boundary must continue to call the redactor.

**PER-METRIC PROVENANCE, INCLUDING PER-METRIC AUTHORITY.** One normalized observation folds
several provider reads together — HiLink answers `monitoring_status` and `device_signal`
separately, UFI answers three endpoints — so a single envelope-level `observedAt` would be a
claim about a reading no individual metric came from. Authority is per-metric for the same
reason a payload can mix classes: a router's RSRP is a measurement the modem reported and is
`authoritative`, while its bar count is a vendor rendering of that measurement and is
`derived`. This layer has no clock: `observedAt` and `sourceEpoch` are supplied by whoever
performed the read, so a normalizer cannot stamp a payload with a time it did not come from.

**SIM PRESENCE IS BINARY, and that is the point.** `deriveSimPresence` answers
`present | absent | unknown`; the third member is not a presence, it is the absence of an
answer, so it becomes the metric's `unknown` state with a reason. That is what stops "we
could not tell" from rendering beside "there is no SIM". For the three ROUTER sources SIM
presence is deliberately NOT claimed at all — each vendor reports its own presence code
(`SimStatus`, `simcard_state`, `simstate`) with vendor semantics and no migrated decoder
covers them, so the code stays verbatim in the diagnostics block for the per-vendor
providers to claim later with evidence. Guessing one would be exactly the invented reading
this layer exists to prevent.

**DESIRED, APPLIED AND OBSERVED ARE THREE THINGS AND STAY THREE THINGS.**
`state-separation.ts` follows NetworkManager's own split: a connection PROFILE is what an
operator asked for, an active connection's BEARER is what was put into force, and the
device's reported state is what the hardware is doing. All three are routinely different at
once, and a merged "current state" blob has to pick one and lose the other two — which makes
"did our write take effect", "is this the network's doing or ours" and "what do we roll back
TO" unanswerable. `ModemStateView` therefore has exactly three slots with three `kind`
discriminants and NO fourth merged field (an effective value is a rendering decision, and
computing one here would bake a policy every consumer would work around).
`describeStateDivergence` returns TWO independent comparisons — `desiredVsApplied` ("did our
write happen") and `appliedVsObserved` ("did it stick") — because one boolean cannot separate
a request that was never carried out from one the network undid a second later, and those
need opposite responses. An unavailable observation compares `indeterminate`, never
`aligned`: "we could not read it" is not evidence that it matches.

Coverage: `control/src/observations/{observation-states,normalization,state-separation}.test.ts`
against the canonical per-source fixtures in `control/test-support/observation-fixtures.ts`
(ModemManager, HiLink, ZTE goform, UFI/HIMI, plus the auth-expired and unparseable variants).
Each fixture deliberately carries vendor-specific fields the normalized model has no slot for
— `Modem.Ports`, `CurrentNetworkTypeEx`, `wan_lte_ca`, `cputemp` — and the round-trip
assertions are what prove those survive. Later provider work should reuse those fixtures
rather than re-invent them.

## MODEMMANAGER PROVIDER — TYPED D-BUS, RUNTIME-DISCOVERED GENERIC CONTROLS

`control/src/providers/modem-manager/` is the concrete `ProviderDefinition` for
`org.freedesktop.ModemManager1`. It composes the existing typed transport and adapters; it does
not introduce a second D-Bus stack. `ObjectManager.GetManagedObjects` supplies normalized
snapshots, while the existing epoch-scoped `MmDbusObserver` supplies signal-driven lifecycle
events and retains rows across daemon loss. A new or unknown model is selected by the live
`Modem` interface and receives mode, signal, SIM, and power reads from the properties it exports.
No model catalog participates in those generic reads.

The provider reuses `MmDbusBackend`/`MmMutations`, `MmLocation` plus the bounded
`location/fix-state.ts` machine, `createDbusSmsPort`, `MmUssd`, the band codec/certification split,
and FCC coverage. Band reads are generic; band writes remain refused until the embedding process
supplies a `bandSku` resolving to a catalog entry (see § RADIO CAPABILITY TRUTH). Its `modes`
operation surfaces the modem's own `(allowed, preferred)` catalog verbatim. `Location.Setup` still sends `signal_location=false`, SMS remains
read-only, and FCC remains policy/catalog-only. One shared `ModemActor` serializes every composed
adapter for a modem. The provider has no bearer/APN method; NetworkManager remains sole owner.

`errors.ts` maps typed daemon/transport failures to stable refusal reasons (`unauthorized`,
`unsupported`, `wrong-state`, `busy`, `not-found`, `timed-out`, `disconnected`, `failed`).
`forbidden-subprocess.test.ts` scans every production file in this provider and proves no path can
spawn `mmcli`, `qmicli`, or `mbimcli`; its detector has a non-vacuity control for all three names.
Private-session-bus coverage is `modem-manager-provider.integration.test.ts`. Operation-by-operation
detail (which reads are generic, which writes stay refused, and the exact refusal vocabulary) lives in
[`docs/MODEMMANAGER-PROVIDER.md`](docs/MODEMMANAGER-PROVIDER.md).

## NETWORKMANAGER ADAPTER — SAVED vs APPLIED, AND NOTHING ELSE

`control/src/providers/network-manager/` is the thin `NetworkManagerAdapter`: desired
connection profiles, the applied bearer, and the interface that bearer landed on. It is the
**only bearer/APN authority surface in the package**, and it is deliberately narrow — no
radio, band, SIM or power operation appears in it, because those belong to the ModemManager
provider and a second expression of them would make two writers for one resource. It is
exported through the existing `./providers` and root entries; **no eighth package subpath**.

It COMPOSES rather than replaces the existing NM work: `NmcliNmPort`
(`control/src/backend/nmcli-nm-port.ts` — nine-field GSM write parity, device-exact
activation, atomic Auto-APN transitions, quiesce leases) is unchanged and remains the
`NetworkManagerPort` implementation this adapter is constructed with.

Six decisions are load-bearing, each pinned by a test that goes red when removed:

- **Observed state never writes the desired slot.** `observe()` may clear `applied` and
  always rewrites `observed`; it touches `desired` on no path. Reality overtaking a write
  does not un-ask the operator's question — and if it did, a re-enumeration would erase the
  configuration the controller exists to restore.
- **Desired records the REQUEST; applied records NM's READBACK.** Seeding desired from the
  readback would make a field NM silently rewrote (`gsm.auto-config` driving the APN is the
  real case) structurally unreportable, and asserting applied from the input would make a
  silently-rejected write look like it took.
- **`unbound` is a VALUE, not an unavailable observation.** "The device is here and idle" is
  a definite divergence from a desired bearer; "the device is gone" is not knowledge at all.
  An unavailable observation compares `indeterminate` against everything, which is right for
  the second and wrong for the first, so a present-but-idle device produces a FRESH envelope
  carrying `unbound` and only a MISSING device produces `unavailable` / `device-absent`.
- **A readout is an ENUMERATION, never a delta.** A device absent from `NmObservationInput.devices`
  is GONE. That is the only shape in which re-enumeration is detectable without depending on a
  removal event nobody guarantees will arrive.
- **A transitional device state is `pending`, not a loss.** A device in `prepare`/`ip-config`
  carrying our connection is coming UP; reporting that as a lost bearer would turn every
  ordinary activation into a false alarm. Loss is reported only for the four states that
  positively contradict the applied bearer: `interface-absent`, `interface-detached`,
  `connection-replaced`, `activation-failed` — and the loss retains `previous`, because the
  applied slot has just been cleared precisely because it no longer describes reality.
- **The adapter owns no identity and no credential.** Every slot is keyed by NM's own
  connection UUID, never a `PhysicalModemId`, so this can never become a second authority on
  which physical modem is which. `NmBearerBinding` also omits `username`/`password`: a state
  slot is compared and surfaced in divergence output, and `gsm.password` is the one profile
  field redaction masks everywhere else. There is likewise **no delete path** — profile
  removal is not in the port-tagged `NmOp` set, so the adapter cannot express it.

A superseded-generation readout is REFUSED rather than folded late, so a reply about a
previous enumeration cannot clear applied state belonging to the current one. Divergence is
reported through todo 18's `describeStateDivergence` — two independent comparisons, never one
verdict. Coverage is `network-manager-adapter.test.ts`, driven by the stateful `nmcli`
harness in `control/test-support/fake-nm/` (real readback, no bus, no subprocess); its scope
gate scans the module's comment-stripped source for radio/SIM/delete/identity identifiers and
proves the strip non-vacuous in both directions.

## SMS — LIST / READ AND OBSERVATION, PERMANENTLY

`control/src/ports/sms.ts` + `control/src/sms/` are the read-only SMS surface:
`SmsObservationPort` is `list()` / `observe()` / `stop()` and nothing else. There is
no verb here that composes, stores, sends, or deletes a message, and none may be
added — sending or deleting is billable, irreversible, and turns a diagnostic read
into real control over the subscriber's account. That is PERMANENT policy, not a
phase limitation; CeraUI has carried the same contract since Phase A.

**Two grep gates, and they enforce different vocabularies.**
`control/src/sms/readonly-gate.test.ts` scans the whole SMS surface (the port
included) for the D-Bus write verbs (`Messaging.Create` / `Delete`, `Sms.Send` /
`Store`), the mmcli spellings, and the identifiers a hand-rolled write path would
use; it also asserts the only D-Bus METHODS called are `List` + `GetAll` and the
only SIGNALS subscribed are `Added` + `Deleted`. Those two sets are asserted
SEPARATELY because both are spelled `member: 'X'` and only an outgoing `callMethod`
can mutate a device. CeraUI's `tests/modem-sms-readonly-gate.test.ts` is the other
half, extended by this work to cover the D-Bus verbs its mmcli-flag patterns could
not spell. Neither gate may be deleted or narrowed to land a write path.

**LIST ONCE, then follow the signals.** `createDbusSmsPort`
(`sms/dbus-messaging.ts`) calls `Messaging.List` once and folds `Added`/`Deleted`
from then on. Re-listing on a poll tick is the anti-pattern this port exists to
remove: it costs one method call per stored message per tick and still cannot report
an arrival sooner than the tick it lands on. The ONE re-list is on a transport
RECONNECT, where the events that occurred while the bus was down were never
delivered — and it is published as `resynced`, which the store applies by REPLACING
its rows. Folding a fresh list as a series of `Added` events would keep a message
deleted during the outage forever, and is exactly how a restart comes to duplicate
an inbox it already held.

**Duplicate suppression is not identity-based, because MM's own duplicate is not
byte-identical.** ModemManager announces a message while it is `receiving` and again
once it is `received`, so `createSmsInboxStore` (`sms/inbox-store.ts`) updates a row
whose content CHANGED and no-ops one that is verbatim. A store that skipped on "have
I seen this id" would keep the empty `receiving` row forever.

**`sms/mmcli-parse.ts` is a CLI grammar living beside a D-Bus adapter, deliberately.**
`mmcli` is a client of the SAME daemon, and CeraUI has read its inbox through it on
real hardware since Phase A — so owning the grammar here is what makes the port's
output provable against that reader on captured output (`sms/parse.test.ts` pins the
golden values; CeraUI's `modem-sms-port-parity.test.ts` pins the identical ones), and
what lets a consumer move its parsing onto this package without moving its transport
in the same change. Four behaviours in it are load-bearing and each fails silently if
dropped: the octal unescape is per-BYTE then UTF-8 (`\302\241` is two bytes, not two
characters); the service-centre timestamp's HOURS-ONLY offset (`…-05`) is widened to
`-05:00` or every message scores undated and "newest first" degrades to object-index
order, which MM reuses; the list is cut to `SMS_INBOX_CAP` (50) BEFORE any per-message
read; and an absent `modem.messaging.sms` VALUE is an empty inbox while a missing KEY
is drift.

**Nothing here puts message content into an error, a log, or a receipt.** A body
routinely carries a one-time code and a sender identifies the subscriber, so a
malformed record reports the KEY NAMES it found and nothing else, and the module
never logs at all. `redact.ts`'s `isSmsSensitiveKey` is the value-side class; it is
its own set rather than additions to `SENSITIVE_KEYS` because that set matches leaf
names exactly, so adding `text` / `number` / `sender` would blank a receipt reason, a
slot number, and a signal reading across the package. It mirrors CeraUI's
`helpers/logger.ts` set key-for-key — a Rule-D MIRROR, never a shared import.

**HONEST STATUS: no live receive has been drilled.** Only the Quectel has a SIM and
it never registers, so no bench modem can receive an SMS (todo-2 BLOCKER B4). Every
claim here is fixture-proven, including the restart-recovery behaviour; what is
missing is the board measurement, not the behaviour.

## FCC AUTO-UNLOCK — A CATALOG, A POLICY FILE, AND NOTHING ELSE

`control/src/fcc/` implements NO unlock procedure and ships NO unlock script. It
records which `<vid>:<pid>` MODELS an operator opted in for, so
`ceralive-fcc-reconcile` can re-derive ModemManager's own admin-tier symlinks from
that record on every boot. The unlocking is ModemManager's dispatcher's job, start
to finish. Full model, matrix and certification status:
[`docs/FCC-UNLOCK-COVERAGE.md`](docs/FCC-UNLOCK-COVERAGE.md).

The coverage mirror names its exact provenance in `MM_FCC_UNLOCK_SOURCE`: ModemManager
1.24.2 commit `f2b9ab1ad78d322f32134a444b5b54c6e8160e19`,
`data/dispatcher-fcc-unlock/meson.build`, installed into the inert
`fcc-unlock.available.d` tier. Its four Sierra entries are `03f0:4e1d`, `1199:9079`,
`413c:81a3`, and `413c:81a8`; another well-formed Sierra PID is positively `absent`, not
guessed covered. This classifier-side mirror does not create or own any packaging link.

- **`<vid>:<pid>` is the ONLY correct key.** `mm-dispatcher-fcc-unlock.c` builds
  exactly `g_strdup_printf("%04x:%04x", vid, pid)` and opens no other name, so a
  vendor-only file is never a dispatcher target — it exists only as what the
  available tier's `<vid>:<pid>` symlinks point at. A vendor-keyed rule would also
  be wrong twice over: Sierra silicon ships under THREE vendor ids (`1199` its own,
  `03f0` HP-branded, `413c` Dell-branded), so keying on the vendor misses two of the
  three, and keying on the model misses the OEM rebrands.
- **Three tiers, and the reconciler owns exactly one.** available
  (`/usr/share/ModemManager/fcc-unlock.available.d`, ModemManager's, inert) →
  enabled-admin (`/etc/ModemManager/fcc-unlock.d`, **ours, opt-in only**) →
  enabled-package (`${libdir}/ModemManager/fcc-unlock.d`, a distribution's; CeraLive
  writes there never). Writing into the wrong one is SILENT — the link is simply
  never opened.
- **The `/data` file is the record; the symlink is derived.** `/etc` rides the
  rootfs, which is exactly what a RAUC slot swap REPLACES, so an opt-in written only
  as a symlink survives a reboot and not an OTA. `/data/ceralive/fcc-unlock-policy.json`
  (0600, atomic temp→chmod→rename) is what persists, and the oneshot re-materializes
  the link before ModemManager probes a radio.
- **Coverage is a TRI-STATE, and `unknown` is not `absent`.**
  `resolveFccUnlockCoverage` answers `present` (MM ships a procedure), `absent` (the
  ids are well-formed and are NOT in the mapping — a positive statement about the
  device) or `unknown` (we could not read the ids, a statement about the READ).
  Folding the third into the second would hide the module on hardware that may be
  covered.
- **The coverage check is part of the WRITE, not a UI nicety.** Persisting `true`
  for an uncovered model leaves an enabled toggle that provably cannot act — the
  reconciler would skip it forever, silently. `setFccUnlockPolicy` rejects it
  `not-covered`. Disabling is deliberately NOT coverage-checked: a fail-closed
  opt-OUT is not a thing.
- **Corruption is fail-SAFE and the bytes are KEPT.** Unlike
  `backend/usage/policy-store.ts`, which rewrites a fresh file, this store leaves a
  damaged policy on disk and simply refuses to act on it. Enabling a
  regulatory-unlock procedure is not something to infer from a file we could not
  read, and replacing the evidence would make the next diagnosis impossible.
- **The toggle is per MODEL and the UI must say so.** The mechanism is a
  `<vid>:<pid>` symlink, so it applies to EVERY attached device matching it — the
  bench's two identical HiLink twins are the shape of the problem. No per-unit
  refinement exists without changing ModemManager.
- **Enabling is not retroactive.** The dispatcher runs during modem
  INITIALIZATION, so an already-enumerated modem needs a re-probe
  (`mmcli -m <id> --disable && --enable`, or a replug). `SetFccUnlockPolicyResult`
  carries `changed` precisely so an unchanged write does not cost one.

Coverage: `control/src/fcc/{coverage,policy}.test.ts` plus
[`packaging/ci/test-fcc-reconcile.sh`](packaging/ci/test-fcc-reconcile.sh) (the
shell reconciler's behaviour on any host) and `packaging/ci/test-companion-chroot.sh`
§ 6 (the same logic from its PACKAGED location after a real `dpkg` install).

## BAND LOCK — THE ONE MODULE THAT IS STRICTER THAN THE FRAMEWORK FLOOR

`control/src/band/` is the first of the seven capability modules with real verbs
behind it. Two halves:

- **`band-names.ts`** — `MMModemBand` ↔ name, both directions. The D-Bus surface
  speaks numbers (`SupportedBands` / `CurrentBands` / `SetCurrentBands` are all
  `au`); every operator-facing surface speaks the name (`eutran-3`, `any`). ONE
  mapping so the two cannot disagree. It reproduces `mm-enums.h`'s actual shape:
  the GSM/UTRAN head (1..20) is IRREGULAR — `UTRAN_2` is 12 while `UTRAN_6` is 8 —
  so it is an explicit table and can only ever be one, while every later block is
  arithmetic by MM's own construction (`EUTRAN_n = 30 + n`, `CDMA_BCn = 128 + n`,
  `NGRAN_n = 300 + n`). Deriving those rather than transcribing ~350 constants is
  the point: a transcription is where a wrong band number hides, and a wrong band
  number locks a radio to a band the network does not operate on. A value this
  build does not name round-trips as `band-<n>` — never dropped, never guessed.
- **`certification.ts` + `certified-bands.json`** — the per-SKU proof gate.

**`encodeBandList` FAILS CLOSED AS A WHOLE.** One unplaceable name rejects the
entire selection rather than silently narrowing it: a partial band set is a
DIFFERENT lock from the one that was asked for, and applying it strands the radio
on bands nobody chose. `decodeBandList` is the mirror — a malformed member is
dropped rather than coerced, and MM's `unknown` (0) is dropped because it means
"the modem did not say", which is not a band an operator can select.

**There is no reset VERB, and there must not be one.** ModemManager releases a
band lock by setting exactly `MM_MODEM_BAND_ANY` (256); `setCurrentBands(modem,
['any'])` IS the reset. Adding a `resetBands` sibling would be a second way to
express one D-Bus call, and the two would eventually disagree about what "no
lock" means.

**Band-lock deliberately requires `certified`, not `capable`, to be OFFERED.**
That is a documented DEVIATION from `support-claim.ts`'s framework floor, and the
framework is right in general: hiding an uncertified-but-working control puts
hardware behind a paperwork gate. For this module the paperwork IS the safety
argument — a band the SIM's network does not operate on registers nowhere, and a
modem that does not honour a reset leaves an operator with no way back short of a
replug they may not be able to reach. So `isBandControlCertified` gates the
control, and the catalog demands FOUR separate proofs (`supportedRead`, `set`,
`readback`, `reset`), each `z.literal(true)`, so a half-certified entry cannot be
expressed at all: a reviewer with three of four has an uncertified SKU and the
file says so by OMITTING it. `readback` exists because an accepted-but-ignored
write is indistinguishable from success at the call site.

**The shipped catalog is EMPTY, and a test pins that.** No fleet modem has been
through the drill: the bench Quectel RM530N-GL's SIM never registers (phase-C
todo 2, blocker B2), so "re-registration proven" cannot be claimed on this bench
today. An entry is added by a human-reviewed commit carrying the transcript,
exactly like `usb-mode/certified-catalog.json`.

`setCurrentBands` runs QUIESCED through the shared `ModemActor` for the same
reason `setRadioModes` does: it re-registers the radio, so NM must stand down
before the bearer drops underneath it rather than after.

## RADIO CAPABILITY TRUTH — THE MODEM'S OWN CATALOG, UNEDITED

`control/src/radio/` is the layer that carries ModemManager's `SupportedModes` /
`CurrentModes` / `SupportedBands` answers to a consumer **without editing them**, and
turns them into operation descriptors. Reachable through the package ROOT entry;
**no eighth subpath** (the todo 17/18/23 precedent). It sits BESIDE `src/band/` rather
than inside it — a mode change is disruptive-but-reversible, a band lock can strand a
radio where nothing registers, and the two safety models must not be merged.

- **`preferred: 0` is `none`, and `none` is a VALUE.** The bench FM350-GL advertises
  exactly one combination whose preferred mask is 0: the modem allows a set of modes and
  states NO preference within it. Substituting "the highest allowed mode" shows an
  operator a preference the modem never expressed and cannot be returned to. `none`
  therefore survives all the way into `descriptor.constraints.values`, and a test asserts
  it is not any of the allowed modes.
- **An unfamiliar mode bit stays OFFERED.** It round-trips as `mode-bit-<n>` (the
  `band-<n>` discipline from `band-names.ts`), the combination is classified
  `unknown-combination`, and the descriptor stays `available`. Hiding it would coerce
  `unknown` into `unsupported`, which is the first rule `support-claim.ts` exists to
  enforce.
- **Nothing is dropped, structurally.** `decodeSupportedModeCombinations` puts a member
  that is not a `(uu)` into `undecodable`, so `combinations.length + undecodable.length`
  is the member count the provider sent. A test asserts that identity rather than the
  contents.
- **A selection the modem never advertised is REFUSED, never rounded.** Same rule, same
  reason as `five-g-preference.ts`: substituting is how "prefer 4G" on a marginal cell
  silently becomes 5G-first.
- **`MmMutations.setModeCombination` exists because `setRadioModes` structurally cannot
  express `MM_MODEM_MODE_NONE`** — its preferred mask is derived from
  `preferenceOrdered[0]`. Both quiesce; both are one `SetCurrentModes` call.
- **Mode and band writes are readback-gated at the CALL PATH, not only in the
  descriptor.** `SetCurrentModes` / `SetCurrentBands` returning without an error only
  proves the daemon accepted the call; an accepted-but-ignored write looks like success
  from the call site, which is exactly the failure the catalog's own `readback` proof
  exists to catch.
- **The band-write gate is `band/certification.ts`, wired — not re-implemented.**
  `describeBandWriteCertification` reads `findBandCertification` + `offerableBands` and
  nothing else. `buildBandWriteDescriptor` then publishes `mutationImpact: 'disruptive'`,
  a `band-certification-present` live precondition, a required readback, and
  `availability: refused` / `support.write: false` carrying
  `band-certification-required`. Because the shipped catalog is EMPTY, that is the
  answer for every device on the fleet today. **The gate is deliberately DOUBLED** — the
  descriptor is what a consumer reads to decide whether to offer the control, the
  provider's own check is what refuses a call made anyway; a gate that exists in only one
  of the two is either advisory or invisible.
- **`ModemManagerProviderOptions.isBandControlCertified` is GONE, replaced by `bandSku` +
  `bandCertificationCatalog`.** An injected boolean let a caller assert certification
  without a catalog row, which the four-proof `z.literal(true)` schema exists to prevent.
  MM's `Modem` interface carries `Model` and `Revision` but no USB `vid:pid`, and
  `BandSku` needs all three — so the SKU resolver is injected and, with none supplied,
  there is no SKU, no entry, and no band write. Fail-closed in every direction.
- **A band reset readback is satisfied by `any` OR by the whole supported set** (MM
  reports either after `SetCurrentBands([ANY])`); a NARROWING lock must match exactly,
  because a superset is a different lock from the one that was asked for.

`ContextWriteOperation` gained `describe(context)` for this: a static descriptor cannot
carry a device's own catalog, so "which combinations does THIS modem advertise" and "is
THIS SKU's band lock certified" are read live instead of inferred from a capability flag.

Coverage: `control/src/radio/{mode-combinations,mode-truth,band-truth}.test.ts` (pure) and
`control/src/providers/modem-manager/capability-truth.test.ts` (the whole path, over the
in-memory MM transport, with FM350 / Quectel / SIMCom / unknown-combination / no-SIM
specs).

## SIGNAL AND SIM NORMALIZATION — EVIDENCE, NOT INFERENCE

The observation layer's SIM and signal halves are finalized on top of todo 18.

- **`absent` is reachable through exactly ONE evidence kind.**
  `readSimPresence` (`hardware/router-parsers.ts`) returns the presence AND the
  `SimPresenceEvidence` that decided it; only `state-failed-reason` (mmcli's
  `sim-missing`) can produce `absent`. `NormalizedSim.presenceEvidence` and
  `ModemManagerSimState.presenceEvidence` carry it, so "there is no SIM" and "we could not
  tell" — read off the SAME empty fields — are separable by a consumer and by a test.
  ModemManager reports `Sim: '/'` while a modem is initializing and while a slot switch is
  in flight, so a blank object path proves nothing and stays `unknown`.
- **`decodeStateFailedReason` is what makes absence readable at all.**
  `Modem.StateFailedReason` is a `u` on D-Bus, while the migrated presence rule matches
  the mmcli STRING — so before this decoder the D-Bus path could never produce the one
  fact that proves absence. Both spellings are accepted; an unrecognized number decodes
  to `undefined` and proves nothing.
- **`ModemManagerSimState.present` is POSITIVE evidence only.** `true` means the modem
  exports an active SIM object path. `false` is NOT a claim of absence — `presence` is.
- **The router sources still claim no presence, and now say WHICH code they left alone.**
  `vendor-code-unclaimed` names HiLink's `SimStatus`, goform's `simcard_state` and HIMI's
  `simstate`. The field is NAMED in the evidence but deliberately NOT marked `consumed`,
  so it stays in the diagnostics block's `unmapped` set, verbatim, for the per-vendor
  provider that will one day decode it with evidence.
- **`Modem.CurrentModes` and `Modem.SignalQuality` are retained as their D-Bus STRUCTS.**
  The provider used to flatten `(uu)` and `(ub)` to their first member before handing them
  to normalization, which dropped the preferred mode and the measurement-recency flag
  before the diagnostics block ever saw them. `rawStructMember` / `rawNumberAt` /
  `rawBooleanAt` read either shape, so a pre-existing flattened fixture still decodes.
- **`NormalizedSignal.qualityRecent` claims the `(ub)` boolean.** It is a fact about when
  the MODEM last measured, which is a different question from the envelope's staleness
  (when WE last read). The router APIs have no such flag and answer `unsupported` — a
  capability claim, the `bars` / `maxBars` precedent.

### `Modem.Signal`'s per-RAT dicts — the detail the router dongles already carried

`NormalizedSignal.rsrp` / `rsrq` / `snr` / `sinr` are now claimed for MM-managed modems
too, from the `Modem.Signal` interface's own `a{sv}` properties. Five facts about that
path are load-bearing, and each is pinned by a test:

- **A dict member arrives WRAPPED, and used to be dropped.** An `a{sv}` decodes to
  `[key, variant][]`, so `snapshot.ts`'s `rawValue` kept the key and discarded the reading
  — `Signal.Lte` retained as `[['rsrp'], ['rsrq'], …]`. It now unwraps the variant, which
  is why the extended metrics are reachable at all. `signal-richness.test.ts` fails three
  ways with that unwrap removed, so the fix is not a silent one.
- **The dict is read by MEMBER, never flattened at retention.** `raw.ts`'s
  `rawDictMember` / `rawDictNumber` / `hasRawDictMember` read one member by name, so
  `error-rate`, `ecio`, `io` and `rscp` — every key the normalized model has no slot for —
  stay verbatim in the diagnostics block instead of being lost to make four metrics fit.
- **The RAT ladder is NEWEST FIRST, and provenance names which rung answered.** On an NSA
  attach `Nr5g` and `Lte` are both populated with genuinely different measurements (the NR
  leg and the LTE anchor), so one has to be the reported reading. `rsrp`/`rsrq`/`snr` take
  `Nr5g` then `Lte`; `dbm` takes `Lte → Umts → Gsm → Evdo → Cdma`. Nothing is merged and
  nothing is averaged — `MetricProvenance.rawFields` carries `Signal.Nr5g.rsrp` rather than
  a bare `Signal.rsrp`, and the unchosen dict is still in `raw`.
- **SINR comes from `Evdo` and from NOWHERE ELSE.** Checked against MM 1.24.2's own
  introspection rather than recalled: `sinr` is a member of the `Evdo` dict only — `Lte`
  and `Nr5g` publish `snr`, which is a different quantity and must never populate it (the
  same rule `backend/cell-info.ts` already enforces in the other direction). So an LTE/NR
  modem reporting no SINR answers **`not-reported`, not `unsupported`**: the source CAN
  express it, this modem did not. The former blanket `unsupported` was a false capability
  claim and is gone. The NR SINR a device may publish through `Modem.GetCellInfo` is a
  different call on a different interface and is deliberately NOT folded in here.
- **A dict-sourced metric consumes the whole property.** `consumed` must name a real raw
  key or `createObservationDiagnostics` drops it, so the entry is `Signal.Nr5g` while
  `rawFields` stays member-precise. An exported-but-silent `Modem.Signal` therefore yields
  five READ-class `not-reported` metrics carrying no `value` field at all, and a modem with
  no `Modem.Signal` interface yields `not-observed` — never a zero, in either case.

**The `Signal.Setup` rate is injected at three levels and defaults at all three.**
`SignalSetupManagerOptions.intervalSeconds` → `MmDbusBackendOptions.signalIntervalSeconds`
→ `ModemManagerProviderOptions.signalIntervalSeconds`, each resolving to
`DEFAULT_SIGNAL_INTERVAL_SECONDS` (5) when absent. The provider seam is the one this work
added: the backend had accepted the option since it was written, and the provider — which
is what an embedder actually constructs — had no way to pass it. `Setup` takes a `u`, so a
fractional or non-positive rate is REFUSED at construction rather than marshalled; a modem
silently polling at the wrong cadence is a defect nothing downstream can see. The
once-per-(epoch, modem) issue semantics are the conformance-scale pin and are untouched.

Coverage: `control/src/observations/sim-evidence.test.ts`, whose control case is a modem
with the identical blank fields and NO failure reason, asserting `unknown`;
`control/src/observations/normalization.test.ts` for the per-metric claims and the
absent-dict unknowns; `control/src/providers/modem-manager/signal-richness.test.ts` for
the same claims over the real provider wire; `control/src/backend/signal-setup-rate.test.ts`
for the injected rate and the once-per-(epoch, modem) issue count.

## GPS / LOCATION — A LIVE FIX, AND DELIBERATELY NO HISTORY

`control/src/ports/location.ts` + `control/src/location/` +
`control/src/backend/mm-location.ts` are the gated GNSS module. The port is
`getLocationStatus` / `enableGnss` / `disableGnss` / `readFix` and nothing else, and it
is deliberately NOT part of `ModemManagerPort` — a consumer that only reconciles radio
and SIM state has no business holding a handle that can read a position.

**The privacy fence is a PRODUCT rule, not a phase limitation.** There is no history
verb, no track verb, no export verb and no upload verb, and none may be added: a fix is
held in memory for a live display and is gone the moment GNSS is switched off or the fix
goes stale. `ports/location-fence.test.ts` fails the build if a member whose name implies
history, tracking, persistence or upload ever appears on the port.

Four decisions are load-bearing and easy to undo by accident:

- **`Location.Setup`'s `signal_location` argument is ALWAYS false.** Passing `true` makes
  ModemManager broadcast the `Location` property over `PropertiesChanged`, which would put
  the operator's coordinates on the system bus for every listener — including this
  package's own observer, whose snapshots are logged. The fix is fetched by an explicit
  `GetLocation` call instead, so a coordinate only ever exists where somebody asked for one.
- **GNSS runs through `actor.run`, NOT `actor.runQuiesced`.** Quiescing exists to stop
  NetworkManager racing a disruptive change and it costs a bearer deactivation; dropping a
  link on a bonded device to switch a GPS receiver on would be an absurd trade.
  `Location.Setup` touches no bearer, so per-modem serialization is all that is needed.
- **Disable clears ONLY the GNSS bits.** `3gpp-lac-ci` is the existing cell-info module's
  source, so blanking the whole mask would silently switch off a neighbouring feature the
  operator never touched. For the same reason `3gpp-lac-ci` is absent from `GNSS_SOURCES`,
  and the `Location` interface merely being exported is NOT a GNSS claim — MM exports it
  for 3GPP-LAC/CID-only devices (the fleet's FM350-GL is exactly one), so a GNSS source
  must appear in `Location.Capabilities`.
- **Acquisition is BOUNDED and a fix EXPIRES.** `location/fix-state.ts` is a pure, total
  machine with no clock and no I/O — the caller supplies `at` on every event, which is what
  makes both bounds testable without waiting. Past `acquireTimeoutMs` (120 s) the state
  becomes an honest terminal `no-fix` rather than an endless spinner; a fix older than
  `fixTtlMs` (30 s) is dropped. A fix is reachable ONLY through `renderableFix`, which
  answers only in the `fix` state, so no code path can render a position the modem has
  stopped reporting.

`gps-nmea` is decoded locally (`location/nmea.ts` — GGA only, checksum-verified) because it
is the one GNSS source every GNSS-capable fleet modem advertises while MM's pre-decoded
`gps-raw` dict is not guaranteed. GGA is the sentence used because it carries fix QUALITY
alongside the position, so "the receiver has not locked on" is decoded rather than inferred.
A `gps-raw` entry that exists but carries no usable coordinate pair is NOT a fix — MM
populates the key as soon as the source is switched on.

Coordinates are their own redaction class (`latitude` / `longitude` / `altitude` / `lat` /
`lon` / `lng` / `nmea` / `nmeasentences` / `coordinates`), so a fix that reaches a log line,
a receipt or a bundle comes out as the marker.

**Status: `implemented-but-uncertified`.** Three fleet modems advertise GNSS, so the
capability gate is satisfied, but whether a GNSS antenna is physically attached to the bench
Quectel is unanswered (phase-C todo 2, `needs-user` N1), so the live-fix drill has not run.
The capability, no-fix, disable, expiry and redaction paths are fixture-proven; the
acquire-a-real-fix path is not.

## USSD — A SESSION PROTOCOL, MODELLED AS ONE

`control/src/ussd/` is the gated USSD module: a pure session machine (`session.ts`), a
refusal taxonomy with its registration reader (`refusal.ts` + `registration.ts`), the four
D-Bus calls (`calls.ts`), and the adapter that drives them (`mm-ussd.ts`).

**LEASE-ONLY, never journaled.** A USSD session cannot re-register the radio, so it takes
the per-modem mutation lease and carries no pre-state and no rollback — the split todo 29's
`MutationAdmissionPort` enforces in the TYPE SYSTEM, so this classification is not a
convention that can drift.

**USSD is a SESSION protocol, not request/response, and that is why the machine exists.**
`Initiate` opens a dialogue the network may hold open pending a `Respond`; a session that is
neither responded to nor cancelled stays open NETWORK-side, consuming a scarce
per-subscriber slot and failing the next `Initiate` with a busy error nobody can see the
cause of. "Which verb is legal right now" is therefore a real question with a real wrong
answer, and answering it inside the D-Bus adapter would make it untestable without a bus.

Four properties are load-bearing:

- **Three of the seven states are LOCAL.** `initiating` / `responding` / `cancelling` have
  no counterpart in MM's `MMModem3gppUssdSessionState`, because MM has no state for "we
  dispatched a call and the reply has not landed". Without them a second `initiate` racing
  the first would be judged against `idle` and let through — exactly the double-open the
  network answers busy.
- **An illegal verb is REFUSED with a typed reason, never thrown and never ignored**, and
  the machine does not move. A refusal at an RPC boundary must name what the caller can do
  about it; a throw becomes an opaque failure and a silent no-op becomes a UI that spins.
- **`lte-only-unsupported` is claimed ONLY on a positively PS-only registration.** USSD is a
  circuit-switched supplementary service, so a modem attached LTE/5G-SA with no CS domain
  and no CSFB can only carry it where the operator deployed USSI (3GPP TS 24.390) — and
  where they did not, the modem answers a generic unsupported/failed error indistinguishable
  from "this modem has no USSD interface". Reporting that as a device limitation would send
  an operator hunting for a firmware fix for a network policy. `registration.ts` derives the
  fact rather than guessing: `AccessTechnologies` all packet-only ⇒ no CS domain, EXCEPT
  that MM's two CSFB registration states (`*_CSFB_NOT_PREFERRED`, 9 and 10) override it
  outright. An unread registration stays `undefined` and can only ever make the refusal LESS
  specific.
- **An unanswered session is closed at a bound AND the network release is attempted.** The
  machine closes `timed-out` first — that is the operator's answer whether or not the
  release lands — and the modem-side `Cancel` is best-effort afterwards, because a modem
  that did not answer the dialogue may not answer this either and a timeout must still
  terminate. A `closed` machine accepts nothing, so a finished session cannot be
  resurrected; the adapter's per-modem map starts each new dialogue from a fresh machine.

**Carrier text is redacted by FIELD NAME, which is why the fields are named as they are.**
`../redact.ts` is key-based, so `ussdCommand` / `ussdResponse` / `ussdReply` (rather than the
shorter names that read better) ARE the guarantee. BOTH directions are sensitive, not just
the reply: a USSD dialogue is how a subscriber tops up a prepaid line, so the command
routinely carries a voucher code and the reply a balance or a one-time code.
`NetworkNotification` / `NetworkRequest` are MM's own property names for network-initiated
USSD text and are included so a raw property dump cannot leak what the call path masks.
Nothing in `calls.ts` logs, and every error it raises is re-thrown untouched so the
classifier — not a string built around the payload — decides what the caller is told.

**Status: `implemented-but-uncertified`.** Only the bench Quectel has a SIM and it never
registers, so no bench modem can open a USSD session (phase-C todo 2, BLOCKER B4). The state
machine, the refusal classifier, the timeout path and the redaction are fixture-proven; the
live balance-check drill has not run.

## eSIM — `blocked` on hardware, not deferred by choice (2026-08-18)

`docs/ESIM-DECISION.md` records the full eSIM investigation: SGP.22 profile-binding makes
cross-device profile "copying" cryptographically impossible; the workable paths are
removable eUICC, carrier reissue, or multi-profile remote switching; `lpac` (external LPA)
is assessed but not adopted (AGPL-3.0 core, AT backend is demo-only, needs MM
inhibit-coordination).

The 2026-08-13 **deferral was reversed** by user decision and eSIM re-entered scope as a
hardware-gated adoption spike. It closed **`blocked`** (§9): **no bench modem exposes an
eUICC** — the only SIM on the entire fleet reports no `eid` under MM 1.24.2, which is
positive evidence of a classic removable UICC, and RM530N-GL eUICC capability is unproven
for that unit. **`blocked` is not a NO-GO**: the spike's three hardware steps could not
start, so no verdict exists and none may be inferred.

**No eSIM code exists in this repository, and none may be written on the strength of this
record.** No `ceralive-lpac` `.deb`, no closure row, no manifest entry, no apt publication,
no image pin — the release manifest stays at `closure_version: 2` with its frozen matrix.

The **licensing half of the spike did complete** and binds any future adoption:

- lpac's program logic (`src/`, `driver/`, `utils/`) is **AGPL-3.0-only** — it may only ever
  be spawned as an EXTERNAL process over its CLI, never linked or embedded into
  `@ceralive/modem-control`, `cerastream`, or `CeraUI`.
- Redistributing it obliges **Corresponding Source from the same place** (AGPL-3.0 §6(d)).
  `apt.ceralive.tv` publishes binary indexes only — a source channel would have to exist
  BEFORE any lpac upload.
- AGPL §13 attaches to **modified** versions only, so the rule is *ship unmodified or not at
  all* — the same answer `POLICY.md`'s no-fork rule already gives.
- Shipping form on a hypothetical GO: a first-party bookworm rebuild in `packaging/`, pinned
  like the other four sources. The stock Debian package (`lpac` 2.3.0-1) exists but is in
  testing/unstable only — **not** bookworm, **not** trixie.

## THE SIM'S OWN NUMBER — READ, REDACTED, NEVER A KEY

`Modem.OwnNumbers` is the MSISDN the carrier wrote into the SIM. `mapping.ts`
`readOwnNumbers` folds it onto `ModemIdentity.ownNumbers`
(`readonly SubscriberNumber[]`, branded like `SubscriptionId` because it is the
same PII class), and `redact.ts` gains `isOwnNumberSensitiveKey` for it.

Four decisions carry weight:

- **ABSENT, EMPTY and BLANK all read as NOT REPORTED.** Most SIMs carry no
  MSISDN in their elementary files at all, so an empty `as` is the ordinary
  answer — publishing `[]` would invite a consumer to render "no numbers" as a
  finding rather than as silence. The key is omitted instead.
- **The array is KEPT, not collapsed to a first element.** MM's property is `as`
  and a dual-number SIM is expressible; dropping the tail would be a silent
  loss. The bench Quectel RM530N-GL reports exactly one (`+573115422359`), which
  is what the fixtures use.
- **It is its OWN redaction class, not an addition to `SENSITIVE_KEYS`.** That
  set matches a leaf name, so `number` / `numbers` there would blank a slot
  index and a band count package-wide. `msisdn` stays where it already lived, in
  the SMS set, and is not duplicated. Mirrors CeraUI's
  `isOwnNumberSensitiveKey` (`helpers/logger.ts`) — a Rule-D MIRROR, never a
  shared import.
- **It may never bind policy.** `PolicyBindingKey` enumerates its fields, so the
  addition cannot leak into a durable key by construction — the same protection
  `subscriptionId` already relies on. It IS displayed to an operator behind an
  explicit reveal; that is a rendering decision and does not make it loggable.

Coverage: `control/src/backend/mapping.test.ts` (the read matrix, the
fingerprint bump, and the everything-else-untouched control) plus the three
own-number blocks in `control/src/redact.test.ts`.

## POLICY

`packaging/` is a **no-fork** effort: the first release carried zero quilt patches; adding a
patch later is an architecture gate (rationale + filed upstream MR + review). The sole current
exception is the exact three-patch BELABOX-derived FM350-GL series approved by the project
owner on 2026-08-22; its MR is still drafted, not filed, and its hardware drill remains open.
This narrow exception does not weaken the default that udev/plugin/device-support improvements
go **upstream first**. The Phase A → Phase B scope boundary is **version-gated at
`v1.0.0`**: CeraUI / device-image / apt integration is out of scope through `v0.2.0` and
authorized from the `v1.0.0` tag forward. Full terms: `POLICY.md` §4.
The Fibocom **FM350** modem (PCIe / `mtk_t7xx`) is documented-**deferred**, not supported —
rationale, source cites, and the open gates are recorded in `docs/FM350-DECISION.md`.

## WORKSPACE / TOOLCHAIN

**The language is a decided question, not a default.** A Rust migration (a `zbus` daemon
fronted by a thin TS client, the `srtla-send-rs` shape) was assessed and **rejected by the
project owner on 2026-08-24**. TypeScript on Bun stays, and the decision is final until one
of the named revisit triggers fires. That record also carries the idea-attribution for
`irlserver/modem-metrics`: MIT-licensed, concepts adopted, **no source code copied**. Read it
before proposing a rewrite or extending the telemetry surface:
[`docs/adr/ADR-STAY-TYPESCRIPT.md`](docs/adr/ADR-STAY-TYPESCRIPT.md).

- **Bun 1.4.0** (`.bun-version`, `packageManager` in `package.json`). `control/` + `cli/`
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

`packaging/` runs in a `debian:bookworm` container; its contract/verification scripts live
under `packaging/ci/`. The four sources' `debian/` recipes are checked in at
`packaging/<Source>/debian/` (`ModemManager`, `libmbim`, `libqmi`, `libqrtr-glib` — matching
their pinned salsa commits except the bookworm adaptations and the approved ModemManager
FM350-GL series documented in `packaging/BOOKWORM-ADAPTATIONS.md`).
`packaging/ci/build-bookworm.sh <amd64|arm64>` rebuilds
them from source in the mandatory bootstrap order (`libqrtr-glib → libmbim → libqmi →
modemmanager`) via a temporary local apt repo, on native amd64 or full-system-QEMU arm64
(never cross-built), and asserts the 9-package runtime closure. `.deb` output lands in the
gitignored `packaging/build/<arch>/`.

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
     **Build the MM 1.24 stack (.deb) — amd64 + arm64** (`build-bookworm.sh amd64` /`arm64`,
     with `VERDICTS_FILE` + the already-resolved `PREV_MANIFEST_FILE`) → **Package contract
     suite** (amd64 full, arm64 metadata) → **Daemon smoke (amd64)** → **Build the first-party
     companion .deb (Architecture: all)** (UNCONDITIONAL — the companion is never detected and
     never carried) → **Companion package contract (clean Debian chroot)** → **Generate release
     manifest** (`packaging/ci/generate-release-manifest.sh`) → **Upload .deb artifacts +
     release manifest**.

     Three things about that order are load-bearing. The previous release is resolved and its
     manifest downloaded **exactly once**, and that one path feeds all three consumers
     (detection, carry-forward staging, per-source counter derivation). Carry-forward staging
     runs **strictly before any `build-bookworm.sh` call**, because carried debs are a build
     INPUT — `build-bookworm.sh` seeds its Pin-Priority-1001 local apt repo from
     `packaging/build/<arch>/`, so a changed source resolves its build-deps and gir typelibs
     against the carried `-dev`/`gir1.2-*` packages rather than stock bookworm; staging late
     still goes green and silently reintroduces stock dependencies, which is why
     `packaging/ci/test-release-workflow-wiring.sh` pins the ordering statically. And a
     zero-build run starts no container at all yet still asserts the merged runtime closure
     over the carried set.

     Detection is **fail-SAFE toward rebuilding**: an absent previous release, a manifest with
     no `closure_version:` header (an absent header IS closure version 1), a shared-input
     change under `packaging/ci/**` or `packaging/BOOKWORM-ADAPTATIONS.md`, or the operator's
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

## DOCS DISCIPLINE (Rule A)

Any change to this repo's behavior or structure updates this `AGENTS.md`, the relevant
`README.md`, and `docs/` in the **same** change. Keep the three-artifact map, the versioning
contract, and the no-fork policy authoritative.

## Huawei HiLink provider (Todo 24)

`control/src/providers/huawei-hilink/` is the concrete network provider for two exact replay-backed firmware profiles: `e3372h-22.200-password-type-3` and `e3372h-22.333-password-type-4`. The evidence matcher first requires the exact firmware and an unauthenticated `SesTokInfo` document, then makes ONE profile-selected login attempt only after `state-login` confirms that profile's password type. It never tries the neighbouring algorithm. Unknown firmware and profile mismatches receive no operations surface.

Every HTTP request is interface-bound and redirect-disabled. Credentials, password derivatives, cookies and tokens stay in memory and never enter errors or contract fixtures. Status, signal, network-mode and mobile-data capabilities are probed separately; only mode and mobile-data have writes, and Wi-Fi has no operation at all. Writes serialize per physical modem, acquire the non-queueing `router-session` ownership lease, preflight their own capability, and use a newly authenticated session for exact readback before `applied`. A `125002` or HTTP 401/403 during the write refuses `auth-expired` without another login attempt. Pure XML parsing remains centralized in `hardware/router-parsers` through `hardware/hilink-protocol.ts`.

## ZTE GOFORM PROVIDER (TODO 25)

`control/src/providers/zte-goform/` owns three incompatible, exact replay-backed profiles:
`mf79u-legacy` uses `LOGIN` with a base64 password; `mf79u-ld-salted` uses the same bare
`LOGIN` with `SHA256(SHA256(password)+LD)` (the MF79U B03 dialect); and `mf266-salted` uses
`LOGIN_MULTI_USER` with the salted hash, `stok`, `RD`, and derived `AD`. A batched pre-auth
`multi_data` GET reads `LD`, remaining attempts, lock time, and both version fields. That
evidence selects the algorithm and refuses a positive lockout before any credential POST;
firmware text alone never selects an encoding. The selected algorithm receives one bounded
attempt and never falls through to another profile. Cookies and derivatives are memory-only and sanitized fixtures expose only
redaction markers. Unknown firmware may match the ZTE response shape but receives only the
`zte-unknown-read-only` operation surface. All ZTE operation surfaces are currently read-only;
in particular `wifi.enabled` is absent until a safe write plus readback is captured.

The bench-only harness `control/scripts/mf79u-diagnose.sh` requires
`MF79U_BENCH_PASSWORD` and one redacted browser request-shape manifest. It performs at most
one login request and emits only `auth-accepted`, `protocol-mismatch`, `auth-rejection`, or
`lockout`; see `docs/MF79U-DIAGNOSIS.md`.

## UFI / HIMI PROVIDER (TODO 26) — READ-ONLY, PLUS THE QUALCOMM PROHIBITION FENCES

`control/src/providers/ufi-himi/` normalizes the Qualcomm UFI/HIMI telemetry the pure
parsers already own (`hardware/router-parsers.ts` → `observations/sources/ufi.ts`) into a
provider that is **read-only by construction, not by policy**. It adds a session and a
transport around those parsers and nothing else.

**Read-only is structural in three independent places.** HIMI is one endpoint
(`POST /himiapi/json`) with the verb in the body's `cmdid`, so a method restriction would
prove nothing; the command vocabulary is a frozen union instead — seven `get*` reads plus
`login` — and a write command is therefore UNREPRESENTABLE rather than refused. The
operations surface exposes `ProviderReadOperations` entries verbatim (a type with no
`write` member to omit), every descriptor carries
`support.write: {supported:false, reason:'ufi-himi-provider-is-read-only'}`, and a
structural test asserts the only callables reachable from `operations()` are the two
reads and the pure planner.

**`05c6:9024` is evidence of a COMPOSITION, not a permission** — RNDIS plus an ADB
interface. **`05c6:9091` is a firmware-chosen product id and is NOT proof of DIAG**; only
an interface descriptor (class `ff`, subclass `ff`, protocol `30`) proves a DIAG channel,
which is what `classifyUfiDiagEvidence()` encodes. Production never falls back to ADB,
SSH, telnet or DIAG under any circumstance, and `UFI_DIAG_PRODUCTION_ACCESS` is
`prohibited` unconditionally — a descriptor-confirmed channel raises only what a
SUPERVISED BENCH operator may attempt by hand ([`docs/UFI-DIAG-PROBE.md`](docs/UFI-DIAG-PROBE.md)).

**`prohibitions.ts` is INERT DATA, and the operations it names have no implementation
anywhere** — not a refused stub, not a disabled branch. NV/EFS/identity/calibration
writes, firmware flashing, EDL automation, blind driver/interface retries, DIAG writes,
the DIAG info probe (bench-supervised only) and shell transport fallback each answer a
typed reason. `planUfiOperation` takes no transport parameter and returns synchronously,
so `transportContacted: false` is a provable literal; a spy-transport test asserts ZERO
calls both there and for the same ids driven through the real `OperationEngine`, where
the inert descriptor refuses on three independent fences (read unsupported, write
unsupported, availability refused, plus an empty allowed-value set).
`no-write-path.test.ts` scans the comment-stripped provider source for the constructs a
write path would need — subprocess, raw socket, shell-fallback binary, DIAG device node,
mutating HTTP verb, write-shaped literal — each with a non-vacuity control.

Login is bounded to ONE attempt per physical modem per generation; a `SessionOut` drops
the cached session and surfaces as an honest `auth-expired` reading rather than a retry
loop. The admin password is EPHEMERAL BENCH INPUT (`UFI_BENCH_PASSWORD`), injected for a
supervised run only, and `credential-fence.test.ts` scans tracked and intended-untracked
files for it plus its base64/SHA-256 derivatives.

### Bench descriptor capture — tooling, schema, and measured composition

`control/scripts/ufi-himi-capture.sh` + `control/scripts/ufi-himi-evidence.ts` are the
read-only evidence-capture path for `05c6:9091`, and they live in `control/scripts/`
rather than in the provider directory on purpose: bench tooling is not published
(`files: ["dist"]`), and `no-write-path.test.ts` enumerates the provider directory
exactly, so a file added there would be a change to that gate. **No bundle CONTENT is
committed** — the redacted 2026-08-23 hardware bundle remains repo-local and gitignored.
That drill measured a four-interface QMI + ADB-class composition: interface 2 was claimed
by `qmi_wwan`, no `ff/ff/30` DIAG descriptor existed, and the HIMI identity endpoint was
unreachable through the target's own `wwan1`. The tracked classification is in
`docs/UFI-DIAG-PROBE.md`; no composition change was attempted.

- **The bundle is `manifest.json` + five capture files + one credential-gated HIMI file**,
  staged in a temp directory and moved into place as a unit, so a published path either
  holds a complete bundle or does not exist. With no matching device the script answers
  `device-not-present` on stdout and exits 3 having written nothing.
- **Per-step status is five-valued, not a boolean** — `captured` / `empty` /
  `tool-unavailable` / `unreachable` / `skipped-no-credential`. The bench image ships no
  `usbutils` (RB-9), so "no `lsusb` here" and "no device there" must not collapse.
- **Redaction happens at capture time and the rules have ONE implementation** — the
  script's `--redact-filter` mode, which the test EXECUTES rather than re-expressing. Two
  layers mirroring `redact.ts`: key-based masking plus a MAC/14+-digit backstop. The
  staged bundle is then swept and a surviving identifier DESTROYS it (exit 4); there is no
  override flag. `sweepUfiEvidenceText` is the tested twin of the script's own sweep, and
  two checkers that disagree fail the capture.
- **The descriptor triple and the driver binding are two facts and are never merged.**
  `classifyUfiInterfaceRole` answers `diag` only through `classifyUfiDiagEvidence` itself,
  so the bench analysis cannot drift from the shipped rule; `ff/ff/*` outside `30` stays
  `vendor-specific` and the CAPTURED binding says who claimed it. Upstream matching
  `05c6:9091` in `qmi_wwan.c` under an unrelated annotation, and QCSuper documenting the
  same id on a different device, are evidence about neither — only this unit's descriptor
  is.
- **A static gate scans both files** for `usb_modeswitch`, `setprop`, a shell-transport
  invocation, an emergency-download tool, `AT!`, an uppercase AT write form and a QMI
  write, each with a non-vacuity control, and asserts every command literal in them is a
  member of `UFI_COMMANDS`. Procedure: [`docs/UFI-DIAG-PROBE.md`](docs/UFI-DIAG-PROBE.md).
