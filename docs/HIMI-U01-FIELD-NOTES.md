# HiMI U01 "4G UFI" sticks: field notes (bench, 2026-11-14/15)

> **Internal engineering note.** This is not user documentation and is never published on
> docs.ceralive.tv. It records a supervised bench investigation of two HiMI U01 sticks and
> the manual, per-stick changes that made them usable as QMI modems. None of it is a
> `@ceralive/modem-control` operation: the UFI/HIMI provider stays read-only, and the
> prohibitions in its [contract](agents/ufi-himi-provider-todo-26-read-only-plus-the-qualcomm-pro.md)
> (firmware flashing, EDL automation, shell fallback, NV/EFS writes) are unchanged.

Two sticks were used, one per firmware (V1.0 and V2.0): first on an RK3588 CeraLive bench
device under ModemManager and NetworkManager, then on a Linux workstation for the root work.
Everything below was observed on the bench unless it is marked **Unproven**. No IMEI, IMSI,
ICCID, phone number, address or password appears here; the raw evidence stays outside the
repository.

## Identity

| Fact        | Value                                                                                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Device      | HiMI "4G UFI" USB stick: a small Android 4.4.4 system (`qcom/msm8916_32_512`, brand HiMI, model UFI, `userdebug`) on Qualcomm MSM8916                                      |
| Modem mode  | `05c6:9091`, USB manufacturer/product string `Android`                                                                                                                     |
| Router mode | `05c6:9024`, RNDIS plus ADB                                                                                                                                                |
| Firmware    | ModemManager revision `HIMI_U01_MODEM_V1.0` (2015 build) and `HIMI_U01_MODEM_V2.0` (2022 build)                                                                            |
| Interfaces  | `ff/ff/ff` (0, unbound), `ff/00/00` (1, unbound), `ff/ff/ff` (2, `qmi_wwan`), `ff/42/01` (3, ADB); the stick's `persist.sys.usb.config` is `diag,serial_smd,rmnet_bam,adb` |
| QMI         | raw-IP, no aggregation, autoconnect off; the LTE attach PDN is the carrier's internet APN                                                                                  |
| Android     | `ro.debuggable=1`, `ro.secure=1`, SELinux permissive, ADB shell uid 2000                                                                                                   |
| Bootloader  | Qualcomm LK, locked: `fastboot oem device-info` reports unlocked false, tampered false                                                                                     |
| Storage     | 3.9 GB eMMC, 30 GPT partitions                                                                                                                                             |

A DIAG download command sent to interface 0 was accepted (the stick then rebooted into
Android), so interface 0 does carry DIAG even though its descriptor is `ff/ff/ff`, not the
`ff/ff/30` that [UFI-DIAG-PROBE.md](UFI-DIAG-PROBE.md) requires. That rule is unchanged: it
governs what the product may conclude from a descriptor, and this was a supervised bench
action.

Signals that identify the stick and its two failure modes from data a host already has:

- `05c6:9091` with USB strings `Android`, an `ff/42/01` interface, and a firmware revision
  starting `HIMI_`.
- Stick's own data on: every call on the carrier APN ends with QMI `CallFailed`, verbose
  reason internal (2,201), while ModemManager shows the LTE attach bearer connected.
- Stick's own data off, watchdog active: verbose reason (3,1028) `emm-detached` every 60 to
  70 s, with the SIM briefly absent.

[BENCH.md](BENCH.md)'s owner field row (2026-10-05) records a completed stream with HIMI U01
in QMI mode. On this bench the same mode carried no data until the stick's own data was
turned off. **Unproven:** whether the field units had their own data off, or ran a firmware
that behaves differently.

## Data call: the stick's own Android holds the PDN

