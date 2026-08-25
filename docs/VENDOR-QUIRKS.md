# Vendor quirks — a sourced reading list, not a support matrix

This document records the per-vendor behaviours that make one cellular module behave
differently from another on Linux, **with a citation for every claim**. It exists so that
the next person to write a provider, a classifier row, or a compatibility matrix starts
from evidence instead of from folklore.

It is deliberately NOT a support matrix. Nothing here says CeraLive works with a device.

## How to read the "posture" column

Every row carries a CeraLive posture drawn from the five-state support-claim ladder in
[`control/src/capability/support-claim.ts`](../control/src/capability/support-claim.ts):

```
unavailable → implemented → enabled → capable → certified
```

**No row in this document may sit above `implemented`, and none does.** `capable` requires
a live probe against a specific modem; `certified` requires a proven drill on an exact
model and firmware. A document cannot produce either — only hardware can, and only through
the per-SKU capture runbooks in [`BENCH.md`](BENCH.md). Reading a quirk write-up is not
evidence about a device, so a doc that promoted itself past `implemented` would be
manufacturing exactly the false confidence the ladder exists to prevent.

The two rungs that appear below mean:

- **`unavailable`** — CeraLive ships no code for this at all. That is the honest answer for
  every vendor-specific AT surface named here; the vendor's own behaviour is documented so
  a future change starts from a source, not so anything is claimed today.
- **`implemented`** — code exists in this repository, gate OFF, unproven on the device.

## The one rule that governs this whole file

**Nothing here is on a write path, and nothing here may be put on one.**

A quirk is a description of how somebody else's firmware behaves. Turning a description
into an automatic corrective action means writing to a radio on the strength of a document,
which is precisely what the evidence gates in
[`CATALOG-INGESTION.md`](CATALOG-INGESTION.md) and
[`control/src/band/certification.ts`](../control/src/band/certification.ts) refuse. A row
below may inform a classifier LABEL, a diagnostic READ, or a doc. It may never select an AT
command, a QMI/MBIM write, a composition switch, or a band lock.

## Sources, pinned

