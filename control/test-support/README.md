# Test support — MM-faithful fake D-Bus service + stateful NM harness

The doubles the A3.x ModemManager D-Bus backend and A4.1 NetworkManager adapter are
tested against. This lives outside `control/src`, so it is **not** published in the
`@ceralive/modem-control` npm package (`files: ["dist"]`, and the build only emits from
`src`) — it is test-only.

**This is not the package's contract-fakes surface.** What a CONSUMER should reuse is
the published `@ceralive/modem-control/testing` entry (`control/src/testing/`): pure
data and functions, no bus, no process. Everything here needs a private session bus or
a stateful `nmcli` state machine and is deliberately unpublished — do not promote it to
a public subpath, and do not have a consumer reach into it by path.

## `fake-mm/` — a scriptable, MM-faithful `org.freedesktop.ModemManager1`

A real ModemManager object model served on a private session bus (built on the same
`@httptoolkit/dbus-native` the transport uses):

- **Root ObjectManager** at `/org/freedesktop/ModemManager1` answering `GetManagedObjects`
  (`a{oa{sa{sv}}}`) and emitting `InterfacesAdded` / `InterfacesRemoved`.
- **Modems** at `/Modem/<n>` exposing `Modem` and `Modem.Modem3gpp` as **separate**
  D-Bus interfaces — never merged (draft §Oracle round-2 #6).
- **SIMs** as **separate** `/SIM/<n>` objects, reached from a modem's `Sim` object-path
  property (draft §Oracle round-2 #6).
- **Bearers** at `/Bearer/<n>` that are observable in the tree but **throw a tripwire**
  on `Connect` / `Disconnect` — and so do `Modem.Simple.Connect` and `Modem.CreateBearer`
  — proving nothing in the stack ever activates a bearer through MM (NM owns activation).
- **Three property shapes:** `1.20` (has `Device`, no `Physdev`), `1.22` and `1.24`
  (both `Device` and `Physdev`, since `Physdev` is 1.22+), switched per scenario
  (draft §round-4). Feature detection (A3.2) reads the shape's real property set.
- **Signals:** invalidated-only `PropertiesChanged` (`sa{sv}as`, empty changed dict,
  names in the invalidated array), value-carrying `PropertiesChanged`, and real daemon
  `NameOwnerChanged` via name drop / reclaim / restart (new-owner epoch).
- **Scenario scripting:** `addModem`, `removeModem`, `replaceSim` (SIM hot-swap),
  `configureScan`, `expectPin`, `setReplyDelay` (late replies), `changeProperties`,
  `invalidateProperties`, `dropName`, `reclaimName`, `restart`.

`tree.ts` provides the decoded-tree walk helpers (`fetchManagedObjects`, `findInterface`,
`propValue`, `followObjectPath`, …) the A3.x observer reuses.

## `fake-nm/` — a stateful `nmcli` runner + a fake `NetworkManagerPort`

- `StatefulNmcliRunner` runs a tiny state machine over the real `nmcli` argv grammar and
  keeps profiles + active-device state, so `connection show` after `add` / `modify`
  reflects exactly what was written — **real readback**, no canned strings.
- `FakeNetworkManagerPort` fulfils the `NetworkManagerPort` contract over that runner.

Neither is the shipping adapter. `NmcliNmPort` (`control/src/backend/nmcli-nm-port.ts`) owns
the full nine-field GSM write parity and the atomic Auto-APN transitions; this harness is
what its suite injects to assert them. `NetworkManagerAdapter`
(`control/src/providers/network-manager/`) sits one level up on the same harness — the
runner's real readback is what lets its tests tell "the desired slot echoed the request"
apart from "the desired slot was seeded from the readback".

## `conformance/` — the provider-matching matrix harness

The corpus and harness behind `control/src/providers/conformance-{matrix,transcripts,scale}.test.ts`.
It is the only place all four real providers (ModemManager, Huawei HiLink, ZTE goform,
UFI/HIMI) are registered at once, so it is where a provider claiming a neighbour's
hardware is visible at all.

- `exchange.ts` — ONE normalized `RecordedExchange` shape for three transports that agree
  about nothing (HiLink posts XML to a path, goform posts a form and carries its verb in
  `goformId`, HIMI posts JSON to one endpoint and carries its verb in `cmdid`). Bodies are
  decoded into the vendor's own encoding rather than flattened to a string, headers are kept
  verbatim **in order**, and the cookie is lifted out because that is where the three diverge.
- `corpus.ts` — the sanitized per-firmware documents. It **reuses** `observation-fixtures.ts`
  for every telemetry payload; what is new is only the session / login / challenge documents
  those fixtures do not carry. Devices are ROUTE TABLES, not ordered reply queues, so a case
  cannot break just because another provider's probe interleaved.
- `transcripts.ts` — expected transcripts rebuilt **from the protocol**, so a `toEqual`
  against a recording is a comparison and not an echo.
- `cases.ts` — the 20-case table with each case's entitled decision.
- `mm-transport.ts` — an in-memory `DbusTransport` over the SAME `fake-mm/object-model.ts`
  tree. `fake-mm/service.ts` remains the right harness for codec and epoch proof (only a real
  bus proves those); this one exists because a matrix whose ModemManager rows SKIP wherever
  there is no session bus is a matrix with holes in it, and it makes the 16-modem scale
  fixture's resource counts deterministic.
- `matrix-report.ts` — writes the summary artifact to the gitignored `test-results/`.

## Running

```sh
dbus-run-session -- bun test control/test-support
```

The bus-dependent suites use `describe.skipIf(!hasSessionBus())` and print one loud
`console.warn` when skipped, so a missing `dbus-run-session` is never mistaken for a
pass. The `fake-nm` suite needs no bus and always runs. CI installs `dbus` +
`python3-dbus`.
