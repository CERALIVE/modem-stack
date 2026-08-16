# eSIM Decision Record (Investigate-Only)

**Status:** Investigation complete. Implementation explicitly deferred by user decision, 2026-08-13.
This document is the exit artifact for that investigation — see §8.

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
