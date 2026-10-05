<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## FROZEN V1.1 DOMAIN CONTRACTS

`control/src/domain/` additively freezes the provider-neutral v1.1 foundation while the
published v1.0 package facade remains intact. The exact public shapes and safety rules are
documented in [`docs/DOMAIN-CONTRACTS.md`](../DOMAIN-CONTRACTS.md).

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

