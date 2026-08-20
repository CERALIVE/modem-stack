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
