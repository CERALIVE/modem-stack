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

## RB-10 — Hub VBUS verification `[PARTIAL]`

Prove that a USB hub on the bench really **switches per-port power**, and that cutting a
port's power actually recovers a modem. This is the hardware half of the
`usb-hub-port-cycle` PowerHook (recovery-ladder rung 4): the code path is unit-tested with
a fake runner, but nothing in CI can prove a physical hub drops VBUS.

> **A zero exit code from `uhubctl` does NOT prove power was cut — and it is not this
> runbook's gate.** `uhubctl -a cycle` exits 0 whenever the hub *accepts* the control
> request. A hub whose per-port power switching is absent, ganged, or simply not wired to
> the VBUS rail accepts the request and cuts nothing, exiting 0 every time. **The only
> honest observable is the modem DISAPPEARING from the USB bus and coming back at the same
> physical topology path.** Step 3 below is that proof, performed by hand; step 4 is the
> automated harness that asserts the same thing plus ModemManager re-detection. A run that
> reports only "uhubctl exited 0" is **not** a passing RB-10.

> **Second honesty caveat — `uhubctl` may disable the port instead of cutting VBUS.**
> `uhubctl --help` (2.6.0) documents `--nosysfs, -S — do not use the Linux sysfs port
> disable interface`, i.e. by default it *prefers* the kernel's port-disable path where
> one exists. Port-disable makes the device vanish from the bus exactly like a power cut,
> so it satisfies steps 3 and 4 — but it does **not** electrically de-power a wedged
> modem, which is the whole reason rung 4 exists. Run step 3 **both ways** (default and
> `-S`) and record which one the hub honoured. The PowerHook never passes `-S` (its argv
> allowlist admits only `-l`, `-p`, `-a`, `-d`), so whatever the default path does on this
> hub is what rung 4 will do in production.

**Preconditions**

- Bench device reachable over SSH. `mmcli` on `PATH`. **No `lsusb` and no `usbutils` on
  the bench image** — the USB tree comes from the `/sys/bus/usb/devices/*` sweep (RB-9).
- `uhubctl` installed and runnable as root. **It is NOT on the bench image and is NOT in
  the image's apt archive** (`apt-cache show uhubctl` → `E: No packages found`, verified
  2026-08-16 on `ceralive2`), so it must be installed for the bench run — from a bookworm
  archive that carries it, or built from source. `uhubctl` needs `sudo` (or a udev
  permissions rule); the PowerHook never escalates on its own.
- The compiled `modem-control` binary (RB-1 preconditions).

**Commands**

```sh
OUT=test-results/modem-phase-b/07; mkdir -p "$OUT"

# 1) DISCOVERY — list every hub uhubctl considers power-switchable. Read-only, no action.
sudo uhubctl | tee "$OUT/uhubctl-discovery.txt"

# 2) CAPABILITY — assert the target hub advertises per-port power switching.
#    `ppps` in the hub's status line is uhubctl's rendering of the USB hub descriptor's
#    "Per-port power switching" bit — the `lsusb -v` field, read without lsusb.
grep -E 'Current status for hub .*, ppps\]' "$OUT/uhubctl-discovery.txt" \
  | tee "$OUT/uhubctl-ppps.txt"

# 3) PHYSICAL VBUS-DROP PROOF — the real gate. Cut the port, observe the modem LEAVE the
#    bus, restore the port, observe it COME BACK. HUB/PORT below are the mapped values.
HUB=4-1.4; PORT=4; DEV=4-1.4.4
sweep() { for d in /sys/bus/usb/devices/*; do [ -f "$d/idVendor" ] && \
  echo "$(basename "$d"): $(cat "$d/idVendor"):$(cat "$d/idProduct") product=\"$(cat "$d/product" 2>/dev/null)\""; done; }
{
  echo "--- before (device MUST be present) ---";      sweep
  echo "--- uhubctl -a off ---";                        sudo uhubctl -l "$HUB" -p "$PORT" -a off; echo "exit=$?"
  sleep 3
  echo "--- dark (device MUST be absent) ---";          sweep
  echo "--- uhubctl -a on ---";                         sudo uhubctl -l "$HUB" -p "$PORT" -a on; echo "exit=$?"
  sleep 8
  echo "--- after (device MUST be present again) ---";  sweep
} 2>&1 | tee "$OUT/vbus-drop-proof.txt"

# 3b) Repeat step 3 with -S (no sysfs port-disable) to learn which mechanism the hub
#     actually honours. Same assertions; recorded separately, never merged with 3.
{
  sudo uhubctl -S -l "$HUB" -p "$PORT" -a off; echo "exit=$?"; sleep 3; sweep
  sudo uhubctl -S -l "$HUB" -p "$PORT" -a on;  echo "exit=$?"; sleep 8; sweep
} 2>&1 | tee "$OUT/vbus-drop-proof-nosysfs.txt"

# 4) AUTOMATED HARNESS — one bounded cycle with all five assertions. `<slot>` is the
#    modem's udev ID_PATH (the hub-map key); `--mm-slot` is its ModemManager selector.
cat > "$OUT/hub-map.json" <<'EOF'
{
  "platform-xhci-hcd.0.auto-usb-0:1.4.4": { "hubLocation": "4-1.4", "port": 4 }
}
EOF
sudo ./modem-control hil-cycle 'platform-xhci-hcd.0.auto-usb-0:1.4.4' \
  --hub-map "$OUT/hub-map.json" --mm-slot 2 \
  2>&1 | tee "$OUT/hil-cycle-quectel-rm530n-gl.txt"
```

**Expected output**

Step 1 prints one block per power-switchable hub, in this exact shape (uhubctl 2.6.0):

```
Current status for hub 4-1.4 [0bda:0411 Generic USB3.2 Hub, USB 3.20, 4 ports, ppps]
  Port 1: 0100 power
  Port 4: 0503 power highspeed enable connect [2c7c:0801]
```

The trailing **`ppps`** token is the capability assertion of step 2 — a hub listed
`ganged` (or absent entirely, which is how `uhubctl` reports a hub it will not touch
without `-f`) **fails** RB-10 and must not be put in a hub map.

Step 3 must show the target `$DEV` line **present**, then **absent** in the dark sweep,
then **present again**. The absence is the pass; the two `exit=0` lines are not.

Step 4 ends with exactly:

```
HIL-CYCLE PASS slot=<slot> disappeared=<ms> reenumerated=<ms>
```

Any failure prints `HIL-CYCLE FAIL slot=<slot> reason=<reason>` and exits non-zero, where
`<reason>` is one of `hub-map-unreadable`, `hub-map-slot-unmapped`, `pre-capture-failed`,
`slot-not-enumerated`, `mm-slot-absent`, `power-cycle-unsupported`, `power-cycle-failed`,
`no-vbus-drop`, `reenumeration-timeout`, `mm-redetect-timeout`, `mm-slot-mismatch`.

`no-vbus-drop` is the reason that means **this hub exited 0 and cut nothing** — or that
the port came back faster than the harness sampled it. `uhubctl -a cycle -d N` blocks for
the whole dark window and only returns afterwards, so the harness observes the gap through
the tail of re-enumeration rather than the dark window itself. If step 3 proves a real
drop by hand but step 4 reports `no-vbus-drop`, that is a sampling miss, not a hub fault —
record both captures and treat step 3 as authoritative.

**Machine check**

```sh
OUT=test-results/modem-phase-b/07; DEV=4-1.4.4
grep -Eq 'Current status for hub .*, ppps\]' "$OUT/uhubctl-discovery.txt" \
  && awk -v d="$DEV" '/^--- dark/{s=1} /^--- after/{s=0} s && $0 ~ ("^" d ":"){f=1} END{exit !f}' \
       "$OUT/vbus-drop-proof.txt" && echo "RB-10 FAIL (device present while dark)" \
  || grep -Eq "^HIL-CYCLE PASS slot=.+ disappeared=[0-9]+ reenumerated=[0-9]+$" \
       "$OUT/hil-cycle-quectel-rm530n-gl.txt" \
     && echo "RB-10 PASS" || echo "RB-10 FAIL"
```

