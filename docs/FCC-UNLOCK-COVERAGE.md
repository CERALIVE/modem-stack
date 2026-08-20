# FCC-unlock coverage matrix

Which modems ModemManager can FCC-unlock, and which of them CeraLive actually has.

**Status:** `[EXISTS]` — the matrix below is derived from ModemManager **1.24.2**
(`packaging/upstream-pins.yaml`), the exact release this repository rebuilds, and
from the live bench inventory captured on `ceralive2` (2026-08-17). Nothing here is
recalled or inferred from documentation.

---

## 1. What an FCC unlock is, and what ModemManager does about it

Some modems ship from the factory in a state where the radio refuses to transmit
until a vendor-specific unlock command is sent. The lock is a **regulatory**
(FCC-certification) interlock, not a SIM lock, and it **re-applies on every power
cycle** — a modem that needs it needs it again after every boot.

Since **1.18.4** ModemManager no longer performs that unlock automatically. It
ships the vendor procedures as *disabled* scripts and requires an explicit,
per-device opt-in. There are **three directories**, and only the last two are
consulted at runtime:

| Tier | Path (Debian) | Role |
|---|---|---|
| **available** | `/usr/share/ModemManager/fcc-unlock.available.d/` | shipped-but-INERT. ModemManager owns it. Nothing here ever runs. |
| **enabled — admin** | `/etc/ModemManager/fcc-unlock.d/` | the ADMIN opt-in tier. **This is the tier CeraLive uses.** |
| **enabled — package** | `${libdir}/ModemManager/fcc-unlock.d/` (multiarch) | the tier a distribution package would own. **CeraLive ships nothing here, ever.** |

The dispatcher (`src/mm-dispatcher-fcc-unlock.c`) builds ONE filename —

```c
filename = g_strdup_printf ("%04x:%04x", vid, pid);
```

— and looks for exactly that name in the admin tier first, then the package tier.
**It consults no other name.** A vendor-only file (`2c7c`) is therefore never
opened by the dispatcher; it is only ever the *target* of a `<vid>:<pid>` link.

### The available tier is 4 scripts and 14 links

`data/dispatcher-fcc-unlock/` in ModemManager 1.24.2 contains four real scripts,
one per vendor, and the build installs a `<vid>:<pid>` symlink onto the right one
for every model the vendor script covers (`meson.build`, the `vidpids` dict).

| Vendor script | Talks to the modem via |
|---|---|
| `105b` (Foxconn) | `mbimcli` |
| `1199` (Sierra Wireless) | `qmicli` |
| `14c3` (MediaTek / Fibocom) | `mbimcli` |
| `2c7c` (Quectel) | `qmicli` |

**Runtime dependency — asserted, not assumed.** Those scripts call `qmicli` and
`mbimcli`, which are shipped by `libqmi-utils` and `libmbim-utils`. Both are
members of the frozen nine-package runtime closure this repository builds and
`apt-worker` publishes (`packaging/ci/expected-packages.txt`,
`apt-worker/scripts/modem-closure-lib.sh`), so the unlock path can never be
activated on a device that lacks its own interpreter. A device that somehow did
would see the dispatcher fail loudly rather than silently no-op.

---

## 2. ModemManager 1.24.2's complete shipped mapping (14 entries)

Every `<vid>:<pid>` ModemManager 1.24.2 can unlock. There are no others.

| `<vid>:<pid>` | Vendor script | Device |
|---|---|---|
| `03f0:4e1d` | `1199` | HP lt4120 / lt4132 (Sierra silicon, HP-branded) |
| `105b:e0ab` | `105b` | Foxconn T77W968 (Fibocom L850-GL class) |
| `105b:e0c3` | `105b` | Foxconn T99W175 (Snapdragon X55 class) |
| `1199:9079` | `1199` | Sierra Wireless EM7455 / MC7455 |
| `14c3:4d75` | `14c3` | Fibocom FM350-GL — **PCIe/MediaTek identity** |
| `1eac:1001` | `2c7c` | Quectel-silicon OEM rebrand |
| `1eac:1004` | `2c7c` | Quectel-silicon OEM rebrand |
| `1eac:1007` | `2c7c` | Quectel-silicon OEM rebrand |
| `2c7c:030a` | `2c7c` | Quectel EM120R-GL |
| `2c7c:0313` | `2c7c` | Quectel EM160R-GL |
| `2c7c:0314` | `2c7c` | Quectel EM060K-GL |
| `2c7c:0801` | `2c7c` | **Quectel RM520N-GL / RM530N-GL** |
| `413c:81a3` | `1199` | Dell DW5811e (Sierra silicon, Dell-branded) |
| `413c:81a8` | `1199` | Dell DW5816e (Sierra silicon, Dell-branded) |

