# ModemManager provider

`ModemManagerProvider` is the concrete provider-registry adapter for ModemManager 1.20+.
It uses the package's typed D-Bus transport directly. Command-line clients such as `mmcli`,
`qmicli`, and `mbimcli` are diagnostics for an operator, never production transports.

## Runtime discovery

The provider resolves a physical modem from `ObjectManager.GetManagedObjects`, then derives its
generic controls from the interfaces and properties on that object. A modem does not need a catalog
entry to expose current mode, signal, SIM, multi-SIM, or power state. Missing runtime evidence
refuses only the affected control; it is not converted into an unsupported-model verdict.

Certification is narrower: a band read is generic, while a band mutation is unavailable unless the
embedding process injects a positive certification decision. FCC auto-unlock likewise keeps using
the existing `<vid>:<pid>` coverage catalog because ModemManager's own modem object does not advertise
dispatcher coverage.

## Existing modules composed

- `backend/observer.ts` and `backend/managed-objects.ts`: authoritative snapshot and signal lifecycle.
- `backend/mm-backend.ts` and `backend/mm-mutations.ts`: radio, band, SIM, scan, and inhibit calls.
- `backend/mm-location.ts` plus `location/fix-state.ts`: `Location.Setup` with signaling disabled,
  bounded acquisition, fix expiry, and no location history.
- `sms/dbus-messaging.ts`: permanently read-only list/read plus `Added`/`Deleted` events.
- `ussd/mm-ussd.ts`: bounded serialized USSD sessions.
- `band/` and `fcc/`: existing safety gates and catalogs.

All composed mutations share one `ModemActor`. No provider surface creates, connects, or disconnects
a bearer; NetworkManager owns bearer and APN state.

## Refusals and tests

Typed D-Bus failures map to stable domain reasons instead of exposing daemon text. The private-bus
suite in `control/src/providers/modem-manager/modem-manager-provider.integration.test.ts` drives the
real fake-MM ObjectManager service. It covers unknown-model discovery, events, radio/signal/SIM/power,
GPS capability and privacy, SMS, USSD, certification-gated bands, and an injected
`Core.Unauthorized` error. `forbidden-subprocess.test.ts` is a non-vacuous production-source gate.