**Per-hub capability status (this bench, `ceralive2` 192.168.78.132)**

| Hub location | VID:PID | uhubctl compatible-hub list | Modems behind it | Status |
|---|---|---|---|---|
| `4-1`, `4-1.3`, `4-1.4` | `0bda:0411` | **yes** — listed for the Rosonway RSH-A10 / RSH-A16 | Quectel RM530N-GL at `4-1.4.4` (hub `4-1.4`, port 4) | `[PARTIAL]` — `uhubctl` not installed on the board and not in its apt archive; no discovery, no VBUS proof, no harness run |
| `1-1`, `1-1.3`, `1-1.4` | `0bda:5411` | **no** — not on the list; may need `-f`, which the PowerHook never passes | SIMCom SIM7600G-H at `1-1.3.4`; ZTE, both Huawei HiLink, both generic sticks | `[PARTIAL]` — untested; if it reports no `ppps` it is not mappable and rung 4 stays `unsupported` for every modem behind it |
| `3-1` | `1a40:0101` | not evaluated | none (Bluetooth radio only) | `[PARTIAL]` — out of scope, no modem behind it |

The two hub families matter: only the `0bda:0411` tree is a documented per-port-power
switcher, and on this bench that tree carries exactly **one** modem (the Quectel). Every
other unit hangs off `0bda:5411` hubs, so until step 2 is actually run there is no evidence
any of them can be power-cycled at all. Do not write a hub-map entry for a hub that has not
passed step 2 — the PowerHook's refuse-if-unmapped rule is the only thing standing between
a wrong entry and blacking out an unrelated device.

**Slot keys.** The hub-map key is the modem's udev **`ID_PATH`**, not a MAC, not an
`ifname`, and not a USB port number. This bench has already produced a duplicate-MAC pair
and has seen port positions move when devices were reordered on the hub (RB-9), so those
are all disqualified as identity. Current values, captured 2026-08-16:

| Unit | Sysfs node | `ID_PATH` (hub-map key) | `modem.generic.device` (`--mm-slot 2` / `4`) |
|---|---|---|---|
| Quectel RM530N-GL | `4-1.4.4` | `platform-xhci-hcd.0.auto-usb-0:1.4.4` | `/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4` |
| SIMCom SIM7600G-H | `1-1.3.4` | `platform-xhci-hcd.0.auto-usb-0:1.3.4` | `/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb1/1-1/1-1.3/1-1.3.4` |

**Evidence:** `test-results/modem-phase-b/07/{uhubctl-discovery,uhubctl-ppps,vbus-drop-proof,vbus-drop-proof-nosysfs}.txt`
plus one `test-results/modem-phase-b/07/hil-cycle-<slot>.txt` per cycled unit (repo-local,
gitignored). `<slot>` is the unit slug, matching RB-9's per-unit directory names — e.g.
`test-results/modem-phase-b/07/hil-cycle-quectel-rm530n-gl.txt`.

---

## Per-SKU certification (RB-11 … RB-15) — shared contract

RB-11 through RB-15 are one runbook per acquired modem family. They all drive the **same**
command (`./modem-control certify <slot>`) and differ only in the SKU-specific facts each
one must additionally capture. Everything the five have in common is stated **once**, here.

### The two-stage certification order (not optional — it falls out of the code)

A catalog entry cannot be authored in one pass, because `certify --transition` **refuses**
a SKU that is not already in the catalog (`cli/src/certify/transition-evidence.ts`, the
`no certified catalog entry for SKU …` throw). The order is therefore:

| Stage | Command | Produces | Lands as |
|-------|---------|----------|----------|
| **1 — base** | `./modem-control certify <slot> --output <bundle>.json` | a base bundle: `lsusb -v`, `usb-devices`, the slot's udev properties, `mmcli -K`, redacted `GetManagedObjects`, a bounded signal window | a candidate entry with `permittedTransitions: []`, reviewed and committed by a human |
| **2 — transition** | `./modem-control certify <slot> --transition <mode> --output <bundle>.json` | stage-1 evidence **plus** before/after descriptors, the executed AT command, and the port-drop / re-enumeration timeline | ONE `permittedTransitions[]` element on the entry from stage 1, carrying that bundle's `evidenceBundleSha256` |

Stage 2 is only reachable for a SKU whose stage-1 entry is already merged. Both stages feed
the same reviewed ingestion path: [`CATALOG-INGESTION.md`](CATALOG-INGESTION.md).

### Blockers that make every RB-11…RB-15 row `[PARTIAL]` today

Originally verified on `ceralive2` (192.168.78.132) on 2026-08-16 and **re-verified on the
same board on 2026-08-18** by a non-mutating capture pass against the SIMCom SIM7600G-H and
the Fibocom FM350-GL. The re-run **cleared B1, downgraded B3, promoted B2 from a code read
to a hardware-proven failure, and found two new blockers (B5, B6).** None is "not run yet";
each is a named obligation with a code or packaging fix behind it.

| # | Blocker | State | Verified how | Consequence |
|---|---------|-------|--------------|-------------|
| **B1** | `usbutils` absent from the board and its apt archive | **CLEARED (2026-08-18)** | live `command -v` sweep: `/usr/bin/lsusb`, `/usr/bin/usb-devices` both present | `certify` now completes its base capture; two real `CERTIFY OK … synthetic=false` bundles were captured on 2026-08-18 |
| **B2** | The production USB enumerator never populates `ifname` (`control/src/backend/usb-enumerator.ts`, `buildSnapshot`), but `certify` matches its target device **by** `ifname` (`cli/src/commands/certify.ts`) | **OPEN — now hardware-proven** | two live `certify` runs | the matched device is always `undefined`, so both real bundles came out with **no `sku` and empty `udevProperties`**; the ingestion seam correctly refuses them `sku-missing`, so **no bundle this pipeline produces can currently be promoted**. Pinned by `control/src/usb-mode/ingestion.hardware.test.ts` |
| **B3** | No AT transport | **PARTIALLY CLEARED (2026-08-18)** | live: `socat` **is** present at `/usr/bin/socat`; a query-only AT session over `/dev/ttyUSB2` (SIMCom) and `/dev/ttyUSB12` (FM350) succeeded | a **manual** AT session is now possible on the bench. The CLI half is unchanged: `benchAtSender` still rejects every send, so `certify --transition` still cannot execute an AT command. `picocom` / `minicom` remain absent; ModemManager's `--command` passthrough remains unavailable (MM is not run with `--debug`, so `mmcli --command` answers `Operation only allowed in debug mode`) |
| **B4** | The shipped `certified-catalog.json` holds exactly one entry, `CERALIVE-SYNTHETIC-TEST-SKU` | OPEN | repo read | stage 2 is unreachable for every real SKU until that SKU's stage-1 entry is merged |
| **B5** | The shared redactor does **not** mask `imei` / `equipment-identifier` / `device-identifier` (`control/src/redact.ts` `SENSITIVE_KEYS` covers ICCID / IMSI / EID / PIN / PUK / passwords only) | **OPEN — new** | inspected both real bundles | every real bundle's `modemManager` half carries the IMEI of **every** modem on the bench (`GetManagedObjects` is fleet-wide, not slot-scoped). A bundle therefore **must not be committed to this repo or pasted into a PR** as-is — which directly conflicts with the review workflow in [`CATALOG-INGESTION.md`](CATALOG-INGESTION.md). The `usb.lsusb` / `usb.usbDevices` halves are IMEI-free and safe to quote |
| **B6** | `skuOf` (`cli/src/certify/transform.ts`) derives `firmwarePrefix` from udev `ID_REVISION`, which is the USB **bcdDevice** — not the modem firmware revision | **OPEN — new** | compared udev against `mmcli` and AT `AT+CGMR` for both units | for the bench SIMCom, `ID_REVISION` is `0318` while the firmware is `LE20B04SIM7600G22`; for the FM350, `0001` vs `81600.0000.00.19.17.10`. A catalog entry keyed on `ID_REVISION` would **not** be firmware-keyed, so it could not distinguish two firmware builds of one SKU. Pinned by `ingestion.hardware.test.ts` |