**Vendor-branding is per-PID, and that is the trap.** Sierra silicon appears three
times under three different vendor ids (`1199`, `03f0`, `413c`) because HP and Dell
re-badge the USB descriptor. A rule keyed on the vendor id alone would miss two of
the three; a rule keyed on the model would miss the OEM rebrands. The dispatcher's
`<vid>:<pid>` key is the only correct one, which is why CeraLive's policy keys on
it too.

---

## 3. The CeraLive bench fleet against that mapping

Captured live on `ceralive2` (RK3588, kernel `7.1.7-ceralive-rk3588`, 2026-08-17 —
`.omo` todo-2 hardware gate). Every VID:PID below was read from the device, not
from a datasheet.

| Device | `<vid>:<pid>` | Covered by MM 1.24.2? | Notes |
|---|---|---|---|
| **Quectel RM530N-GL** | `2c7c:0801` | ✅ **YES** — `2c7c` script | The one fleet modem with a shipped unlock procedure. |
| Fibocom FM350-GL (via M.2→USB adapter) | `0e8d:7127` | ❌ no | MM covers the FM350's **PCIe** identity `14c3:4d75`. On the USB adapter the carrier board re-enumerates it under MediaTek's `0e8d` vendor id, which is **not** in the mapping. See `docs/FM350-DECISION.md`. |
| SIMCom SIM7600G-H R2 | `1e0e:9001` | ❌ no | SIMCom ships no MM unlock script. |
| Huawei E3372 HiLink (twin A) | `12d1:14dc` | ❌ no | Router-mode dongle; no AT/QMI control port for a script to use. |
| Huawei E3372 HiLink (twin B) | `12d1:14dc` | ❌ no | Same model, same answer — the toggle is per MODEL, so the twins are inseparable by construction. |
| ZTE MF79U-class | `19d2:1405` | ❌ no | Router-mode dongle. |
| Qualcomm dual-mode stick (`2b16081`) | `05c6:9024` ⇄ `05c6:9091` | ❌ no | Generic Qualcomm reference ids; both compositions are uncovered. |
| Qualcomm dual-mode stick (`c6125db3`) | `05c6:9091` | ❌ no | Same. |

**Coverage: 1 of 8 fleet devices.** That number is the reason this module is
capability-gated per model rather than offered device-wide: on seven of the eight,
turning it on would create a symlink the dispatcher would never open.

---

## 4. Common market modems not in the fleet

For operators buying hardware, the same matrix from the buyer's side. "Covered"
means an unlock procedure ships with ModemManager 1.24.2 and can be activated by
the CeraLive toggle.

| Modem | `<vid>:<pid>` | Covered? |
|---|---|---|
| Quectel RM520N-GL / RM530N-GL | `2c7c:0801` | ✅ |
| Quectel EM160R-GL | `2c7c:0313` | ✅ |
| Quectel EM120R-GL | `2c7c:030a` | ✅ |
| Quectel EM060K-GL | `2c7c:0314` | ✅ |
| Sierra Wireless EM7455 / MC7455 | `1199:9079` | ✅ |
| Dell DW5811e / DW5816e | `413c:81a3` / `413c:81a8` | ✅ |
| HP lt4120 / lt4132 | `03f0:4e1d` | ✅ |
| Foxconn T77W968 / T99W175 | `105b:e0ab` / `105b:e0c3` | ✅ |
| Fibocom FM350-GL (native PCIe) | `14c3:4d75` | ✅ |
| Fibocom FM350-GL (USB carrier) | `0e8d:7127` | ❌ |
| Quectel EC25 / EG25-G | `2c7c:0125` | ❌ — not FCC-locked; no script needed |
| SIMCom SIM7600 family | `1e0e:9001` | ❌ |
| Huawei / ZTE router-mode dongles | `12d1:*` / `19d2:*` | ❌ |
| Telit LN940 / LM940 | `1bc7:*` | ❌ |

