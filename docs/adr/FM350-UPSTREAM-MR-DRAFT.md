# Upstream merge-request draft — Fibocom FM350-GL over USB/RNDIS

**Status: DRAFTED, NOT FILED.**

This is the complete content of the merge request(s) that
[`ADR-FM350-RNDIS-BEARER.md`](ADR-FM350-RNDIS-BEARER.md) commits to offering upstream. It has
**not** been submitted.

**Why not.** The target is
`https://gitlab.freedesktop.org/mobile-broadband/ModemManager`. This repository's tooling holds
no credentials for that GitLab instance, and the host sits behind an interactive proof-of-work
anti-bot challenge that a non-interactive client cannot clear. Filing needs an owner with
GitLab write access on freedesktop.org.

**No merge-request URL exists.** None is recorded anywhere in this repository, and inventing one
would defeat the entire purpose of `POLICY.md` §1's upstream-MR requirement. When the MRs are
filed, fill in §5 below and the corresponding row of the ADR's §7 gate table in the same change.

The offer is split into **two** merge requests, for the reason given in the ADR §5.2: one of the
seven commits is a shared-core fix that stands entirely on its own and should not be held
hostage to review of a 1700-line new plugin.

---

## MR 1 — `mm-modem-helpers: accept the FM350-GL's non-standard +COPS=? field`

**Target:** `mobile-broadband/ModemManager`, branch `main`
**Type:** bug fix, core
**Size:** one file, +8 / −2, plus a test case

### Title

```
mm-modem-helpers: tolerate an extra field in +COPS=? operator entries
```

### Description

```
Some Fibocom FM350-GL firmware emits an additional, undocumented value between
the operator numeric code and the access technology in +COPS=? entries:

    +COPS: (2,"","EE","23430","609C",7)

The current regex in mm_3gpp_parse_cops_test_response() expects the access
technology immediately after the operator code, so it does not match these
entries at all. The affected operator is dropped from the scan result, and
where every entry carries the extra field the whole scan comes back empty.

Make the extra group optional and move the access-technology capture from
match 5 to match 6. Standard responses are unaffected: the added group is
optional, so an entry without the extra field matches exactly as before.

Observed on FM350-GL firmware 81600.0000.00.19.17.10.

Originally from the BELABOX ModemManager fork, commit 43e09a76.
```

### The change

`src/mm-modem-helpers.c`, in `mm_3gpp_parse_cops_test_response()`:

```diff
-    r = g_regex_new ("\\((\\d),\"([^\"\\)]*)\",([^,\\)]*),([^,\\)]*)[\\)]?,(\\d+)\\)", G_REGEX_UNGREEDY, 0, NULL);
+    /* Quirk: at least some versions of FM350-GL include an additional (unknown)
+     * value between the operator code and the access tech:
+     *
+     *       +COPS: (2,"","EE","23430","609C",7)
+     */
+
+    r = g_regex_new ("\\((\\d),\"([^\"\\)]*)\",([^,\\)]*),([^,\\)]*)[\\)]?,([^,\\)]*,)?(\\d+)\\)", G_REGEX_UNGREEDY, 0, NULL);
```

```diff
-            mm_get_uint_from_match_info (match_info, 5, &act_value);
+            mm_get_uint_from_match_info (match_info, 6, &act_value);
```

### Test plan

Add a case to `src/tests/test-modem-helpers.c` alongside the existing
`test_cops_response_*` entries, covering the FM350-GL form
`+COPS: (2,"","EE","23430","609C",7)` and asserting the operator code and an access
technology of E-UTRAN. The existing standard-form cases in that file are the regression
guard for the optional group; they must stay green unchanged.

### Provenance

Upstream base verified 2026-08-22: the regex is byte-identical at tag `1.24.2`
(`src/mm-modem-helpers.c:1277`) and on `main` (`src/mm-modem-helpers.c:1296`). The gap is
still open upstream.

---

## MR 2 — `fm350gl: new plugin for the FM350-GL's USB/RNDIS composition`