**B2 and B6 gate stage 1. B3 and B4 additionally gate stage 2. B5 gates the review step for
every stage.** A run that reports a `CERTIFY OK` line with `synthetic=true`, or with an empty
`sku`, is **not** a passing RB-11…RB-15 — the gate is the `synthetic=false` line *and* a
bundle whose `sku` is populated.

> **Query-only AT sessions are safe; SET forms are not.** The 2026-08-18 pass established
> that a read-only AT survey needs no ModemManager inhibit on this bench: MM held only the
> Quectel's `ttyUSB7`/`ttyUSB8` open, so every other AT port was free. Restrict such a
> session to bare execute commands (`ATI`), READ forms (`AT+X?`), and TEST forms (`AT+X=?`)
> — the TEST form returns a parameter range and assigns nothing (ITU-T V.250 §5.4.1). A SET
> form (`AT+X=<value>`) is a certification-gated mutation and must never appear in a survey.

### The shared certify step

Every RB-11…RB-15 "Commands" block below opens with this, differing only in `SLOT`/`UNIT`:

```sh
OUT=test-results/modem-phase-b/08; mkdir -p "$OUT/$UNIT"
./modem-control certify "$SLOT" --output "$OUT/$UNIT/bundle.json" \
  2>&1 | tee "$OUT/$UNIT/certify.txt"
```

and every one asserts the same gate line:

```
CERTIFY OK: sha256=<64 hex> synthetic=false transition=none slot=<SLOT>
```

```sh
grep -Eq '^CERTIFY OK: sha256=[0-9a-f]{64} synthetic=false transition=none slot=' \
  "$OUT/$UNIT/certify.txt"
```

> **`<slot>` is a ModemManager selector, and MM indices renumber.** `Modem/2` is the
> Quectel *today*; a replug or an MM restart can move it. Re-read `mmcli -L` immediately
> before each run (RB-9 step 2) and never reuse a recorded index across sessions. The
> stable key is the udev `ID_PATH`, which is what the bundle carries.

---

## RB-11 — Quectel RM530N-GL certification capture (QMI) `[PARTIAL]`

Capture the certification bundle for the Quectel RM530N-GL, and record the `AT+QCFG="usbnet"`
composition-mode **transition candidate** — the one SKU on this bench with a documented,
schema-representable within-ModemManager mode switch.

> **`AT+QCFG="usbnet"` is a CANDIDATE, not a certified transition.** Nothing below promotes
> it. The value set is firmware-dependent, so step 3 **reads** the current setting rather
> than assuming a mapping, and the read result is what a reviewer uses to author the
> stage-2 transition. Note also that the RNDIS value is **not representable** in a catalog
> entry at all: `catalog-schema.ts` types a transition's `from`/`to` to the MM-mode enum
> (`qmi` / `mbim` / `ecm-ncm`), so an `MM → rndis` transition fails to parse by construction.
> Do not record one.

**Preconditions**

- The shared contract above, including blockers **B1–B4**.
- The Quectel enumerated and MM-managed. Live values on this bench (2026-08-16):
  USB `4-1.4.4`, VID:PID `2c7c:0801`, `ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.4.4:1.4`,
  MM `/org/freedesktop/ModemManager1/Modem/2`, plugin `quectel`, drivers `qmi_wwan` +
  `option`, primary port `cdc-wdm0`, net `wwan0`, firmware `RM530NGLAAR05A01M4G`.
- **A SIM whose state does not block registration.** The inserted SIM currently reports
  `lock: sim-pin2` (PIN1 satisfied — PIN2 only gates Fixed-Dialing-Number edits and does
  **not** block registration) with `registration: idle`, `packet service state: detached`,
  `signal quality: 0%`. That is a captureable state for the bundle, but it means no bearer
  smoke can accompany it.

**Commands**

```sh
OUT=test-results/modem-phase-b/08; UNIT=quectel-rm530n-gl; SLOT=Modem/2
mkdir -p "$OUT/$UNIT"

# 1) STAGE-1 BUNDLE — the gate.
./modem-control certify "$SLOT" --output "$OUT/$UNIT/bundle.json" \
  2>&1 | tee "$OUT/$UNIT/certify.txt"

# 2) SKU-SPECIFIC FACTS — QMI transport, raw-IP flag, port map.
{
  echo "--- mmcli dump ---";        mmcli -m "$SLOT"
  echo "--- qmi raw_ip ---";        cat /sys/class/net/wwan0/qmi/raw_ip
  echo "--- wda data format ---";   qmicli -d /dev/cdc-wdm0 --wda-get-data-format
  echo "--- id_path ---";           udevadm info -q property -p /sys/class/net/wwan0 \
                                      | grep -E '^ID_PATH=|^ID_NET_DRIVER='
} 2>&1 | tee "$OUT/$UNIT/qmi-facts.txt"

# 3) TRANSITION CANDIDATE — READ ONLY. Blocked by B3 (no AT transport); the command is
#    recorded so the bench run is a fill-in, not a judgment call. AT ports: ttyUSB2, ttyUSB3.
{
  echo 'AT+QCFG="usbnet"'    # read the CURRENT value — never assume the mapping
  echo 'AT+QCFG="usbnet",<n>'  # the switch, executed ONLY under stage 2, never here
} | tee "$OUT/$UNIT/transition-candidate.txt"
```

**Expected output**

