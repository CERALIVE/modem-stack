# FM350 decision record — PCIe modem, documented-deferred

**Status:** documented-deferred. This repo does **not** implement Fibocom FM350 device
enablement, and adds **no** entry for it to the USB device classifier. The FM350 is a PCIe
device; the reasons and the future-decision gates are recorded below so the deferral is a
deliberate, evidence-backed choice rather than an oversight.

This is a **tracked** engineering decision record (committed to git), not a claim that the
FM350 works on any CeraLive device. Nothing here has been exercised on real hardware.

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

## Three-gate ledger

FM350 device enablement upstream requires three independent gates. This record is honest
about each: only gate 1 is verified in this repo; gates 2 and 3 are untested.

| # | Gate | Requirement | State | Basis |
|---|------|-------------|-------|-------|
| 1 | MM version floor | ModemManager **≥ 1.24.2** (the release carrying the mtk-plugin FM350 fixes) | **CLEARED** | This repo now ships ModemManager **1.24.2** — see `packaging/upstream-pins.yaml` (`sources.modemmanager.upstream_tag: "1.24.2"`). The version-floor gate is satisfied. |
| 2 | Kernel | The `mtk_t7xx` PCIe WWAN driver present and enumerating the module over PCIe on the target hardware | **OPEN** | Not validated on real bench hardware in this work. No target-kernel `mtk_t7xx` bring-up has been performed or observed. |
| 3 | HIL (hardware-in-the-loop) | A physical FM350 module probed end-to-end through the stack on a bench device | **OPEN** | No physical FM350 unit has been tested. There is no hardware evidence of any kind. |

Gate 1 being CLEARED does **not** imply the FM350 works — it only removes the upstream
version-floor obstacle. Gates 2 and 3 remain the blocking, hardware-gated unknowns, and are
deliberately left OPEN rather than assumed.

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

## Gate-ledger update template — fill in on the next bench run that captures real FM350 data

The mechanical rule above is unambiguous once real bus data exists. Whoever next runs RB-16
against a physically connected unit MUST resolve to exactly ONE of the two branches below, fill
in the bracketed evidence, and land it as the update to the three-gate ledger table — never
invent a third outcome, and never promote a matrix/certification claim from this probe alone.

### Branch A — USB VID:PID observed (`0e8d:7126` or `14c3:4d75` on the USB bus)

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
