# UFI / HIMI supervised DIAG info probe — BENCH ONLY `[PARTIAL]`

**This procedure never runs on a production board, never runs unattended, and is not an
operation `@ceralive/modem-control` can perform.** The shipped `UfiHimiProvider` is
read-only over the HIMI HTTP API and has no DIAG code path at all — not a refused stub,
not a disabled branch. Everything below is done by a human, by hand, on a bench unit
whose loss would cost nothing.

No executable harness ships for this one, and that is deliberate: a script that opens a
DIAG channel IS the code path this provider exists to not have. The MF79U procedure has
`control/scripts/mf79u-diagnose.sh` because its subject is an ordinary HTTP login; this
one's subject is the channel that can rewrite a modem's persistent storage.

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
- `usbutils` installed. Nothing else is required for step 1, which is where most units
  will stop.
- The unit's admin password injected as **ephemeral bench input** for step 2 only:

  ```sh
  read -rsp 'UFI bench password: ' UFI_BENCH_PASSWORD; printf '\n'
  export UFI_BENCH_PASSWORD
  ```

  Never put it in a script, a transcript, an issue, or an evidence file, and `unset` it
  when the run ends. `control/src/providers/ufi-himi/credential-fence.test.ts` scans the
  repository for it and its base64/SHA-256 derivatives on every test run.

## Step 1 — confirm the descriptor, or stop

```sh
lsusb -d 05c6: -v 2>/dev/null |
  awk '/bInterfaceNumber|bInterfaceClass|bInterfaceSubClass|bInterfaceProtocol/'
```

Classify and record ONE of:

- `diag-not-present` — no interface reports class `ff`, subclass `ff`, protocol `30`.
  **Stop here.** There is nothing to probe, whatever the product id says.
- `diag-descriptor-confirmed` — such an interface exists; note its `bInterfaceNumber`.

## Step 2 — read the telemetry the provider itself uses

This is the READ that answers most questions, and it needs no DIAG at all:

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

Only the classification lines from steps 1–3 may be kept, under the gitignored
`test-results/`. No raw capture, no DIAG frame, no session token, no password, and no
IMSI/ICCID/IMEI. `unset UFI_BENCH_PASSWORD` before the shell is left.

## After the probe

A `diag-descriptor-confirmed` result changes what a supervised bench operator may attempt
by hand. It changes nothing about the product: `UFI_DIAG_PRODUCTION_ACCESS` is
`prohibited` unconditionally, and promoting this probe into a production operation is out
of scope permanently, not pending evidence.
