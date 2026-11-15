# HiMI U01 "4G UFI" sticks: field notes (bench, 2026-11-14/15)

> **Engineering bench record.** This is not user documentation. It records what a supervised
> bench investigation of two HiMI U01 sticks found. None of it is a `@ceralive/modem-control`
> operation: the UFI/HIMI provider stays read-only, and the prohibitions in its
> [contract](agents/ufi-himi-provider-todo-26-read-only-plus-the-qualcomm-pro.md) (firmware
> flashing, EDL automation, shell fallback, NV/EFS writes) are unchanged.

Two sticks were used, one per firmware (V1.0 and V2.0), on an RK3588 CeraLive bench device
under ModemManager and NetworkManager and later on a Linux workstation. Everything below was
observed on the bench unless it is marked **Unproven**. No IMEI, IMSI, ICCID, phone number,
address or password appears here; the raw evidence stays outside the repository.

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
| Bootloader  | Qualcomm LK. V1.0: locked (`fastboot oem device-info` reports unlocked false, tampered false). V2.0: **Unproven**, not measured                                            |
| Storage     | 3.9 GB eMMC, 30 GPT partitions                                                                                                                                             |

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

With the stick's own mobile data off, host data calls succeed; with it on, they fail.

Turning the stick's data off arms the SIM-switch watchdog described next.

## SIM-switch watchdog

With the stick's own data off, LTE detaches about every 70 s on both sticks. The host sees
`emm-detached` and NetworkManager reconnects about 10 s later with a new address (14
detaches across the two sticks in 18 minutes).

The components involved, from a static read of one stick's SystemUI and PhoneFeatures code,
matched to logcat on both sticks:

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
   (`mBroadcastSimRunable`), independent of the broadcast; the V1.0 stick's logcat showed
   SimDetector switching without it.

The SIM switch can only be disabled with root access on the stick. A verified procedure
exists in CeraLive's internal engineering notes; there is no user-level setting for it.

## Operational: QMI control-port hang

- About 3 minutes after a ModemManager restart, both sticks' QMI control ports began timing
  out, and ModemManager marked each modem invalid after 10 consecutive timeouts.
- Once, without any restart, one stick's QMI port hung roughly 20 minutes after it attached,
  while its Android stayed healthy (SIM READY, LTE registered).

A power cycle of only the affected stick's USB hub port recovered it. Each stick came back
as `05c6:9091` (no switch to router mode), registered and connected with an IPv4 address
within 26 to 32 s, and after the last pair of cycles there were no QMI timeouts for 5
minutes 13 seconds. A ModemManager restart drops every modem and preceded the first hang.
**Unproven:** the cause of the hang.

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
  <https://github.com/airecode/Flash-OpenWRT-to-HiMI-msm8916>.
- hung.dev handbook, "HiMI UFI 4G dongle Debian/OpenStick":
  <https://handbook.hung.dev/blog/himi-ufi-4g-dongle-debian-openstick/>.
- OpenStick project: <https://openstick.org/>; Basistiy installer:
  <https://github.com/Basistiy/openstick-installer>.
- bkerler/edl: <https://github.com/bkerler/edl>.
- bkerler/Loaders: <https://github.com/bkerler/Loaders>.

Both sticks keep their stock firmware; the OpenStick route (replacing it) was not used.
