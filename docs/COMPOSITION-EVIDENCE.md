# Composition evidence — SIMCom SIM7600G-H and Fibocom FM350-GL

A **non-mutating** bench capture of what these two units actually expose: USB descriptors,
driver bindings, firmware revisions, and the read-back state of each vendor's USB-mode
command. Captured on `ceralive2` (RK3588, kernel `7.1.7-ceralive-rk3588`, Debian 12,
packaged ModemManager `1.24.2-2~ceralive0.2.0`) on **2026-08-18**.

**Neither unit is certified by this document, and neither gains a catalog entry.** This is
the evidence half only. `certified-catalog.json` is unchanged; two guard tests in
[`ingestion.hardware.test.ts`](../control/src/usb-mode/ingestion.hardware.test.ts) fail the
build if either SKU is promoted without going through
[`CATALOG-INGESTION.md`](CATALOG-INGESTION.md).

## What "non-mutating" means here, precisely

Every AT command sent was one of three read-only forms:

| Form | Example | Effect |
|------|---------|--------|
| bare execute | `ATI` | identifies the module |
| READ | `AT+GTUSBMODE?` | returns the current value |
| TEST | `AT+GTUSBMODE=?` | returns the supported parameter range (ITU-T V.250 §5.4.1) |

**No SET form (`AT+X=<value>`) was sent to either unit.** The capture harness carried a
guard that refused any command containing `=` unless it was exactly `=?`. Each unit's
`idVendor`/`idProduct` was read from sysfs immediately before and after its AT session and
was **unchanged** in both cases — `1e0e:9001` → `1e0e:9001`, `0e8d:7127` → `0e8d:7127`.

No modem was enabled, no SIM operation was attempted (neither unit has a SIM), no USB port
was power-cycled, and no ModemManager inhibit was taken. MM held only the *Quectel's*
`ttyUSB7`/`ttyUSB8`, so the AT ports used here were free.

---

## SIMCom SIM7600G-H R2 — `1e0e:9001`

| Field | Value |
|-------|-------|
| USB id | `1e0e:9001` (`bcdDevice` 3.18) |
| sysfs / udev `ID_PATH` | `1-1.3.4` / `platform-xhci-hcd.0.auto-usb-0:1.3.4` |
| Device descriptor | `bDeviceClass=00` (class is per-interface), 6 interfaces |
| Drivers | 5 × `option` + 1 × `qmi_wwan` |
| MM plugin / primary port | `simtech` / `cdc-wdm0` (QMI) |
| MM state | `failed` / `sim-missing` (no SIM in either slot) |
| Classifier verdict | `mm-managed`, mode `qmi` |
| Firmware (`AT+CGMR`, `mmcli`) | `LE20B04SIM7600G22` |
| Sub-version (`AT+CSUB`) | `B04V03` / `MDM9x07_LE20_G-H_22_V1.16_221104` |

### The USB-mode command — domain read back, tuple NOT proven

```
AT+CUSBPIDSWITCH?
+CUSBPIDSWITCH: 9001

AT+CUSBPIDSWITCH=?
+CUSBPIDSWITCH: (9000,9001,9002,9003,9004,9005,9006,9007,9011,9016,9018,9019,901A,
                 901B,9020,9021,9022,9023,9024,9025,9026,9027,9028,9029,902A,902B),(0-1),(0-1)
```

This is the first **device-sourced** statement of the command's shape. It establishes two
facts that were previously guesses:

1. **Arity is three**, not one: `AT+CUSBPIDSWITCH=<pid>,<p2>,<p3>`, with both trailing
   parameters in `(0-1)`. Vendor documentation commonly describes these as a
   *save-to-NV* flag and a *reset-now* flag, **but this capture does not establish that** —
   the module reports only the ranges, not the semantics.
2. **The PID domain is the 26 values listed above**, and the unit is currently on `9001`.

What it does **not** establish, and what nothing on this bench establishes:

- **which** PID yields which composition (QMI vs MBIM vs ECM vs RNDIS);
- what the two trailing flags actually do;
- whether any target composition survives a power cycle;
- whether a wrong tuple is recoverable without a vendor tool.

