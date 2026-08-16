# Bench runbooks — modem-stack

Agent-executable runbooks for every **hardware-gated** claim in the modem stack. Each of
these paths needs a real modem, a real SIM, or real arm64 hardware, so none of them run in
CI. Every runbook below is therefore marked **`[PARTIAL]`** — the CI proxy that stands in
for it is green, but the on-hardware evidence has not been captured in this session because
no bench hardware exists here yet. A runbook flips to `[EXISTS]` only when its evidence
artifact under `test-results/modem-control/A6.3/` (repo-local, gitignored) is captured on a
real bench device and the machine-checkable assertion passes.

These are the Phase-A **iteration surface**. You run them against real modems on a bench
device to mature `@ceralive/modem-control`, feed findings back as issues, and cut the next
`0.x` release. Nothing here ships to a product; nothing here requires a human judgment call
— every gate is a machine-checkable expected line.

## Conventions

Every runbook has the same shape:

- **Preconditions** — what must be true before you start.
- **Commands** — copy-pasteable and **non-interactive**. Secrets are piped on `stdin`
  (never typed at a prompt), so the whole runbook can be driven by an agent or a script.
- **Expected output** — an exact line (or a `PASS`/`FAIL` from an inline assertion) that a
  machine can grep for. This is the pass/fail gate.
- **Evidence** — the repo-local path the captured output is written to. All evidence lives
  under `test-results/modem-control/A6.3/` (gitignored per Rule D); the CLI `[PARTIAL]`
  probe runbook from A6.1 keeps its original `A6.1/hil-system-bus.txt` path.

The compiled `modem-control` binary comes from `cli/smoke/build-binaries.sh`
(`cli/dist/modem-control-{amd64,arm64}`) or the release artifact set. On a bench device with
the packaged ModemManager stack installed it talks to the **system bus** by default; point
it elsewhere with `--bus-address` / `MODEM_CONTROL_BUS_ADDRESS`.

> **Non-interactivity note (runbook-lint contract).** `unlock-pin` / `unlock-puk` disable
> terminal echo when attached to a TTY, but read one line from `stdin` when they are not. So
> **every** step below — including PIN/PUK entry — is expressed as a non-interactive pipe
> (`printf '%s\n' "$PIN" | modem-control unlock-pin …`). No step waits on a human at a
> prompt; each ends in a greppable expected line. A runbook that reintroduces an interactive
> prompt (a bare `modem-control unlock-pin` on a TTY with no stdin redirect) is a
> runbook-lint failure.

---

## The Phase-A iteration loop

The bench is not a one-shot certification pass; it is a loop that drives the `0.x` line to
maturity:

```
   ┌──────────────────────────────────────────────────────────────────────┐
   │                                                                        │
   ▼                                                                        │
bench run ──▶ finding ──▶ issue ──▶ fix on integration branch ──▶ 0.x release ──┐
(runbook)    (a runbook   (notepad   (one PR, wave-ordered        (ONE tag       │
             gate fails    issues.md  coherent commits)            vX.Y.Z:       │
             OR a new      + GH issue)                             npm + debs)    │
             SKU appears)                                                         │
                                                                                 │
   matrix / catalog update ◀── certify bundle ◀────────────────────────────────┘
   (MODEM-SUPPORT-MATRIX.md    (modem-control certify <slot>
    recommended_usb_mode;       --transition <mode> → sha256 →
    certified-catalog.json      certified-catalog.json
    evidenceBundleSha256)       evidenceBundleSha256)
```

1. **Bench findings.** Run the runbooks below against a real device/SKU. A gate that fails,
   or a new SKU that a runbook surfaces (`probe` classifies it `unmanaged`, a transition
   postcondition mismatches, the usage meter drifts >5 %), is a finding.
2. **Issues.** Each finding becomes an entry in
   `.omo/notepads/modem-control-package/issues.md` and, when it needs code, a GitHub issue
   on `CERALIVE/modem-stack`. A finding never silently disappears — it is either fixed or
   recorded as a known limitation.