A modem in the ❌ rows is not necessarily locked — most consumer dongles never
were. The absence of a script means only that ModemManager has no procedure to
run, so CeraLive offers no toggle.

---

## 5. What CeraLive does with this

### The policy of record lives in `/data`, not in `/etc`

`/etc` is on the rootfs, and the rootfs is what a RAUC A/B slot swap REPLACES
(`image-building-pipeline/docs/partition-contract.md`). A symlink written into
`/etc/ModemManager/fcc-unlock.d/` therefore survives a reboot and does **not**
survive an OTA. `/data` is the only update-surviving store, so the durable record
is a file there:

```
/data/ceralive/fcc-unlock-policy.json    mode 0600
```

```json
{ "schemaVersion": 1, "savedAtMs": 1755500000000, "unlock": { "2c7c:0801": true } }
```

The symlink is a *derived artifact*, re-created from that file on every boot by
`ceralive-fcc-reconcile` (a oneshot ordered `Before=ModemManager.service`, with
`RequiresMountsFor=/data` and `After=ceralive-migrate-data.service` so it can never
race an unmounted or unmigrated `/data` and silently skip an enabled model).

### Default-OFF is absolute

- No key present ⇒ no symlink ⇒ no unlock. An absent policy file is exactly this.
- A malformed policy is treated as absent — fail-safe, never fail-open. A file we
  cannot read must not be read as consent to touch a regulatory-locked radio.
- **CeraLive authors no unlock script.** Not in `/etc`, not in the multiarch
  package tier, not anywhere. If one is ever needed it ships INACTIVE alongside
  ModemManager's own `available.d` and is activated through the same per-model
  opt-in — there is no second mechanism.
- Automation is confined to ModemManager's own dispatcher. There is no CeraLive
  startup AT channel, and the AT-lease engine is not involved.

### The toggle is per MODEL, and the UI says so

The mechanism is a symlink named `<vid>:<pid>`, so it applies to **every attached
device matching that VID:PID** — the two Huawei twins on this bench are the shape
of the problem, and no per-unit refinement is possible without changing
ModemManager. The toggle is therefore modelled and labelled per model, and the
disclosure is part of the control rather than a footnote.

### Enabling has no retroactive effect

ModemManager runs the dispatcher during modem *initialization*. A modem already
enumerated when the toggle flips is not re-processed, so the toggle RPC performs a
re-probe (`mmcli -m <id> --disable && --enable`) under the mutation lease; a replug
has the same effect.

---

## 6. Certification status

| Claim | State |
|---|---|
| The policy store, the reconciler and the per-model toggle behave as documented | proven by unit tests + the packaging chroot contract |
| The reconciler activates the right link on a real board before ModemManager starts | **bench-gated** — see `.omo/notepads/modem-phase-c-quality/evidence/todo33.md` |
| An actually-FCC-locked modem is unlocked on every boot | **BLOCKED — no such modem exists on this bench.** Todo 2's hardware gate `needs-user N2` recorded the search: three modems `failed`/`sim-missing`, one `searching`, and `journalctl -u ModemManager \| grep -iE 'fcc\|unlock'` produced only SIM-absence lines and **no FCC-lock line at all**. The FM350-GL — the likeliest candidate — cannot be distinguished while no SIM is present. The **no-op path** is what gets tested, which is the outcome this work anticipated. |

The claim this documentation may make is therefore: *the opt-in mechanism is
implemented and its no-op path is proven.* It is not: *CeraLive unlocks
FCC-locked modems.* That second sentence needs an FCC-locked modem on a bench.