In modem mode the stick still runs its own router. Its Android has `mobile_data=1`, holds a
data call on `rmnet0` with a carrier address and its own default route, and runs `hostapd`,
`dnsmasq` and `himiwebserver`. That embedded call owns the PDN on the carrier's internet
APN, which is also the LTE attach PDN. Every host WDS Start Network on that APN is
therefore rejected inside the modem with `CallFailed` internal (2,201). A different APN
reaches the network and gets 3GPP cause 33 (requested service option not subscribed),
which fits the same picture. APN, authentication, IP family and ModemManager restarts do not
change the outcome.

The cause is proven by intervention with a control: once a stick booted with its own data
off, the unchanged NetworkManager profile connected and two of two pings went out through
the modem interface, on both sticks. In the same minute a stick whose own data was still on
failed with the same internal (2,201).

Fix, per stick:

```sh
adb shell settings put global mobile_data 0
# then power-cycle the stick: Android 4.4 reads mobile_data only at boot
```

Undo: `adb shell settings put global mobile_data 1`, then power-cycle the stick.

What did not work: `svc data disable` throws (the shell uid lacks `MODIFY_PHONE_STATE`); the
web admin has no working mobile-data switch (its handler is empty); `settings put` alone
has no runtime effect until the next boot.

Turning the stick's data off arms the SIM-switch watchdog described next.

## SIM-switch watchdog

With the stick's own data off, LTE detaches about every 70 s on both sticks. The host sees
`emm-detached` and NetworkManager reconnects about 10 s later with a new address (14
detaches across the two sticks in 18 minutes).

The chain, from a static read of the stick's SystemUI and PhoneFeatures code, matched to
logcat:

1. `com.android.systemui/.HimiMainService` watches the stick's own data state. When it is
   not CONNECTED, the SIM is ready and the PLMN is not the test PLMN 00101, it posts a
   runnable at +50 s that logs `Logcat start ....` and, 10 s later, broadcasts
   `android.intent.action.MO_SIM_SWITCH`. Only the stick's own data reaching CONNECTED
   cancels it.
2. `SimDetector` in `com.qualcomm.qti.phonefeature` (Qualcomm PhoneFeatures, patched by
   HiMI) receives the broadcast and runs `SimSwitchThread`, which toggles
   `/sys/class/leds/sim_hotplug` and `esimN_en`: a SIM power cycle. The SIM goes ABSENT,
   then READY, and LTE re-attaches.
3. SimDetector also starts the same switch from its own internal timer
   (`mBroadcastSimRunable`), independent of the broadcast: with HimiMainService disabled,
   logcat still showed SimDetector switching (V1.0 stick).

No setting gates it. `INTERNET_DETECT` (already 0) and `HIMI_USB_STATUS` are read only on the
connected path. The per-slot `mobile_data0=0` had no effect and was reverted;
`setprop persist.himi.sim.num 1` is denied by init; adbd answers `root:` with "password
error"; the vendor's setuid `tcpdump` drops root before writing.

**The trap: never disable HimiMainService.** On the V1.0 stick, with HimiMainService
disabled the stick dropped off USB and came back about every 70 to 75 s. With both
HimiMainService and PhoneFeatures disabled, logcat showed SystemUI starting from scratch on
every cycle and no SimDetector lines: a reboot loop. Re-enabling HimiMainService alone ended
it, and uptime grew past the threshold. **Unproven (mechanism):** HimiMainService carries
`HimiAliveThread`, `himialive` and "sn alive" strings and most likely feeds a hardware
alive-watchdog. The loop and its cure are observed; the watchdog itself was not read from
code.

**Minimal fix, proven on both sticks:** disable only PhoneFeatures, from a root shell (next
section), keep `mobile_data=0` and leave HimiMainService enabled.

```sh
pm disable com.qualcomm.qti.phonefeature
```

The disabled state lives in userdata, so it survives reboots on the stock boot image.

| Stick | Quiet window                                                          | Result                                                                                                    |
| ----- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| V1.0  | about 13 minutes of uptime (779 s, monotonic), 11-minute logcat watch | no reboot, no USB re-enumeration, SIM READY and LTE registered throughout; 0 of 1719 logcat lines matched |
| V2.0  | 10 minutes (uptime 41 to 642 s, monotonic)                            | the same; 0 of 1758 logcat lines matched                                                                  |