3. **Unified `0.x` releases.** Fixes land on the single Phase-A integration branch as
   wave-ordered coherent commits (one PR), then a **single** tag `vX.Y.Z` cuts **both**
   artifacts together — `@ceralive/modem-control@X.Y.Z` on npm and the ModemManager-stack
   `.deb` set (`…~ceraliveX.Y.Z`) + release manifest as CI artifacts. `0.x` allows breaking
   changes between minors while the API settles; see [`VERSIONING.md`](VERSIONING.md).
4. **Matrix / catalog updates.** A certified USB-mode transition (RB-5) produces a redacted
   evidence bundle whose `sha256` is recorded in a new `certified-catalog.json` entry's
   `evidenceBundleSha256`, and the SKU's confirmed `recommended_usb_mode` is written back to
   [`../docs/MODEM-SUPPORT-MATRIX.md`](../../docs/MODEM-SUPPORT-MATRIX.md). Certification is a
   human-reviewed commit adding a real entry — never an automated write.

The loop repeats for as many `0.x` releases as the hardware fleet needs. `1.0.0` is reserved
for Phase-B adoption.

---

## RB-1 — System-bus probe `[PARTIAL]`

The real on-device D-Bus probe: EXTERNAL-auth handshake on the system bus, one authoritative
`GetManagedObjects`, identity-ladder resolution, feature detection, and USB classification.
This is the on-hardware counterpart of A6.1's compiled cross-arch probe smoke (which runs in
CI against the fake MM on both arches). CLI reference: [`../cli/README.md`](../cli/README.md).

**Preconditions**

- Bench device with the packaged ModemManager 1.24 stack installed and running (RB-3).
- At least one modem enumerated by ModemManager.

**Commands**

```sh
# On the bench device, against the real system bus:
./modem-control probe | tee A6.1/hil-system-bus.txt
```

**Expected output** — the run ends with:

```
PROBE OK: external-auth, objects=<n>
```

where `<n>` ≥ 1 (modems + SIMs + bearers ModemManager reports). The ICCID must **not** appear
anywhere in the output — the subscription id is rendered `sim=[redacted]`.

**Machine check**

```sh
grep -Eq '^PROBE OK: external-auth, objects=[1-9][0-9]*$' A6.1/hil-system-bus.txt \
  && ! grep -Eq '[0-9]{18,22}' A6.1/hil-system-bus.txt \
  && echo "RB-1 PASS" || echo "RB-1 FAIL"
```

**Evidence:** `test-results/modem-control/A6.1/hil-system-bus.txt`

---

## RB-2 — Slot-UID stability across replug `[PARTIAL]`

Asserts that a modem's **`modem.generic.device`** (ModemManager's `Modem.Device` property,
the udev slot UID) is stable across a physical unplug/replug, so the A3.2 identity ladder
resolves the **same** stable key and the identity registry keeps **one** row (a `replugged`
transition, not `attached` + a phantom removal). This is the on-hardware proof of the
replug-keeps-one-row guarantee.

**Preconditions**

- One modem on a known port; you can physically unplug and replug it (or toggle a USB-hub
  port). `mmcli` from the packaged stack is on `PATH`.

**Commands**

```sh
mkdir -p A6.3
# Modem index (first modem):
M=$(mmcli -L 2>/dev/null | grep -oE '/Modem/[0-9]+' | head -1 | grep -oE '[0-9]+$')

# 1) Capture the slot UID BEFORE replug:
mmcli -m "$M" -K | grep '^modem.generic.device ' | tee A6.3/slot-uid-before.txt

# 2) Physically unplug the modem, wait for MM to drop it, replug, wait for re-enumeration.
#    (usb-hub port toggle is equivalent; give udev + MM time to settle.)
#    Then re-read the slot UID for the (possibly renumbered) modem on the SAME port:
M2=$(mmcli -L 2>/dev/null | grep -oE '/Modem/[0-9]+' | head -1 | grep -oE '[0-9]+$')
mmcli -m "$M2" -K | grep '^modem.generic.device ' | tee A6.3/slot-uid-after.txt

# 3) Cross-check via the identity ladder (the resolved logical slot must match too):
./modem-control probe | tee A6.3/slot-uid-probe.txt
```

**Expected output** — the `modem.generic.device` value is **identical** before and after,
even though the `/Modem/<n>` runtime path may change:

