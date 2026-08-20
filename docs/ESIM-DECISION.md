# eSIM Decision Record (Investigate-Only)

**Status:** **`blocked` — no eUICC-capable hardware exists on the fleet.** No eSIM code
ships and the feature gate stays off.

| Date | Decision | Recorded in |
|---|---|---|
| 2026-08-13 | Implementation **deferred** by user decision; investigation closed as investigate-only. | §8 |
| 2026-08-18 | Deferral **reversed** by user decision, then closed **`blocked`** on a named hardware gap: no bench modem exposes an eUICC. The adoption spike could not run; its **licensing half did**, and is recorded. | §9 |

§1–§7 are the 2026-08-13 research and stand unchanged. §8 records the first decision;
**§9 is the current one and supersedes §8's "that decision stands."**

## Why this document exists

modem-stack ships six physical modems on the bench: Quectel RM530N-GL, SIMCom SIM7600G-H,
and several Huawei/ZTE USB dongles, plus the still-unconnected Sierra FM350. eSIM
("embedded SIM," an eUICC — embedded Universal Integrated Circuit Card — that holds one or
more remotely-provisioned network profiles) came up as a plausible operator feature: can a
CeraLive device let an operator load, switch, or transfer a cellular profile without a
physical SIM swap? This record answers that question with primary sources, states clearly
what is and is not possible on Linux today, and stops there. It does not propose an
implementation.

---

## 1. SGP.22 profile-binding proof — a profile cannot be copied from a phone or a physical SIM

