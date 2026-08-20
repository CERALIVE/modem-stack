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
| `control/` | `@ceralive/modem-control` (npm) | TypeScript control library — domain model, ModemManager D-Bus backend, NetworkManager adapter, desired-state reconciler, recovery ladder + the `usb-hub-port-cycle` **uhubctl PowerHook** (see § below), USB composition-mode model + evidence-bundle **ingestion seam**, data-usage sampler + the **usage-policy write surface**, capability-module **support-claim taxonomy + detection**, and the **band-lock** vocabulary + certification catalog (see §§ below). Published to public npm under `@ceralive`. |
| `cli/` | `modem-control` (bench CLI) | The iteration surface: `probe`/`watch`/`apply`/`set-usb-mode`/`usage`/`certify`/`hil-cycle`, compiled `arm64`+`amd64`, run against real modems. Not published to npm. |
| `packaging/` | ModemManager stack `.deb`s **+ the first-party companion** | Bookworm rebuilds of ModemManager + libmbim + libqmi + libqrtr-glib — packaging only, zero source patches (see `POLICY.md`) — PLUS `ceralive-modem-support`, the `Architecture: all` first-party companion that owns CeraLive's generic modem system assets so those four never absorb one. |

`control/` + `cli/` are one **Bun** workspace. `packaging/` builds in a bookworm container.

## FIRST-PARTY COMPANION — `ceralive-modem-support`

The four upstream sources are byte-faithful, zero-patch rebuilds. `ceralive-modem-support`
(`packaging/ceralive-modem-support/`, `Architecture: all`) is the first-party package that
keeps them that way: it owns the UNCONDITIONAL, generic modem system assets — CeraLive's
identification-only udev rules, Zero-CD usb-modeswitch device data, and the FCC
policy-reconciliation helper plus its oneshot unit. It ships **no FCC-unlock script at
all**; an absent `/data/ceralive/fcc-unlock-policy.json` exits 0 and activates nothing,
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
npm and the `.deb` set. `.deb` versions encode the tag as `<upstream>-<rev>~ceralive<X.Y.Z>`
(upstream-ordered, apt-safe; injected with `dch --force-bad-version`). Non-tag CI builds use
`~ceralive0.0.0~dev`. Full contract: `docs/VERSIONING.md`.

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
  RB-17 is modem-flap resilience). All are `[PARTIAL]` — **six** named blockers are recorded
  in `docs/BENCH.md` § "Per-SKU certification", re-verified live on 2026-08-18:
  **B1 CLEARED** (`usbutils` is now on the board), **B3 downgraded** (`socat` is present, so
  a manual query-only AT session works; the CLI's `benchAtSender` still rejects every send),
  and **B2 promoted to hardware-proven** — `certify` matches its device by `ifname`, which
  the enumerator never populates, so **every real bundle comes out with no `sku` and empty
  `udevProperties`** and the ingestion seam refuses it `sku-missing`. Two blockers are new:
  **B5**, the shared redactor does not mask `imei` / `equipment-identifier`, so a real
  bundle carries every bench modem's IMEI and must not be committed or pasted into a review
  comment; and **B6**, `skuOf` reads `firmwarePrefix` from udev `ID_REVISION`, which is the
  USB `bcdDevice` rather than the modem firmware revision, so a catalog entry built from a
  capture would not actually be firmware-keyed. B2 and B6 are pinned by
  `control/src/usb-mode/ingestion.hardware.test.ts`. No SKU is certified and no matrix row
  is promoted.
- **Bench composition evidence** for the SIMCom SIM7600G-H and the carrier-mounted Fibocom
  FM350-GL is recorded in [`docs/COMPOSITION-EVIDENCE.md`](docs/COMPOSITION-EVIDENCE.md) —
  descriptors, driver bindings, firmware revisions, and the read-back state of each vendor's
  USB-mode command (`AT+CUSBPIDSWITCH`, `AT+GTUSBMODE`), captured **non-mutatingly**
  (bare-execute / READ `?` / TEST `=?` forms only; no SET form was ever sent). It certifies
  nothing: the SIMCom's PID→composition mapping is unproven so its target modes stay
  UNCERTIFIED and HIDDEN, and the FM350 gains **no** classifier entry for its `0e8d:7127`
  carrier id — `docs/FM350-DECISION.md` is unchanged.
- The full bench-runbook ladder, RB-1 through RB-17, lives in `docs/BENCH.md`: RB-9 is the
  fleet-inventory capture (one identity bundle per acquired physical unit), RB-10 is the
  hub VBUS port-cycle verification backing the PowerHook above, RB-11..15/17 are the
  per-SKU/flap-resilience captures documented above, RB-16 is the FM350 probe.

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
`withCapabilityModuleMutation` enforces in the TYPE SYSTEM, so this classification is not a
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
     arches, runs the package contract suite + daemon smoke, builds the `Architecture: all`
     companion ONCE (`packaging/ci/build-companion.sh`) and runs its clean-chroot contract
     (`packaging/ci/test-companion-chroot.sh`), generates the manifest-complete
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

Action pins track the latest stable **major** (resolved via the `gh api` releases/latest
endpoint); Dependabot keeps them current. JS/TS CI runs on **Node 24**.

## DOCS DISCIPLINE (Rule A)

Any change to this repo's behavior or structure updates this `AGENTS.md`, the relevant
`README.md`, and `docs/` in the **same** change. Keep the three-artifact map, the versioning
contract, and the no-fork policy authoritative.