The logcat match covered `MO_SIM_SWITCH`, `SimSwitchThread`, `mBroadcastSimRunable`,
`SimDetector`, `CARDSTATE_ABSENT` and `NOT_READY`. No side effect of disabling PhoneFeatures
was seen in these windows; registration held. **Unproven:** behaviour beyond these
windows; any other PhoneFeatures function on this firmware (none was exercised); whether a
factory reset from the web admin, which would clear userdata, brings the watchdog back.

## Root without flashing: RAM-boot the stick's own boot

LK is locked, yet `fastboot boot` accepted a modified copy of the stick's own boot image, as
long as the image kept its Qualcomm device tree (QCDT). Per stick, using only that stick's
own backup:

1. Take the stick's own `boot` partition image (16 MiB) from its backup.
2. Unpack it and change `ro.secure=1` to `ro.secure=0` in the ramdisk's `default.prop`. That
   is the only content change; the kernel stays byte-identical.
3. Repack with identical header parameters and **append the original QCDT blob**, keeping
   `dt_size` (boot header offset 40; about 3.7 MB on these units). Recompute the header id
   with the same algorithm, checked first by reproducing the stock image's id, and verify the
   result with an unpack round-trip.
4. `adb reboot bootloader` (fastboot enumerates as `18d1:d00d`), then
   `fastboot boot <patched-boot-with-dt>.img`. adbd runs as uid 0 for that boot only.
5. As root: `pm disable com.qualcomm.qti.phonefeature`; confirm with `pm list packages -d`.
6. `adb reboot` into the untouched stock boot. Check `id` (uid 2000), `getprop ro.secure` (1)
   and that the package is still disabled.

An image without the QCDT is refused with `bootimage: incomplete or not signed`, both by
`fastboot boot` and after flashing. Despite the wording, the missing device tree was the
cause: the same image with the DT appended booted.

History, so nobody repeats it: on the V1.0 stick the first DT-less image was written to
`boot` over EDL, and LK refused it and stopped in fastboot. The DT-complete image was then
RAM-booted, and the original `boot` was written back from that root shell with `dd`; its
read-back SHA-256 matched the backup. The V2.0 stick's `boot` was never written, so the
no-flash route is proven end to end there. No other partition was written on either stick.

## EDL: hardware button only, one stick at a time

- Software EDL entry does not work on these units. `adb reboot edl` reboots to Android;
  `fastboot oem edl` and `reboot-edl` are unknown commands on the locked LK; DIAG download
  and DIAG-to-Sahara commands were accepted, but the stick came back as `05c6:9091` Android
  every time.
- Hardware entry works: hold the reset button while plugging the stick in, and it
  enumerates as `05c6:9008`.
- Firehose loader that worked: `007050e100000000_394a2e47cf830150_fhprg_peek.bin` from
  bkerler/Loaders `qualcomm/factory/msm8916` (SHA-256
  `53f193500c03248f0d671ab57bfe9ca8a42967e97f28403294b4b3f854075aca`). HWID `007050e1`
  with a zero PK hash: secure boot is not fused.
- Host access: stock systemd `70-uaccess.rules` gives a desktop user the ADB (`ff/42/01`)
  and fastboot (`ff/42/03`) interfaces but not `05c6:9008`. EDL needs a udev rule or
  elevated rights.
- **One stick at a time.** bkerler/edl (read at commit `1cda1a6`) connects to the first
  `05c6:9008` it finds. Its `--serial_number` filter exists only for `memorydump` and is
  rejected by `printgpt`, `rl`, `rf` and `w`, and `--portname` applies to serial transport
  only. With two sticks in EDL the target is nondeterministic, so unplug every other stick
  before any EDL read or write.

## Backups and undo

Before any change, per stick and with only that stick attached:

```sh
edl printgpt
edl rl <dir>/partitions --genxml   # every partition, plus the partition XML
edl rf <dir>/full-emmc.bin         # independent second read of the whole eMMC
edl reset                          # back to Android
```

