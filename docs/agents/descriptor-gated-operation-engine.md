<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

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

