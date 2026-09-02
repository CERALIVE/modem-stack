# FM350 decision record — PCIe modem, documented-deferred

**Status:** documented-deferred. This repo does **not** implement Fibocom FM350 device
enablement, and adds **no** entry for it to the USB device classifier. The FM350 is a PCIe
device; the reasons and the future-decision gates are recorded below so the deferral is a
deliberate, evidence-backed choice rather than an oversight.

This is a **tracked** engineering decision record (committed to git), not a claim that the
FM350 works on any CeraLive device.

> **⚠ CONTRADICTED BY HARDWARE, 2026-08-17 — decision frozen pending human review.** A real
> FM350-GL is now connected to the bench and enumerates as a **USB** device (`0e8d:7127`,
> `rndis_host` + `option`), not as the PCIe `mtk_t7xx` device this record describes. The
> evidence is recorded verbatim in **[Citation 6](#citation-6--hardware-a-real-fm350-gl-observed-on-the-usb-bus-2026-08-17)**;
> this is the mechanical rule's branch-1 contrary-evidence **HARD STOP**. Everything below
> Citation 6 — the status line above, "What the FM350 is", the branch verdict, the three-gate
> ledger — is left **exactly as previously written** on purpose, so the contradiction is
> visible rather than smoothed over. Nothing is resolved until a human adjudicates.

## What the FM350 is

The Fibocom FM350-GL is an M.2 **PCIe** WWAN module built on the MediaTek T700/T7xx
platform (Lenovo ships it in ThinkPad laptops). Its bus identity is the **PCI**
vendor:device pair `0x14c3:0x4d75` (`14c3` = MediaTek), and the Linux kernel binds it with
the **`mtk_t7xx`** PCIe WWAN driver, which exposes the modem on the `wwan`/`net` subsystems.
It is **not** a USB modem and presents **no** USB VID:PID.

## The mechanical rule

Given the question *"does this repo add FM350 device enablement to `device-classifier.ts`?"*,
apply this decision procedure against the **verified upstream ModemManager 1.24.2 source**:

1. Extract, verbatim from the MM source, how the plugin layer matches the FM350.
2. **IF** the source matches the device by a **USB VID:PID** (a USB-bus identity):
   - the device is in scope for `device-classifier.ts` (which is a **USB-only** model);
   - **sub-branch — contrary-evidence HARD STOP:** if the source names an *explicit FM350
     USB VID:PID*, do not improvise a classifier representation — stop and surface the exact
     citation to a human; any classifier change becomes a user decision.
3. **ELSE IF** the source matches the device by a **PCIe identity** (a PCI vendor:device
   pair gated on a PCIe kernel driver + `wwan`/`net` subsystems, with no USB VID:PID):
   - the device is **out of scope** for the USB-only classifier;
   - the outcome is **documented-deferred** — record the decision here, add **no** classifier
     entry, add **no** code branch, add **no** fixture.

### Which branch fired

**Branch 3 (PCIe identity) fired.** The MM 1.24.2 source matches the FM350 exclusively by the
PCI pair `0x14c3:0x4d75`, gated on the `mtk_t7xx` PCIe WWAN kernel driver and the `wwan`/`net`
subsystems. No USB VID:PID for the FM350 exists anywhere in the source tree. The
contrary-evidence HARD STOP was therefore **not** triggered. Outcome: **documented-deferred**,
with zero change to the USB device classifier.

## Verified evidence

### Provenance — the exact tarball these facts come from

- Artifact: `modemmanager_1.24.2.orig.tar.xz`
- Source of truth: `packaging/upstream-pins.yaml` (`sources.modemmanager.orig_tar_url` /
  `orig_tar_sha256`), the provenance-verified pin landed in this repo's upstream-currency work.
- Download URL:
  `https://deb.debian.org/debian/pool/main/m/modemmanager/modemmanager_1.24.2.orig.tar.xz`
- **sha256 (re-downloaded and re-verified for this record):**
  `8f575bfdcc0277b68946a65b527a804be8051abbb17430b6108da365a92c6913`
  — byte-for-byte equal to the pinned `orig_tar_sha256`.

All file:line citations below are relative to the extracted tree root
`modemmanager-1.24.2/`.

### Citation 1 — the PCI vendor:device match (`0x14c3:0x4d75`)

`src/plugins/mtk/mm-plugin-mtk.c`, lines 49-50 (inside `create_modem`):

```c
        /* FM350 support with Fibocom-specific changes */
        if (vendor == 0x14c3 && product == 0x4d75) {
```

This confirms the expected pair exactly: `vendor == 0x14c3 && product == 0x4d75`.

### Citation 2 — the `mtk_t7xx` driver requirement and the `wwan`/`net` subsystems

`src/plugins/mtk/mm-plugin-mtk.c`, lines 82-83 and 88-89 (inside `mm_plugin_create_mtk`):

```c
    static const gchar *subsystems[] = { "wwan", "net", NULL };
    static const gchar *drivers[] = { "mtk_t7xx", NULL };
    ...
                      MM_PLUGIN_ALLOWED_SUBSYSTEMS, subsystems,
                      MM_PLUGIN_ALLOWED_DRIVERS,    drivers,
```

The plugin only ever binds devices on the `wwan`/`net` subsystems whose kernel driver is
`mtk_t7xx` (the MediaTek T7xx **PCIe** WWAN driver).

### Citation 2b — the match is PCIe, not USB

`src/plugins/mtk/mm-plugin-mtk.c`, `create_modem` signature (lines 42-43) receives the
**PCI** subsystem identifiers, which are only ever populated for PCI devices:

```c
              guint16 subsystem_vendor,
              guint16 subsystem_device,
```

The mtk plugin declares **no** `MM_PLUGIN_ALLOWED_VENDOR_IDS` — the USB-style vendor-id
table. It matches purely by PCIe driver + subsystem. (For contrast, USB plugins publish a
USB vendor-id table, e.g. the fibocom plugin below.)

### Citation 3 — the fibocom plugin carries NO FM350 USB VID:PID (the contrary-evidence check)

A whole-directory search of the USB-based fibocom plugin returns nothing for the FM350:

```
$ grep -rniI '14c3|4d75|fm350|t7xx' src/plugins/fibocom/
(no matches)
```

For contrast, the fibocom plugin matches its own **USB** devices by a USB vendor-id table,
`src/plugins/fibocom/mm-plugin-fibocom.c`, lines 113-114:

```c
    static const gchar *subsystems[] = { "tty", "net", "usbmisc", NULL };
    static const guint16 vendor_ids[] = { 0x2cb7, 0x1782, 0x1508, 0 };
```

None of `0x2cb7`, `0x1782`, `0x1508` is `0x14c3`; there is no `0x4d75`. The FM350 is not a
fibocom-USB device in this source.

### Citation 4 — every `14c3`/`4d75` occurrence in the whole tree

```
$ grep -rniI '14c3|4d75' .
data/dispatcher-fcc-unlock/14c3:7:# Lenovo-shipped Fibocom FM350-GL (14c3:4d75) FCC unlock
data/dispatcher-fcc-unlock/meson.build:16:  '14c3',
data/dispatcher-fcc-unlock/meson.build:33:  '14c3:4d75': '14c3',
src/plugins/mtk/mm-plugin-mtk.c:50:        if (vendor == 0x14c3 && product == 0x4d75) {
```

Only three places name the FM350: the PCIe mtk plugin match, and an FCC-unlock dispatcher
keyed on `14c3:4d75` plus its meson wiring. None is a USB identity.

### Citation 5 — the NEWS entry that introduced this plugin

`NEWS`, line 168:

```
   ** mtk: new plugin with MBIM support for t7xx devices (eg FM350, L850, etc)
```

The FM350 is handled by the (PCIe) `mtk` plugin's T7xx path — corroborating the source-level
findings above.

### Citation 6 — HARDWARE: a real FM350-GL observed on the **USB** bus (2026-08-17)

> **HARD STOP — Branch A fired. Human decision required before any classifier change.**
> Recorded per the Branch-A template below, steps 1-2 ONLY. No classifier entry, branch,
> type, or fixture has been added; the three-gate ledger below is deliberately left as it
> was. Steps 4-5 require human sign-off that has not happened.

An RB-16 re-run against the live bench board `ceralive2` (192.168.78.132, kernel
`7.1.7-ceralive-rk3588`, packaged ModemManager `1.24.2-2~ceralive0.2.0`) found a physically
connected Fibocom FM350-GL — **enumerating over USB**, not PCIe. This is the first hardware
evidence of any kind for this module, and it contradicts the "no USB VID:PID" conclusion of
Citations 1-4 at the observation level (see the reconciliation note below for what it does and
does not overturn).

**Observed identity**

| Field | Value |
|-------|-------|
| USB `VID:PID` | **`0e8d:7127`** |
| sysfs node | `/sys/bus/usb/devices/1-1.2` → `/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.2` |
| udev `ID_PATH` | `platform-xhci-hcd.0.auto-usb-0:1.2` |
| `manufacturer` / `product` | `Fibocom Wireless Inc.` / `FM350-GL` |
| `ID_VENDOR_FROM_DATABASE` | **`MediaTek Inc.`** |
| Device descriptor | `bDeviceClass=ef` `bDeviceSubClass=02` `bDeviceProtocol=01` (IAD composite), `bNumInterfaces=10`, `bcdDevice=0001`, USB 2.10 @ 480 Mb/s |
| `ID_USB_INTERFACES` | `:0202ff:0a0000:ff0000:ff4201:` |

**Observed driver bindings — NOT `cdc_mbim`.** The Branch-A template predicted `cdc_mbim` as
the expected driver family for a USB MBIM personality. That prediction is **wrong for this
unit**: the composition is RNDIS + AT, with no MBIM function at all.

```
1-1.2:1.0  class=02 sub=02 proto=ff  driver=rndis_host   -> net/enx000011121314
1-1.2:1.1  class=0a sub=00 proto=00  driver=rndis_host
1-1.2:1.2  class=ff sub=00 proto=00  driver=option       -> ttyUSB9
1-1.2:1.3  class=ff sub=00 proto=00  driver=option       -> ttyUSB10
1-1.2:1.4  class=ff sub=00 proto=00  driver=option       -> ttyUSB11
1-1.2:1.5  class=ff sub=42 proto=01  driver=(none)
1-1.2:1.6  class=ff sub=00 proto=00  driver=option       -> ttyUSB12
1-1.2:1.7  class=ff sub=00 proto=00  driver=option       -> ttyUSB13
1-1.2:1.8  class=ff sub=00 proto=00  driver=option       -> ttyUSB14
1-1.2:1.9  class=ff sub=00 proto=00  driver=option       -> ttyUSB15
```

`cdc_mbim` is not loaded on this board; `mtk_t7xx` is not loaded either. Interface `1-1.2:1.5`
(`ff/42/01`) is claimed by no driver.

**`0e8d` matches NOTHING previously considered in this record.** It is neither the PCI vendor
`14c3` of Citations 1-2, nor any of the fibocom USB plugin's vendor ids `0x2cb7` / `0x1782` /
`0x1508` from Citation 3. It is a **fourth, previously unconsidered vendor id** — MediaTek's
*USB* vendor id per the hwdb (`ID_VENDOR_FROM_DATABASE=MediaTek Inc.`), as distinct from
MediaTek's *PCI* vendor id `14c3`. The product id `7127` likewise appears nowhere in the MM
1.24.2 tree (Citation 4 enumerated every `14c3`/`4d75` occurrence; neither `0e8d` nor `7127`
was among them), and it is not the `0e8d:7126` bootloader id RB-16 was written to look for.

**ModemManager's own verdict — the `generic` plugin, not `mtk`, not `fibocom`.**
`mmcli -L` lists it cleanly as `/org/freedesktop/ModemManager1/Modem/4 [Fibocom Wireless Inc.]
FM350-GL`. Abridged `mmcli -m 4 -K` (full transcript in the evidence bundle):

```
modem.generic.manufacturer      : Fibocom Wireless Inc.
modem.generic.model             : FM350-GL
modem.generic.revision          : 81600.0000.00.19.17.10
modem.generic.device            : /sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.2
modem.generic.drivers.value[1]  : option
modem.generic.drivers.value[2]  : rndis_host
modem.generic.plugin            : generic
modem.generic.primary-port      : ttyUSB12
modem.generic.ports.value[1]    : enx000011121314 (net)
modem.generic.ports.value[2]    : ttyUSB12 (at)
modem.generic.state             : failed
modem.generic.state-failed-reason : sim-missing
modem.generic.supported-capabilities.value[1] : gsm-umts, lte
modem.generic.supported-modes.value[1]        : allowed: 2g, 3g, 4g, 5g; preferred: none
modem.3gpp.imei                 : 350274430001765
modem.3gpp.registration-state   : --
modem.generic.sim               : --
```

**No SIM is installed** (`state: failed`, `failed reason: sim-missing`), so every 3GPP field
beyond the IMEI is empty and no registration, bearer, or data-session evidence exists. The
5G capability the SKU advertises is not reported: MM sees `gsm-umts, lte` only.

**PCIe bus: still nothing.** The step-3 sweep found the same six PCI devices as the 2026-08-16
run (RK3588 root complex `1d87:3588` ×3, Realtek `10ec:b852` / `10ec:8125`) — no `14c3:4d75`,
`/sys/class/wwan/` does not exist, `mtk_t7xx` not loaded. So this is not a module that also
appeared on PCIe; on this bench it is USB-only.

**What this does and does not overturn.** Citations 1-4 audited the MM 1.24.2 *plugin* layer
and concluded no plugin matches an FM350 by USB VID:PID. That conclusion is **not** falsified
by this observation — MM here claims the device through the `generic` plugin (the fallback for
a device exposing AT ports), precisely because no vendor plugin's VID table contains `0e8d`.
What IS contradicted is this record's broader hardware claim, stated at the top of the file and
in "What the FM350 is": that the FM350 "is **not** a USB modem and presents **no** USB VID:PID."
The unit on this bench does present one. Whether that is the bare M.2 module in a USB
composition mode or an M.2-to-USB carrier interposing its own USB identity is **not determined
by this evidence** and is part of what needs human adjudication — no inference either way is
recorded here.

**Evidence bundle:** `test-results/modem-phase-b/65/{usb-sweep,driver-binding,pcie-sweep,mmcli-list,mmcli-dump,context}.txt`
(repo-local, gitignored); mirrored to `.omo/notepads/modem-stack-phase-b/`.

**RB-16 runbook defect, recorded not fixed.** [`BENCH.md`](BENCH.md) § RB-16 step 1 matches
only `0e8d:7126|14c3:4d75`, so its literal machine check prints `NO MATCHES` — i.e. "not
connected" — against a board where the FM350 is plainly enumerated. This run therefore ran the
runbook expression verbatim AND an explicit `0e8d:7127` extension, and both results are in
`usb-sweep.txt`. Widening the runbook's candidate list is deliberately left to the same human
decision that governs the classifier question, so the runbook and the decision stay in sync.

## Three-gate ledger

FM350 device enablement upstream requires three independent gates. This record is honest
about each: gate 1 is verified, gate 2 remains untested on the production PCIe topology, and
gate 3 is cleared for the carrier-mediated USB topology after correcting the downstream
forward-port.

| # | Gate | Requirement | State | Basis |
|---|------|-------------|-------|-------|
| 1 | MM version floor | ModemManager **≥ 1.24.2** (the release carrying the mtk-plugin FM350 fixes) | **CLEARED** | This repo now ships ModemManager **1.24.2** — see `packaging/upstream-pins.yaml` (`sources.modemmanager.upstream_tag: "1.24.2"`). The version-floor gate is satisfied. |
| 2 | Kernel | The `mtk_t7xx` PCIe WWAN driver present and enumerating the module over PCIe on the target hardware | **OPEN** | Not validated on real bench hardware in this work. No target-kernel `mtk_t7xx` bring-up has been performed or observed. |
| 3 | HIL (hardware-in-the-loop) | A physical FM350 module probed end-to-end through the stack on a bench device | **CLEARED — USB CARRIER** | The follow-up restored BELABOX's omitted `enabling_modem_init` override (`ATZ0`, not `ATZ`). The unit registered home, attached packet service, established the RNDIS bearer, assigned `10.0.163.14/32` to `enx000011121314`, and `curl --interface enx000011121314 https://example.com` returned HTTP 200. See [Follow-up root cause and passing HIL](#follow-up-root-cause-and-passing-hil-2026-08-23). |

Gate 1 being CLEARED does **not** imply the FM350 works on the production topology — it only
removes the upstream version-floor obstacle. Gate 2 remains a PCIe hardware-gated unknown.
Gate 3 clears only the carrier-mediated USB path measured below.

The 2026-08-17 USB-enumeration observation did not close either hardware gate: the human later
confirmed that an M.2-to-USB carrier mediates this bench topology, while the production topology
remains PCIe. The 2026-08-23 run is the first end-to-end attempt with a SIM under the candidate
USB plugin. It updates gate 3 with a measured failure rather than promoting enumeration to a
pass.

### Patched ModemManager HIL attempt, 2026-08-23

The owner-approved three-patch series was rebuilt locally for arm64 using the documented
`packaging/ci/build-stack.sh arm64` bench path. No release, package publication, or apt
dispatch occurred. The board started on `modemmanager` and `libmm-glib0`
`1.24.2-2~ceralive0.2.0`; the local dev packages were installed with `dpkg -i`, udev was
reloaded, and ModemManager was restarted.

Three candidate behaviors were observable:

- **Plugin binding passed.** The FM350 changed from the stock `generic` plugin to `fm350gl`.
- **CPOL disable passed.** The primary AT port carried
  `ID_MM_PREFERRED_NETWORKS_CPOL_DISABLED=1`.
- **`+GTACT` mode reading passed.** The plugin reported 12 supported mode combinations and
  current modes `allowed: 3g, 4g; preferred: 4g` instead of the generic plugin's single
  flattened combination.

The decisive bearer path failed earlier than the prior `0,NONE` dial failure. On every enable
attempt, the first initialization command and reply were:

```text
--> ATZ
<-- +CME ERROR: 59
```

ModemManager mapped that reply to `MobileEquipment.UnexpectedDataValue`, left the modem
`disabled`, and published no registration or packet-service state. Consequently:

- a `--3gpp-scan` was refused with `modem not enabled yet`, so the extended `+COPS` parser fix
  is **not hardware-measured** by this run;
- NetworkManager's existing FM350 profile timed out without creating a bearer;
- `enx000011121314` retained only link-local IPv6, with no routable IPv4 address or route; and
- an HTTPS request explicitly bound to that interface timed out.

The other attached modems were observed passively after installation: SIMCom remained bound to
`simtech`, Quectel remained bound to `quectel` and connected, and the Qualcomm/HIMI row remained
present. No non-FM350 modem was actively exercised.

**Decision at the end of this first attempt:** the patch series did not clear the HIL gate in
that form. After the drill, the exact pre-drill v0.2.0 packages were reinstalled; ModemManager
and NetworkManager were active, all four modem rows were present, and the FM350 was again bound
to `generic`. The follow-up below supersedes only that release-carry verdict.

### Follow-up root cause and passing HIL, 2026-08-23

The suspected udev error was tested first and rejected. Mode 41 exposes RNDIS on interfaces
0/1, option ttys on interfaces 2/3/4/6/7/8/9, and an unbound `ff/42/01` interface 5.
ttyUSB12/interface 6 — the rules' primary — was the only tty that answered a full query-only
AT sweep. Stock v0.2.0's generic plugin also selected ttyUSB12 and reproduced the same first-
enable CME 59 after a daemon restart.

Fresh inspection of BELABOX commit `da01610c46c581b0c6f2acd0ac50f5bba666efdf` found the
missing forward-port behavior: the original modem subclass overrides
`MMBroadbandModemClass.enabling_modem_init` and sends `Z0`. The downstream re-implementation
had omitted the override, so ModemManager inherited core `Z`. Directly on ttyUSB12, `ATZ`
returned CME 59 after both 2 and 32 seconds, while `ATZ0` returned `OK`. Restoring that exact
override therefore toggled the cause, not merely the symptom.

With the corrected arm64 packages installed, the FM350 bound `fm350gl` on ttyUSB12 and moved
through `enabling → enabled → registering → home → connected`. The bearer debug trace showed:

```text
AT+CGACT=1,0
AT+CGPADDR=0  -> +CGPADDR: 0,"10.0.163.14",""
AT+CGCONTRDP=0
(fm350gl) IP settings loaded for RNDIS PDP context #0
```

The acceptance transcript then passed:

```text
nmcli connection up gsm-4 ifname ttyUSB12
Connection successfully activated
enx000011121314  UNKNOWN  10.0.163.14/32
default via 190.157.8.46 proto static metric 700
curl --interface enx000011121314 https://example.com
http_code=200
```

The board was returned to `modemmanager`/`libmm-glib0` `1.24.2-2~ceralive0.2.0` after the
final capture. This clears the carrier-mediated USB HIL gate and justifies carrying the fixed
series. It does not clear gate 2 or claim production PCIe operation.

## Bench probe evidence (RB-16)

On 2026-08-16, [`docs/BENCH.md`](BENCH.md) § RB-16 was run against the live bench board
`ceralive2` (192.168.78.132, kernel `7.1.7-ceralive-rk3588`, packaged ModemManager `1.24.2`).
Full transcript: `test-results/modem-phase-b/09/{usb-sweep,driver-binding,pcie-sweep,mmcli-list,mm-version,bearer-connect,hil-cycle-fm350}.txt`
(repo-local, gitignored); mirrored to `.omo/notepads/modem-stack-phase-b/evidence-todo09-fm350.log`.

**Result: the FM350 is not physically connected to this bench** — neither in a USB adapter nor
in a PCIe M.2 slot. The USB sysfs sweep covered all 15 enumerated USB nodes and matched neither
`0e8d:7126` nor `14c3:4d75`. The PCIe sysfs sweep (this image has no `lspci`; walked
`/sys/bus/pci/devices/*` instead) found six real PCI devices — the RK3588 root complex
(`1d87:3588` ×3) and the board's own Realtek WiFi/Ethernet silicon (`10ec:b852`, `10ec:8125`) —
none matching `14c3:4d75`; `/sys/class/wwan/` does not exist; the `mtk_t7xx` module is not
loaded (the only MediaTek-named module present, `btmtk`, is Bluetooth, not WWAN, confirmed by
name). `mmcli -L` under the packaged `1.24.2` shows only the Quectel RM530N-GL and SIMCom
SIM7600G-H, consistent with every prior inventory pass this session
(`.omo/notepads/modem-stack-phase-b/learnings.md`, RB-9).

Per the mechanical rule above, **no branch fired** — there was nothing on either bus to
classify. The three-gate ledger stays exactly as recorded: gate 1 CLEARED, gates 2 and 3 OPEN.
This probe does not close gate 3; it is a documented non-event, recorded so a future reader
does not have to re-derive "was the unit ever actually checked on this bench."

### RB-16 re-run, 2026-08-17 — the unit IS connected, on USB

Same board, same image, one day later: the FM350-GL is physically present and enumerated at
`/sys/bus/usb/devices/1-1.2` as `0e8d:7127`, claimed by ModemManager 1.24.2 as Modem/4 via the
`generic` plugin over `option` + `rndis_host`. The PCIe sweep is unchanged from the 2026-08-16
pass (no `14c3:4d75`, no `/sys/class/wwan/`, no `mtk_t7xx`). Steps 5-6 of RB-16 did not run:
no SIM is installed (`state: failed / sim-missing`), so the bearer smoke has nothing to connect
and the port-cycle harness was not exercised — neither was simulated.

Per the mechanical rule, **branch 1 (USB VID:PID) fires, with its contrary-evidence HARD STOP**.
Full detail, exact descriptors, and driver bindings: [Citation 6](#citation-6--hardware-a-real-fm350-gl-observed-on-the-usb-bus-2026-08-17).
Evidence bundle: `test-results/modem-phase-b/65/` (repo-local, gitignored).

**Read-only observation on the classifier path (no change made):** on this board the device is
MM-managed — `nmcli` reports `ttyUSB12:gsm:unavailable`, i.e. NetworkManager sees it as a modem
port owned by ModemManager, and its RNDIS interface `enx000011121314` (MAC `00:00:11:12:13:14`,
no IPv4 lease) is not under NM management and hands out no DHCP address, so it does not present
as a router-mode dongle. No classifier in this repo or in CeraUI was modified, and none has an
entry for `0e8d:7127`; an unrecognized descriptor set is correctly `unmanaged` by the USB-only
classifier's own honesty rule. That is the current, truthful behavior — changing it is exactly
the decision this HARD STOP defers.

## Gate-ledger update template — fill in on the next bench run that captures real FM350 data

The mechanical rule above is unambiguous once real bus data exists. Whoever next runs RB-16
against a physically connected unit MUST resolve to exactly ONE of the two branches below, fill
in the bracketed evidence, and land it as the update to the three-gate ledger table — never
invent a third outcome, and never promote a matrix/certification claim from this probe alone.

### Branch A — USB VID:PID observed (`0e8d:7126` or `14c3:4d75` on the USB bus)

> **THIS BRANCH FIRED on 2026-08-17 — steps 1-3 DONE, steps 4-5 BLOCKED on human sign-off.**
> The observed id is `0e8d:7127`, a third value this template did not anticipate (see
> [Citation 6](#citation-6--hardware-a-real-fm350-gl-observed-on-the-usb-bus-2026-08-17)); it is
> still a USB VID:PID for the FM350, so the branch applies unchanged.
> Step 1 (STOP — no classifier entry, branch, or fixture added): **done**.
> Step 2 (record VID:PID + sysfs node + driver binding as Citation 6 with the evidence-bundle
> path): **done** — bundle `test-results/modem-phase-b/65/`.
> Step 3 (surface to a human, verbatim): **done** — the message in that step was reported to the
> operator on 2026-08-17.
> Steps 4 (ledger update + classifier fixture) and 5 (matrix/certification) are **NOT done** and
> must not be done without that sign-off.

This is the mechanical rule's **branch-1 contrary-evidence HARD STOP** (line ~27 above): a USB
VID:PID for the FM350 would contradict Citations 1-4's PCIe-only finding from the verified MM
1.24.2 source. **Do not silently update the classifier** — this is exactly the case the rule
says to stop and surface to a human.

1. STOP. Do not add a classifier entry, branch, or fixture without human sign-off, even though
   the mechanical rule literally reads "in scope for the USB-only classifier."
2. Record the exact `[VID:PID]`, the sysfs node, and the driver binding observed
   (`[driver name]` — `cdc_mbim` is the expected driver family for a USB MBIM personality, a
   **different** driver family than the documented PCIe `mtk_t7xx` path) as a new Citation 6
   here, with the RB-16 evidence bundle path `[test-results/modem-phase-b/09/...]`.
3. Surface to a human, verbatim: "FM350 unexpectedly enumerated as a USB device — contradicts
   MM 1.24.2 source Citations 1-4. Human decision required before any classifier change."
4. Ledger update, ONLY after human sign-off to proceed: gate 2 (kernel) → `N/A (USB path
   observed, not PCIe)`; gate 3 (HIL) → `CLEARED`, basis = the RB-16 evidence bundle path. Add
   the real classifier fixture (`device-classifier.test.ts`-shape) for the observed descriptor.
5. **USB enumeration alone does NOT promote any support/matrix/certification status** (per the
   plan's Metis a5 finding) — `docs/MODEM-SUPPORT-MATRIX.md` stays unchanged until the unit
   clears the SAME per-SKU certification ladder every other USB modem does (a real `certify`
   bundle, `synthetic:false` for the exact SKU+firmware).

### Branch-A STOP closed — adapter-mediated bench observation (2026-08-17)

The human clarification was: **"It is being connected through an adapter M2 to USB."** The
bench FM350 is mounted through an M.2-to-USB carrier/adapter, whose USB identity is interposed
in front of the module. Therefore Citation 6 remains accurate evidence of what this bench
observed (`0e8d:7127`, `rndis_host` + `option`), but it is an adapter artifact and is not
evidence that the FM350 has a native USB mode. A production board seats the FM350 in a real
M.2 PCIe slot, so the ModemManager source-audit conclusion for the shipping topology remains
correct and unchanged.

Decision: **no classifier change**. This is deliberate: no classifier code, branch, type, or
fixture is added, and no CeraUI classifier is touched. The three-gate ledger remains exactly
as todo 65 left it — gate 1 **CLEARED**, gate 2 **OPEN**, and gate 3 **OPEN** — and the
FM350's **documented-deferred** PCIe conclusion remains unchanged. Consistent with the
existing rule, USB enumeration alone does not promote support, matrix, or certification
status. This note closes the Branch-A human-decision-required STOP; it does not retract or
rewrite Citation 6.

### Non-mutating composition capture, 2026-08-18 — decision UNCHANGED

A read-only capture pass re-verified the carrier-mounted unit on the same board and added
the first **AT-level** evidence for it. Full record:
[`COMPOSITION-EVIDENCE.md`](COMPOSITION-EVIDENCE.md).

| Query | Response |
|-------|----------|
| `AT+CGMR` | `81600.0000.00.19.17.10` (matches `mmcli`'s `modem.generic.revision`) |
| `AT+GTPKGVER?` | `81600.0000.00.19.17.10_5001.0000.030.000.026_B77` |
| `AT+GTUSBMODE?` | `41` |
| `AT+GTUSBMODE=?` | `(40,41)` |

Only bare-execute, READ (`?`), and TEST (`=?`) forms were sent; **no SET form**, and the
unit's `0e8d:7127` identity was read from sysfs before and after and was unchanged.

**Nothing in this record changes.** Specifically:

- **No USB classifier entry is added for `0e8d:7127`.** The Branch-A STOP closure above
  stands: the id belongs to the M.2→USB carrier, not to a native FM350 USB personality.
- **The three-gate ledger is untouched** — gate 1 CLEARED, gates 2 and 3 OPEN. Reading a
  mode register is not an end-to-end HIL pass, and the unit still has no SIM.
- **`docs/MODEM-SUPPORT-MATRIX.md` is unchanged.** Per the standing rule, USB enumeration —
  and now an AT read-back — promotes no support, matrix, or certification status.
- **No mode control is offered for the FM350 in any topology.** The `(40,41)` domain
  corroborates the kernel-sourced `AT+GTUSBMODE=40/41` research, but which value maps to
  which composition, and whether a change persists or is recoverable, remains unproven and
  was deliberately not tested.

### Branch B — PCIe-only observed (`14c3:4d75` on the PCI bus, `mtk_t7xx` driver bound, no USB VID:PID)

This CONFIRMS the mechanical rule's already-fired branch 3 (documented-deferred) with real
hardware evidence for the first time — the deferral decision itself does not change; it moves
from "source-verified" to "source-verified AND bench-confirmed."

1. Record the exact `[PCI vendor:device]`, `[wwan interface name]`, and `[mtk_t7xx module
   version/load status]` as a new Citation 6 here, with the RB-16 evidence bundle path
   `[test-results/modem-phase-b/09/...]`.
2. Ledger update: gate 2 (kernel) → `CLEARED`, basis = "`mtk_t7xx` observed bound and
   enumerating the module over PCIe on bench `[board id]`, RB-16 evidence `[path]`." Gate 3
   (HIL) → `CLEARED` only if the RB-16 bearer/data-session smoke (step 5) also succeeded end to
   end; otherwise gate 3 stays `OPEN` with the partial evidence noted explicitly (kernel-level
   PCIe enumeration alone is not an end-to-end HIL pass).
3. **No classifier entry is added** — the FM350 remains correctly out of scope for the
   USB-only classifier (see "No USB classifier entry — and why" below); PCIe modems are modeled
   elsewhere per "If this is revisited."
4. `docs/MODEM-SUPPORT-MATRIX.md` is NOT updated by this alone — gate closure is a prerequisite
   for a future support decision, not the decision itself.

### If the unit is still not connected

No branch fires. Append to "Bench probe evidence" above (date, board, what was swept, zero
matches) and leave the ledger untouched — this is the honest, expected outcome until physical
FM350 hardware exists on a reachable bench.

## No USB classifier entry — and why

**No USB classifier entry exists or is added for the FM350.** `control/src/backend/device-classifier.ts`
is, by its own top-of-file docstring, a **USB-only** model: its whole input is a
`UsbDeviceSnapshot` (a udev/sysfs view of a **USB** device — `vendorId`/`productId` are USB
identifiers), and it classifies into exactly four classes:
`mm-managed` / `router-mode` / `unmanaged` / `pending-modeswitch`.

The FM350 is a **PCIe** device with **no** USB VID:PID (Citations 1-4). Representing a PCI
`vendor:device` pair as a pseudo-USB identity in the USB-only classifier would be a
fabrication — it would violate the classifier's own honesty rule (an ambiguous or
unrecognized descriptor set must return `unmanaged` with a truthful reason, never a
confident-sounding wrong class). Therefore:

- No classifier entry, branch, type, or fixture is added for the FM350.
- The classifier's four classes are unchanged. There is **no** fifth "deferred" class and
  none is added — "deferred" is the status of *this decision record*, never a device class.
- If a mis-fed FM350-shaped descriptor were ever handed to the USB-only classifier, the
  correct, truthful result is `unmanaged` (an unrecognized device), with no mode-switch
  recommendation. That behavior is exercised by the negative-drill test whose output is
  captured as QA evidence under `test-results/upstream-currency/2.5/` (the
  unmanaged-classification proof).

A doc comment in `device-classifier.ts` cross-references this record so future readers
understand why PCIe modems like the FM350 are intentionally out of the USB-only model.

## If this is revisited

Enabling the FM350 is a **future decision**, not a code change to make here. It would begin
by closing gate 2 (target-kernel `mtk_t7xx` PCIe enumeration) and gate 3 (a real HIL run),
and would live wherever PCIe/`wwan`-subsystem modems are modeled — **not** as a pseudo-USB
entry in this USB-only classifier.