| Key | Source | Pin |
|-----|--------|-----|
| MM | ModemManager `src/plugins/` — [gitlab.freedesktop.org/mobile-broadband/ModemManager](https://gitlab.freedesktop.org/mobile-broadband/ModemManager/-/tree/1.24.2/src/plugins) | tag `1.24.2` (the release [`packaging/upstream-pins.yaml`](../packaging/upstream-pins.yaml) rebuilds) |
| KERNEL | Linux `drivers/net/usb/qmi_wwan.c`, `drivers/usb/serial/option.c` — [github.com/torvalds/linux](https://github.com/torvalds/linux/blob/master/drivers/net/usb/qmi_wwan.c) | `45c13f3f9e3bb15fd89ff2864c6f627a3b4b4229` |
| USBIDS | The USB ID Repository — [linux-usb.org/usb.ids](http://www.linux-usb.org/usb.ids) | version `2026.06.26` |
| UQMI | OpenWrt `uqmi` protocol handler `qmi.sh` — [github.com/openwrt/openwrt](https://github.com/openwrt/openwrt/blob/main/package/network/utils/uqmi/files/lib/netifd/proto/qmi.sh) | branch `main` |
| MODESWITCH | `usb-modeswitch-data` device data — upstream [draisberghof.de/usb_modeswitch](https://www.draisberghof.de/usb_modeswitch/), file listing read from the [Distrotech mirror](https://github.com/Distrotech/usb-modeswitch-data/tree/master/usb_modeswitch.d) | 297 device files |
| BELABOX | BELABOX tutorial wiki — [Peripherals & modems](https://github.com/BELABOX/tutorial/wiki/Peripherals,-accessories-and-power-banks), [M.2 initial setup](https://github.com/BELABOX/tutorial/wiki/Initial-setup-steps-for-various-M.2-modem-module-models), [README](https://github.com/BELABOX/tutorial) | wiki head |

---

## Quectel (`2c7c`)

| Quirk | Evidence | Posture |
|---|---|---|
| **QMI data format is raw-IP, not 802.3, on modern modules.** The bearer will not carry traffic until the driver is told, and the switch is a `/sys` write on the netdev, not a QMI message. | UQMI — `qmi.sh` writes `Y` to `/sys/class/net/$ifname/qmi/raw_ip` and fails with `"Device only supports raw-ip mode but is missing this required driver attribute"` when the attribute is absent. | `implemented` — the device path is NetworkManager's; CeraLive owns no data-format write. |
| **AT is tunnelled over MBIM, through the firmware-update service.** On an MBIM composition there is no separate AT tty; MM reaches AT by wrapping it in a Quectel vendor CID. | MM — `quectel/mm-port-mbim-quectel.c` sends `MBIM_QUECTEL_COMMAND_TYPE_AT` inside `MBIM_SERVICE_QDU` / `MBIM_CID_QDU_COMMAND`, and probes `mm_port_mbim_supports_command` first. Copyright Quectel, 2024. | `unavailable` — CeraLive sends no AT over MBIM. |
| **Port roles are per-PID, not per-vendor.** Which `ttyUSB` is AT, which is GPS and which is QCDM differs between an EG06 and an EG91; MM ships a udev rule per product id. | MM — `quectel/77-mm-quectel-port-types.rules` enumerates `ATTRS{idProduct}` one model at a time (`0306`, `0191`, …), never a vendor-wide default. | `implemented` — this is why `CELLULAR_USB_MODEL_ROWS` is keyed on exact VID:PID. |
| **`+QNWPREFCFG` is a vendor AT command ModemManager does not implement.** The 5G SA/NSA preference operators look for is not reachable through MM's D-Bus surface on a Quectel. | MM — grep of all six `quectel/*.c` plugin files at `1.24.2` returns zero occurrences of `QNWPREFCFG`; the plugin's AT vocabulary is `+QGMR?`, `+QGPS*`, `+QUSIM`. | `unavailable` — matches the `not-exposed-by-modemmanager` reason `capability/five-g-preference.ts` already reports. |
| **QMI stalls and MBIM MTU lockups are reported by operators, not by a pinned source.** | BELABOX — RM520N-GL/RM530N-GL rows note instability on USB 2.0/3.0 ports with some carrier boards and a dependence on the SBC's current supply. No upstream source pins a QMI-stall or MBIM-MTU defect. | `unavailable` — recorded as an operator report, deliberately NOT as a device claim. |

## Sierra Wireless (`1199`, plus HP `03f0` and Dell `413c`)

| Quirk | Evidence | Posture |
|---|---|---|
| **FCC lock: the radio stays disabled until an unlock procedure runs, and it is keyed per `<vid>:<pid>`.** OEM rebrands are separate keys, so covering `1199` alone misses two thirds of the fleet. | MM — `data/dispatcher-fcc-unlock/meson.build` at `1.24.2` names exactly `03f0:4e1d`, `1199:9079`, `413c:81a3`, `413c:81a8` for the Sierra script. Mirrored in [`control/src/fcc/coverage.ts`](../control/src/fcc/coverage.ts). | `implemented` — CeraLive records an opt-in policy and re-derives MM's own symlink. It ships no unlock script; see [`FCC-UNLOCK-COVERAGE.md`](FCC-UNLOCK-COVERAGE.md). |
| **`AT!`-prefixed commands (`AT!BAND`, `AT!ENTERCND`) are a password-gated vendor surface.** | MM — the `sierra` plugin is a first-class plugin at `1.24.2`. `providers/ufi-himi`'s static gate scans for `AT!` as a FORBIDDEN construct, but its scope is that provider's directory, not the repository. | `unavailable` — for this password-gated surface: no `AT!BAND` or `AT!ENTERCND` form exists anywhere in this repository. It is NOT a repo-wide absence of `AT!` — `usb-mode/runtime-capability.ts` carries Sierra's reviewed `AT!USBCOMP?` / `AT!USBCOMP=?` / `AT!USBCOMP=` composition forms, allowlisted by name and fenced like every other composition write. |
| EM7455/EM7565 are the widely-deployed bonding-rig parts. | BELABOX — EM7455 (a.k.a. Dell DW5811e) and EM7565 are listed as working on RK3588 and Jetson. | `unavailable` — no CeraLive hardware drill has run; [`BENCH.md`](BENCH.md) RB-18 is a recorded `device-not-present` skip. |

## Fibocom (`2cb7`)

| Quirk | Evidence | Posture |
|---|---|---|
| **AT-over-MBIM again — with an upstream kill switch.** MM tunnels AT through a Fibocom vendor CID, and ships a udev opt-OUT because it does not work on every unit. | MM — `fibocom/mm-port-mbim-fibocom.c` uses `MBIM_SERVICE_FIBOCOM` / `MBIM_CID_FIBOCOM_AT_COMMAND` and bails when `ID_MM_FIBOCOM_AT_OVER_MBIM_DISABLED` is set. | `unavailable` — CeraLive sends no AT over MBIM. |
| **Some SKUs need a dedicated ECM bearer path rather than the generic one.** | MM — `fibocom/mm-broadband-bearer-fibocom-ecm.c` exists as its own bearer subclass and drives `+GTRNDIS?`. | `implemented` — CeraLive's bearer authority is the NetworkManager adapter; it has no vendor bearer subclass. |
| **Composition drifts with firmware, and one part is PCIe rather than USB.** The FM350-GL has no USB VID:PID at all. | Repo — [`FM350-DECISION.md`](FM350-DECISION.md) records PCI `14c3:4d75` under `mtk_t7xx`; BELABOX lists FM350-GL as experimental and RK3588-only. | `unavailable` — documented-deferred; it gets no classifier row on purpose. |

## SIMCom (`1e0e`)

| Quirk | Evidence | Posture |
|---|---|---|
| **SIM hot-swap is claimed by the plugin, so SIM state can recover without a replug.** | MM — `simtech/mm-broadband-modem-qmi-simtech.c` sets `MM_IFACE_MODEM_SIM_HOT_SWAP_SUPPORTED, TRUE`. | `implemented` — CeraLive reads SIM presence as evidence only; `absent` is reachable through one evidence kind and never inferred from a blank object path. |
| **Coverage is uneven between the AT and QMI halves of the plugin.** The QMI modem is a separate, much smaller subclass than the generic one. | MM — `simtech/` ships `mm-broadband-modem-simtech.c` alongside a distinct `mm-broadband-modem-qmi-simtech.c`; the QMI subclass is ~6 kB against a far larger shared/AT implementation. | `implemented` — CeraLive's provider is generic and runtime-discovered; it makes no SIMCom-specific claim. |
| **A Zero-CD personality exists for at least one SIMCom id.** | MODESWITCH — exactly one `1e0e:*` device file (`1e0e:f000`). | `implemented` — the generic `pending-modeswitch` class covers it; no per-vendor rule. |
| Its USB-mode command (`AT+CUSBPIDSWITCH`) was captured non-mutatingly on the bench and its PID→composition mapping is unproven. | Repo — [`COMPOSITION-EVIDENCE.md`](COMPOSITION-EVIDENCE.md). | `unavailable` — target modes stay UNCERTIFIED and hidden. |

## Telit (`1bc7`)

| Quirk | Evidence | Posture |
|---|---|---|
| **Band selection is `AT#BND`, and its argument arity changes with the generation.** A 2G-only part takes one field, a 4G part takes three or four, and the 4G mask has a second extended-mask spelling. | MM — `telit/mm-modem-helpers-telit.c` builds nine distinct `#BND=` forms (`#BND=%d`, `#BND=0,%…`, `#BND=0,0,%…x,%…x`, …) and parses both the `AT#BND=?` range reply and the `AT#BND?` current reply. | `unavailable` — CeraLive's band writes go through ModemManager's generic `SetCurrentBands` and are additionally refused until a four-proof catalog entry exists; the catalog ships EMPTY. |
| **One family occupies many application PIDs, one per composition.** FN990A alone is `1070` rmnet / `1071` MBIM / `1072` RNDIS / `1073` ECM. Reading the family from the PID therefore requires the exact PID. | KERNEL — `option.c` names each variant explicitly; `qmi_wwan.c` carries the rmnet ones with `QMI_QUIRK_SET_DTR`. | `implemented` — ten exact Telit rows added to `CELLULAR_USB_MODEL_ROWS`, all `mainline-kernel`. |
| **`QMI_QUIRK_SET_DTR` is a real per-device driver quirk**, not a formality: those PIDs need DTR asserted before the QMI control channel behaves. | KERNEL — the macro is used for `1bc7:1031`, `1034`, `1040`, `1050`, `1060`, `1070`, `1080`, `10a0`, `1200`+ and not for the `QMI_FIXED_INTF` entries (`1100`, `1101`, `1200`). | `implemented` — recorded so the classifier row's tier is checkable; CeraLive performs no DTR handling. |
| **No Zero-CD entry exists for Telit.** A Telit module enumerates in its application composition directly. | MODESWITCH — zero `1bc7:*` device files. | `implemented` — no modeswitch rule is needed, and none is shipped. |
| IPv6 bearer cleanup is an operator-reported rough edge. | No pinned source found. | `unavailable` — stated as unsourced and therefore claimed as nothing. |

## u-blox (`1546`)

| Quirk | Evidence | Posture |
|---|---|---|
| **There are TWO band-configuration commands and which one works is per-model.** MM preloads a per-model support config and picks `+UBANDSEL?` or `+UACT?`; a model supporting neither gets an explicit "loading current bands is unsupported" error. | MM — `ublox/mm-broadband-modem-ublox.c` `preload_support_config` / `load_current_bands`. | `unavailable` — CeraLive issues neither command. |
| **Applying a band change may require dropping to low-power mode or explicitly unregistering.** MM models this as a per-model `SETTINGS_UPDATE_METHOD_CFUN` / `SETTINGS_UPDATE_METHOD_COPS` / `UNKNOWN`. | MM — same file, `preload_support_config`'s `support_config.method` switch. | `unavailable` — this is precisely the "a band lock can strand a radio" hazard behind CeraLive's four-proof certification gate. |
| **`1546` is a MIXED vendor id.** It carries u-blox GNSS receivers (Antaris 4, u-blox 5/6/7/8) as well as cellular modules. | USBIDS — the `1546` block lists `01a4`–`01a8` GNSS parts beside `1102` LISA-U2. | `implemented` — six exact LARA-R6/LARA-L6 rows added. The vendor id remains in `CELLULAR_USB_VENDOR_IDS` as inherited behaviour; treat a vendor-only match there as WEAK evidence. |
| **No Zero-CD entry exists for u-blox.** | MODESWITCH — zero `1546:*` device files. | `implemented` — none shipped. |

## NETGEAR (`0846`) — a router/WebUI family

| Quirk | Evidence | Posture |
|---|---|---|
| **ModemManager ships no NETGEAR plugin.** There is no vendor plugin to bind, so there is no MM-managed control surface to expect. | MM — the `src/plugins/` tree at `1.24.2` contains 39 vendor plugins; NETGEAR is not among them. | `implemented` — the classifier labels the family `router-webui` and nothing more. |
| **No kernel modem driver claims `0846:68e1` (LB1120).** It is absent from both `qmi_wwan.c` and `option.c`, so it comes up as a plain Ethernet-over-USB tether. | KERNEL + USBIDS — `0846:68e1  LB1120-100NAS` is in `usb.ids`; grep of both driver tables returns nothing for it. | `implemented` — one exact row, tier `usb-ids-registry`, `familyKind: 'router-webui'`. |
| **`0846` is a MIXED vendor id, and heavily so.** Its `usb.ids` block is dominated by Wi-Fi (`9050`–`9055`, `4110`–`4301`, …) and Ethernet (`1001`, `1040`) adapters; `68e1` is the only cellular entry. | USBIDS — the `0846` block. | `implemented` — `0846` is deliberately **absent** from `CELLULAR_USB_VENDOR_IDS`. A vendor-keyed rule would report a Wi-Fi dongle as a cellular uplink. |
| Two NETGEAR AirCard ids DO appear in `qmi_wwan.c` (`0846:68a2`, `0846:68d3` "Aircard 779S"). | KERNEL — `qmi_wwan.c`. | `unavailable` — a different family from the router/WebUI one this section covers; no row is added for them here. Note `68a2` is reused across four unrelated vendor ids in the same table, which is why a PID is never a key on its own. |

## Huawei (`12d1`) and ZTE (`19d2`) — Zero-CD and HiLink

| Quirk | Evidence | Posture |
|---|---|---|
| **Zero-CD: the device enumerates as a CD-ROM first and must be mode-switched.** The switch is a SCSI command sequence, per device, and the target PID differs from the installer PID. | MODESWITCH — 38 `12d1:*` and 45 `19d2:*` device files. `12d1:1f01` carries `TargetProduct= 0x14db`, a 31-byte `MessageContent`, and `NoDriverLoading=1`. | `implemented` — `classifyDevice` returns `pending-modeswitch` as a DISTINCT class, never folded into `unmanaged`. |
| **HiLink is a firmware personality, not a mode switch.** A HiLink stick presents CDC-ECM plus a web UI and has no modem control port at all; no amount of `usb_modeswitch` produces one. | Repo — [`HUAWEI-HILINK-PROVIDER.md`](HUAWEI-HILINK-PROVIDER.md); the classifier's `HILINK_ECM` fixture is `12d1:14db` with `cdc_ether` only. | `implemented` — a dedicated read/limited-write HTTP provider for two exact E3372H firmwares, gate off. |
| **Several Huawei models present the SAME MAC address**, which breaks per-interface configuration that keys on it. | BELABOX — the tutorial README states `/etc/network/interfaces` "brings up all the modems even when they use the same MAC address (which is the case for several Huawei models), unlike NetworkManager". | `implemented` — CeraLive derives physical identity from serial → udev `ID_PATH` → bounded fallback, and `PhysicalModemId` REFUSES interface names and addresses by construction. |
| **ZTE authentication differs per firmware within one model.** MF79U alone has a base64 dialect and an `LD`-salted SHA-256 dialect under the same `LOGIN` verb. | Repo — [`MF79U-DIAGNOSIS.md`](MF79U-DIAGNOSIS.md) and `providers/zte-goform/`. | `implemented` — three evidence-selected profiles, one bounded attempt, no fallback between them. |

## Phone tethering — an interface, not a modem

| Quirk | Evidence | Posture |
|---|---|---|
| **A tethering phone exposes a network interface and nothing else.** There is no control port, no band surface, no SIM surface and no signal reading; the phone's own OS owns all of it. | KERNEL/classifier — an RNDIS or ECM/NCM data interface with no MBIM/QMI/AT control interface is exactly `classifyDevice`'s `router-mode` branch. | `implemented` — classified `router-mode` with an honest reason; no capability module is offered. |
| **Cellular-ness cannot be inferred from the descriptors.** A phone's RNDIS tether and a USB Ethernet dongle are the same shape on the wire. | Classifier — `classifyUsbNetDevice` requires POSITIVE cellular evidence (a known cellular vendor id, a modeswitch trigger, or a Zero-CD storage interface) before naming a tether `router-cellular`; absent that it is `wired-ethernet`. | `implemented` — and this is why the NETGEAR LB1120 currently reads `wired-ethernet`: honest, and a known gap rather than a guess. |

---

## What this document does NOT license

- It does not add a provider. No Telit, u-blox or NETGEAR provider exists in this
  repository, and none may be inferred from a row above.
- It does not certify anything. Certification comes from a captured bundle and a
  human-reviewed commit — [`CATALOG-INGESTION.md`](CATALOG-INGESTION.md).
- It does not authorize an AT command. The runtime AT allowlist is a closed set of exact
  READ/TEST forms in `control/src/usb-mode/`; adding to it is a separate, reviewed change
  with its own evidence.