```
modem.generic.device : <slot-uid>        # before
modem.generic.device : <slot-uid>        # after  (same <slot-uid>)
```

**Machine check**

```sh
b=$(sed 's/.*: *//' A6.3/slot-uid-before.txt); a=$(sed 's/.*: *//' A6.3/slot-uid-after.txt)
[ -n "$b" ] && [ "$b" = "$a" ] && echo "RB-2 PASS (device=$b stable)" || echo "RB-2 FAIL (before=$b after=$a)"
```

> If `modem.generic.device` is a path-shaped default (`/sys/devices/…`) rather than a
> CeraLive `slot-*` UID, the ladder falls through to `physdev` / `sysfs-walk`; the stability
> assertion is still on `modem.generic.device`. The `slot-*` udev rule that makes the value a
> stable hand-labeled UID is Phase-B image-integration work (`78-mm-ceralive-slot-uid.rules`).

**Evidence:** `test-results/modem-control/A6.3/slot-uid-{before,after,probe}.txt`

---

## RB-3 — MM-1.24-from-artifacts install `[PARTIAL]`

Install the packaged ModemManager 1.24 stack on a clean bench device **from the release CI
artifacts** (Phase A does no apt publication) and prove the daemon comes up at 1.24.2. This
is the on-hardware counterpart of A5.2's daemon smoke (which runs in a `debian:bookworm`
container in CI).

**Preconditions**

- Clean Debian bookworm bench device (`arm64` for the shipping target; `amd64` acceptable
  for the desk proxy). `gh` authenticated, or the artifact zip already copied to the device.

**Commands**

```sh
mkdir -p A6.3 debs && cd debs
# Preferred: download the permanent latest-release GitHub Release assets (durable — never
# expires); v0.2.0 is the latest release at time of writing:
gh release download v0.2.0 --repo CERALIVE/modem-stack --dir . --clobber
# -> release-manifest.txt + all 54 .deb files, flat, arch encoded in the filename suffix
#    (..._amd64.deb / ..._arm64.deb).
#
# NOTE: GitHub Release upload sanitizes `~` to `.` in asset filenames (e.g.
# modemmanager_1.24.2-2~ceralive0.2.0_amd64.deb -> modemmanager_1.24.2-2.ceralive0.2.0_amd64.deb).
# This is cosmetic only — package content, embedded Debian version, and installability are
# unaffected (verified byte-identical via sha256 against release-manifest.txt). apt/dpkg read
# the version from the package's internal control data, not the filename.
#
# Fallback (time-limited — CI workflow-run artifact retention expires ~90 days after the
# release run): `gh run download --repo CERALIVE/modem-stack -n modem-stack-debs-0.2.0
# --dir .` — this variant nests debs under packaging/build/<arch>/*.deb instead of a flat dir;
# adjust the install glob below accordingly if you use this path instead of the Release.

