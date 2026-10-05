<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

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

### COUNTER-RESET-AWARE THROUGHPUT — AN ABSENT RATE IS A REAL ANSWER

`SlotUsageSnapshot` also gained an additive `rateBytesPerSecond`, measured in
`backend/usage/sampling.ts` (`SlotRate`) and projected by `policy.ts`. The whole design is
one rule: **a rate exists only when this process observed BOTH ends of one sampling
interval over one unchanged counter.** Absent is not zero, and `projectUsageSnapshot`
OMITS the key rather than emitting `0` — an operator cannot tell an idle link from an
unmeasured one if both render as zero.

- **A BACKWARDS COUNTER PRODUCES NO RATE AND REBASELINES.** `/proc/net/dev` counters
  restart at zero when an interface is re-created — a replug, a `wwan0` teardown, a driver
  reload. Both obvious repairs report something untrue: clamping the negative delta to 0
  shows an idle link that was carrying traffic, and dividing the raw post-reset value by
  the interval shows every byte since the interface came up as if it had all moved inside
  that one interval. Reporting nothing is the honest answer, and `applySample` rebases the
  baseline in the SAME pass so the next interval measures correctly instead of inheriting
  the gap. Both halves are pinned together — the rollback fixture asserts the absent rate
  AND the correct attribution on the following sample.
- **Five other cases are equally unmeasured**, each for its own reason: the first sample
  and a resume-from-pause are zero-delta rebaselines; a low-confidence slot attributes
  nothing at all; a remap or reboot means the two values are two different counters
  (`sameBaselineKey` is now exported from `accounting.ts` precisely so the rate and the
  reducer cannot drift about what "same counter" means); an interface missing from the
  counter table drops the rate sample, which deliberately costs the RETURN pass its rate
  too; and a clock that did not advance yields no interval rather than `Infinity`.
- **NO RATE IS PERSISTED, and the negative is pinned by a test.** A throughput is a
  measurement over an interval whose two ends one process observed; a restart observed
  neither. Persisting the last rate would republish a pre-gap figure as current, and
  persisting the baseline's sample TIME would invite the next sample to divide a whole
  downtime's bytes by one interval. So the counter BASELINE resumes across a same-boot
  reload — it is a cumulative total and still true — while the rate restarts unmeasured.
- **No history verb was added.** The sampler still reports the CURRENT window and the last
  interval; there is no series, no retention and no export, and none may be added.

Idea provenance: `irlserver/modem-metrics` (MIT) — concepts adopted, no source code
copied, recorded in [`docs/adr/ADR-STAY-TYPESCRIPT.md`](../adr/ADR-STAY-TYPESCRIPT.md).

Coverage: `control/src/backend/usage/sampling.test.ts` (the rollback fixture plus every
unmeasured case) and `control/src/backend/usage/persistence.test.ts` (the persisted
negative, from both the bytes on disk and the behaviour after a reload).

