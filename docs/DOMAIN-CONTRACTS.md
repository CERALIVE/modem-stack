# Modem control domain contracts

The additive v1.1 domain surface lives in `control/src/domain/` and is re-exported by the
existing package root. The v1.0 identity, snapshot, policy, ports, backend, and transport
exports remain unchanged.

## Physical identity

`resolvePhysicalModemIdentity()` applies one precedence order: serial, then udev `ID_PATH`,
then an opaque fallback capped at 128 characters. It returns a branded `PhysicalModemId`, a
branded `StableKey`, and the selected `PhysicalIdentitySource`.

Canonical physical ids are prefixed `serial:`, `id-path:`, or `fallback:`; stable keys add
the `modem:` namespace. `physicalModemId()` and `stableKey()` refuse values shaped like a
ModemManager object path, network interface, IP address, IMEI, ICCID/IMSI/EID, or an
unbounded fallback. Runtime MM paths, ifnames, addresses, and subscriber/equipment ids are
observations, never physical identity.

## Lifetimes and observations

`DeviceGeneration` is a non-negative monotonic generation. Call
`nextDeviceGeneration()` whenever a physical modem re-enumerates or its selected provider
is replaced. Every asynchronous observation and operation completion carries the generation
it started under; `isCurrentGeneration()` identifies stale work.

`ObservationEnvelope<T>` always carries `stableKey`, `generation`, `source`, `sourceEpoch`,
`observedAt`, `freshness`, `authority`, and `value`. Fresh and stale observations retain a
typed value. Unavailable observations are a separate discriminated state with `value: null`;
they cannot be confused with stale data or with a boolean freshness flag.

The layer that PRODUCES these envelopes — normalization, per-metric provenance, freshness
evaluation, and the desired/applied/observed split — is `control/src/observations/`,
documented in `AGENTS.md` § "OBSERVATIONS". It builds on this contract and does not redefine
it: `ObservationEnvelope<T>`, `SourceEpoch`, `DeviceGeneration` and `StableKey` stay frozen
exactly as described above.

## Operations

`OperationDescriptor<I, O>` records independent read/write support, provider authority,
input constraints, live preconditions, typed availability, mutation impact, retry class,
readback/rollback/journal/admission requirements, profile and firmware evidence, and
confidence. `defineOperationDescriptor()` refuses automatic retry unless the operation is a
supported read classified `idempotent-read`.

`classifyOperationCompletion()` maps results to `applied`, `refused`, `unknown-outcome`, or
`failed`. A stale-generation completion is always `unknown-outcome`. A timed-out or dropped
write reply is also `unknown-outcome`, even when the generation is current. Every unknown
outcome has `requiresReconciliation: true`; callers must reconcile that modem before another
mutation. `canAutoRetry()` returns true only for a failed, supported, explicitly idempotent
read.

`createOperationEngine()` is the executable form of those contracts. It receives a composition
root, a live generation reader, and an `OperationPreconditionPort`. Mutations enter the root's
shared physical-modem actor before the engine re-reads preconditions and admission, so a queued
write cannot act on an earlier check. Unsupported, unavailable, out-of-constraint, or missing
required-hook requests are typed refusals and never reach the provider.

The engine keeps a reconciliation-required gate per `PhysicalModemId`. Any classified
`unknown-outcome` closes that modem's mutation gate; later writes return
`reconciliation-required` without calling their executor. `engine.reconcile()` runs through the
same actor and clears the gate only after reconciliation succeeds without a generation change.
Reads remain outside the write queue, and only a failed descriptor-classified idempotent read gets
one automatic retry. Required journal, readback, and rollback hooks are invoked from the
descriptor-defined lifecycle; rollback is never guessed after an unknown outcome.

## Admission, ownership, and actors

`MutationAdmissionPort` consumes the descriptor's `admission` requirement without adding a
second policy vocabulary. Required admission with no injected authority is the typed refusal
`admission-port-missing`. The interface contains no stream concept; the embedding controller
owns whatever policy backs its decision and releases the returned lease.

`ResourceOwnershipPort` is acquire-or-refuse, never queued. File-backed stores, router
sessions, and USB-hub access require it. `createFlockResourceOwnershipPort({ lockPath })`
provides the Linux default with non-blocking `flock` and holder PID/start-time metadata; the
path is mandatory input and the exported `/run/ceralive/modem-control.lock` value is a caller
convention, not an implementation hardcode. Kernel lock lifetime and PID liveness make a
dead holder recoverable without stealing from a live process.

`createModemControlCompositionRoot()` enforces one live root per process and owns a
per-`PhysicalModemId` actor registry. Repeated `actorFor()` calls for the same physical modem
return one shared `ModemActor`. `ModemManagerInhibitPort` narrows MM maintenance inhibition;
`UhubctlPort` is an injected contract with no implementation in the v1.1 control package.