Step 1 ends with the shared gate line, `slot=Modem/2`. Step 2's raw-IP read prints exactly
`Y` (captured live 2026-08-16 — the Quectel's `qmi_wwan` link is in raw-IP mode), and the
`ID_PATH` line reads `ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.4.4:1.4` with
`ID_NET_DRIVER=qmi_wwan`. Step 3's read returns, on a working AT channel:

```
+QCFG: "usbnet",<n>

OK
```

**Machine check**

```sh
OUT=test-results/modem-phase-b/08; UNIT=quectel-rm530n-gl
grep -Eq '^CERTIFY OK: sha256=[0-9a-f]{64} synthetic=false transition=none slot=' \
     "$OUT/$UNIT/certify.txt" \
  && grep -Eq '"vidPid": *"2c7c:0801"' "$OUT/$UNIT/bundle.json" \
  && echo "RB-11 PASS" || echo "RB-11 FAIL"
```

The `vidPid` clause is not decoration: it is what fails when blocker **B2** is still live,
because an unmatched device yields a bundle with no `sku` at all.

**Status:** `[PARTIAL]` — no capture. Blockers B1 (no `usbutils`) and B2 (no `ifname` on
enumerated devices) both stop stage 1; B3 and B4 additionally stop stage 2.

**Evidence:** `test-results/modem-phase-b/08/quectel-rm530n-gl/{certify.txt,bundle.json,qmi-facts.txt,transition-candidate.txt}`

---

## RB-12 — Sierra EM75xx certification capture (MBIM/QMI, FCC-locked) `[PARTIAL]`

Capture the certification bundle for a Sierra Wireless EM75xx-class module, and record the
**FCC-lock** behaviour honestly in its locked state.

> **FCC unlock stays UNRUN, and that is a policy, not an omission.** Sierra EM-series
> modules ship RF-disabled until an FCC-authorization sequence is sent; the community
> `qmi-fcc-unlock` / `mbim-fcc-unlock` helpers exist and ModemManager 1.24 can invoke a
> per-vendor unlock script. This project does **not** run one, and this runbook does not
> document one as a step. Sending an FCC-authorization command is a **regulatory act about
> the operator's own equipment**, so it is **opt-in per deployment** and is never performed
> as part of a certification capture. What RB-12 captures instead is the **LOCKED-state
> behaviour** — which is a real, useful, reportable fact: an FCC-locked EM75xx enumerates,
> is MM-managed, reports its identity, and reports RF disabled. A bundle captured in the
> locked state is a valid stage-1 bundle. It is **not** evidence of a working data path,
> and no row may claim one from it.

**Preconditions**

- The shared contract above, including blockers **B1–B4**.
- **A Sierra EM75xx module physically connected. There is none on this bench** — the
  2026-08-16 USB sweep shows no `1199:*` device. Every value below is the *documented
  expectation*, captured from no hardware, and is marked as such.
- Expected identity when one is connected: VID `1199` (Sierra Wireless), MBIM composition
  binding `cdc_mbim` (`0x02/0x0e` control + `0x0a` data), QMI composition binding
  `qmi_wwan`; MM plugin `sierra`.

**Commands**

```sh
OUT=test-results/modem-phase-b/08; UNIT=sierra-em75xx; SLOT=Modem/0   # re-read mmcli -L first
mkdir -p "$OUT/$UNIT"

# 1) STAGE-1 BUNDLE — the gate.
./modem-control certify "$SLOT" --output "$OUT/$UNIT/bundle.json" \
  2>&1 | tee "$OUT/$UNIT/certify.txt"

# 2) LOCKED-STATE CAPTURE — the whole point of this runbook.
{
  echo "--- mmcli dump ---";  mmcli -m "$SLOT"
  echo "--- power state ---"; mmcli -m "$SLOT" -K | grep -E '^modem\.generic\.(state|power-state|device)'
  echo "--- transport ---";   udevadm info -q property -p /sys/class/net/wwan0 \
                                | grep -E '^ID_PATH=|^ID_NET_DRIVER=|^ID_VENDOR_ID='
} 2>&1 | tee "$OUT/$UNIT/fcc-locked-state.txt"

# 3) FCC POLICY MARKER — records that the unlock was deliberately NOT run.
printf 'FCC-UNLOCK: NOT RUN (opt-in per deployment; see RB-12 policy note)\n' \
  | tee "$OUT/$UNIT/fcc-policy.txt"
```

**Expected output**

Step 1 ends with the shared gate line. Step 2, on an FCC-locked unit, shows the modem
present and identified with its RF path disabled — typically `state: disabled` or
`state: failed` alongside a `power state`, with the module's manufacturer/model/firmware all
populated. **Both are a valid capture**; RB-12 does not require a particular one, it
requires the observed one to be recorded verbatim. Step 3 writes the literal marker line.

**Machine check**

```sh
OUT=test-results/modem-phase-b/08; UNIT=sierra-em75xx
grep -Eq '^CERTIFY OK: sha256=[0-9a-f]{64} synthetic=false transition=none slot=' \
     "$OUT/$UNIT/certify.txt" \
  && grep -Eq '"vidPid": *"1199:[0-9a-f]{4}"' "$OUT/$UNIT/bundle.json" \
  && grep -Fq 'FCC-UNLOCK: NOT RUN' "$OUT/$UNIT/fcc-policy.txt" \
  && echo "RB-12 PASS" || echo "RB-12 FAIL"
```

**Status:** `[PARTIAL]` — **fully** unrun, and unrunnable: no EM75xx exists on this bench, on
top of blockers B1–B4. No capture directory is created; no value above was observed.

**Evidence:** `test-results/modem-phase-b/08/sierra-em75xx/{certify.txt,bundle.json,fcc-locked-state.txt,fcc-policy.txt}`

---

## RB-13 — SIMCom SIM7600G-H certification capture (QMI raw-IP) `[PARTIAL]`

Capture the certification bundle for the SIMCom SIM7600G-H R2, recording its **QMI raw-IP
flag state** explicitly, and record the `AT+CUSBPIDSWITCH` RNDIS personality as an
**observation only**.

> **`AT+CUSBPIDSWITCH=9011` exists and is NOT certified.** SIM7600-series firmware exposes a
> USB PID switch, and `9011` selects an RNDIS personality. It is recorded here so a bench
> operator who encounters it knows what it is — **and knows not to certify it**. Two
> independent reasons: (a) RNDIS is not a ModemManager-manageable mode, so the transition is
> **schema-invalid** in `catalog-schema.ts` and cannot be written down as a permitted
> transition; (b) a PID switch changes the device's VID:PID, i.e. its catalog
> **discriminator**, so the post-switch device is a *different* catalog subject, not a mode
> of this one. Observation only. Do not run it as part of a certification capture.

**Preconditions**

- The shared contract above, including blockers **B1–B4**.
- The SIM7600G-H enumerated and MM-managed. Live values on this bench (2026-08-16):
  USB `1-1.3.4`, VID:PID `1e0e:9001`, `ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.3.4:1.5`,
  MM `/org/freedesktop/ModemManager1/Modem/4`, plugin `simtech`, drivers `qmi_wwan` +
  `option`, primary port `cdc-wdm1`, net `wwan1`, firmware `LE20B04SIM7600G22`.
- **No SIM is inserted** in this unit — MM reports `state: failed`,
  `failed reason: sim-missing`. That is a captureable stage-1 state (the module identifies
  itself fully), but it forbids any registration or bearer claim from this bundle.

**Commands**

```sh
OUT=test-results/modem-phase-b/08; UNIT=simcom-sim7600g-h; SLOT=Modem/4
mkdir -p "$OUT/$UNIT"

# 1) STAGE-1 BUNDLE — the gate.
./modem-control certify "$SLOT" --output "$OUT/$UNIT/bundle.json" \
  2>&1 | tee "$OUT/$UNIT/certify.txt"

# 2) RAW-IP FLAG STATE — the SKU-specific fact this runbook exists to capture. The kernel
#    sysfs flag and the modem's own WDA data format must AGREE; a mismatch is the classic
#    "QMI link up, no traffic" fault and is a finding, not a pass.
{
  echo "--- kernel raw_ip flag ---"; cat /sys/class/net/wwan1/qmi/raw_ip
  echo "--- modem wda format ---";   qmicli -d /dev/cdc-wdm1 --wda-get-data-format
  echo "--- transport ---";          udevadm info -q property -p /sys/class/net/wwan1 \
                                       | grep -E '^ID_PATH=|^ID_NET_DRIVER='
  echo "--- sim state ---";          mmcli -m "$SLOT" -K | grep -E '^modem\.generic\.(state|state-failed-reason)'
} 2>&1 | tee "$OUT/$UNIT/raw-ip-state.txt"

# 3) RNDIS PERSONALITY — OBSERVATION ONLY. Recorded, never executed, never certified.
printf 'AT+CUSBPIDSWITCH=9011  # RNDIS personality — EXISTS, NOT CERTIFIED, NOT RUN\n' \
  | tee "$OUT/$UNIT/rndis-observation.txt"
```

**Expected output**

Step 1 ends with the shared gate line, `slot=Modem/4`. Step 2's kernel flag prints exactly
`Y` (captured live 2026-08-16), the `ID_PATH` line reads
`ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.3.4:1.5` with `ID_NET_DRIVER=qmi_wwan`, and the
SIM state reads `modem.generic.state-failed-reason : sim-missing` until a card is inserted.
`--wda-get-data-format` reports its link-layer protocol; on a healthy raw-IP link it reads
`raw-ip`, matching the `Y` above.

**Machine check**

```sh
OUT=test-results/modem-phase-b/08; UNIT=simcom-sim7600g-h
grep -Eq '^CERTIFY OK: sha256=[0-9a-f]{64} synthetic=false transition=none slot=' \
     "$OUT/$UNIT/certify.txt" \
  && grep -Eq '"vidPid": *"1e0e:9001"' "$OUT/$UNIT/bundle.json" \
  && sed -n '2p' "$OUT/$UNIT/raw-ip-state.txt" | grep -Eq '^(Y|N)$' \
  && echo "RB-13 PASS" || echo "RB-13 FAIL"
```

The raw-IP clause asserts the flag was **captured**, not that it holds a particular value —
`N` is a legitimate observation and a legitimate finding. Recording it is the gate.

**Status:** `[PARTIAL]` — no capture; blockers B1/B2 stop stage 1, and this unit has no SIM.
The raw-IP flag value (`Y`) and the transport facts above are RB-9-class live observations
already captured on 2026-08-16; they are **not** a certification bundle.

**Evidence:** `test-results/modem-phase-b/08/simcom-sim7600g-h/{certify.txt,bundle.json,raw-ip-state.txt,rndis-observation.txt}`

---

## RB-14 — Huawei personality capture (Stick vs HiLink) `[PARTIAL]`

Capture which **personality** a Huawei dongle is presenting — *Stick* (an MM-managed modem
with AT/QMI control ports) or *HiLink* (a self-contained router that presents only a
CDC-Ethernet tether) — and record the class evidence for each. The two personalities are
different device classes to this stack, not different settings of one device.

> **A HiLink unit is `router-mode`, and that is a terminal classification here.** With a
> CDC-Ethernet tether and no control port of any kind, `classifyDevice` returns
> `router-mode` and `detectUsbMode` returns `router-ethernet`. Neither is an MM mode, so a
> HiLink unit can hold a catalog entry with `canonicalMode: "router-ethernet"` and
> **`permittedTransitions: []`** — and nothing else. Any Stick↔HiLink switch (`AT^SETPORT`,
> a vendor tool, or a firmware reflash) crosses the MM↔router line the schema forbids and
> is therefore **observation only**, exactly like RB-13's PID switch.

**Preconditions**

- The shared contract above, including blockers **B1–B4**. Note a HiLink unit is **not**
  MM-managed, so `certify <slot>` — which selects a *ModemManager* slot — cannot be run
  against one at all; RB-14's HiLink half is a udev/network capture, and only its Stick half
  is a certify capture.
- Live values on this bench (2026-08-16): **two** HiLink units, both `12d1:14dc`, at USB
  `1-1.3.1` and `1-1.3.2`, both bound by `cdc_ether`, neither in `mmcli -L`. **No Huawei
  Stick-mode unit is present** — the Stick half of this runbook is documented, not captured.

> **The duplicate-MAC pair is the reason this runbook cannot key on anything but `ID_PATH`.**
> Both HiLink units carry the **identical factory MAC `0c:5b:8f:27:9a:64`**, both DHCP-serve
> `192.168.8.100/24` to the host, and both offer the same default gateway `192.168.8.1`. The
> unit that wins the naming race gets `enx0c5b8f279a64`; the loser falls back to a legacy
> `eth1` and — verified live — has **no `ID_PATH` udev property at all**, only a `DEVPATH`.
> So the per-unit capture below reads `ID_PATH` **with a `DEVPATH` fallback**, and a run that
> silently produces one row for two physical units is a FAIL, not a tidy result.

**Commands**

```sh
OUT=test-results/modem-phase-b/08; UNIT=huawei; mkdir -p "$OUT/$UNIT"

# 1) PERSONALITY SWEEP — one row per physically present Huawei device, keyed on sysfs path.
for d in /sys/bus/usb/devices/*; do
  [ -f "$d/idVendor" ] || continue
  [ "$(cat "$d/idVendor")" = "12d1" ] || continue
  echo "=== $(basename "$d") $(cat "$d/idVendor"):$(cat "$d/idProduct") ==="
  echo "interfaces: $(for i in "$d":*; do [ -f "$i/bInterfaceClass" ] && \
    printf '%s/%s/%s(%s) ' "$(cat "$i/bInterfaceClass")" "$(cat "$i/bInterfaceSubClass")" \
      "$(cat "$i/bInterfaceProtocol")" "$(basename "$(readlink -f "$i/driver" 2>/dev/null)")"; done)"
  echo "net children: $(ls "$d"/*/net 2>/dev/null | tr '\n' ' ')"
  echo "tty children: $(ls -d "$d"/*/tty* 2>/dev/null | tr '\n' ' ')"
done 2>&1 | tee "$OUT/$UNIT/personality-sweep.txt"

# 2) PER-INTERFACE IDENTITY — ID_PATH, with the DEVPATH fallback the duplicate-MAC loser needs.
for ifc in $(ip -br link | awk '{print $1}'); do
  drv=$(udevadm info -q property -p "/sys/class/net/$ifc" 2>/dev/null | grep -E '^ID_NET_DRIVER=')
  case "$drv" in *cdc_ether*|*rndis_host*|*cdc_ncm*|*option*|*qmi_wwan*) ;; *) continue ;; esac
  echo "--- $ifc ---"
  udevadm info -q property -p "/sys/class/net/$ifc" 2>/dev/null \
    | grep -E '^ID_PATH=|^DEVPATH=|^ID_VENDOR_ID=|^ID_MODEL_ID=|^ID_NET_DRIVER='
  echo "mac=$(cat "/sys/class/net/$ifc/address")"
done 2>&1 | tee "$OUT/$UNIT/id-path-fallback.txt"

# 3) STICK HALF — only when an MM-managed Huawei is present (none on this bench).
#    SLOT comes from `mmcli -L`; skip entirely when no 12d1 unit is listed.
# ./modem-control certify "$SLOT" --output "$OUT/$UNIT/stick-bundle.json" \
#   2>&1 | tee "$OUT/$UNIT/stick-certify.txt"

# 4) PERSONALITY-SWITCH OBSERVATION — recorded, never executed, never certified.
printf 'AT^SETPORT  # Huawei Stick<->HiLink personality — EXISTS, NOT CERTIFIED, NOT RUN\n' \
  | tee "$OUT/$UNIT/personality-switch-observation.txt"
```

**Expected output**

Step 1 prints one `===` block per physical Huawei device — **two** on this bench. A HiLink
block shows CDC-Ethernet interfaces bound to `cdc_ether`, a `net` child, and **no** `tty`
children; a Stick block would show `option`-bound `ttyUSB*` children (and, on a QMI-capable
Stick, a `qmi_wwan` interface). Step 2 prints, for the naming-race winner:

```
ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.3.2:1.0
ID_NET_DRIVER=cdc_ether
mac=0c:5b:8f:27:9a:64
```

and, for the loser, a `DEVPATH=` line with **no** `ID_PATH` — the same MAC on a different
sysfs path. Two blocks, two paths, one MAC.

**Machine check**

```sh
OUT=test-results/modem-phase-b/08; UNIT=huawei
n=$(grep -c '^=== ' "$OUT/$UNIT/personality-sweep.txt")
p=$(grep -cE '^(ID_PATH=|DEVPATH=)' "$OUT/$UNIT/id-path-fallback.txt")
[ "$n" -ge 1 ] && [ "$p" -ge "$n" ] \
  && echo "RB-14 PASS (units=$n identity-rows=$p)" || echo "RB-14 FAIL (units=$n identity-rows=$p)"
```

Every physical unit must contribute at least one identity row. That is the assertion the
duplicate-MAC pair would otherwise silently defeat.

**Status:** `[PARTIAL]` — no certification bundle. The HiLink half is capturable today (it
needs neither `certify` nor `usbutils`), but it has not been run as an RB-14 capture; the
Stick half has no hardware at all.

**Evidence:** `test-results/modem-phase-b/08/huawei/{personality-sweep.txt,id-path-fallback.txt,personality-switch-observation.txt}` (+ `stick-{certify.txt,bundle.json}` when a Stick unit exists)

---

## RB-15 — ZTE MF79U router-mode capture `[PARTIAL]`

Capture the router-mode class evidence for the ZTE MF79U-class dongle: the LAN subnet it
actually serves, the DHCP lease it hands the host, its default gateway, and the presence of
its embedded web UI. This is the canonical **`router-ethernet`** capture — the device MM
never manages.

> **A router dongle's catalog entry can only ever be `canonicalMode: "router-ethernet"` with
> `permittedTransitions: []`.** There is no AT channel, no QMI channel, and no MM slot. The
> entry records *what it is*, so the stack can recognise it and hand it to the netns layer —
> it never records a switch. Nothing in RB-15 produces a `certify` bundle, because `certify`
> selects a ModemManager slot and this device has none.

**Preconditions**

- Bench device reachable over SSH; `curl` present (**verified installed**; `wget` is **not**
  on this image, so the web-UI step has no fallback and is a hard dependency).
- Live values on this bench (2026-08-16): USB `1-1.1`, VID:PID `19d2:1405`,
  `ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.1:1.0`, driver `cdc_ether`, interface
  `enx344b50000000` (MAC `34:4b:50:00:00:00`, unique — **no** collision, unlike RB-14's pair),
  host lease `192.168.0.169/24`, gateway `192.168.0.1`.

**Commands**

```sh
OUT=test-results/modem-phase-b/08; UNIT=zte-mf79u; IF=enx344b50000000
mkdir -p "$OUT/$UNIT"

# 1) CLASS EVIDENCE — descriptors + driver + the absence of any control port.
{
  D=/sys/bus/usb/devices/1-1.1
  echo "vidpid: $(cat $D/idVendor):$(cat $D/idProduct)"
  echo "interfaces: $(for i in $D:*; do [ -f "$i/bInterfaceClass" ] && \
    printf '%s/%s/%s(%s) ' "$(cat "$i/bInterfaceClass")" "$(cat "$i/bInterfaceSubClass")" \
      "$(cat "$i/bInterfaceProtocol")" "$(basename "$(readlink -f "$i/driver" 2>/dev/null)")"; done)"
  echo "tty children: $(ls -d $D/*/tty* 2>/dev/null | wc -l)   # MUST be 0 for router-mode"
  echo "cdc-wdm children: $(ls -d $D/*/usbmisc 2>/dev/null | wc -l)  # MUST be 0"
  echo "mm-managed: $(mmcli -L 2>/dev/null | grep -c 19d2)          # MUST be 0"
} 2>&1 | tee "$OUT/$UNIT/class-evidence.txt"

# 2) LAN SUBNET + DHCP LEASE the dongle actually serves to the host.
{
  ip -br addr show "$IF"
  ip route show dev "$IF"
  udevadm info -q property -p "/sys/class/net/$IF" \
    | grep -E '^ID_PATH=|^ID_NET_DRIVER=|^ID_VENDOR_ID=|^ID_MODEL_ID='
  echo "mac=$(cat "/sys/class/net/$IF/address")"
} 2>&1 | tee "$OUT/$UNIT/lan-dhcp.txt"

# 3) WEB-UI PRESENCE — the router personality's own control surface, header-only.
GW=$(ip route show dev "$IF" | awk '/^default/{print $3}' | head -1)
curl -sS -m 8 -o /dev/null -w "gw=$GW http_code=%{http_code} redirect=%{redirect_url}\n" \
  "http://$GW/" 2>&1 | tee "$OUT/$UNIT/web-ui.txt"
```

**Expected output**

Step 1 prints `vidpid: 19d2:1405`, CDC-Ethernet interface triples bound to `cdc_ether`, and
**three zeros** — no tty child, no `cdc-wdm` child, not in `mmcli -L`. Those three zeros
*are* the router-mode classification. Step 2 prints the live lease and gateway:

```
enx344b50000000  UP   192.168.0.169/24 fe80::a408:7435:436b:94db/64
default via 192.168.0.1 proto dhcp src 192.168.0.169 metric 103
ID_PATH=platform-xhci-hcd.0.auto-usb-0:1.1:1.0
ID_NET_DRIVER=cdc_ether
```

Step 3 prints the embedded web UI's redirect — captured live 2026-08-16:

```
gw=192.168.0.1 http_code=302 redirect=http://192.168.0.1/index.html
```

For contrast (RB-14's HiLink units, same command against `192.168.8.1`) the response is
`http_code=307 redirect=http://192.168.8.1/html/index.html` — a different vendor UI at a
different path, which is why the assertion below accepts any 2xx/3xx rather than one code.

**Machine check**

```sh
OUT=test-results/modem-phase-b/08; UNIT=zte-mf79u
grep -Eq '^vidpid: 19d2:1405$' "$OUT/$UNIT/class-evidence.txt" \
  && grep -Eq 'tty children: 0 ' "$OUT/$UNIT/class-evidence.txt" \
  && grep -Eq '^default via [0-9.]+ ' "$OUT/$UNIT/lan-dhcp.txt" \
  && grep -Eq 'http_code=[23][0-9]{2} ' "$OUT/$UNIT/web-ui.txt" \
  && echo "RB-15 PASS" || echo "RB-15 FAIL"
```

**Status:** `[PARTIAL]` — no RB-15 capture has been run. Every value quoted above is a live
RB-9-class observation from 2026-08-16, not an RB-15 evidence bundle. Unlike RB-11…RB-14
this runbook is **not** blocked by B1–B4 (it never invokes `certify`), so it is the first of
the six that can be closed on the current image.

**Evidence:** `test-results/modem-phase-b/08/zte-mf79u/{class-evidence.txt,lan-dhcp.txt,web-ui.txt}`

---

## RB-16 — Fibocom FM350 USB-vs-PCIe probe `[PARTIAL]`

Determine, from real bus evidence, whether the physical FM350 unit enumerates as a **USB**
device (`0e8d:7126` bootloader / `14c3:4d75` MBIM) — which would trigger the contrary-evidence
**HARD STOP** in [`FM350-DECISION.md`](FM350-DECISION.md)'s mechanical rule — or as the
documented **PCIe** `mtk_t7xx` device (`14c3:4d75` on the PCI bus), or is simply **not
connected** to this bench at all. This runbook never certifies the FM350 and never adds a
matrix row; it only produces the bus-level evidence the decision doc's mechanical rule
consumes.

> **USB enumeration alone never promotes support/matrix status.** Even in the branch where the
> FM350 enumerates as USB (in scope for the classifier per the mechanical rule), the SKU still
> has to clear the same per-family certification ladder as every RB-11…RB-15 unit (a real
> `certify` bundle, `synthetic:false`) before `docs/MODEM-SUPPORT-MATRIX.md` changes. A bus
> match is bus evidence, not a certification.

**Preconditions**

- Bench device reachable over SSH. **No `lsusb` and no `lspci` on the bench image** — the USB
  tree comes from the `/sys/bus/usb/devices/*` sweep (RB-9's pattern) and the PCI tree from a
  `/sys/bus/pci/devices/*` sweep, neither of which needs `usbutils`/`pciutils`.
- `mmcli` on `PATH`, ModemManager **≥ 1.24.2** (the version floor `FM350-DECISION.md`'s gate 1
  already confirms this repo ships).
- Re-run this probe immediately before trusting a prior capture — hardware on this bench has
  moved multiple times this session (`.omo/notepads/modem-stack-phase-b/learnings.md`); do not
  assume the unit's absence from an earlier pass still holds.

**Commands**

```sh
OUT=test-results/modem-phase-b/09; mkdir -p "$OUT"

# 1) USB DESCRIPTOR SWEEP — lsusb-equivalent. Expect 0e8d:7126 (bootloader) or 14c3:4d75
#    (MBIM mode) if the unit is USB-enumerating.
{
  for d in /sys/bus/usb/devices/*; do [ -f "$d/idVendor" ] && \
    echo "$(basename "$d"): $(cat "$d/idVendor"):$(cat "$d/idProduct") mfg=\"$(cat "$d/manufacturer" 2>/dev/null)\" product=\"$(cat "$d/product" 2>/dev/null)\""; done
  echo "--- FM350 USB candidate match ---"
  m=$(for d in /sys/bus/usb/devices/*; do [ -f "$d/idVendor" ] && \
    vp="$(cat "$d/idVendor"):$(cat "$d/idProduct")" && \
    case "$vp" in 0e8d:7126|14c3:4d75) echo "MATCH: $(basename "$d") $vp";; esac; done)
  [ -n "$m" ] && echo "$m" || echo "NO MATCHES (checked all usb nodes above)"
} 2>&1 | tee "$OUT/usb-sweep.txt"

# 2) DRIVER BINDING CHECK — only meaningful if step 1 matched. `cdc_mbim` is the expected
#    driver for a USB MBIM personality; this is a DIFFERENT driver family than the documented
#    PCIe mtk_t7xx path, so a match here is itself part of the contrary-evidence record.
{
  for d in /sys/bus/usb/devices/*:1.*; do [ -d "$d/driver" ] && \
    echo "$(basename "$d"): driver=$(basename "$(readlink -f "$d/driver")")"; done
} 2>&1 | tee "$OUT/driver-binding.txt"

# 3) PCIe SWEEP — expect 14c3:4d75 (vendor:device) if the unit is in its native M.2 PCIe
#    slot, plus the mtk_t7xx driver bound and the wwan/net subsystems populated
#    (FM350-DECISION.md Citation 2).
{
  if [ -d /sys/bus/pci/devices ]; then
    for d in /sys/bus/pci/devices/*; do [ -f "$d/vendor" ] && \
      echo "$(basename "$d"): $(cat "$d/vendor"):$(cat "$d/device")"; done
    echo "--- FM350 PCI candidate match (14c3:4d75) ---"
    m=$(for d in /sys/bus/pci/devices/*; do [ -f "$d/vendor" ] && \
      vd="$(cat "$d/vendor" | sed 's/^0x//'):$(cat "$d/device" | sed 's/^0x//')" && \
      [ "$vd" = "14c3:4d75" ] && echo "MATCH: $(basename "$d") $vd"; done)
    [ -n "$m" ] && echo "$m" || echo "NO MATCHES (checked all pci nodes above)"
  else
    echo "/sys/bus/pci/devices does not exist on this board"
  fi
  echo "--- wwan class (mtk_t7xx exposes the modem here) ---"
  ls /sys/class/wwan/ 2>&1
  echo "--- mtk_t7xx module ---"
  lsmod | grep -E '^mtk_t7xx' || echo "mtk_t7xx not loaded"
} 2>&1 | tee "$OUT/pcie-sweep.txt"

# 4) MM DETECTION — does the packaged ModemManager 1.24.2 mtk plugin claim it on either bus.
mmcli -L 2>&1 | tee "$OUT/mmcli-list.txt"
mmcli --version 2>&1 | tee "$OUT/mm-version.txt"

# 5) BEARER / DATA-SESSION SMOKE — only runs if step 4 found the FM350's MM index; <N> is
#    filled in at capture time from that step's real output, never guessed.
N=${FM350_MM_INDEX:-}
if [ -n "$N" ]; then
  mmcli -m "$N" 2>&1 | tee "$OUT/mmcli-dump.txt"
  mmcli -m "$N" --simple-connect="apn=internet" 2>&1 | tee "$OUT/bearer-connect.txt"
else
  echo "FM350_MM_INDEX unset -- no MM index found for FM350 in step 4, bearer smoke SKIPPED (not simulated)" \
    | tee "$OUT/bearer-connect.txt"
fi

# 6) PORT-CYCLE RECOVERY — via todo 7's hil-cycle harness, same shape as RB-10 step 4. <slot>
#    is the ID_PATH found in step 1; hub-map entry is filled in once the unit is physically
#    mapped to a hub port.
SLOT=${FM350_ID_PATH:-}
if [ -n "$SLOT" ]; then
  sudo ./modem-control hil-cycle "$SLOT" --hub-map "$OUT/hub-map.json" --mm-slot "$N" \
    2>&1 | tee "$OUT/hil-cycle-fm350.txt"
else
  echo "FM350_ID_PATH unset -- unit not enumerated on either bus, hil-cycle SKIPPED (not simulated)" \
    | tee "$OUT/hil-cycle-fm350.txt"
fi
```

**Expected output**

If the unit is USB-enumerating, step 1 prints a `MATCH: <node> 0e8d:7126` or
`MATCH: <node> 14c3:4d75` line. If it is PCIe-only, step 3 prints a `MATCH: <node> 14c3:4d75`
line under the PCI sweep, a non-empty `/sys/class/wwan/` listing, and a `mtk_t7xx` row in
`lsmod`. If neither fires, both sweeps print their full device list with a `NO MATCHES` line
appended, `/sys/class/wwan/` does not exist, and `mtk_t7xx` is reported not loaded — the honest
"not connected" outcome.

**Machine check**

```sh
OUT=test-results/modem-phase-b/09
if grep -q '^MATCH: ' "$OUT/usb-sweep.txt"; then
  echo "RB-16 RESULT: USB-observed -- see FM350-DECISION.md Branch A template"
elif grep -q '^MATCH: ' "$OUT/pcie-sweep.txt"; then
  echo "RB-16 RESULT: PCIe-only observed -- see FM350-DECISION.md Branch B template"
elif grep -q 'NO MATCHES' "$OUT/usb-sweep.txt" && grep -q 'NO MATCHES' "$OUT/pcie-sweep.txt"; then
  echo "RB-16 RESULT: not connected -- ledger stays OPEN, probe evidence recorded"
else
  echo "RB-16 FAIL (sweep output malformed -- neither MATCH nor NO MATCHES present)"
fi
```

**Live capture, 2026-08-16, `ceralive2` (192.168.78.132, kernel `7.1.7-ceralive-rk3588`,
ModemManager `1.24.2`)**

The FM350 is **not physically connected to this bench** — neither in a USB adapter nor in a
PCIe M.2 slot. Step 1's USB sweep swept all 15 enumerated USB nodes (three `0bda:*` hubs, the
five MM-managed/router-class modems from RB-9, one Bluetooth radio, eight host controllers) —
zero matched `0e8d:7126` or `14c3:4d75`. Step 2 (driver binding) had nothing to check. Step 3's
PCIe sweep found six real PCI devices (the RK3588 root complex `1d87:3588` ×3, a Realtek
`10ec:b852` and `10ec:8125`, i.e. the board's own WiFi/Ethernet silicon, not a WWAN module) —
zero matched `14c3:4d75`; `/sys/class/wwan/` does not exist; `mtk_t7xx` is not loaded (only the
unrelated Bluetooth `btmtk` module is present, confirmed by name — it is not the WWAN driver).
Step 4: `mmcli -L` shows only the Quectel RM530N-GL and SIMCom SIM7600G-H (`mmcli --version`
confirms the packaged `1.24.2`), consistent with every prior inventory pass this session
(RB-9). Steps 5-6 SKIPPED — no MM index or `ID_PATH` exists to act on, and this is recorded
verbatim in `bearer-connect.txt`/`hil-cycle-fm350.txt` rather than simulated.

**Status:** `[PARTIAL]` — probe run, unit not present. Per `FM350-DECISION.md`'s own mechanical
rule, no branch fires when there is nothing to classify; the three-gate ledger stays exactly as
recorded (gate 1 CLEARED, gates 2 and 3 OPEN). See `FM350-DECISION.md` § "Bench probe evidence
(RB-16)" and § "Gate-ledger update template" for the fill-in-ready next step.

**Evidence:** `test-results/modem-phase-b/09/{usb-sweep,driver-binding,pcie-sweep,mmcli-list,mm-version,bearer-connect,hil-cycle-fm350}.txt`
(repo-local, gitignored).

---

## RB-17 — Modem-flap resilience under a live bonded stream `[PARTIAL]`

Prove that a modem physically disappearing and returning **while a bonded stream is live**
costs the stream nothing permanent: the link re-registers, the surviving link(s) carry the
stream throughout, and the receiver's SRTLA group count returns to its pre-flap baseline
rather than accumulating stale groups.

> **This is a RESILIENCE runbook, not a certification runbook.** It certifies no SKU and
> produces no catalog entry. It is the acceptance that the device-stable-core effort
> specified and never closed, restated here against the RB-10 hub-cycle mechanism now that
> one exists.

> **The stale-group assertion is the real gate.** A flap that re-registers the link but
> leaves the receiver holding an orphaned SRTLA group is the failure this runbook exists to
> catch: it is invisible on the sender, invisible in the video for one flap, and accumulates
> — five flaps leave five groups, and the receiver's group table is what eventually breaks.
> "The stream kept playing" is **not** a passing RB-17.

**Preconditions**

- **RB-10 passing on the hub carrying the flapped modem.** RB-17 flaps via the RB-10
  mechanism, so a hub that has not proven per-port power switching (`ppps`) cannot host this
  test. On this bench only the `0bda:0411` tree qualifies, and it carries exactly one modem
  (the Quectel at `4-1.4.4`) — see RB-10's per-hub table. `uhubctl` is **not installed on the
  board and not in its apt archive**, so RB-10 itself is unrun.
- **At least TWO links carrying a live bonded stream**, of which the flapped modem is one.
  The surviving link is what proves continuity; flapping a single-link stream proves nothing
  but that the stream dies.
- Receiver-side access to the SRTLA receiver's group count for the baseline assertion.
- A registered modem with a working bearer. **No modem on this bench is registered** — the
  Quectel reports `registration: idle` / `signal quality: 0%`, and the SIMCom has no SIM.

**Commands**

```sh
OUT=test-results/modem-phase-b/08; mkdir -p "$OUT/flap"
HUB=4-1.4; PORT=4; SLOT='platform-xhci-hcd.0.auto-usb-0:1.4.4'; MMSLOT=2

# GROUPS_CMD belongs to the SRTLA RECEIVER deployment used for this run — it is deliberately
# NOT guessed here. It must print the receiver's current SRTLA group count as a bare integer.
# Unset ⇒ the runbook fails closed on the first line rather than silently asserting nothing.
GROUPS_CMD=${GROUPS_CMD:?set GROUPS_CMD to the receiver group-count command before running}

# 0) BASELINE — with the stream LIVE over >=2 links, before any flap.
{
  echo "--- links ---";        ip -br addr
  echo "--- mm ---";           mmcli -L
  echo "--- srtla groups ---"; sh -c "$GROUPS_CMD"
} 2>&1 | tee "$OUT/flap/baseline.txt"

# 1) FLAP x5 within 60 s. Each iteration is one RB-10 hub cycle plus per-flap assertions.
for n in 1 2 3 4 5; do
  echo "===== flap $n ====="
  sudo ./modem-control hil-cycle "$SLOT" --hub-map "$OUT/flap/hub-map.json" --mm-slot "$MMSLOT"
  sleep 3
  echo "--- post-flap links ---";  ip -br addr
  echo "--- post-flap mm ---";     mmcli -L
  echo "--- post-flap groups ---"; sh -c "$GROUPS_CMD"
done 2>&1 | tee "$OUT/flap/flap-x5.txt"

# 2) SETTLE + FINAL GROUP COUNT — must equal the baseline, not merely be "small".
sleep 30
sh -c "$GROUPS_CMD" 2>&1 | tee "$OUT/flap/final-groups.txt"

# 3) STREAM CONTINUITY — the receiver-side record for the whole 60 s window, captured
#    independently of the sender so a sender-side "everything is fine" cannot mask a gap.
```

**Expected output**

Each of the five iterations ends with the RB-10 harness line

```
HIL-CYCLE PASS slot=platform-xhci-hcd.0.auto-usb-0:1.4.4 disappeared=<ms> reenumerated=<ms>
```

and shows the flapped modem back in `mmcli -L` at the same `modem.generic.device` path. The
final group count equals the baseline count **exactly**. The receiver-side continuity record
shows no interruption attributable to the flapped link.

**Machine check**

```sh
OUT=test-results/modem-phase-b/08
flaps=$(grep -c '^HIL-CYCLE PASS ' "$OUT/flap/flap-x5.txt")
base=$(tail -1 "$OUT/flap/baseline.txt" | tr -dc '0-9')
final=$(tail -1 "$OUT/flap/final-groups.txt" | tr -dc '0-9')
[ "$flaps" -eq 5 ] && [ -n "$base" ] && [ "$final" = "$base" ] \
  && echo "RB-17 PASS (flaps=$flaps groups=$final==$base)" \
  || echo "RB-17 FAIL (flaps=$flaps baseline=$base final=$final)"
```

Both clauses are load-bearing. `flaps -eq 5` fails a run that gave up early; `final = base`
fails the stale-group accumulation that a "the stream survived" eyeball check passes.

**Status:** `[PARTIAL]` — unrun, and blocked on **four** independent counts: `uhubctl` is
absent from the board and its archive (so RB-10 is unrun and RB-17's flap mechanism does not
exist yet); no modem on this bench is registered; there is no live bonded stream on this
bench; and only one modem sits behind a `ppps`-capable hub, so a two-link flap cannot be
staged there at all. The `GROUPS_CMD` fill-in is deliberate — the receiver-side command
belongs to the SRTLA receiver deployment used for the run and must be taken from it, not
guessed here; the `${GROUPS_CMD:?…}` guard makes an unfilled run fail closed on line one.

**Evidence:** `test-results/modem-phase-b/08/flap/{baseline.txt,flap-x5.txt,final-groups.txt,hub-map.json}`

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
| RB-10 | Hub VBUS verification | `[PARTIAL]` | `test-results/modem-phase-b/07/{uhubctl-discovery,uhubctl-ppps,vbus-drop-proof,vbus-drop-proof-nosysfs}.txt` + `hil-cycle-<slot>.txt` |
| RB-11 | Quectel RM530N-GL certification capture (QMI) | `[PARTIAL]` | `test-results/modem-phase-b/08/quectel-rm530n-gl/{certify.txt,bundle.json,qmi-facts.txt,transition-candidate.txt}` |
| RB-12 | Sierra EM75xx certification capture (MBIM/QMI, FCC-locked) | `[PARTIAL]` | `test-results/modem-phase-b/08/sierra-em75xx/{certify.txt,bundle.json,fcc-locked-state.txt,fcc-policy.txt}` |
| RB-13 | SIMCom SIM7600G-H certification capture (QMI raw-IP) | `[PARTIAL]` | `test-results/modem-phase-b/08/simcom-sim7600g-h/{certify.txt,bundle.json,raw-ip-state.txt,rndis-observation.txt}` |
| RB-14 | Huawei personality capture (Stick vs HiLink) | `[PARTIAL]` | `test-results/modem-phase-b/08/huawei/{personality-sweep.txt,id-path-fallback.txt,personality-switch-observation.txt}` |
| RB-15 | ZTE MF79U router-mode capture | `[PARTIAL]` | `test-results/modem-phase-b/08/zte-mf79u/{class-evidence.txt,lan-dhcp.txt,web-ui.txt}` |
| RB-16 | Fibocom FM350 USB-vs-PCIe probe | `[PARTIAL]` | `test-results/modem-phase-b/09/{usb-sweep,driver-binding,pcie-sweep,mmcli-list,mm-version,bearer-connect,hil-cycle-fm350}.txt` |
| RB-17 | Modem-flap resilience under a live bonded stream | `[PARTIAL]` | `test-results/modem-phase-b/08/flap/{baseline.txt,flap-x5.txt,final-groups.txt,hub-map.json}` |

Every row stays `[PARTIAL]` until its evidence artifact is captured on a real bench device
and its machine check prints `PASS`. No row may be claimed `[EXISTS]` on the strength of the
CI proxy alone — the CI proxy is green (compiled probe smoke both arches, packaging contract
+ daemon smoke in a bookworm container, the full `bun test` suite), but the hardware evidence
is what closes each gate.