Discovering that would require sending SET forms — a mutation, deliberately out of scope
for this pass. **Consequence: every SIM7600G-H target mode stays UNCERTIFIED and the mode
control stays HIDDEN.** Certification requires the exact tuple proven with a working
recovery path and ≥10 cold-boot persistence cycles; none of that has been attempted.

`AT+CUSBSPEED?` and `AT+CUSBSPEED=?` both answer `ERROR` — this firmware has no such
command, so USB-speed selection is not a control surface on this unit.

---

## Fibocom FM350-GL on an M.2→USB carrier — `0e8d:7127`

> **Read [`FM350-DECISION.md`](FM350-DECISION.md) before acting on anything here.** The
> `0e8d:7127` identity belongs to the **bench carrier**, not to a native FM350 USB
> personality; a production board seats this module in a real M.2 **PCIe** slot. That
> decision is unchanged by this capture, and **no USB classifier entry is added for
> `0e8d:7127`.** Everything below is classified strictly as *USB-attachment-only* evidence.

| Field | Value |
|-------|-------|
| USB id | `0e8d:7127` (`bcdDevice` 0.01) — MediaTek's **USB** vendor id, not the PCI `14c3` |
| sysfs / udev `ID_PATH` | `1-1.2` / `platform-xhci-hcd.0.auto-usb-0:1.2` |
| Device descriptor | `bDeviceClass=ef` / `Sub=02` / `Prot=01` (IAD composite), 10 interfaces |
| Drivers | 2 × `rndis_host`, 7 × `option`, 1 × unbound (`ff/42/01`) |
| MM plugin / primary port | `generic` / `ttyUSB12` (AT) |
| MM state | `failed` / `sim-missing` |
| Classifier verdict | `mm-managed`, mode `rndis` |
| Firmware (`AT+CGMR`, `mmcli`) | `81600.0000.00.19.17.10` |
| Package version (`AT+GTPKGVER?`) | `81600.0000.00.19.17.10_5001.0000.030.000.026_B77` |

### The USB-mode command — read back cleanly

```
AT+GTUSBMODE?
+GTUSBMODE: 41

AT+GTUSBMODE=?
+GTUSBMODE: (40,41)
```

This **corroborates the kernel-sourced research** that the FM350's mode command is
`AT+GTUSBMODE` with values 40 and 41, and adds what the research could not: the module on
this bench reports exactly those two values as its supported set and is currently on **41**.

Still not established, and not attempted:

- which of 40 / 41 corresponds to which composition (the unit is enumerating RNDIS + AT
  today, but that is not attributed to mode 41 by any evidence here);
- persistence, recovery, or behaviour of a mode change of any kind.

**Consequence: no mode control is offered for the FM350 in any topology.** For the native
PCIe attachment the exclusion is a standing decision (`FM350-DECISION.md`); for this
USB-carrier attachment it is simply uncertified.

`AT+GTFLAGS?` answers `+CME ERROR: 100` (not supported on this firmware). `AT+CFUN?`
reports `1` (full functionality) for both units' equivalent query.

---

## Why no bundle from this capture is promotable

Both units were captured with the real `modem-control certify` CLI, and both produced a
valid `CERTIFY OK … synthetic=false` line. Neither bundle can be promoted, for reasons that
are **defects in the capture pipeline, not gaps in the hardware evidence** — see blockers
**B2**, **B5**, and **B6** in [`BENCH.md`](BENCH.md):

- the bundles carry **no `sku` and empty `udevProperties`** (B2), so the ingestion seam
  refuses them `sku-missing`;
- they carry **every bench modem's IMEI** in the `modemManager` half (B5), so they cannot be
  committed here or pasted into a review comment;
- the `firmwarePrefix` a fixed capture would carry is the USB `bcdDevice`, not the modem
  firmware revision (B6).

The raw bundles and full transcripts therefore live in the local orchestration scratch
directory, not in this repository. What is reproduced in
[`ingestion.hardware.test.ts`](../control/src/usb-mode/ingestion.hardware.test.ts) is the
IMEI-free half — the verbatim `usb-devices` records and udev property maps — which is
enough to pin every descriptor and driver binding above as an executable regression test.
