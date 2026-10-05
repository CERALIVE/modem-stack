<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

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

