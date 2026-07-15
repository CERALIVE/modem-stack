# modem-control — bench CLI

The iteration surface for the CeraLive modem stack. It drives the
[`@ceralive/modem-control`](../control/) library against real modems on a bench device
to mature the package and (with `certify`) capture per-SKU certification bundles.

## Commands

| Command | What it does |
|---------|--------------|
| `probe` | One-shot stack snapshot: identities (+ identity-ladder resolution), lifecycle state, MM feature detection, read-only enrichment, cell info, and classified USB devices. Ends with `PROBE OK: external-auth, objects=<n>`. |
| `watch` | Live event stream. Prints `+ ADDED` / `~ CHANGED` / `- REMOVED` per change and `! SOURCE-UNAVAILABLE` on a bus drop. A bus drop / MM restart marks a modem source-unavailable with its row **retained** — never a removal (A3.1 epoch authority). `--duration <ms>` / `--events <n>` bound the run; otherwise it runs until Ctrl-C. |
| `apply --policy <file>` | Reads a JSON/YAML desired-state policy, derives the modem's durable binding key (refusing an ambiguous identity), runs the reconcile planner, applies the ops, and prints one receipt per policy dimension. |
| `set-usb-mode <slot> <target> --confirm` | Runs a certified USB-mode transition. **Omitting `--confirm` refuses the transition with zero side effects.** `<target>` is one of `qmi` / `mbim` / `ecm-ncm`. |
| `certify <slot>` | Captures a redacted, schema-validated certification bundle: `lsusb -v`, `usb-devices`, the slot's udev properties, an `mmcli -K` dump, a redacted `GetManagedObjects`, and a bounded signal window. `--transition <mode>` adds transition evidence (before/after descriptors, the executed AT command, and the port-drop / re-enumeration timeline) shaped to drop straight into an A4.2 catalog entry. Prints `CERTIFY OK: sha256=<hash> …` — the sha256 is the value a reviewer records in a catalog entry's `evidenceBundleSha256`. Real captures are marked `synthetic: false`; ICCID / IMSI / EID are masked; a malformed capture exits non-zero with a clear error rather than writing a broken bundle. `--output <file>` writes the bundle JSON (default stdout). |
| `usage` | Prints the data-usage sampler snapshot (per-slot cumulative-cycle bytes; advisory threshold). |
| `unlock-pin [slot]` / `unlock-puk [slot]` | Prompts for the PIN / PUK with **terminal echo disabled** (the secret is never printed back) and submits it. |

### Global options

- `--bus-address <addr>` (or env `MODEM_CONTROL_BUS_ADDRESS`) — the D-Bus bus address.
  Defaults to the system bus (`unix:path=/var/run/dbus/system_bus_socket`), where a real
  ModemManager lives. This is the injection point that points the CLI at a fake MM service
  for harness-driven tests and the compiled-probe smoke.
- `--destination <name>` — override the ModemManager bus name.

### Policy file

`apply --policy` accepts JSON or YAML (by file extension). The file carries the desired
intent only — `apply` binds it to the selected modem's live identity:

```json
{
  "slot": "Modem/0",
  "enabled": true,
  "connection": { "apn": "auto", "ipFamily": "ipv4v6" },
  "roaming": false,
  "radio": { "preferenceOrdered": ["5gnr", "lte", "umts", "gsm"] },
  "recovery": { "enabled": false },
  "usage": { "cycleDay": 1, "thresholdBytes": 5000000000 }
}
```

## Develop

From the repository root (single Bun workspace):

```sh
bun install
bun run typecheck            # tsc --noEmit (strict)
bun run lint                 # Biome
dbus-run-session -- bun test cli   # harness-driven CLI integration tests
```

The integration tests run the dev/TS CLI against the fake ModemManager + NetworkManager
(A2.3). They need a session bus, hence `dbus-run-session`.

## Compiled binaries + cross-arch probe smoke

The CLI is compiled to standalone binaries for `arm64` + `amd64`, and a self-contained
smoke harness proves a real D-Bus probe on both architectures:

```sh
cli/smoke/build-binaries.sh   # -> cli/dist/modem-control-{amd64,arm64} + smoke harness
cli/smoke/run.sh              # amd64 native + arm64 (Docker QEMU) + a negative sanity run
```

`run.sh` proves, on both arches, that the compiled binary completes an EXTERNAL-auth
handshake, `GetManagedObjects` returns real data, a signal is received, and a bus drop is
discriminated from a real removal. The negative run spins a modem-less fake and MUST fail,
proving the smoke exercises the real dependency rather than passing unconditionally. The
arm64 run reuses the `docker run --platform linux/arm64` QEMU path.

## Hardware-gated: on-device system-bus probe `[PARTIAL]`

Run against a **real** ModemManager on a bench device's system bus. This path is gated on
hardware and is not exercised in CI.

```sh
# On the bench device, with the packaged ModemManager stack installed and running:
./modem-control probe
```

Expected: the run ends with a line of the form

```
PROBE OK: external-auth, objects=<n>
```

where `<n>` is the number of managed objects ModemManager reports (modems + SIMs +
bearers). Capture the full output to the evidence path `A6.1/hil-system-bus.txt`.

If the device's ModemManager is on a non-default address, point the CLI at it with
`--bus-address` or `MODEM_CONTROL_BUS_ADDRESS`.