Then verify every partition file byte-for-byte against its GPT slice of `full-emmc.bin`
(30 of 30 matched on both sticks) and write a SHA-256 manifest of the whole set. Keep it
private and outside every repository: `modem`, `modemst1`, `modemst2`, `fsg`, `fsc`, `sec`
and `persist` carry the stick's identity and RF calibration.

**Never restore one stick's image, or any of those partitions, onto another stick.** It
clones the IMEI and the calibration.

Undo of the kept changes, per stick:

- Watchdog fix: RAM-boot that stick's own patched image (previous section), run
  `pm enable com.qualcomm.qti.phonefeature`, then reboot. **Unproven** for this package:
  the same RAM-boot plus `pm enable` path was exercised once, to re-enable HimiMainService on
  the V1.0 stick, but never for PhoneFeatures.
- Alternative: rewrite that stick's own `userdata` from its backup over EDL, which also rolls
  back everything else in userdata to the backup time. **Unproven:** never done.
- Data fix: `adb shell settings put global mobile_data 1`, then power-cycle.

## Operational: QMI control-port hang

- About 3 minutes after a ModemManager restart, both sticks' QMI control ports began timing
  out, and ModemManager marked each modem invalid after 10 consecutive timeouts.
- Once, without any restart, one stick's QMI port hung roughly 20 minutes after it attached,
  while its Android stayed healthy (SIM READY, LTE registered).

Recovery: power-cycle only that stick's hub port.

```sh
uhubctl -l <hub> -p <port> -a cycle -d 3
```

Each stick came back as `05c6:9091` (no switch to router mode), registered and connected
with an IPv4 address within 26 to 32 s. After the last pair of cycles there were no QMI
timeouts for 5 minutes 13 seconds. Prefer this to a ModemManager restart, which drops every
modem and preceded the first hang. uhubctl also toggles the USB3 companion lane of the same
physical port, so anything attached there is cycled too. **Unproven:** the cause of the
hang.

## Security observations

- ADB is open over USB with no authorization prompt (shell uid 2000).
- The web admin (`himiwebserver`, port 8000, `POST /himiapi/json`) ships with a well-known
  factory default password.
- HimiMainService also runs vendor cloud threads (`RemoteCmdThread`, `RemoteWebThread`) and
  can silently install APKs from a vendor URL. These are active whenever the stick itself
  has internet: router mode, or modem mode with its own data on. **Unproven at runtime:**
  found by static reading; no traffic was captured.
- With its own data off, the stick's Android had no uplink (`rmnet0` down, no address).
  **Unproven:** whether its Wi-Fi hotspot stays up in that state; it was running in modem
  mode with data on.

Treat these sticks as untrusted network devices.

## Sources

Third-party references, used as background only; this bench reproduced only what is stated
above.

- airecode, "Flash OpenWrt to a HiMI MSM8916 4G USB Stick":
  <https://github.com/airecode/Flash-OpenWRT-to-HiMI-msm8916> (EDL through the reset
  button, secure boot not fused, back up first, never cross-restore
  `modemst1`/`modemst2`/`fsg`/`fsc`/`sec`/`persist`).
- hung.dev handbook, "HiMI UFI 4G dongle Debian/OpenStick":
  <https://handbook.hung.dev/blog/himi-ufi-4g-dongle-debian-openstick/> (EDL entry,
  `edl printgpt` / `rl` / `rf` backup with a double-read check).
- OpenStick project: <https://openstick.org/>; Basistiy installer:
  <https://github.com/Basistiy/openstick-installer>.
- bkerler/edl: <https://github.com/bkerler/edl>, read at commit
  `1cda1a616748d608667b2d13b73a28d3197ceb45`.
- bkerler/Loaders: <https://github.com/bkerler/Loaders>, `qualcomm/factory/msm8916`.

The OpenStick route (replacing the stick's firmware) was not used; both sticks keep their
stock firmware.