The GSMA's Remote SIM Provisioning (RSP) architecture for consumer devices is specified in
[SGP.21 (Architecture)](https://www.gsma.com/solutions-and-impact/technologies/esim/wp-content/uploads/2022/03/SGP.21-v3.0.pdf)
and [SGP.22 (Technical Specification)](https://www.gsma.com/solutions-and-impact/technologies/esim/wp-content/uploads/2026/04/SGP.22-v2.7-.pdf).
The mechanism that makes an eSIM profile non-portable is the **Bound Profile Package (BPP)**:

- Every eUICC has a unique **EID** (eUICC Identifier), a 32-digit hardware serial number
  established and cryptographically anchored at manufacturing time (SGP.22 §2.4, §2.5.4;
  summarized well in the [eSeye eUICC overview](https://docs.eseye.com/Content/GettingStarted/eSIM/Euicc.htm)
  and the [Ambimat RSP provisioning writeup](https://esim.ambimat.com/blogs/esim-euicc-rsp-provisioning-architecture.html)).
- The operator's back end (**SM-DP+**, Subscription Manager Data Preparation Plus) prepares
  a Profile Package and, in the *binding* step, encrypts it specifically against the target
  eUICC's public key and its EID (SGP.22 §2.5.4 "Bound Profile Package," full TLV structure
  given in the spec). The result — the BPP — is cryptographically linked to **one** eUICC.
  A BPP bound to EID-A cannot be installed on EID-B; the eUICC on the other end will reject
  the key-agreement handshake.
- The eUICC's private key never leaves the chip. Decryption of the profile package happens
  **inside** the eUICC; "the decrypted profile content never leaves the chip"
  (Ambimat, citing SGP.22 §2.6 Security Overview).
- There is no reverse path defined anywhere in SGP.21/22 to read an *installed* profile back
  out of an eUICC in a portable form. The Local Profile Assistant (LPA) can list, enable,
  disable, delete, and rename profiles (SGP.22 §2.4.9, "LPA Services") — it cannot export one.

**Conclusion:** "copy the eSIM profile off my phone onto a modem" is not a permissions
problem or a missing-tool problem — it is cryptographically impossible under SGP.22 as
specified. Any product surface implying "clone your phone's eSIM" would be describing
something that does not exist in the standard.

---

## 2. Phone-to-phone transfer flows are carrier+OS-gated, not Linux-invokable

Both major mobile OSes ship consumer transfer flows, and both route through the carrier,
never through a raw device-to-device protocol a third party (like a Linux modem host) could
invoke:

- **Apple "eSIM Quick Transfer"** moves a profile between two iPhones on carriers that
  support it (US: AT&T, FirstNet, T-Mobile, Verizon; and per-country lists for Japan,
  Germany, France, UK) — [Apple support: Set up eSIM on iPhone](https://support.apple.com/en-us/118669),
  [Apple support: Transfer an eSIM to a new iPhone](https://support.apple.com/en-us/126058).
  It requires a same-account/paired-device flow and explicit carrier support; Apple's own
  copy says "if your carrier supports it."
- **Android's eSIM Transfer** ("Transfer SIM from another device") uses a documented
  device-to-device (D2D) protocol built on **GSMA TS.43** entitlement-server calls
  (`ManageSubscription(TRANSFER)` / `ManageSubscription(UPDATE SUBSCRIPTION)`), requires both
  devices paired over Bluetooth+Wi-Fi during first-run setup, a screen-lock-verified source
  device, and **carrier-side ES (Entitlement Server) support** —
  [Android Open Source Project: eSIM Transfer carrier integration](https://source.android.com/docs/core/connect/esim-transfer-carrier-integration).
  The temporary carrier token used in the handshake is stored in an OS keystore-encrypted
  block store; "no API is exposed to access [it] from other first-party and third-party
  apps."
- Cross-platform (iOS 26 ↔ Android): as of iOS 26.3, Apple ships a "Transfer to Android"
  flow that can move an eSIM as part of a broader migration, but it's a **paired-device,
  same-Wi-Fi, QR-paired session between the two phones' own OS transfer stacks** — not a
  protocol exposed to third-party hosts —
  [AndroidPolice: Latest iPhone update makes switching to Android easier](https://www.androidpolice.com/latest-iphone-update-makes-switching-to-android-easier/).

**Conclusion:** every consumer transfer path is (a) carrier-gated — the carrier's ES/SM-DP+
has to agree to move the subscription — and (b) OS-gated — it's a proprietary handshake
between two phone OS stacks with no published API for a third device (like a Linux-based
modem host) to participate in. A CeraLive device cannot "answer" or "initiate" a phone's
Quick Transfer or Android eSIM Transfer flow; there is no wire protocol document for it to
implement, and even if there were, it would still require carrier-side ES cooperation that
has nothing to do with our stack.

**SGP.22 v3.x "Device Change" is the standards-track answer to the same problem — and it's
future, not retrofittable onto our hardware.** SGP.22 v3.0
([GSMA SGP.22 v3.0 landing page](https://www.gsma.com/esim/resources/sgp-22-v3-0/),
[SGP.21 v3.0 architecture PDF](https://www.gsma.com/solutions-and-impact/technologies/esim/wp-content/uploads/2022/03/SGP.21-v3.0.pdf))
introduced a standardized **Device Change** feature (§4.18, Annex O; use case in Annex K.1)
letting a device conduct the operator handshake on the user's behalf, without a manual
carrier-support call. But:

- It's an *optional* feature (`#SupportedForDcV3.0.0#` per the v3.0 spec's feature-support
  tagging) — an eUICC and LPA must both explicitly implement it.
- GlobalPlatform's compliance program did not even certify SGP.22 v3.0-conformant products;
  certification only exists from **v3.1** onward
  ([GlobalPlatform Ops Bulletin 33: eUICC Consumer SGP.22 v3.x Qualification](https://globalplatform.org/wp-content/uploads/2023/04/GP-Ops-Bulletin33-eUICC-Consumer-v3.x-Qualification.pdf)).
- None of our bench eUICCs (see §6) advertise SGP.22 v3.x support, and `lpac` — the only
  open-source LPA available to us (§5) — targets **SGP.22 v2.2.2** (its own README states
  this explicitly:
  [estkme-group/lpac README](https://github.com/estkme-group/lpac?tab=readme-ov-file)), not
  v3.x. There is no open-source LPA implementation of Device Change as of this writing.

**Conclusion:** Device Change is a real, standardized answer to "move my subscription
between devices without calling the carrier" — but it needs a v3.x-capable eUICC, a v3.x-
capable LPA, and carrier SM-DP+ support for the feature, none of which exist in our current
toolchain or hardware set. It is a future horizon, not something retrofittable today.

---

## 3. Physical-SIM-to-eSIM is a carrier reissue, not a local conversion

"Convert my physical SIM to an eSIM" is likewise gated by the carrier, not by anything on
the device. Apple's own documentation frames it as a carrier operation: "If your carrier
supports it, you can convert your physical SIM to an eSIM on the same iPhone" (
[Apple support: Set up eSIM on iPhone](https://support.apple.com/en-us/118669)). Under the
hood this is not a "conversion" at all in the cryptographic sense of §1 — the carrier's
back end deactivates the physical SIM's subscription and issues a brand-new eSIM profile
bound (per §1) to the target device's EID via the normal SM-DP+ profile-download flow. There
is no on-device or on-modem operation that turns a physical SIM's contents into an eUICC
profile; the physical SIM's ICCID/IMSI pair is simply retired and a new profile is
provisioned.

**Conclusion:** for our stack, this path is identical in shape to any other new-eSIM
activation (§4) — it requires the carrier to issue a fresh SM-DP+-bound profile. Nothing
about "physical SIM" as the source changes the mechanics from the LPA's point of view.

---

## 4. Workable paths — what CAN actually get an eUICC profile onto a CeraLive board

Given §1–3 rule out "clone/transfer from a phone," the paths that are cryptographically and
operationally real are:

1. **Removable eUICC.** A profile lives on a physical, swappable eUICC card (a "MFF2" or
   plastic-form-factor eUICC, sometimes called a "programmable SIM" from vendors like
   [eSTK.me](https://docs.estk.me/manual/download/lpac/index.html) or ST4SIM). The profile
   travels with the physical card exactly like a traditional SIM's IMSI does — moving the
   card moves the profile. This is the only path where "moving a modem to a different board"
   preserves the subscription without any network operation at all.
2. **Carrier reissue / QR activation targeted at the board's own EID.** The board's eUICC
   has its own EID (§1); the operator issues a *new* profile bound to that EID, delivered as
   an activation code (an `LPA:1$<sm-dp+ host>$<matching-id>` string, typically QR-encoded)
   that the LPA on the board redeems against the carrier's SM-DP+
   ([lpac USAGE.md, `profile download`](https://github.com/estkme-group/lpac/blob/main/docs/USAGE.md)).
   This is the normal, standards-conformant activation flow for any eUICC device and is the
   path every eSIM-capable phone uses today.
3. **Multiple-profile remote switching (post-activation).** Once one or more profiles are
   already installed on the board's own eUICC (via path 2), an operator or the local LPA can
   `enable`/`disable` between them without a new network round-trip
   ([lpac USAGE.md — profile enable/disable](https://github.com/estkme-group/lpac/blob/main/docs/USAGE.md)).
   This is local profile *management*, not profile *transfer* — no new binding occurs.

**Conclusion:** the honest menu is "swap a removable eUICC card" or "have the carrier issue
a profile to this board's own EID," optionally followed by "switch between profiles already
resident on the board." There is no fourth path that avoids carrier involvement.

---

## 5. `lpac` assessment — the only viable open-source LPA, and its real limits

[`estkme-group/lpac`](https://github.com/estkme-group/lpac) ("C-based eUICC LPA") is the de
facto open-source Linux LPA. Assessment against our bench:

### Transports (APDU backends)

Per [`docs/ENVVARS.md`](https://github.com/estkme-group/lpac/blob/main/docs/ENVVARS.md) and
the [Driver Architecture DeepWiki page](https://deepwiki.com/estkme-group/lpac/5-driver-architecture),
`lpac` supports these APDU (eUICC command) backends, selected via `$LPAC_APDU`:

| Backend | Purpose | Linux availability |
|---|---|---|
| `pcsc` | PC/SC smartcard reader (external eUICC card reader) | default, all platforms |
| `at` | AT `+CCHO`/`+CCHC`/`+CGLA` (managed logical channel) | Linux only, opt-in build flag `LPAC_WITH_APDU_AT` |
| `at_csim` | AT `+CSIM` (unmanaged APDU passthrough) | Linux only, same build flag |
| `qmi` | Direct QMI character device | Qualcomm modems, opt-in |
| `qmi_qrtr` | QMI over QRTR (PCIe/embedded Qualcomm) | Qualcomm modems, opt-in |
| `uqmi` | OpenWrt `uqmi` CLI wrapper | OpenWrt-specific |
| `mbim` | MBIM interface | opt-in |
| `stdio` | Manual/scripted APDU injection | debug only, no `main` support |

The HTTP (SM-DP+ transport) side offers `curl` (default) or `stdio`.

### AT backend — "FOR DEMO PURPOSES ONLY," 300 ms caveat

`lpac`'s own AT-backend documentation is explicit and unambiguous
([`docs/backends/at.md`](https://raw.githubusercontent.com/estkme-group/lpac/main/docs/backends/at.md)):

> **FOR DEMO PURPOSES ONLY.**
> Only requests that strictly follow the ETSI TS 127 007 specification are supported.
> Requests outside the specification will be REJECTED.
> Some operations (e.g: download, delete, etc.), may fail due to insufficient response
> time. The Maximum Response Time is typically 300ms, which is insufficient for many
> eUICC operations.

The 300 ms ceiling comes from ETSI TS 127 007's `+CCHO`/`+CGLA` timing model, which was
never designed for eUICC-scale operations (profile download/binding routinely exceeds this).
There is also a known **protocol-conformance bug**: `lpac`'s `at` backend historically
misparsed the `+CCHO` "handle" as a logical-channel number per the strict TS 27.007 reading,
which breaks on modems that implement the spec correctly (Sierra `MC7455`/`WP7611`) while
working by accident on modems that don't (Quectel `EC25`) —
[lpac issue #138, "AT command APDU driver violates 3GPP TS 27.007"](https://github.com/estkme-group/lpac/issues/138).
The `at` backend was undergoing a rewrite (PR #284) as of that thread.

### ModemManager coordination requirement

Multiple independent reports confirm the `at`/`at_csim` backends cannot share the serial
port with ModemManager while ModemManager is actively managing the device: "I can't seem to
use the at devices while modem manager is running, so modem manager needs to be stopped in
order for lpac to be able to work" —
[lpac issue #73](https://github.com/estkme-group/lpac/issues/73). ModemManager's own
`--inhibit`/`--inhibit-device` mechanism exists precisely to release a device from
ModemManager's control for exactly this kind of out-of-band tool use — the `mmcli` man page
states: "When a device is inhibited via this method, ModemManager will disable the modem
… and will no longer use it until it is uninhibited" —
[`mmcli` man page](https://manpages.ubuntu.com/manpages/focal/man1/mmcli.1.html). This is
the correct primitive (`mmcli -I <UID>` / `Modem.Inhibit`), not stopping the ModemManager
daemon outright — but either way, **any `lpac` invocation against a UIM-managed modem must
first serialize with ModemManager's ownership of the SIM/UIM APDU channel**, or the two will
race for the port. The `qmi`/`qmi_qrtr` backends fare better here — per
[lpac issue #94](https://github.com/estkme-group/lpac/issues/94), MBIM in particular "requires
no updates to ModemManager… you don't need to stop ModemManager to use MBIM with lpac, both
can communicate with the modem at the same time" — but QMI/MBIM coexistence with an
*actively connected* bearer is a separate, unverified claim from QMI/MBIM coexistence with
an *idle* ModemManager instance, and neither has been tested against our stack's actor
model.

### AGPL-3.0 packaging constraint

`lpac`'s own [`REUSE.toml`](https://raw.githubusercontent.com/estkme-group/lpac/main/REUSE.toml)
license manifest is explicit about a **split license**:

```
src/**, driver/**, utils/**  → AGPL-3.0-only
euicc/**                     → LGPL-2.1-only OR LicenseRef-ESTKME-Commercial
docs/**, cmake/**, etc.      → MIT
```

The bulk of the program logic (`src/`, `driver/`, `utils/`) is **AGPL-3.0-only**. AGPL-3.0 is
a network-copyleft license: linking it (statically or dynamically) into another program
requires that program's *entire* source, including anything communicating with it over a
network, to also be released under AGPL-3.0-compatible terms. Given `cerastream`,
`CeraUI`, and the rest of the CeraLive stack are not AGPL-licensed, `lpac` **must remain a
separately-spawned external binary invoked via subprocess/CLI**, never linked into or
statically embedded in any CeraLive process. This is the same boundary already drawn for
other GPL-family tools consumed as external processes elsewhere in the stack, and it must be
preserved for any future eSIM work.

---

## 6. Per-modem eUICC reality table

Claim status vocabulary, per the plan: **verified** (primary-source documentation or direct
hands-on confirmation exists), **conditional** (documented as SKU/firmware-dependent, not
universal for the part number), **unknown** (no primary source found either way).

| Modem | On this bench? | eUICC claim status | Evidence |
|---|---|---|---|
| Sierra Wireless EM75xx (EM7565/EM7590/EM7595 family) | No (reference case) | **verified** (SKU-conditional) | EM7565 product page markets "Consumer and M2M eUICC" as a feature — [Sierra EM7565 product page](https://www.sierrawireless.com/iot-modules/4g-modules/em7565/) — but a Sierra forum thread on the *same part* states the eUICC "was never enacted" on some SKUs and that documentation across distributors is unreliable — [Sierra forum: EM7565 eUICC sku](https://forum.sierrawireless.com/t/em7565-euicc-sku/24816). Multiple independent bench reports (EM7590, EM7595, EM7511 family) show *some* units successfully listing/downloading eUICC profiles via `lpac`'s `at`/`at_csim` backend after vendor-specific `AT!CUSTOM="SIMLPA",0` unlock steps — [Sierra EM7590/EM7595 AT+CGLA thread](https://forum.sierrawireless.com/t/at-cgla-not-supported-on-em7590-and-at-ccho-returns-error/32595) — while others report "SIM failure" and no onboard eUICC at all on a nominally-eSIM SKU — [Sierra EM7595 provisioning thread](https://forum.sierrawireless.com/t/em7595-esim-provisioning/35746). **Net: this is the best-documented family in the ecosystem, but "eUICC present and lpac-reachable" is a per-SKU/per-firmware fact, not a blanket EM75xx guarantee.** |
| Quectel RM520N-GL / RM530N-GL (5G family, shares AT+QESIM command set) | RM530N-GL is physically present on the bench | **conditional** | Quectel's proprietary `AT+QESIM` command set exists (`lpa_enable`, `profile_brief`, `profile_detail`, `eid`, `enable_profile`, `disable_profile`, `delete_profile`, `nickname`, `def_svr_addr`) — confirmed live on forum threads for the RM520N-GL sibling part — [Quectel forum: RM520N-GL eSIM Management](https://forums.quectel.com/t/quectel-rm520n-gl-esim-management/47913), [Quectel forum: RM520N-GL eSIM adding profile](https://forums.quectel.com/t/rm520n-gl-esim-adding-profile/49509). Quectel support staff explicitly state: **"module by itself doesn't have eSIM. It should be physical eSIM installed in SIM slot or soldered MFF2 SIM. You should install eSIM on your board, module don't have eSIM, just support the feature"** — [Quectel forum: RM520N-GL eSIM support](https://forums.quectel.com/t/quectel-rm520n-gl-esim-support/48053). Beyond `lpa_enable`/`eid`, most other `AT+QESIM` subcommands (`profile_brief`, `profile_detail`, `def_svr_addr`) return `ERROR` for multiple reporters even with `lpa_enable` set and a valid EID read back, and Quectel support gates the actual profile-add tool (`quectel_lpad`) behind a private, non-forum distribution channel ("we can't share in forum, please contact with your supplier"). **Net: the AT command surface exists and is documented (RM530N-GL ships the same 5G-family firmware/command set as RM520N-GL per Quectel's own module family documentation), the EID-read half works, but the profile-download half is firmware/tooling-gated and unverified on our actual RM530N-GL unit.** |
| SIMCom SIM7600G-H | Physically present on the bench | **unknown, leaning no eUICC AT surface documented** | The official SIM7500/SIM7600 AT Command Manual (v1.10/v1.12, both fetched and checked section-by-section) has **no `AT+EID`, no `AT+QESIM`-equivalent, and no eUICC/eSIM profile-management command group** anywhere in its table of contents — [SIM7500_SIM7600 AT Command Manual v1.10](https://simcom.ee/documents/SIM7600E/SIM7500_SIM7600%20Series_AT%20Command%20Manual%20_V1.10.pdf). A field report on a physical ST4SIM eUICC inserted into a SIM7600 gets `+CME ERROR: SIM not inserted` when querying ICCID, and the reporter notes "Simcomm don't explicitly state that the module supports eSIM, unlike their other modules like the SIM7000 and SIM7070" — [STMicroelectronics community: How to activate an e-SIM on SIM7600](https://community.st.com/t5/interface-and-connectivity-ics/how-to-activate-an-e-sim-on-sim7600/td-p/653404). **Net: no vendor documentation supports an eUICC-management AT surface on this part; treat as no on-device eUICC path until contradicted by a primary source.** |
| Huawei / ZTE USB dongles (router/HiLink-mode devices) | Physically present on the bench | **verified — no eUICC/lpac path** | These are router-mode (HiLink/CPE-style) USB sticks that present a NAT'd LAN/HTTP management surface to the host rather than a raw AT/QMI/MBIM control port — the same reason they only expose an HTTP web UI (`192.168.0.1`/`192.168.8.1`, see `docs/BENCH.md` RB-15) instead of `mmcli`-visible modem objects. `lpac`'s APDU backends all require either a PC/SC reader, a raw AT serial port, or a raw QMI/MBIM character device — none of which router-mode dongles expose to the host. **Net: router-mode USB dongles are categorically out of scope for any local LPA regardless of whether the internal baseband chip has an eUICC, because the host never gets a control channel to it.** |
| Sierra FM350 (M.2, USB or PCIe) | **Not physically connected** as of the 2026-08-16 RB-16 probe (`docs/FM350-DECISION.md`) | **unknown** | No bench evidence exists; no primary-source AT/eUICC documentation was located for this part in this investigation. Not assessed further — the part isn't present to test even if it were the priority. |

**Cross-cutting observation:** across every documented case, the actual failure mode is
almost never "no eUICC silicon exists." It's one of: (a) the SKU variant lacks the eUICC
option entirely (EM7565/EM7595 both have this exact ambiguity), (b) a vendor-proprietary
lock (Sierra's `SIMLPA` custom flag, Quectel's undocumented `lpa_enable` gate) has to be
found and disabled first, or (c) the modem's *management mode* (HiLink/router mode) removes
host-level AT/QMI access entirely, independent of what silicon is inside. None of these are
resolvable from documentation alone — each requires the validation checklist in §7 run
against the specific physical unit.

---

## 7. Pre-adoption validation checklist

Before any eSIM work is scoped for real implementation, run this checklist against the
specific physical unit in question. Every step should be run **twice** — once with
ModemManager running (to observe the coordination failure mode from §5, if any), and once
with the device `mmcli --inhibit`-released or with ModemManager stopped (to observe the
clean-path behavior). A unit only clears this checklist if the AT/QMI/MBIM path is
reachable, an EID reads back, and a profile survives a reboot.

1. **EID read.** `lpac chip info` (or vendor AT equivalent, e.g. `AT+QESIM="eid"`) returns
   a 32-digit EID. If this fails outright, there is no reachable eUICC on this unit/SKU —
   stop here, the part does not clear regardless of datasheet claims.
2. **Disposable profile download.** Download a throwaway test profile from a known-good
   test SM-DP+ (e.g. a `lpac profile download -a` against a vendor test/demo activation
   code, per `docs/USAGE.md`). Record the exact APDU backend and timing that succeeded or
   failed, including any 300 ms-related failures from §5.
3. **Enable.** `lpac profile enable <iccid>` and confirm the profile shows `enabled` in
   `lpac profile list`.
4. **Reboot persistence.** Power-cycle the board (not just the modem) and re-run `lpac
   profile list` — confirm the profile is still present and still `enabled` after a full
   reboot, not just a warm modem reset.
5. **Delete.** `lpac profile delete <iccid>` and confirm it no longer appears in `lpac
   profile list`.
6. **Notification.** Confirm the SM-DP+ notification queue clears correctly (`lpac
   notification list` / `lpac notification remove`) — an unsent enable/delete notification
   left pending against a real carrier SM-DP+ can cause billing or provisioning-state drift
   on their side, so this step is not optional even for a disposable test profile.
7. **Both MM states.** Run steps 1–6 once with ModemManager actively managing the device
   and once with it inhibited/stopped, and record which backend (`at`, `at_csim`, `qmi`,
   `mbim`) worked in which state. This is the concrete evidence a future implementation
   would need to decide the coordination model (mmcli inhibit vs. a dedicated actor lock)
   instead of guessing at it.

No unit on this bench has been run through this checklist. §6's table entries are all
literature-sourced, not bench-validated.

---

## 8. Implementation is deferred — this document is the exit artifact

**This investigation was scoped, and remains scoped, as investigate-only.** The user made
the call on 2026-08-13 to defer eSIM implementation entirely for this phase — no lpac
packaging, no APDU/UIM integration code, no eSIM profile mutation, no QR activation flow,
and no eSIM-manager UI beyond the read-only `EsimInfo` display (`sim_type`/`esim_status`)
that CeraUI already surfaces elsewhere in this effort. That decision stands. This document
records what is now known — SGP.22's binding guarantees, the transfer-flow dead ends, the
`lpac` tool's real capabilities and constraints, the per-modem hardware reality, and the
validation checklist a real implementation would need to run first — so that if and when
eSIM work is picked back up, it starts from verified findings instead of re-deriving them.

Nothing in this document should be read as a task list, a roadmap, or a set of "next steps
to build." It is a closed research record.

> **Superseded on 2026-08-18 — see §9.** The deferral above was reversed by user decision,
> and eSIM re-entered scope as a hardware-gated adoption spike. That spike could not run,
> so the outcome is not "still deferred by choice" but **`blocked` by a measured hardware
> gap**. The distinction matters: §8 is a scope decision, §9 is a hardware fact.

---

## 9. 2026-08-18 — reversal, then `blocked`: no eUICC target exists; licensing review completed

**Closing state: `blocked (named hardware gap from todo 2, B5)`.**

This is one of the four legal outcome states for the phase's gated capability modules, and
eSIM is the only module permitted to use it. A `blocked` closure does **not** halt the
release wave — the feature gate simply stays off and this document says so truthfully.

### 9.1 The hardware gap (the reason)

The phase's hardware-prerequisites gate measured the entire bench fleet live on the board
(RK3588, ModemManager 1.24.2) and recorded item (b) as **BLOCKER B5 — no eUICC/eSIM-capable
modem on the fleet**:

| Check | Measured result |
|---|---|
| SIMs present across the whole bench | exactly **one** — on the Quectel RM530N-GL. Every other modem reads `sim-missing`. |
| That SIM's ModemManager property set | `active`, `imsi`, `iccid`, `operator id` — **no `eid`** |
| Interpretation | MM 1.24.2 reports an `eid` property for an eUICC. Its absence is **positive evidence of a classic removable UICC**, not merely missing data. |
| RM530N-GL eUICC capability | **UNPROVEN** for this unit and firmware (`RM530NGLAAR05A01M4G`). Consistent with §6: Quectel's own support staff state the module "doesn't have eSIM… it should be physical eSIM installed in SIM slot or soldered MFF2 SIM." |
| Any other fleet modem with an eUICC | none — a `sim-missing` modem cannot present one |

Nothing on the bench can hold, receive, or report an eUICC profile.

### 9.2 What that does to the spike — `blocked`, which is NOT a NO-GO

The spike had four questions: lpac↔ModemManager coexistence, device/APDU access on a
certified eUICC target, arm64 packaging, and licensing. Three of the four are hardware
questions:

| Spike step | Status | Why |
|---|---|---|
| lpac builds/runs on arm64, version captured | **not run** | Executable in isolation, but it is not evidence *toward the verdict* — it would prove a binary starts, not that lpac can reach an eUICC or share the port with MM. Running it would mean installing an AGPL-3.0 binary on the bench to answer a question nobody asked. |
| APDU/QMI channel opens against the certified eUICC target, MM inhibited | **impossible** | There is no eUICC target to open a channel to. |
| Port arbitration — MM regains the modem cleanly after lpac exits | **impossible** | Depends on the step above having run. |
| Licensing review | **COMPLETE** — §9.3 | Research, not hardware. It ran. |

**Therefore no GO/NO-GO verdict is recorded, and none may be inferred.** A NO-GO would be a
technical judgment that lpac cannot work here; nothing was measured that would support such
a judgment. The spike did not resolve — it could not start. That is precisely what `blocked`
means, and it is why this todo closes `blocked` rather than `re-deferred` (a scope choice) or
`NO-GO` (a verdict).

**Consequence, stated explicitly:** with no GO verdict, none of the GO-path delivery ships.
There is **no** `ceralive-lpac` `.deb`, **no** row added to the packaging closure, **no**
release-manifest entry, **no** apt publication, and **no** image package pin. The
modem-stack release manifest stays at `closure_version: 2` with its frozen matrix, untouched
by this decision.

### 9.3 Licensing review — the half that could run (and did)

Re-verified against upstream on **2026-08-18**, not carried over from §5.

**Primary sources, fetched this session:**

- `REUSE.toml` at [`estkme-group/lpac@main`](https://raw.githubusercontent.com/estkme-group/lpac/main/REUSE.toml)
  — confirmed **unchanged** from what §5 recorded on 2026-08-13:

  | Path glob | SPDX identifier |
  |---|---|
  | `src/**`, `driver/**`, `utils/**` | **`AGPL-3.0-only`** |
  | `euicc/**` | `LGPL-2.1-only OR LicenseRef-ESTKME-Commercial` |
  | `docs/**`, `cmake/**`, `CMakeLists.txt`, `README.md`, `.github/**`, tool configs | `MIT` |
  | `cjson-ext/**` | `MIT` |
  | `dlfcn-win32/**` | `MIT` (Ramiro Polla + contributors) |

- GitHub's own repository metadata
  ([API](https://api.github.com/repos/estkme-group/lpac)) reports
  `license.spdx_id: "AGPL-3.0"` for the project as a whole. The
  `/license` endpoint returns **404** — there is no single detectable top-level `LICENSE`
  file, because the project is REUSE-structured rather than single-licensed.
- [`LICENSES/`](https://github.com/estkme-group/lpac/tree/main/LICENSES) carries six license
  texts: `AGPL-3.0-only`, `LGPL-2.1-only`, `GPL-2.0-only`, `MIT`, `CC0-1.0`, and
  `LicenseRef-ESTKME-Commercial`. That last one reads, in full: *"Non-public commercial
  license, please contact ESTKME TECHNOLOGY LIMITED, Hong Kong for details via
  inquiry@estk.me."* It is the paid alternative to LGPL-2.1 for `euicc/**` and is
  irrelevant to us — LGPL-2.1-only is acceptable, so the commercial branch never applies.

**Verdict 1 — the program logic is AGPL-3.0-only, so lpac can only ever be an external
process.** This re-confirms §5's boundary against live upstream state: lpac must be
spawned as a separate binary over its CLI, and must **never** be linked, statically
embedded, or otherwise combined into `cerastream`, `CeraUI`, or
`@ceralive/modem-control`. None of those are AGPL-licensed and none may become so.

**Verdict 2 — redistributing lpac is permitted, but it is not free of obligations.** AGPL-3.0
is a free-software license and Debian carries lpac in `main` (§9.4), so redistribution is
clearly allowed. Two obligations attach:

- **Corresponding Source, from the same place (AGPL-3.0 §6).** Conveying object code
  requires the Corresponding Source under one of §6(a)–(e); for network distribution the
  applicable option is **§6(d)** — equivalent access to the source *at the same place*, at
  no further charge. `apt.ceralive.tv` today publishes **binary indexes only**
  (`binary-arm64` / `binary-amd64`); there is no source channel in the closure at all. So
  publishing an lpac `.deb` there would require **adding a source channel** (or an
  equivalent §6(b) written offer) before the first upload — an infrastructure precondition,
  not a paperwork detail. Recording it now means a future GO does not discover it late.
- **§13 attaches only to *modified* versions.** AGPL-3.0 §13's obligation to offer
  Corresponding Source to users interacting with the program remotely over a network is
  written against a version *you modified*. Shipping lpac **unmodified** and driving it by
  subprocess does not trigger that clause. Patch it even once, however, and the CeraUI web
  surface driving it makes §13 a live, continuous obligation. **Policy, therefore: ship
  lpac unmodified or not at all** — which happens to be exactly what `POLICY.md`'s no-fork
  rule already demands of every package in `packaging/`. The licensing constraint and the
  existing repo policy point the same direction; no new rule is needed.

**Observation (flagged, not adjudicated) — one vendored file is `GPL-2.0-only`.**
[`utils/lpac/list.h`](https://github.com/estkme-group/lpac/blob/main/utils/lpac/list.h)
carries an inline `SPDX-License-Identifier: GPL-2.0-only` with
`SPDX-FileCopyrightText: Linux Project` — the kernel's linked-list header — inside a
directory that `REUSE.toml` annotates as `AGPL-3.0-only`. GPLv2-only is
[documented by the FSF](https://www.gnu.org/licenses/gpl-faq.html#v2v3Compatibility) as
incompatible with GPLv3-family terms for combination into a single work. This is an
**upstream** question, not a CeraLive one, and Debian's acceptance of lpac into `main`
strongly suggests ftp-master's copyright review already addressed it. It is recorded here
so a future GO-stage review **reads Debian's `debian/copyright` for `lpac`** instead of
re-deriving the analysis — and does not treat §9.3 as having cleared it. Nothing here is
legal advice; a real adoption decision gets counsel review of the whole file set.
(`CC0-1.0.txt` is likewise present in `LICENSES/` with no annotation naming it; the files
it covers were not located in this review.)

### 9.4 Shipping form — decided in principle, moot in practice

The todo made the licensing verdict the input that decides the shipping form. It does, but
so does availability, and the availability answer is the one that changed since §5.

**lpac is now packaged in Debian — but not in a suite we ship.**

| Channel | State (checked 2026-08-18) | Source |
|---|---|---|
| Debian archive | source `lpac` **2.3.0-1** in `main`, binaries **amd64 / arm64 / armhf** — present in **testing + unstable only**; **absent from bookworm and trixie** | [tracker.debian.org/pkg/lpac](https://tracker.debian.org/pkg/lpac) |
| Ubuntu | source `lpac` 2.3.0-1 in `universe`, amd64 / arm64 / armhf | [launchpad.net/ubuntu/+source/lpac](https://launchpad.net/ubuntu/+source/lpac) |
| Upstream release artifacts | **v2.3.0 (2025-08-15)**, including Linux **aarch64** ZIPs and an upstream-built **`lpac_2.3.0_arm64.deb`** | [releases/tag/v2.3.0](https://github.com/estkme-group/lpac/releases/tag/v2.3.0) |
| Others | Alpine `community` (aarch64), OpenWrt `packages` feed (2.3.0-2), Nixpkgs 2.3.0, AUR (`lpac`, `lpac-git`). **Absent** from Arch official repos and from Fedora. | [Alpine](https://pkgs.alpinelinux.org/package/v3.20/community/aarch64/lpac) · [OpenWrt](https://github.com/openwrt/packages/blob/master/utils/lpac/Makefile) · [Nixpkgs](https://github.com/NixOS/nixpkgs/blob/master/pkgs/by-name/lp/lpac/package.nix) · [AUR](https://aur.archlinux.org/packages/lpac) |
| Build from source | CMake (`cmake -B build`; `-DSTANDALONE_MODE=ON` for a relocatable install). Build deps per Debian's control: `cmake`, `libcurl4-openssl-dev`, `libpcsclite-dev`, QMI/QRTR dev libraries, `zip`. | [docs/DEVELOPERS.md](https://github.com/estkme-group/lpac/blob/main/docs/DEVELOPERS.md) · [Debian control](https://tracker.debian.org/media/packages/l/lpac/control-2.3.0-1) |

Ranked the same way the bench's `uhubctl` delivery decision was ranked — stock distro
package first, first-party build only if that fails:

1. **Stock Debian package — preferred, but currently unavailable to us.** Ruled out by
   *suite*, not by licence: 2.3.0-1 exists only in testing/unstable, and this stack's
   packaging targets bookworm. Revisit on any suite move; this is the option that would
   cost the least.
2. **Upstream's own `lpac_2.3.0_arm64.deb` — rejected as a shipping form.** It is not built
   by us, not covered by `packaging/upstream-pins.yaml`'s four-link provenance chain, and
   not signed by our key. Adopting it would put a binary into the device image through a
   path every other `.deb` in this repo is forbidden to use.
3. **First-party bookworm rebuild in `modem-stack/packaging/` — the recommended form on a
   future GO.** It is not a new model: Debian now maintains a `debian/` recipe (2.3.0-1)
   that can be pinned and rebuilt for bookworm exactly like ModemManager, libmbim, libqmi,
   and libqrtr-glib already are — same zero-patch rule, same provenance chain, same
   two-set package model. The one genuinely new requirement is the AGPL §6(d) source
   channel from §9.3.

**All three are moot today.** No GO verdict exists, so nothing ships, and this subsection
is a decision recorded *in advance* for whoever picks eSIM back up — not authorization to
build anything.

### 9.5 What would unblock this

The gate is one piece of hardware. Two ways to clear it, cheapest first:

1. **A removable eUICC card in an existing bench modem.** Per §4 path 1, a programmable
   eUICC in plastic form factor (eSTK.me, ST4SIM, or similar) dropped into the Quectel
   RM530N-GL's SIM slot gives the bench a real EID to read — no new modem required. It also
   unlocks a second, better-behaved route: with a **PC/SC reader**, lpac's *default* `pcsc`
   backend reaches the card entirely outside ModemManager, which sidesteps the port-
   arbitration question for the inventory/EID half of the spike and isolates the
   coexistence question to the modem-slot path only.
2. **A modem with a genuine on-board eUICC**, per §6's reality table — noting that entry's
   central warning: eUICC presence is a per-SKU/per-firmware fact, so a datasheet claim is
   not acceptance. The unit still has to clear §7's checklist.

With either in hand, §7 step 1 (EID read) becomes runnable, and the spike's three blocked
steps become answerable. Until then this record stands as written.

**The question put to the user, verbatim:** *"No modem on the bench exposes an eUICC — the
only SIM present reports no `eid`, and RM530N-GL eSIM capability is unproven for this unit.
Can you supply an eUICC-capable modem (or confirm the RM530N-GL variant on the bench has
one)? Otherwise eSIM closes `blocked` with its feature gate off and the docs stating so."*
