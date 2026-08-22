# ADR — FM350-GL RNDIS bearer gap, and the decision to forward-port the BELABOX plugin

**Status:** PROPOSED. Not accepted, not landed. No quilt patch exists in `packaging/` as a
result of this record, and none may be added on its strength alone.
**Date:** 2026-08-22
**Deciders:** modem-stack maintainers. Second-maintainer review is OUTSTANDING (see §7).
**Supersedes:** nothing. **Amends:** [`docs/FM350-DECISION.md`](../FM350-DECISION.md) by adding
the bearer-layer analysis that record deliberately left open.

---

## 1. What this ADR is for

[`POLICY.md`](../../POLICY.md) §1 forbids carrying any quilt patch in `packaging/` without
four things: an exact defect rationale, a statement of why a rebuild cannot close it, a filed
upstream merge request, and second-maintainer sign-off. This document is the rationale half of
that gate for exactly one candidate patch series: the seven BELABOX `fm350gl` commits that add
a Fibocom FM350-GL plugin to ModemManager.

It records evidence and a plan. It authorizes no code. §7 is the honest status of each of the
four POLICY requirements, and two of them are not met.

---

## 2. The defect, measured on the board

The bench Fibocom FM350-GL registers on the network and attaches to the packet service, and
then cannot open a data session. Every bearer attempt fails identically:

```
MM: [modem10] simple connect state (6/10): register
MM: [modem10] simple connect state (7/10): wait to get packet service state attached
MM: [modem10] simple connect state (8/10): bearer
MM: [modem10] simple connect state (9/10): connect
MM: [modem10/bearer7] connection attempt #1 failed: 0,NONE
NM: modem-broadband[ttyUSB12]: failed to connect modem: Operation not supported: 0,NONE

mmcli -b 7 -> connection error name: org.freedesktop.ModemManager1.Error.MobileEquipment.NotSupported
              apn: internet.movistar.com.co · ip type: ipv4
```

Everything upstream of the dial is healthy. `+CEREG: 0,1` confirms EPS registration,
`+COPS: 0,0,"Movistar",7` confirms E-UTRAN, MM reports `registered · home · packet service
attached · signal 60%`, and the APN resolved correctly. The RNDIS network interface
`enx000011121314` comes up `UP,LOWER_UP` with an IPv6 link-local address and **no IPv4**.

Board: `ceralive2`, RK3588, kernel `7.1.7-ceralive-rk3588`, packaged ModemManager
`1.24.2-2~ceralive0.2.0`.

