# Test support — MM-faithful fake D-Bus service + stateful NM harness

The doubles the A3.x ModemManager D-Bus backend and A4.1 NetworkManager adapter are
tested against. This lives outside `control/src`, so it is **not** published in the
`@ceralive/modem-control` npm package (`files: ["src"]`) — it is test-only.

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

Neither is the shipping adapter. A4.1's `NmcliNmPort` owns the full nine-field GSM write
parity and the atomic Auto-APN transitions; this harness is what A4.1 injects to assert
them.

## Running

```sh
dbus-run-session -- bun test control/test-support
```

The bus-dependent suites use `describe.skipIf(!hasSessionBus())` and print one loud
`console.warn` when skipped, so a missing `dbus-run-session` is never mistaken for a
pass. The `fake-nm` suite needs no bus and always runs. CI installs `dbus` +
`python3-dbus`.