ARCH=$(dpkg --print-architecture)            # arm64 on the shipping SBC
sudo apt-get update
# Post-bump every source outranks bookworm stock (see the note below), so installing the
# CeraLive set over stock is a pure upgrade — no `--allow-downgrades` needed:
sudo apt-get install -y ./*_"$ARCH".deb | tee ../A6.3/mm-install.txt
cd ..

# Bring the daemon up (or `systemctl restart ModemManager` on a systemd device):
sudo systemctl restart ModemManager 2>/dev/null || true
mmcli --version | tee A6.3/mm-version.txt
busctl introspect org.freedesktop.ModemManager1 /org/freedesktop/ModemManager1 \
  2>/dev/null | grep -i version | tee -a A6.3/mm-version.txt
```

**Expected output**

```
mmcli 1.24.2
```

and the coherence check: every installed stack package carries the same `~ceralive0.2.0`
suffix (per the release manifest).

**Machine check**

```sh
grep -q 'mmcli 1\.24\.2' A6.3/mm-version.txt \
  && awk -F'[ \t]+' 'NR>0 && /~ceralive0\.2\.0/{n++} END{exit !(n>=9)}' debs/release-manifest.txt \
  && echo "RB-3 PASS" || echo "RB-3 FAIL"
```

> **Direction (post-bump):** all four sources now sort **above** bookworm stock —
> ModemManager `1.24.2-2` > `1.20.4-1`, libmbim `1.34.0-1` > `1.28.2-1`, libqmi `1.38.0-1` >
> `1.32.2-1`, and — newly — libqrtr-glib `1.4.0-1` > `1.2.2-1`. libqrtr-glib **flipped** from
> below to above at this bump: pre-bump its `1.2.2-1~ceralive…` was tilde-lower than stock
> `1.2.2-1` and needed `--allow-downgrades`; the new `1.4.0-1` outranks stock outright. So the
> install above is a pure **upgrade** and needs **no** `--allow-downgrades` — only the reverse
> (rollback to stock) is a downgrade. Phase-B image integration replaces the artifact install
> with apt pin 990. (Empirically confirmed in `test-results/upstream-currency/1.3/`.)

**Evidence:** `test-results/modem-control/A6.3/{mm-install,mm-version}.txt`

---

## RB-4 — PIN/PUK on a real SIM `[PARTIAL]`

Unlock a **real** PIN-locked (and, for the PUK path, PUK-locked) SIM through the A3.3
read-before-submit, exactly-once mutation path. The secret is piped on `stdin` (non-echoing,
never printed back, never in any receipt reason).

**Preconditions**

- A modem with a **real, PIN-locked** SIM inserted. You know the correct PIN (and, for the
  PUK drill, the PUK + a new PIN). ⚠️ A wrong PIN spends a real retry; a wrong PUK can
  **permanently brick** the SIM — use a disposable test SIM.

**Commands**

```sh
mkdir -p A6.3
SLOT=Modem/0

# PIN unlock — non-interactive (PIN on stdin, echo disabled / not needed):
printf '%s\n' "$PIN" | ./modem-control unlock-pin "$SLOT" | tee A6.3/unlock-pin.txt

# PUK unlock (only when UnlockRequired == sim-puk) — PUK then new PIN on stdin:
printf '%s\n%s\n' "$PUK" "$NEWPIN" | ./modem-control unlock-puk "$SLOT" | tee A6.3/unlock-puk.txt
```

**Expected output** — the outcome line reports `unlocked` for a correct secret:

```
unlock-pin Modem/0: unlocked
```

For a wrong PIN the outcome is `incorrect-pin (retries left: <k>)`; when the SIM has fallen
to PUK it is `sim-puk-required`. In **no** case does the entered PIN/PUK appear in the
output.

**Machine check**

```sh
grep -q ': unlocked' A6.3/unlock-pin.txt \
  && ! grep -qF "$PIN" A6.3/unlock-pin.txt \
  && echo "RB-4 PASS" || echo "RB-4 FAIL"
```

**Evidence:** `test-results/modem-control/A6.3/unlock-{pin,puk}.txt`

---

## RB-5 — Certified USB-mode transition `[PARTIAL]`

Execute a certified, postcondition-verified USB composition-mode transition on a real SKU,
then capture the transition-evidence bundle whose `sha256` becomes the catalog entry's
`evidenceBundleSha256`. Only within-MM transitions (`qmi` / `mbim` / `ecm-ncm`) are
representable; MM↔router is schema-invalid by construction. The transition **only** succeeds
when the re-enumerated device's descriptors match the target mode — an AT `OK` alone is never
success.

**Preconditions**

- A real modem whose SKU is a **certified** entry in `certified-catalog.json` with a
  permitted transition `from → to`. `--confirm` is the operator gate; bench is a maintenance
  context.

**Commands**

```sh
mkdir -p A6.3
SLOT=Modem/0
TARGET=mbim        # one of qmi | mbim | ecm-ncm, permitted by the catalog entry

# 1) Run the transition (idempotent transaction; nm-quiesce → inhibit → AT → port-drop →
#    re-enumeration → POSTCONDITION → reactivate). --confirm is REQUIRED:
./modem-control set-usb-mode "$SLOT" "$TARGET" --confirm | tee A6.3/set-usb-mode.txt

# 2) Capture the redacted transition-evidence bundle (before/after descriptors, the executed
#    AT command, port-drop / re-enumeration timeline) for the catalog:
./modem-control certify "$SLOT" --transition "$TARGET" --output A6.3/transition-bundle.json \
  | tee A6.3/certify-transition.txt
```

**Expected output**

```
set-usb-mode: OK Modem/0 -> mbim on <newIfname>
steps: nm-quiesce -> inhibit -> at-command -> await-port-drop -> uninhibit -> await-reenumeration -> postcondition -> resolve-ifname -> reactivate -> release-interlock
```

and from `certify --transition`:

```
CERTIFY OK: sha256=<hash> synthetic=false transition=<from>-><to> slot=Modem/0
```

**Machine check**

```sh
grep -Eq "^set-usb-mode: OK $SLOT -> $TARGET on " A6.3/set-usb-mode.txt \
  && grep -Eq '^CERTIFY OK: sha256=[0-9a-f]{64} synthetic=false ' A6.3/certify-transition.txt \
  && echo "RB-5 PASS" || echo "RB-5 FAIL"
```

> The **negative** proof is already non-hardware: omitting `--confirm` prints
> `set-usb-mode: REFUSED (entry)` + `steps: (none — zero side effects)` and exits 1
> (covered by `cli/src/set-usb-mode.test.ts`). On the bench, run it once to confirm the
> zero-side-effect refusal before the real switch.

**Evidence:** `test-results/modem-control/A6.3/{set-usb-mode,certify-transition}.txt` +
`transition-bundle.json`

---

## RB-6 — Usage-meter accuracy (MACHINE-CHECKABLE) `[PARTIAL]`

The one runbook with a self-contained numeric pass/fail. Download a **known-size** payload
over the modem's own network interface, then assert the A4.3 usage sampler's reported delta
equals the kernel's own `/proc/net/dev` delta for that **same window**, within **±5 %**.

**The gate is meter-delta vs. kernel-delta only.** There is deliberately **no**
carrier-portal comparison in the executable gate — portal reconciliation is an optional
manual note (below), outside this runbook's pass/fail.

**Preconditions**

- A modem with data connectivity; you know its data interface name (`wwan0`, `ppp0`, …) —
  the `logicalSlotId ↔ ifname` mapping the sampler is fed. A fixed-size public payload URL.
- The modem interface carries the download (bind `curl --interface`), and it is the only
  significant traffic on that interface during the window (stop other consumers).

**Runbook (copy-paste; exits 0 on PASS, 1 on FAIL)**

```sh
#!/usr/bin/env bash
set -euo pipefail
mkdir -p A6.3

IFACE="${IFACE:-wwan0}"                              # the modem data interface
SLOT="${SLOT:-Modem/0}"                              # logical slot the sampler reports
URL="${URL:-https://speed.hetzner.de/100MB.bin}"     # a FIXED N-MB payload
N_BYTES="${N_BYTES:-104857600}"                      # 100 MiB — must match URL's real size

kernel_total() {  # rx+tx bytes for $IFACE from /proc/net/dev (rx=col1, tx=col9 after the ':')
  awk -v ifc="$IFACE" -F'[: ]+' '$1==ifc || $2==ifc {
    for (i=1;i<=NF;i++) if ($i==ifc){print $(i+1)+$(i+9); exit}}' /proc/net/dev
}
meter_bytes() {   # cycleBytes for $SLOT from the sampler snapshot
  ./modem-control usage | awk -v s="$SLOT" '
    $1 ~ (s"$")   { for (i=1;i<=NF;i++) if ($i ~ /^cycleBytes=/){sub(/cycleBytes=/,"",$i); print $i; exit} }
    index($0,s)>0 { for (i=1;i<=NF;i++) if ($i ~ /^cycleBytes=/){sub(/cycleBytes=/,"",$i); print $i; exit} }'
}

k0=$(kernel_total); m0=$(meter_bytes)
curl --interface "$IFACE" -s -o /dev/null "$URL"      # download the fixed payload over the modem
k1=$(kernel_total); m1=$(meter_bytes)

kd=$(( k1 - k0 )); md=$(( m1 - m0 ))
# PASS iff the meter delta is within ±5% of the KERNEL delta for the same window:
awk -v kd="$kd" -v md="$md" -v n="$N_BYTES" 'BEGIN{
  if (kd<=0){print "RB-6 FAIL: kernel delta non-positive ("kd")"; exit 1}
  err=(md-kd); if (err<0) err=-err; pct=100*err/kd;
  printf "RB-6 kernel_delta=%d meter_delta=%d payload=%d drift=%.2f%%\n", kd, md, n, pct;
  if (pct<=5.0){print "RB-6 PASS"; exit 0} else {print "RB-6 FAIL: drift >5%"; exit 1}
}' | tee A6.3/usage-accuracy.txt
```

**Expected output** — a `drift ≤ 5 %` line and `RB-6 PASS`:

```
RB-6 kernel_delta=104920000 meter_delta=104880000 payload=104857600 drift=0.04%
RB-6 PASS
```

(The kernel delta runs a little above the raw payload — TLS + framing overhead; the meter is
derived from the **same** counters so it tracks the kernel delta, which is what the gate
checks.)

**Evidence:** `test-results/modem-control/A6.3/usage-accuracy.txt`

**Optional manual note — carrier-portal reconciliation (OUTSIDE the gate).** As a
non-blocking sanity check you may, separately, compare the meter against the carrier's own
usage portal over a longer billing window. Portals lag, round, and count differently, so this
is **never** part of the pass/fail above — it is an advisory data point recorded in
`issues.md` if it diverges materially, not a runbook gate.

---

## RB-7 — arm64-on-real-hardware validation `[PARTIAL]`

CI builds the `.deb` stack and runs the compiled probe on arm64 under **QEMU** (A5.1 build,
A6.1 probe smoke). This runbook re-runs the two on a **real arm64 SBC** (e.g. Rock 5B+),
where JIT, real USB, and real timing differ from emulation.

**Preconditions**

- A real arm64 bench SBC with the RB-3 install completed and a modem attached.

**Commands**

```sh
mkdir -p A6.3
uname -m | tee A6.3/arm64-uname.txt                 # expect: aarch64
./modem-control probe | tee A6.3/arm64-probe.txt     # the shipped arm64 binary, native
mmcli --version | tee -a A6.3/arm64-probe.txt
```

**Expected output**

```
aarch64
PROBE OK: external-auth, objects=<n>
mmcli 1.24.2
```

**Machine check**

```sh
grep -q aarch64 A6.3/arm64-uname.txt \
  && grep -Eq '^PROBE OK: external-auth, objects=[1-9]' A6.3/arm64-probe.txt \
  && grep -q 'mmcli 1\.24\.2' A6.3/arm64-probe.txt \
  && echo "RB-7 PASS" || echo "RB-7 FAIL"
```

**Evidence:** `test-results/modem-control/A6.3/arm64-{uname,probe}.txt`

---

## RB-8 — Daemon smoke on real hardware `[PARTIAL]`

The full A5.2 daemon smoke (system D-Bus + polkit + NetworkManager 1.42, `busctl`
introspect, udev/FCC/GIR/Vala paths) re-run on a real device rather than the CI bookworm
container — the last check that the packaged stack is coherent end-to-end on hardware.

**Preconditions**

- RB-3 install completed on the bench device; NetworkManager present.

**Commands**

```sh
mkdir -p A6.3
{ busctl --system list | grep -i ModemManager1
  busctl introspect org.freedesktop.ModemManager1 /org/freedesktop/ModemManager1 | grep -i version
  ls /usr/lib/udev/rules.d/77-mm-*.rules
  ls /etc/ModemManager/fcc-unlock.d/ 2>/dev/null || true
  mmcli --version
} | tee A6.3/daemon-smoke.txt
```

**Expected output** — MM owns the bus name, reports version `1.24.2`, and the udev rules are
present:

```
org.freedesktop.ModemManager1 …
.Version property s "1.24.2" …
/usr/lib/udev/rules.d/77-mm-…rules
mmcli 1.24.2
```

**Machine check**

```sh
grep -q 'ModemManager1' A6.3/daemon-smoke.txt \
  && grep -q '"1\.24\.2"' A6.3/daemon-smoke.txt \
  && grep -q 'mmcli 1\.24\.2' A6.3/daemon-smoke.txt \
  && echo "RB-8 PASS" || echo "RB-8 FAIL"
```

**Evidence:** `test-results/modem-control/A6.3/daemon-smoke.txt`

---

## RB-9 — Fleet inventory capture `[PARTIAL]`

Capture a per-unit inventory bundle for every physical modem/dongle on the bench: raw USB
descriptor (VID:PID per port), USB `ID_PATH`, firmware string, personality (Stick vs HiLink;
router vs MM-managed), ModemManager detection, transport, hub port mapping, SIM state, and —
for router-mode dongles — the actual served LAN subnet. This is inventory only: it records
what is physically connected and what state it honestly reports. It does **not** certify a
USB-mode transition (that is RB-5) and does not claim any unit "certified" (that is a later
step in the plan, outside this runbook).

**Preconditions**

- Bench device reachable over SSH. `mmcli` on `PATH` for MM-managed units. **No `lsusb` binary
  on the bench image** — the canonical raw-USB-tree capture below uses the `/sys/bus/usb/devices/*`
  sweep instead, never `lsusb`.
- Re-run the sweep immediately before trusting any prior capture — hardware on this bench gets
  physically moved/reconnected between sessions, and USB port position is **not** a stable
  identity key across a replug (empirically confirmed — see the machine check below for the
  `ID_PATH`, not port, assertion).

**Commands**

```sh
mkdir -p A6.3
# 1) Raw USB tree — canonical capture, NOT lsusb (not installed on this image):
for d in /sys/bus/usb/devices/*; do [ -f "$d/idVendor" ] && echo "$(basename $d): $(cat $d/idVendor):$(cat $d/idProduct) mfg=\"$(cat $d/manufacturer 2>/dev/null)\" product=\"$(cat $d/product 2>/dev/null)\" serial=\"$(cat $d/serial 2>/dev/null)\""; done | tee A6.3/usb-tree.txt

# 2) ModemManager-visible units:
mmcli -L | tee A6.3/mmcli-list.txt

# 3) Per MM-managed unit, full dump (repeat per index reported by step 2):
for i in $(mmcli -L 2>/dev/null | grep -oE '/Modem/[0-9]+' | grep -oE '[0-9]+$'); do
  mmcli -m "$i" | tee -a A6.3/mmcli-dump.txt
done

# 4) USB ID_PATH per network interface (router-mode dongles and MM net legs alike):
for ifc in $(ip -br addr | awk '{print $1}'); do
  echo "--- $ifc ---"
  udevadm info -q property -p "/sys/class/net/$ifc" 2>/dev/null | grep -E '^ID_PATH=|^ID_VENDOR_ID=|^ID_MODEL_ID='
done | tee A6.3/id-path-per-iface.txt

# 5) Router-dongle LAN subnets actually served (host-side DHCP lease per interface):
ip -br addr | tee A6.3/ip-addr.txt
```

**Expected output** — each command produces at least one non-empty line matching its capture
target:

```
1-1.1: 19d2:1405 mfg="ZTE,Incorporated" product="ZTE Mobile Boardband" serial="..."
```

for the USB tree sweep;

```
    /org/freedesktop/ModemManager1/Modem/<n> [<Vendor>] <Model>
```

for every MM-managed unit; and a non-empty `ID_PATH=platform-...` line per claimed network
interface.

**Machine check**

```sh
grep -Eq '^[0-9]+-[0-9.]+: [0-9a-f]{4}:[0-9a-f]{4} ' A6.3/usb-tree.txt \
  && grep -Eq 'ID_PATH=platform-' A6.3/id-path-per-iface.txt \
  && echo "RB-9 PASS" || echo "RB-9 FAIL"
```

**Per-unit capture status (this bench, `ceralive2` 192.168.78.132)**

| Unit | VID:PID | Personality | MM status | Evidence |
|------|---------|-------------|-----------|----------|
| ZTE Mobile Broadband | `19d2:1405` | router-hilink | not MM-managed | `test-results/modem-phase-b/05/zte-mf79u/` |
| Huawei HiLink #1 | `12d1:14dc` | router-hilink | not MM-managed | `test-results/modem-phase-b/05/huawei-hilink-1/` |
| Huawei HiLink #2 | `12d1:14dc` | router-hilink | not MM-managed | `test-results/modem-phase-b/05/huawei-hilink-2/` |
| Quectel RM530N-GL | `2c7c:0801` | MM-managed stick | enabled, sim-pin2, not registered | `test-results/modem-phase-b/05/quectel-rm530n-gl/` |
| SIMCom SIM7600G-H R2 | `1e0e:9001` | MM-managed stick | failed, sim-missing | `test-results/modem-phase-b/05/simcom-sim7600g-h/` |
| Generic AliExpress stick #1 | `05c6:9024` | generic router-class, QMI passthrough not supported by design | not MM-managed | `test-results/modem-phase-b/05/aliexpress-stick-1/` |
| Generic AliExpress stick #2 | `05c6:9024` | generic router-class, QMI passthrough not supported by design | not MM-managed | `test-results/modem-phase-b/05/aliexpress-stick-2/` |
| Sierra EM75xx | `1199:*` (expected) | — | — | `[PARTIAL]` — not physically connected to this bench yet; capture commands above are documented and ready, no capture run |
| Fibocom FM350 | `0e8d:7126` / `14c3:4d75` (expected) | — | — | `[PARTIAL]` — not physically connected to this bench yet (also see `docs/FM350-DECISION.md` — this SKU is documented-deferred for support, not just uncaptured); capture commands above are documented and ready, no capture run |

The Huawei HiLink pair ships from the factory with an **identical MAC address**
(`0c:5b:8f:27:9a:64`) on both physically distinct units. Both units independently DHCP-serve
`192.168.8.100/24`; the host loses `enx<mac>`-predictable naming for the second unit to
enumerate and it falls back to a legacy `ethN` name. Recorded explicitly in both units' evidence
bundles — this is the exact scenario `image-building-pipeline`'s dongle-netns contract
(`docs/dongle-netns-contract.md`) requires keying identity off USB `ID_PATH`, never MAC, to
survive.

**Evidence:** `test-results/modem-control/A6.3/{usb-tree,mmcli-list,mmcli-dump,id-path-per-iface,ip-addr}.txt`
plus one JSON+text bundle per unit under `test-results/modem-phase-b/05/<unit>/` (repo-local,
gitignored).

---

## Evidence index

| Runbook | Item | Status | Evidence path (`test-results/modem-control/…`) |
|---------|------|--------|-----------------------------------------------|
| RB-1 | System-bus probe | `[PARTIAL]` | `A6.1/hil-system-bus.txt` |
| RB-2 | Slot-UID stability across replug | `[PARTIAL]` | `A6.3/slot-uid-{before,after,probe}.txt` |
| RB-3 | MM-1.24-from-artifacts install | `[PARTIAL]` | `A6.3/{mm-install,mm-version}.txt` |
| RB-4 | PIN/PUK on a real SIM | `[PARTIAL]` | `A6.3/unlock-{pin,puk}.txt` |
| RB-5 | Certified USB-mode transition | `[PARTIAL]` | `A6.3/{set-usb-mode,certify-transition}.txt`, `transition-bundle.json` |
| RB-6 | Usage-meter accuracy (machine-checkable) | `[PARTIAL]` | `A6.3/usage-accuracy.txt` |
| RB-7 | arm64-on-real-hardware validation | `[PARTIAL]` | `A6.3/arm64-{uname,probe}.txt` |
| RB-8 | Daemon smoke on real hardware | `[PARTIAL]` | `A6.3/daemon-smoke.txt` |
| RB-9 | Fleet inventory capture | `[PARTIAL]` | `A6.3/{usb-tree,mmcli-list,mmcli-dump,id-path-per-iface,ip-addr}.txt` + `test-results/modem-phase-b/05/<unit>/` |

Every row stays `[PARTIAL]` until its evidence artifact is captured on a real bench device
and its machine check prints `PASS`. No row may be claimed `[EXISTS]` on the strength of the
CI proxy alone — the CI proxy is green (compiled probe smoke both arches, packaging contract
+ daemon smoke in a bookworm container, the full `bun test` suite), but the hardware evidence
is what closes each gate.