Evidence:
[`session-amendment-fm350-no-connection.md`](#8-evidence-index) §3, and the modes/state dump
`test-results/modem-phase-b/65/mmcli-dump.txt:64-66`, which is where the coarse
`allowed: 2g, 3g, 4g, 5g; preferred: none` capability line lives.

### 2.1 Why the dial fails — the mechanism, not the symptom

The device enumerates over USB as `0e8d:7127`: ten interfaces, `rndis_host` ×2 plus `option`
×7 plus one unbound ADB interface, `bNumConfigurations = 1`. There is **no MBIM function and
no QMI function**, so ModemManager finds no `cdc_mbim` or `qmi_wwan` port, matches no vendor
plugin's id table, and falls back to `plugin: generic`.

The generic broadband bearer's `dial_3gpp` in ModemManager 1.24.2 builds exactly one command
(`src/mm-broadband-bearer.c:565`):

```c
    command = g_strdup_printf ("ATD*99***%d#", cid);
```

That is a PPP-over-serial dial. The FM350-GL in an RNDIS composition does not implement it —
its data plane is the RNDIS network interface, and the context is brought up with
`+CGACT=1,<cid>` while addressing and DNS are read back with `+CGCONTRDP` / `+CGPADDR`. The
modem answers the `ATD` with a bare `0,NONE`, which MM surfaces as
`MobileEquipment.NotSupported`.

So the failure is not a misconfiguration, a SIM problem, an APN problem, or a NetworkManager
problem. ModemManager is dialing a modem over a mechanism that modem does not have, because
nothing in the shipped source tree knows this device.

---

## 3. Upstream 1.24 does not cover this device (POLICY §1.1 — "why a rebuild cannot")

This is the load-bearing finding, and it is the answer to "just rebuild a newer
ModemManager." A newer ModemManager does not help, because upstream's FM350 support is for a
different bus, a different driver, and a different control protocol.

**Upstream FM350 support is `src/plugins/mtk/`, and it is MBIM-over-t7xx-PCIe.** It arrived in
upstream commit `11a1720daffb01f71ff4f6bd3d762cc06013ad96` — *"mtk: add FM350 specific MBIM
implementation"*, Aleksander Morgado, 2023-11-06 — released in ModemManager 1.24.0, whose
`NEWS` entry reads:

```
   ** mtk: new plugin with MBIM support for t7xx devices (eg FM350, L850, etc)
```

The device path into that code is **triple-gated**, and the bench unit fails all three gates.
From `src/plugins/mtk/mm-plugin-mtk.c` at tag `1.24.2`:

```c
    static const gchar *subsystems[] = { "wwan", "net", NULL };
    static const gchar *drivers[] = { "mtk_t7xx", NULL };
```

```c
#if defined WITH_MBIM
    if (mm_port_probe_list_has_mbim_port (probes)) {
        /* FM350 support with Fibocom-specific changes */
        if (vendor == 0x14c3 && product == 0x4d75) {
```

| Gate | Upstream requires | Bench unit is | Reached? |
|------|-------------------|---------------|----------|
| Kernel driver | `mtk_t7xx` (PCIe WWAN) | `rndis_host` + `option` (USB) | no |
| Port probe | an MBIM port present | no MBIM function in the composition | no |
| Identity | PCI `0x14c3:0x4d75` | USB `0e8d:7127` | no |

The mtk plugin declares no `MM_PLUGIN_ALLOWED_VENDOR_IDS` at all — it matches purely by PCIe
driver and subsystem, so the USB vendor id `0e8d` is not merely absent from a table, there is
no table for it to be absent from. `mtk_t7xx` is not loaded on this board and
`/sys/class/wwan/` does not exist.

**There is no `fm350gl` plugin anywhere upstream.** A directory listing of `src/plugins/` at
tag `1.24.2` and on current `main` contains no `fm350gl`; a search of upstream history finds
no commit adding one. The FM350's USB/RNDIS composition is unsupported by ModemManager today
and by every released version of it.

**Therefore a rebuild cannot close this gap.** Rebuilding 1.24.2, or 1.26 when it exists, or
`main`, produces the identical `ATD*99***1#` and the identical `0,NONE`. The missing code has
never been written upstream. That is precisely the condition POLICY §1.2.1 describes as a gap
a rebuild alone cannot close.

### 3.1 The alternatives, and why each is closed

Both non-patch escape routes were tested on hardware and both are closed.

- **Switch the composition to MBIM so an existing plugin binds — CLOSED.**
  `AT+GTUSBMODE=40` was sent on the real unit on 2026-08-19 with explicit authorization, and
  it was reverted the same session. It is accepted, non-volatile, and applied only on
  `AT+CFUN=1,1`. It works, and it does not help: mode 40 re-enumerates as `0e8d:7126` with
  eight interfaces instead of ten, and it is **still RNDIS** — no MBIM, no QMI. The delta is
  two fewer vendor COM ports and the ADB interface moving from slot 5 to slot 3. Downstream,
  mode 40 is identical: `plugin: generic`, the same `MobileEquipment.NotSupported: 0,NONE`,
  no IPv4, the same coarse mode line — plus a `NETDEV WATCHDOG: transmit queue 0 timed out`
  regression the mode-41 composition does not produce. `AT+GTUSBMODE=?` answers `(40,41)`, so
  the whole domain is enumerated and **both members are RNDIS**. There is no MBIM composition
  to switch to on firmware `81600.0000.00.19.17.10`. The board was returned to mode 41 /
  `0e8d:7127` and verified byte-for-byte at baseline.
- **A vendor "just dial the RNDIS session" AT escape hatch — ABSENT.** `+GTRNDIS`,
  `+GTAUTOCONNECT`, `+GTIPPASSTHROUGH`, `+GTDATAMODE` and `+GTFLAGS` all answer
  `+CME ERROR: 100` on this firmware.
- **A firmware update adding an MBIM composition — UNTESTED, and not a packaging decision.**
  It is the only route that could make the device reachable by existing upstream code. It is
  recorded here as an open option, not as a plan.

### 3.2 The second, related gap this evidence characterises

While the AT port was open, a read-only sweep found that the hardware **does** expose granular
RAT and band selection:

```
AT+GTACT?   -> +GTACT: 4,3,,1,2,4,5,8,101,102,...,166
AT+GTACT=?  -> +GTACT: (1,2,4,10,14,16,17,20),(2,3,6),(2,3,6),(),(1,2,4,5,8),(101,...,171),(),(),(501,...,5079)
AT+WS46?    -> 31
AT+WS46=?   -> (12,22,25,28,29,30,31)
```

ModemManager reports one flattened `allowed: 2g, 3g, 4g, 5g; preferred: none` combination and
`supported-bands: --` (`test-results/modem-phase-b/65/mmcli-dump.txt:64-66`) because the
`generic` plugin does not know `+GTACT`. This is a **plugin-coverage gap, not a hardware
limit**, and it has the same root cause as §2.1: no plugin claims the device. It is recorded
for completeness; the BELABOX series below does not address `+GTACT`, so closing it is
separate work.

---

## 4. The candidate patch series — per-commit upstream-status table

The BELABOX ModemManager fork (`github.com/BELABOX/modemmanager`) carries seven commits that
add and then fix an `fm350gl` plugin for exactly this composition. Its plugin matches
`{0x0e8d, 0x7126}` and `{0x0e8d, 0x7127}` on the `tty` + `net` subsystems — both of the bench
unit's observed identities — and its bearer replaces the `ATD` dial with `+CGACT=1,<cid>`,
reading addressing back with `+CGCONTRDP` / `+CGPADDR` and returning the RNDIS net port as the
data port. That is the mechanism §2.1 says is missing.

The series is based on upstream `616df80418612fa9e0f78d34049767e118d60204` (2023-10-17,
pre-1.24), so every commit needs rebasing onto 1.24.2 rather than applying as-is.

| # | SHA (full) | Subject | Files | Upstream status | Verdict |
|---|-----------|---------|-------|-----------------|---------|
| 1 | `da01610c46c581b0c6f2acd0ac50f5bba666efdf` | `FM350GL: backport FM350GL patch` | new `src/plugins/fm350gl/` (7 files, +1697), `meson.build`, `meson_options.txt`, `src/plugins/meson.build`, `src/plugins/mm-builtin-plugins.c` | **NOT UPSTREAM.** No `fm350gl` plugin exists at `1.24.2` or on `main`. The commit message cites upstream issue [#899](https://gitlab.freedesktop.org/mobile-broadband/ModemManager/-/issues/899) as the origin of the code; no merge request carrying it has landed. | **REQUIRED.** This is the whole fix. Everything else in the table is a bug fix on top of it. Largest forward-port risk: it adds a plugin to the build system, and 1.24's plugin build was reorganized after the base commit. |
| 2 | `b4377c5028a0de4435b86f7aad9114e9443d69e4` | `fm350gl: disable CPOL command that crashes the modem` | `src/plugins/fm350gl/77-mm-fm350gl.rules` (+3) | **MECHANISM IS UPSTREAM; THIS DATA ROW IS NOT.** `ID_MM_PREFERRED_NETWORKS_CPOL_DISABLED` is a first-class upstream udev tag, consumed at `src/mm-base-sim.c:1066` and already used by the huawei, sierra, simtech and telit rules files on `main`. No rule tags `0e8d:712[6-7]`. | **REQUIRED, and the most independently landable row.** It is three lines of device data using an upstream-blessed tag. It needs a rules file to live in, though, and upstream has none for this device — so in practice it lands with commit 1. |
| 3 | `419dc598d3f2c11f479dacdc2f6ef0e787e6ea3b` | `fm350gl: delay initialization to avoid crashing on AT+GCMR` | `src/plugins/fm350gl/mm-broadband-modem-fm350gl.c` (+40) | **NOT UPSTREAM** (depends on commit 1). | **REQUIRED but WEAKEST.** It is a fixed 4000 ms sleep before `load_current_capabilities`, chosen by the author as "2500 ms observed worst case, doubled out of caution." A hardcoded settle delay is the row most likely to draw upstream review objections, and it is the row a reviewer should scrutinise hardest. Dropping it risks crashing the modem at probe; keeping it costs four seconds on every FM350 enumeration. |
| 4 | `90bcd376405906d3a94b0c239689eef1a3899ed2` | `fm350gl: fix DNS parsing for IP4-only networks` | `src/plugins/fm350gl/mm-broadband-bearer-fm350gl.c` (+12/−32) | **NOT UPSTREAM** (depends on commit 1). | **REQUIRED.** The original code demanded ≥30 `+CGCONTRDP` fields and hard-failed an IPv4-only reply; this relaxes the floor to 7 and reads the IPv6 DNS pair only when present. The bench SIM is on an IPv4 APN (`internet.movistar.com.co`, `ip type: ipv4`), so without this the bearer would fail even after commit 1. |
| 5 | `9e2bc4992a251b02f75280a2d2b1020227d2bfe8` | `fm350gl: fix modem_set_current_modes_finish()` | `src/plugins/fm350gl/mm-broadband-modem-fm350gl.c` (+1/−1) | **NOT UPSTREAM** (depends on commit 1). | **REQUIRED.** One-line correctness fix in the same file. Fold into commit 1 when forward-porting; there is no reason to carry it separately. |
| 6 | `43e09a768e3855f3afb93e517902c1e0e25ed676` | `fm350gl: update +COPS handler to match nonstandard fm350gl format` | `src/mm-modem-helpers.c` (+8/−2) | **NOT UPSTREAM, AND STILL OPEN.** Verified directly: the regex at `1.24.2:src/mm-modem-helpers.c:1277` and at `main:src/mm-modem-helpers.c:1296` are byte-identical and neither tolerates the extra field. | **REQUIRED, and the ONLY row that is genuinely standalone.** It touches shared core code, not the plugin, so it can be offered upstream on its own merit and does not depend on commit 1. The FM350 emits an extra unknown value between the operator code and the access technology (`+COPS: (2,"","EE","23430","609C",7)`); the patch makes that group optional and shifts the access-tech capture from 5 to 6. Upstream has a test file for exactly this parser (`src/tests/test-modem-helpers.c`), so a test case is cheap and should accompany it. |
| 7 | `9716d38b6a81a79b47a16ea96c27164219de6739` | `fm350gl: fix load_current_modes_finish() for 4G-only mode` | `src/plugins/fm350gl/mm-broadband-modem-fm350gl.c` (+6) | **NOT UPSTREAM** (depends on commit 1). | **REQUIRED.** Same file as 3 and 5. Fold into commit 1 when forward-porting. |

Independent verdict summary: seven commits, **zero already upstream**, one (`43e09a76`)
standalone-landable, one (`b4377c50`) using an upstream mechanism but with no upstream file to
land in, and five inseparable from the plugin itself.

**Nothing in this table has been applied.** No `.patch` file, no `series` entry, no build
change. `packaging/ModemManager/debian/` has **no `patches/` directory at all** — verified
2026-08-22. (The one `.patch` file anywhere under `packaging/ModemManager/` is
`debian/tests/0001-Test-running-service-in-plugin-generic.patch`, an autopkgtest fixture that
arrived byte-identical from the pinned salsa packaging tag and is not a source patch.)

---

## 5. Forward-port plan

Nothing below happens until §7's gates are all green.

1. **Rebase onto 1.24.2.** The series is based on pre-1.24 `616df804`. The plugin build system
   is where breakage is expected: `src/plugins/meson.build` and
   `src/plugins/mm-builtin-plugins.c` both changed upstream after the base commit. Squash
   commits 3, 4, 5 and 7 into commit 1 — they are all fixes to files commit 1 introduces, and
   a reviewer reading a plugin plus four of its own bug fixes is being asked to review noise.
   Keep commits 2 and 6 separate: 2 is device data, 6 is a shared-core fix.
2. **Split the offer.** File `43e09a76` (the `+COPS` quirk) as its own upstream merge request
   with a test case in `src/tests/test-modem-helpers.c`. It stands on its own, it is small,
   and it is the row most likely to be accepted quickly. File the plugin as a second merge
   request against upstream issue #899.
3. **Do not add a quilt patch until the upstream MR exists and has an outcome.** POLICY §2 is
   upstream-contribution-first: the offer precedes the carry. If upstream declines or stalls,
   POLICY §1's gate is what authorizes the local carry, and it needs all four requirements.
4. **When (and only when) the carry is authorized**, the patch lands as
   `packaging/ModemManager/debian/patches/` entries with a `series` file, one patch per logical
   change, each carrying a DEP-3 header naming the upstream MR URL and this ADR. That is the
   first non-empty `series` in this repository's history, so it flips the "zero quilt patches"
   claim in `packaging/README.md`, `AGENTS.md` and `POLICY.md` — all three need updating in the
   same change under Rule A.
5. **Prove it on the board before claiming it.** The acceptance test is not "it builds." It is:
   the FM350 binds the `fm350gl` plugin instead of `generic`, the bearer connects, and
   `enx000011121314` carries a real IPv4 address and routes. Anything short of that is an
   unproven patch, and this repository does not claim unproven things.
6. **Re-verify on every upstream bump.** A carried patch is a merge liability against
   ModemManager's device database — that is exactly what `POLICY.md` §3 warns about. Each
   `upstream-pins.yaml` bump must re-apply and re-test the series, and the series is retired
   the moment upstream ships equivalent support.

**Scope note.** The `+GTACT` granular-modes gap from §3.2 is NOT in this series and is not
closed by it. Do not let this ADR be read as covering it.

---

## 6. Decision

Record the gap, offer the fix upstream, and carry nothing yet.

Concretely: the FM350-GL's USB/RNDIS composition is unsupported by ModemManager and cannot be
made supported by rebuilding, by a composition switch, or by a vendor AT command. The BELABOX
`fm350gl` series is the only known working fix, and the correct first move under POLICY §2 is
an upstream merge request, not a downstream patch. This ADR authorizes the upstream offer and
the forward-port work in §5 steps 1-2. It authorizes no change to `packaging/`.

---

## 7. POLICY.md §1 gate — each requirement, answered

`POLICY.md:11-25` names four requirements. Two are met by this document, one is blocked on
access, one is owner-gated.

| # | POLICY requirement | Status | Evidence |
|---|--------------------|--------|----------|
| a | **Rationale** — the exact defect or gap the patch closes | **MET** | §2 (board-measured `MobileEquipment.NotSupported: Operation not supported: 0,NONE`, with the registration and packet-attach context that rules out every upstream-of-the-dial cause) and §2.1 (the `ATD*99***%d#` mechanism at `1.24.2:src/mm-broadband-bearer.c:565` against an RNDIS-only composition). |
| b | **Why a rebuild cannot** close it | **MET** | §3. Upstream FM350 support is the `mtk` plugin, gated on the `mtk_t7xx` PCIe driver AND an MBIM port AND PCI `0x14c3:0x4d75`; the bench unit clears none of the three. No `fm350gl` plugin exists at `1.24.2` or on `main`. §3.1: the composition switch was tested on hardware (`AT+GTUSBMODE=40`) and reverted — both members of the `(40,41)` domain are RNDIS, so there is no MBIM composition to reach. |
| c | **Upstream MR** filed | **NOT MET — DRAFTED, NOT FILED.** | The full merge-request content (title, description, commit list, test plan) is written and ready at [`FM350-UPSTREAM-MR-DRAFT.md`](FM350-UPSTREAM-MR-DRAFT.md). It has **not** been submitted to `gitlab.freedesktop.org/mobile-broadband/ModemManager` because this repository's tooling holds no GitLab credentials for that instance and the host is behind an interactive anti-bot challenge. **No MR URL exists, and none is claimed here.** Filing requires an owner with GitLab write access; the URL is recorded in this table and in the draft the moment it does. |
| d | **Review** — second-maintainer sign-off | **NOT MET — OWNER-GATED CHECKBOX.** | ☐ Second maintainer has reviewed this ADR on `POLICY.md`'s terms. This box is unchecked and is **not** satisfied by the existence of this document. Verifying it is the job of the downstream patch-series task (plan `modem-control-ui-parity` todo 16), which must not land a patch while it is unchecked. |

**Two of four requirements are unmet, so the gate is CLOSED.** No patch may land. That is the
correct and expected state for this ADR at the moment it is written — the gate is designed to
be closed until a human opens it.

---

## 8. Evidence index

| Source | What it carries |
|--------|-----------------|
| `.omo/notepads/modem-phase-c-quality/evidence/session-amendment-fm350-no-connection.md` | The 2026-08-19 board session that isolated the bearer failure: the `0,NONE` transcript, the RNDIS-composition diagnosis, and the finding that it is downstream of a separate (since-fixed) CeraUI hot-plug defect. |
| `.omo/notepads/modem-phase-c-quality/evidence/session-amendment-fm350-gtusbmode40.md` | The 2026-08-19 `AT+GTUSBMODE=40` hardware trial and revert: 18 raw artifacts, the mode-40/41 descriptor diff, the NV-persistence proof, the `+GTACT`/`+WS46` sweep, and the closure inventory. |
| `test-results/modem-phase-b/65/` | RB-16 re-run bundle (repo-local, gitignored). `mmcli-dump.txt:64-66` is the coarse supported/current-modes evidence cited in §3.2. |
| [`docs/FM350-DECISION.md`](../FM350-DECISION.md) | The prior record: the MM-source audit, Citation 6's USB observation, the adapter-mediated Branch-A closure, and the three-gate ledger this ADR does not touch. |
| [`docs/COMPOSITION-EVIDENCE.md`](../COMPOSITION-EVIDENCE.md) | The non-mutating 2026-08-18 composition capture, including `AT+GTUSBMODE?` → `41` and `=?` → `(40,41)`. |
| `github.com/BELABOX/modemmanager` | The seven commits in §4, read directly from the repository at the SHAs listed. |
| `github.com/linux-mobile-broadband/ModemManager` | Upstream, read at tag `1.24.2` and on `main` for every upstream-status claim in §3 and §4. |

---

## 9. What this ADR does NOT do

- It does not add, stage, or authorize a quilt patch. `packaging/` is unchanged.
- It does not claim an upstream merge request exists.
- It does not claim second-maintainer review has happened.
- It does not change [`docs/FM350-DECISION.md`](../FM350-DECISION.md)'s three-gate ledger, its
  documented-deferred PCIe conclusion, or its no-classifier-entry decision.
- It does not promote the FM350 in `docs/MODEM-SUPPORT-MATRIX.md`, and it adds no catalog or
  certification claim of any kind.
- It does not address the `+GTACT` granular-modes gap (§3.2).
