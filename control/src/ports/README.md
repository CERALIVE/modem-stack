# Port contracts + ownership matrix

The adapter boundaries `@ceralive/modem-control` reconciles across. Every concrete
backend — the A2.3 fake harness, the A3.x ModemManager D-Bus backend, the A4.1
`nmcli` NetworkManager adapter — implements one of these interfaces. Nothing here
performs I/O; these are pure TypeScript contracts.

## The ports

| Port | File | Responsibility |
|------|------|----------------|
| `ModemObservationPort` | [`observation.ts`](./observation.ts) | Read-only: `start()`, `observe()`, `stop()`; emits discriminated `ObservationList` results that **retain rows** on source failure (removal is only ever an authoritative snapshot omission). |
| `ModemManagerPort` | [`modem-manager.ts`](./modem-manager.ts) | **Extends** the observation port with the mutations MM owns: `setRadioModes`, `setPrimarySimSlot`, `sendPin`/`sendPuk`, `scanNetworks`, `inhibit`/`uninhibit`. **NO bearer/connect verb.** |
| `NetworkManagerPort` | [`network-manager.ts`](./network-manager.ts) | GSM profile CRUD; `activate`/`deactivate` taking **both** `(connectionId, deviceIfname)`; quiesce lease. Implemented by `backend/nmcli-nm-port.ts`; `providers/network-manager/` is the saved-vs-applied adapter built on top of it. |
| `RouterPort` | [`router.ts`](./router.ts) | Presence + advisory health only, for devices MM cannot control. |
| `MutationAdmissionPort` | [`mutation-admission.ts`](./mutation-admission.ts) | Consumer-owned acquire/refuse authority for descriptor-gated mutations; no policy is derived here. |
| `ResourceOwnershipPort` | [`resource-ownership.ts`](./resource-ownership.ts) | Non-queueing exclusive ownership for file stores, router sessions, and USB-hub access. |
| `ModemManagerInhibitPort` | [`modem-manager.ts`](./modem-manager.ts) | Narrow MM inhibit/uninhibit maintenance lease. |
| `UhubctlPort` | [`uhubctl.ts`](./uhubctl.ts) | Injected USB-hub actuator contract; the control package ships no implementation. |

## Ownership matrix — one sole writer per resource

Each resource below has **exactly one** owner. No other component writes it. This is
the NM-owns-bearers architecture the whole package is built around (independent
review correction, draft §Oracle #1): the controller is a reconciler over two
adapters, never a second writer of the same resource.

| Resource | Sole writer | Port / owner |
|----------|-------------|--------------|
| APN | NetworkManager | `NetworkManagerPort` (`gsm.apn` / auto-config) |
| Connection auth (username / password) | NetworkManager | `NetworkManagerPort` (`gsm.username` / `gsm.password`) |
| Roaming | NetworkManager | `NetworkManagerPort` (`gsm.home-only`) |
| Autoconnect | NetworkManager | `NetworkManagerPort` (`connection.autoconnect`) |
| Activation (bearer lifecycle) | NetworkManager | `NetworkManagerPort` (`activate`/`deactivate`) |
| Radio access-technology modes | ModemManager | `ModemManagerPort.setRadioModes` |
| SIM operations (PIN / PUK / primary slot / scan) | ModemManager | `ModemManagerPort` |
| Recovery ladder | Local controller | policy `recovery` (disabled by default, A3.4) |
| Usage policy (cycle / threshold) | Local controller | policy `usage` (A4.3 sampler) |

### The bearer invariant (safety-critical)

**The controller NEVER calls MM's `Simple.Connect`, `CreateBearer`, or
`Bearer.Connect`.** Bearers, APN, and connection activation belong exclusively to
NetworkManager. `ModemManagerPort` therefore has no `connect`, `createBearer`, or
`bearerConnect` method, and none may ever be added. This is enforced at build time
by [`forbidden-surface.test.ts`](./forbidden-surface.test.ts), which scans every
port source file and fails if any bearer/connect method declaration appears.

## Port-tagged ops

The planner ([`reconcile.ts`](./reconcile.ts)) emits **port-tagged ops**
([`ops.ts`](./ops.ts)): a discriminated union `{ port: 'mm', op: MmOp } | { port:
'nm', op: NmOp }` whose op-kind spaces are disjoint. A radio op tagged for the NM
port — `{ port: 'nm', op: { kind: 'setRadioModes', … } }` — is a **compile-time type
error**, proved by [`ops.type-test.ts`](./ops.type-test.ts) (`@ts-expect-error`
lines that `tsc --noEmit` must flag). The ownership matrix is thus enforced by the
type system, not merely by convention.

## Receipts

Reconciliation is honest: each policy dimension yields exactly one
[`Receipt`](./receipts.ts) with a status (`applied | pending | unsupported |
failed`) and a **reason**. Nothing is silently dropped — "prefer 5G" on a 4G-only
modem returns `unsupported` with an explicit reason, never a quiet downgrade to a
4G-only mode.
