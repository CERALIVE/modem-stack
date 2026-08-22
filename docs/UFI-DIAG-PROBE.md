# UFI / HIMI supervised DIAG info probe — BENCH ONLY `[PARTIAL]`

**This procedure never runs on a production board, never runs unattended, and is not an
operation `@ceralive/modem-control` can perform.** The shipped `UfiHimiProvider` is
read-only over the HIMI HTTP API and has no DIAG code path at all — not a refused stub,
not a disabled branch. Everything below is done by a human, by hand, on a bench unit
whose loss would cost nothing.

No executable harness ships for the DIAG half, and that is deliberate: a script that opens
a DIAG channel IS the code path this provider exists to not have. The MF79U procedure has
`control/scripts/mf79u-diagnose.sh` because its subject is an ordinary HTTP login; this
one's subject is the channel that can rewrite a modem's persistent storage.

The **descriptor capture** in step 0 below is the one part that does ship as a script
(`control/scripts/ufi-himi-capture.sh`), because its subject is the opposite: reading what
the device already told the kernel at enumeration time. It sends nothing to the DIAG
channel, holds no vendor command, and is scanned on every test run for the constructs one
would need — see [The capture tooling, and its fence](#the-capture-tooling-and-its-fence).

## What this probe may establish, and what it may not

It may establish exactly one fact: **whether a DIAG interface descriptor exists on this
unit, and whether it answers a read-only information request.**

It may not be used to read or write NV items, read or write EFS, read or write device
identity or RF calibration, flash firmware, enter or automate EDL, or re-bind a driver.
Those are the ids in `control/src/providers/ufi-himi/prohibitions.ts`; they are refused
with typed reasons by the provider and have no implementation anywhere.

## The `9091` trap — read this before starting

`05c6` is Qualcomm's generic vendor id and `05c6:9091` is a **firmware-chosen** product
id. It is routinely quoted as proof that DIAG is available. It is not: the product id is
picked by whoever built the firmware image and says nothing about which interfaces the
device exposes. `05c6:9024` is likewise evidence of a composition — RNDIS plus an ADB
interface — and not a permission; production never reaches this device over ADB, SSH,
telnet or DIAG under any circumstance.

Only an interface descriptor proves a DIAG channel. `classifyUfiDiagEvidence()` encodes
that rule, and answers `not-proven` / `product-id-is-not-evidence` for a bare product id.

## Preconditions

- A **bench** UFI/HIMI stick. Not a deployed board, not a board carrying a live stream.
- A second person, or an agreed stop-time, so the probe is supervised rather than
  open-ended.
- `usbutils` installed — it supplies both `lsusb` and `usb-devices`, and **the bench image
  ships neither by default** (`docs/BENCH.md` RB-9). Step 0 records a missing tool as
  `tool-unavailable` rather than as a missing device, but a bundle captured without it is
  missing the verbose descriptor half and is not a complete answer.
- `bash`, `sed`, `grep` and `find` — present on any Debian bench. `jq` and `curl` are
  needed only for the HIMI identity step, and `bun` is needed by nothing on the bench: the
  independent sweep in step 0's verification runs on a development machine.
- The unit's admin password injected as **ephemeral bench input** for step 0's HIMI
  identity half and for step 2 only:

  ```sh
  read -rsp 'UFI bench password: ' UFI_BENCH_PASSWORD; printf '\n'
  export UFI_BENCH_PASSWORD
  ```

  Never put it in a script, a transcript, an issue, or an evidence file, and `unset` it
  when the run ends. `control/src/providers/ufi-himi/credential-fence.test.ts` scans the
  repository for it and its base64/SHA-256 derivatives on every test run.

## Step 0 — capture the descriptor evidence bundle

This is the whole read, in one command, and it is the input every later step argues from.
Nothing in it contacts the DIAG channel.

```sh
UFI_USB_ID=05c6:9091 control/scripts/ufi-himi-capture.sh
```

It answers with exactly one of:

- `device-not-present` on stdout, a one-line explanation on stderr, **exit 3** — no
  bundle directory is created at all. A capture that cannot see the device does not leave
  a partial bundle behind for somebody to mistake for a finding.
- `capture-complete` on stdout followed by the bundle path, **exit 0**.
- `redaction-sweep-failed`, **exit 4** — an identifier survived redaction, so the staged
  bundle was destroyed instead of published. There is no flag to override this.

The bundle is written to `test-results/ufi-himi-descriptor/<vid>-<pid>-<stamp>/` (override
with `UFI_CAPTURE_DIR`), which is repo-local and gitignored. It is staged in a temporary
directory and moved into place as a unit, so the published path either holds a complete
bundle or does not exist.

| File | What it holds |
|------|---------------|
| `manifest.json` | schema version, USB id, capture time, host, kernel, matched sysfs devices, and a per-step status |
| `lsusb-verbose.txt` | `lsusb -v -d 05c6:` — the full configuration/interface/endpoint descriptors |
| `usb-devices.txt` | `usb-devices` — the same tree in the kernel's own per-interface `I:` form |
| `udev-properties.txt` | `udevadm info -q property` for the device **and** each interface |
| `driver-bindings.txt` | one line per interface: sysfs address, class triple, and the bound driver (or `unbound`) |
| `sys-composition.txt` | `/sys` device attributes plus each interface's attributes and its `net`/`tty` children |
| `himi-identity.json` | `getproduceinfo` + `getsysinfo` replies — present only when `UFI_BENCH_PASSWORD` was supplied |

**Per-step status is honest and is not a boolean.** `captured`, `empty`,
`tool-unavailable` (this host lacks the tool), `unreachable` (the device's HTTP API did
not answer), and `skipped-no-credential` (no password was supplied) are five different
facts. Folding them into an absent field would leave the next reader unable to tell a gap
from a finding.

**Redaction happens at capture time, and the bundle is swept before it is published.** Two
layers, mirroring `control/src/redact.ts`: a key-based layer masks the value of any field
whose name says what it holds (`iSerial`, `SerialNumber=`, `ID_SERIAL*`, `ID_NET_NAME_MAC`,
the sysfs `serial` attribute, and JSON keys containing `serial`/`imei`/`imsi`/`iccid`/
`msisdn`/`token`/`session`/`password`, plus exact `sn`/`esn`/`meid`/`simnumber`/`simid`),
and a shape-based backstop masks any MAC address and any run of 14 or more digits. An IMEI
and an IMSI are 15 digits and an ICCID is 19–20; nothing in a USB descriptor is 14 digits
long, so the backstop costs no descriptor fidelity. Interface numbers, class triples,
`bcdDevice`, driver names, product and manufacturer strings all survive verbatim — they
are the evidence.

The login reply is deliberately never written to the bundle: it carries the session
material, and a bundle is a thing that gets pasted into a review comment.

Verify the bundle independently before it leaves the bench, on a machine with `bun`:

```sh
bun run control/scripts/ufi-himi-evidence.ts <bundle-dir>   # prints sweep-clean, or exits 1
control/scripts/ufi-himi-capture.sh --sweep <bundle-dir>    # the script's own second check
```

Two checkers over one bundle is deliberate. They fail the capture when they disagree,
which is the safe direction.

## Step 1 — classify every interface, and record who claimed it

Read `driver-bindings.txt` and `lsusb-verbose.txt` together. **The descriptor triple says
what an interface IS; the driver binding says who took it on this kernel, on this board.
They are two facts and they are never merged** — an interface with a recognizable triple
and an `unbound` driver is a real and interesting finding, not a contradiction.

`classifyUfiInterfaceRole()` in `control/scripts/ufi-himi-evidence.ts` encodes the triple
half; `readUfiDriverBindings()` reads a whole `driver-bindings.txt` into one row per
interface.

| `bInterfaceClass` / `SubClass` / `Protocol` | Role | Typical claiming driver |
|---|---|---|
| `e0` / `01` / `03` | `rndis-control` — the RNDIS control channel | `rndis_host` |
| `0a` / any / any | `rndis-data` — CDC data, the RNDIS payload leg | `rndis_host` |
| `ff` / `42` / `01` | `adb-class` — Google's shell interface | usually `unbound` on a Linux host |
| `ff` / `ff` / `30` | `diag` — **the only proof of a DIAG channel** | usually `unbound` |
| `ff` / any other | `vendor-specific` | `qmi_wwan`, `option`, or `unbound` |
| `02` / `02` / any | `cdc-acm-control` | `cdc_acm` |
| `08` / any / any | `mass-storage` | `usb-storage` |
| anything else | `unclassified` | — |

`ff/ff/*` is a convention space, not a registry: Qualcomm firmware conventionally carries
QMI, NMEA and modem functions in it alongside DIAG's `30`. Which of those a given
`vendor-specific` interface actually is, this bundle does not say — the captured binding
says who claimed it, and nothing here guesses the rest.

**Two inferences are specifically forbidden, and both look reasonable.** Upstream Linux
matches `05c6:9091` interface 2 in `drivers/net/usb/qmi_wwan.c` under an annotation naming
an unrelated device, and QCSuper documents the same product id on a different device
again; `usb_modeswitch`'s device data carries no `9091` entry at all. So neither a kernel
driver table nor third-party tooling is evidence about the unit on this bench. Only the
descriptor answers, and only the captured binding says what this kernel did with it.

Then classify and record ONE of:

- `diag-not-present` — no interface reports class `ff`, subclass `ff`, protocol `30`.
  **Stop here.** There is nothing to probe, whatever the product id says.
- `diag-descriptor-confirmed` — such an interface exists; note its `bInterfaceNumber`.

## The capture tooling, and its fence

`control/scripts/ufi-himi-capture.sh` and `control/scripts/ufi-himi-evidence.ts` are
scanned on every test run by `control/scripts/ufi-himi-evidence.test.ts`, which fails the
build if either file contains a construct that could change the device's state — the
Zero-CD mode switcher, the Android property setter, a shell-transport invocation, an
emergency-download tool, a Sierra vendor command, an AT write form, or a QMI write. Every
detector has a non-vacuity control that trips it with a synthetic violation, so a broken
pattern fails the suite rather than passing it silently.

The same suite EXECUTES the script: it drives the redaction rules over a synthetic capture
carrying every identifier class, proves the sweep fires on that input before redaction and
finds nothing after, and proves that on a host with no matching device the script answers
`device-not-present` and writes no bundle. The redaction rules live in the script and only
in the script — the test runs them rather than re-expressing them, because a second copy
is a second thing to drift.

The HIMI half of the capture is limited to the same frozen vocabulary the shipped provider
is: one `login`, then `getproduceinfo` and `getsysinfo`. The test asserts every command
literal in both files is a member of `UFI_COMMANDS`, so a command outside the seven `get*`
reads plus `login` cannot appear here either.

## Step 2 — read the telemetry the provider itself uses

Step 0 already performs this read when `UFI_BENCH_PASSWORD` is set, and files the answer
as `himi-identity.json`. Do it by hand only when step 0 recorded `unreachable`, or when a
reply beyond `getproduceinfo` / `getsysinfo` is wanted. It needs no DIAG at all:

```sh
curl --interface usb0 --no-location -sS \
  -H 'Content-Type: application/json;charset=UTF-8' \
  -d "{\"cmdid\":\"login\",\"username\":\"admin\",\"password\":\"${UFI_BENCH_PASSWORD}\"}" \
  http://192.168.0.1/himiapi/json
```

Then re-issue with `"cmdid":"getsysinfo"` (and `getoverview`, `getallstatus`,
`getproduceinfo`) carrying the returned session in an `Authorization:` header. A
`{"reply":"SessionOut"}` means the session expired — record it and stop; do not retry the
login in a loop. **If this step answers what you came to find out, the probe is over.**

## Step 3 — the supervised read-only info request

Only with `diag-descriptor-confirmed`, only with the supervisor present, and only for an
**information** request — the command that asks the modem what it is, and writes nothing.

Before running anything, state out loud (or in the transcript) the exact command and why
it cannot write. Abort on any of these:

- the tool wants to enable a log mask, a packet filter, or any "capture" mode;
- the tool offers, or defaults to, an NV/EFS read-write session;
- the unit stops answering the HIMI HTTP API mid-probe;
- the supervisor is no longer watching.

Record ONE classification:

- `probe-read-only-ok` — the info request answered; note nothing but the classification.
- `probe-refused` — the channel exists but refused the request.
- `probe-aborted` — any abort condition above fired.

## Retention

Two different things, with two different rules.

**Step 0's bundle** lives under the gitignored `test-results/` and is retained whole. It
is redacted at capture time and swept before it is published, so it carries no serial, no
IMSI, no ICCID, no IMEI, no MAC and no session material — that is what makes it safe to
keep, quote in a review, or transcribe into a committed evidence document. Transcribing a
bundle into `docs/` follows the `COMPOSITION-EVIDENCE.md` precedent: the descriptors, the
driver bindings and the per-interface classification table go in; the bundle directory
itself stays repo-local.

**Steps 1–3** keep only their classification lines. No raw DIAG frame, no session token,
no password. `unset UFI_BENCH_PASSWORD` before the shell is left.

Nothing from either half may name the password or a derivative of it;
`control/src/providers/ufi-himi/credential-fence.test.ts` scans tracked and
intended-untracked files for it and its base64/SHA-256 forms on every test run.

## After the probe

A `diag-descriptor-confirmed` result changes what a supervised bench operator may attempt
by hand. It changes nothing about the product: `UFI_DIAG_PRODUCTION_ACCESS` is
`prohibited` unconditionally, and promoting this probe into a production operation is out
of scope permanently, not pending evidence.