**Target:** `mobile-broadband/ModemManager`, branch `main`
**Type:** new plugin
**Relates to:** issue
[#899](https://gitlab.freedesktop.org/mobile-broadband/ModemManager/-/issues/899)
**Size:** new `src/plugins/fm350gl/` (7 files, ~1700 lines) plus build wiring

### Title

```
fm350gl: add a plugin for the FM350-GL in its USB/RNDIS composition
```

### Description

```
The Fibocom FM350-GL is already supported by the mtk plugin, but only over
PCIe: that path is gated on the mtk_t7xx driver, the wwan/net subsystems, an
MBIM port, and the PCI id 14c3:4d75.

The same module also ships in USB compositions, where it enumerates as
0e8d:7126 or 0e8d:7127 with rndis_host plus option ports and no MBIM or QMI
function at all. ModemManager falls back to the generic plugin, which dials
with ATD*99***<cid># — a mechanism this composition does not implement. The
modem registers, attaches to the packet service, and then every bearer
attempt fails:

    [bearer] connection attempt #1 failed: 0,NONE
    failed to connect modem: Operation not supported: 0,NONE

with the RNDIS network interface up and carrying no IPv4 address.

This adds an fm350gl plugin matching 0e8d:7126 and 0e8d:7127 on the tty and
net subsystems. Its bearer activates the context with +CGACT=1,<cid>, reads
addressing and DNS back with +CGCONTRDP and +CGPADDR, and returns the RNDIS
net port as the data port, which is what this composition actually wants.

Also included:

  * A udev rule tagging 0e8d:712[6-7] with
    ID_MM_PREFERRED_NETWORKS_CPOL_DISABLED. The existing upstream tag; the
    FM350-GL crashes on the CPOL-based preferred-network read.

  * A delay before load_current_capabilities. The module crashes if it
    receives AT+CGMR too soon after enumeration. The settle time varies by
    host; 2500 ms was the worst observed, and the delay is set to 4000 ms.
    Feedback on a better mechanism than a fixed delay is welcome — see the
    open question below.

  * IPv4-only +CGCONTRDP replies. The initial parser required at least 30
    comma-separated fields and hard-failed shorter replies, so an IPv4-only
    APN never connected. The floor is now 7 fields, with the IPv6 DNS pair
    read only when present.

The code originates in the BELABOX ModemManager fork, forward-ported from
1.23-era ModemManager onto current main. Original commits:

    da01610c  FM350GL: backport FM350GL patch
    b4377c50  fm350gl: disable CPOL command that crashes the modem
    419dc598  fm350gl: delay initialization to avoid crashing on AT+GCMR
    90bcd376  fm350gl: fix DNS parsing for IP4-only networks
    9e2bc499  fm350gl: fix modem_set_current_modes_finish()
    9716d38b  fm350gl: fix load_current_modes_finish() for 4G-only mode

Tested on a Fibocom FM350-GL, firmware 81600.0000.00.19.17.10, in both
GTUSBMODE compositions (0e8d:7126 and 0e8d:7127), on an RK3588 board running
Debian bookworm.
```

### Commits in this MR

| Commit | Origin SHA | Content |
|--------|-----------|---------|
| 1 | `da01610c` squashed with `419dc598`, `90bcd376`, `9e2bc499`, `9716d38b` | The plugin, with its own four bug fixes folded in. A reviewer should read a working plugin, not a plugin plus four of its own regressions. |
| 2 | `b4377c50` | The `ID_MM_PREFERRED_NETWORKS_CPOL_DISABLED` udev row, kept separate because it is device data using an existing upstream mechanism. |

Full per-commit provenance, file lists and forward-port verdicts:
[`ADR-FM350-RNDIS-BEARER.md`](ADR-FM350-RNDIS-BEARER.md) §4.

### Open question for reviewers

The 4000 ms pre-capability delay is the weakest part of this series and we would rather not
carry it in this form. It exists because the module crashes on an early `AT+CGMR`. If there is
a preferred upstream pattern — a retry with backoff, a readiness URC to wait on, or a probe
delay expressible through the plugin properties — we will rework it. It is called out here
rather than buried because it is the row most likely to be objected to, and we agree with the
objection.

### Test plan

- FM350-GL in composition `0e8d:7127` (10 interfaces) and `0e8d:7126` (8 interfaces): the
  plugin binds instead of `generic`, a bearer connects on an IPv4-only APN, and the RNDIS
  interface carries a routable IPv4 address.
- The CPOL rule: no modem crash during SIM preferred-network initialization.
- The probe delay: repeated replug cycles with no `AT+CGMR` crash.
- No regression for PCIe FM350 units — the mtk plugin's gating is untouched, and this plugin
  matches only USB product ids.

---

## 3. What has to be true before either MR is filed

1. Both series rebased onto current upstream `main` and building clean. The BELABOX base is
   `616df804` (2023-10-17); `src/plugins/meson.build` and `src/plugins/mm-builtin-plugins.c`
   have both moved since.
2. MR 1's test case written and passing.
3. The hardware test plan above actually run on the bench board, with the transcript captured.
   Filing an MR whose "Tested on" paragraph is aspirational is worse than filing nothing.

## 4. What must NOT happen before these are filed

Per `POLICY.md` §2 (upstream-contribution-first) and §1 (the no-fork gate): **no quilt patch
lands in `packaging/ModemManager/debian/patches/`.** The offer precedes the carry. That
directory does not exist today, and it stays that way.

## 5. Filed-MR record — fill in on submission

| MR | URL | Filed on | Filed by | Outcome |
|----|-----|----------|----------|---------|
| MR 1 (`+COPS` quirk) | _not filed_ | — | — | — |
| MR 2 (`fm350gl` plugin) | _not filed_ | — | — | — |

Filling a row here also requires updating row (c) of the gate table in
[`ADR-FM350-RNDIS-BEARER.md`](ADR-FM350-RNDIS-BEARER.md) §7, in the same change.
