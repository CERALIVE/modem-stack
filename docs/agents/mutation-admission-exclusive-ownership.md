<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

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

