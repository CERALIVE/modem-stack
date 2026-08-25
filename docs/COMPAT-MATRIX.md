# Compatibility matrix — vendor × firmware × composition × operation

One tracked matrix for the whole modem stack: which hardware rows this repository knows
about, which operations it has code for, and, for every cell, exactly how much is actually
known. It is the answer to "does CeraLive work with this modem", stated in the only
vocabulary that cannot overstate itself.

Two documents sit either side of this one and are not duplicated here:

- [`VENDOR-QUIRKS.md`](VENDOR-QUIRKS.md) is the sourced per-vendor reading list, with a
  pinned citation for every behavioural claim. When you want to know *why* a cell below
  reads the way it does, that is the document, organised as one `Quirk | Evidence | Posture`
  table per vendor behind a "how to read the posture column" preamble, a pinned six-key
  SOURCES table, and a closing "what this does NOT license". Do not re-derive its content
  into this file.
- [`BENCH.md`](BENCH.md) is the runbook ladder RB-1 … RB-18 and the per-SKU status ledger.
  **Every hardware evidence claim lives there and only there.** This matrix links to it and
  deliberately restates none of its per-runbook status.

## The only vocabulary in use

Every claim cell below is one member of the five-state support-claim ladder in
[`control/src/capability/support-claim.ts`](../control/src/capability/support-claim.ts):

```
unavailable → implemented → enabled → capable → certified
```

- **`unavailable`** — not shipped in this build, or the device positively lacks it. It is
  the rung *below* `implemented`, never above it.
- **`implemented`** — code exists in this repository, gate OFF, unproven on the device.
- **`enabled`** — gate ON, capability unknown.
- **`capable`** — gate ON, device advertises it. The floor for offering a control.
- **`certified`** — proven on this exact model and firmware. The only rung a support matrix
  may claim as support.

**No cell in this document exceeds `implemented`, and `enabled` / `capable` / `certified`
appear nowhere in the matrix at all.** That is not modesty. `enabled` is a statement about a
deployment's gate settings, which a document does not have; `capable` needs a live probe
against one device; `certified` needs a completed hardware drill. A document produces none
of the three. The rung a row reaches is raised by a bench capture under
[`BENCH.md`](BENCH.md), never by an edit here.

**There is no second status vocabulary.** No "partial", no "works", no "untested", no
tick-and-cross. Those words are how a matrix comes to promise a combination nobody ever
ran, which is the exact failure the ladder was built to prevent. If a cell needs more
nuance than the ladder carries, it gets a footnote, not a new word.

One column below does use a different vocabulary, and it is labelled as such: the FCC state
in Table A is `fcc/coverage.ts`'s coverage tri-state (`present` / `absent` / `unknown`),
which answers "does ModemManager ship an unlock procedure keyed on these ids". It is a fact
about MM's catalog, not a support claim, and it is deliberately kept out of Table B.

---

## Table A — the hardware rows

Vendor and model, firmware/SKU including FCC state, and protocol/composition. The evidence
column names the classifier tier that placed the row; `family` is the Table B column the row
answers under.

| # | Vendor / model | Firmware / SKU, FCC state | Protocol / composition | Classifier evidence | Family |
|---|---|---|---|---|---|
| 1 | Quectel RM530N-GL | `RM530NGLAAR05A01M4G`; FCC coverage `absent` | QMI raw-IP (`2c7c`) | vendor id, whole range cellular | Quectel |
| 2 | SIMCom SIM7600G-H | firmware unrecorded on the bench; FCC coverage `absent` | QMI raw-IP (`1e0e`); one Zero-CD id `1e0e:f000` | vendor id | SIMCom |
| 3 | Fibocom FM350-GL, carrier-mounted | carrier id `0e8d:7127`; FCC coverage `unknown` | RNDIS over the carrier's USB composition | no classifier row, deliberately | Fibocom |
| 4 | Fibocom FM350-GL, native | PCI `14c3:4d75` under `mtk_t7xx`; FCC coverage `unknown` | PCIe, not USB | none; documented-deferred | see note **F** |
| 5 | Sierra EM74xx | `1199:9071`, `1199:907b`; FCC coverage `absent` for these ids | MBIM / QMI | `mainline-kernel` | Sierra |
| 6 | Sierra EM74xx, FCC-locked ids | `1199:9079`, `03f0:4e1d` (HP), `413c:81a3` / `413c:81a8` (Dell); FCC coverage `present` | MBIM / QMI | `modemmanager-1.24.2-fcc` | Sierra |
| 7 | Sierra EM75xx | `1199:9091`, `1199:c081`; FCC coverage `absent` | MBIM / QMI | `mainline-kernel` | Sierra |
| 8 | Sierra EM919x | `1199:90d3`; FCC coverage `absent` | MBIM / QMI | `mainline-kernel` | Sierra |
| 9 | Telit module families | `1bc7:` `1031` LE910C1-EUX, `1034` LE910C4-WWX, `1040` LE922A, `1050` FN980, `1060` LN920, `1070` FN990A, `1080` FE990A, `10a0` FN920C04, `1100` ME910, `1200` LE920; FCC coverage `absent` | one application PID per composition: QMI rmnet, MBIM, RNDIS, ECM | `mainline-kernel` | Telit |
| 10 | u-blox LARA-R6 | `1546:1311` / `1312` / `1313`; FCC coverage `absent` | per-PID composition | `mainline-kernel` | u-blox |
| 11 | u-blox LARA-L6 | `1546:1341` / `1342` / `1343`; FCC coverage `absent` | per-PID composition | `mainline-kernel` | u-blox |
| 12 | NETGEAR LB1120 | `0846:68e1`, `familyKind: 'router-webui'`; FCC coverage `absent` | Ethernet-over-USB tether plus a vendor web UI | `usb-ids-registry` | NETGEAR |
| 13 | Huawei E3372H HiLink | firmware `22.200.05.00.1080`, password type 3; FCC coverage `absent` | CDC-ECM plus HTTP web UI, no control port | vendor id `12d1` | Huawei |
| 14 | Huawei E3372H HiLink | firmware `22.333.01.00.00`, password type 4; FCC coverage `absent` | CDC-ECM plus HTTP web UI, no control port | vendor id `12d1` | Huawei |
| 15 | Huawei Zero-CD installer personality | e.g. `12d1:1f01`, target `14db`; FCC coverage `absent` | mass-storage installer until mode-switched | vendor id plus a `usb_modeswitch` trigger | Huawei |
| 16 | ZTE MF79U | legacy base64 under `LOGIN`; FCC coverage `absent` | router web UI (`goform`), Zero-CD lineage | vendor id `19d2` | ZTE |
| 17 | ZTE MF79U | `LD`-salted SHA-256 under the same bare `LOGIN`; FCC coverage `absent` | router web UI (`goform`) | vendor id `19d2` | ZTE |
| 18 | ZTE MF266 | salted SHA-256 under `LOGIN_MULTI_USER`, `stok` + `RD` + derived `AD`; FCC coverage `absent` | router web UI (`goform`) | vendor id `19d2` | ZTE |
| 19 | ZTE, unrecognised firmware | fingerprinted, read-only telemetry profile; FCC coverage `absent` | router web UI (`goform`) | vendor id `19d2` | ZTE |
| 20 | Qualcomm UFI / HIMI | `05c6:9091`, measured four-interface composition; FCC coverage `absent` | QMI plus an ADB-class interface; HIMI HTTP telemetry | vendor id `05c6` | UFI/HIMI |
| 21 | Qualcomm UFI / HIMI | `05c6:9024`; FCC coverage `absent` | RNDIS plus ADB | vendor id `05c6` | UFI/HIMI |
| 22 | Phone tether, any vendor | not applicable; FCC coverage `absent` | RNDIS or ECM/NCM data interface, no control interface | none; no positive cellular evidence | Tether |

**Note F — the FM350-GL is two rows because it is two devices.** Row 3 is the carrier board
that presents it over USB; row 4 is the native PCIe part under `mtk_t7xx`, which has no USB
VID:PID at all and therefore no classifier row, on purpose. Every Table B claim for row 4 is
`unavailable`: this stack's enumeration, classification and identity derivation are all USB
snapshot driven, so a PCIe part reaches none of them. That is documented-deferred rather than
broken; see [`FM350-DECISION.md`](FM350-DECISION.md).

**Note N — the NETGEAR row is a family label, and its device class is an open gap.** The row
labels the LB1120 `router-webui`, which is a positive claim about the family and nothing
more. The device class is decided by interfaces, not by the family row, and `0846` is
deliberately absent from `CELLULAR_USB_VENDOR_IDS` (its USB ID Repository block is mostly
Wi-Fi and Ethernet adapters, so a vendor-keyed rule there would report a Wi-Fi dongle as a
cellular uplink). With no kernel modem driver claiming `68e1` and no modeswitch trigger,
`classifyUsbNetDevice` finds no positive cellular evidence and answers **`wired-ethernet`,
not `router-cellular`**. So an attached LB1120 is presently not recognised as a cellular
uplink at all. This is recorded as a known gap rather than papered over, and it is why the
NETGEAR column below is mostly `unavailable`: no operation in this stack reaches a device it
does not classify as cellular. Row 22 reads the same way for the same reason, and that shared
reason is the point: a phone's RNDIS tether and a USB Ethernet dongle are identical on the
wire.

---

## Table B — operation × family

Eighteen operations, from first enumeration through a sustained bonded uplink. Columns are
the Table A families. Read every cell as a claim about *this repository's code*, at the rung
the ladder allows a document to state.

| # | Operation | Quectel | SIMCom | Fibocom | Sierra | Telit | u-blox | NETGEAR | Huawei | ZTE | UFI/HIMI | Tether |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Enumerate: USB descriptors, `/sys` composition, udev properties | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented |
| 2 | Classify: device class from interfaces and drivers | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented |
| 3 | Identity: `PhysicalModemId` stable across replug | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented | implemented |
| 4 | Control surface: an MM control port, or a vendor HTTP session | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | implemented | implemented | implemented | unavailable |
| 5 | SIM presence as evidence | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | unavailable | unavailable | unavailable | unavailable |
| 6 | SIM unlock: PIN and PUK | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | unavailable | unavailable | unavailable | unavailable |
| 7 | Registration and cell context read | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | implemented | implemented | implemented | unavailable |
| 8 | Signal read, including the per-RAT extended metrics | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | implemented | implemented | implemented | unavailable |
| 9 | Radio capability read: mode and band catalogs | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | implemented | unavailable | unavailable | unavailable |
| 10 | Mode write, including the 5G preference postures | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | implemented | unavailable | unavailable | unavailable |
| 11 | Band lock write, certification-gated | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | unavailable | unavailable | unavailable | unavailable |
| 12 | USB composition switch | implemented | implemented | implemented | implemented | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |
| 13 | FCC auto-unlock policy reconciliation | unavailable | unavailable | unavailable | implemented | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |
| 14 | SMS list and read, never send or delete | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | unavailable | unavailable | unavailable | unavailable |
| 15 | USSD session | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | unavailable | unavailable | unavailable | unavailable |
| 16 | GNSS fix, live only, no history | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | unavailable | unavailable | unavailable | unavailable |
| 17 | Bearer and APN activation | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | implemented | unavailable | unavailable | unavailable |
| 18 | Sustained bonded uplink: flap, re-enumeration, applied-state recovery | implemented | implemented | implemented | implemented | implemented | implemented | unavailable | implemented | implemented | implemented | unavailable |

### Reading the cells that are easy to misread

- **Operation 11 is `implemented`, not `unavailable`, and the shipped band catalog is
  empty.** The code exists, gate off, and a band write is refused today on every device for
  want of a four-proof catalog entry. `unavailable` would say "not shipped", which is false;
  `capable` would say a modem advertised it, which no document may say. Band lock is also the
  one module that requires `certified` rather than `capable` to be OFFERED at all, a
  deliberate deviation from the framework floor, because a band the SIM's network does not
  operate on registers nowhere and a modem that ignores a reset leaves an operator with no
  way back short of a replug.
- **Operation 12 is `implemented` for exactly four vendors** — Fibocom, Quectel, SIMCom and
  Sierra — because `RUNTIME_COMPOSITION_VENDORS` names those four and no others. A vendor
  outside that set has no reviewed READ/TEST/SET form, so there is no code to claim. Targets
  still come from the device's own enumeration and only when that enumeration proves a return
  path.
- **Operation 13's `unavailable` is a positive statement, not a shrug.** `fcc/coverage.ts`
  answers `absent` when the ids are well formed and are not in ModemManager's pinned mapping,
  which is knowledge about the device. It answers `unknown` only when the ids could not be
  read. Sierra is `implemented` because four Sierra-silicon ids are covered (under Sierra's
  own, HP's and Dell's vendor ids), and because this repo records an opt-in policy and
  re-derives MM's symlink; it ships no unlock script and performs no unlock.
- **Operations 5 and 6 are `unavailable` for every router family on purpose.** Huawei, ZTE
  and the UFI each report their own SIM code (`SimStatus`, `simcard_state`, `simstate`) with
  vendor semantics that no decoder here covers. The code stays verbatim in the diagnostics
  block for a per-vendor provider to claim later with evidence. Guessing one would invent a
  reading, which is the failure the observation layer exists to prevent.
- **Operation 18 is about this stack surviving a flap, not about bonding.** No bonding code
  lives in this repository; SRTLA is elsewhere in the workspace. What is claimed here is
  generation fencing, applied-state loss reporting, and re-promotion after a re-enumeration
  on a leg this stack tracks. A family it classifies `wired-ethernet` is not a tracked
  cellular leg, hence `unavailable` for NETGEAR and Tether.
- **A cell says nothing about a firmware that is not in Table A.** Family-level code is
  generic and runtime discovered, so an unlisted PID within a listed vendor still reaches the
  generic controls, but it gets no family label and no row here. Absence from Table A is
  absence of a claim, never a claim of absence.

### What the operation axis deliberately omits

Data-usage metering is not an operation column, because it is measured from
`/proc/net/dev` and a local policy file and is therefore identical for every family that has
a tracked interface at all. Making it a column would add eleven cells that all say the same
thing for a non-vendor reason. Its accuracy gate is RB-6 in [`BENCH.md`](BENCH.md).

### Why Sierra's composition switch is `implemented` even though `AT!` is fenced

`control/src/usb-mode/runtime-capability.ts` carries Sierra's reviewed `AT!USBCOMP?` /
`AT!USBCOMP=?` / `AT!USBCOMP=` forms in the composition registries, which is what makes
operation 12 `implemented` for Sierra. The forms are reviewed, allowlisted by name, and
gated by the same admission, journal, rollback and readback fences as every other
composition write.

That coexists with the `AT!` fence rather than contradicting it, because the two speak
about different surfaces. [`VENDOR-QUIRKS.md`](VENDOR-QUIRKS.md)'s Sierra `AT!` row is
about the **password-gated** `AT!BAND` / `AT!ENTERCND` surface, which is absent from this
repository and stays `unavailable`; the static gate it cites (`providers/ufi-himi`) scans
that provider's directory, not the repository. An earlier revision of that row claimed a
repo-wide absence of every `AT!` form, which was not true — it has been narrowed to the
surface it actually describes.

---

## Hardware-free versus hardware-required

The split below is the whole reason this matrix can be trusted: it says exactly which claims
a green CI run establishes, and which ones only a bench device can.

### Hardware-free — provable in CI, no device attached

These are the claims Table B's `implemented` rungs actually rest on, and every one is
exercised by the workspace suite on any machine:

- **Every Table A row's identity.** Vendor and model rows are exact VID:PID map entries with
  a pinned evidence tier; a test asserts every tier a row uses has provenance recorded. No
  vendor range is ever inferred, and an unlisted PID returns nothing.
- **Classification from a snapshot.** Interface-and-driver precedence, the `router-mode` and
  `pending-modeswitch` and `wired-ethernet` branches, and the proof that a family label
  decides no device class. Note N's LB1120 gap is a CI-provable fact, not a bench finding.
- **Physical identity derivation** across the serial → udev `ID_PATH` → bounded-fallback
  ladder, including the constructors' refusal of interface names, addresses and subscriber
  identifiers.
- **Response parsing and normalization** for every router family, over the canonical fixture
  corpus, including the malformed, auth-expired and lockout variants.
- **Every refusal path.** Band-write certification refusal, composition suppression states,
  the read-only SMS and UFI fences, the USSD illegal-verb refusals, the prohibited Qualcomm
  operations answering before any transport contact.
- **FCC coverage lookups**, which are a table read against MM's pinned mapping.
- **The provider-matching conformance matrix**, including its 16-modem scale case, which is a
  fixture upper bound and never a hardware claim.
- **The vocabulary cap itself**: that this document and the matrix above use only ladder
  members. See the grep in the evidence note below.

Nothing in this list can raise a cell above `implemented`, by construction. A fixture proves
that code behaves as written; it cannot prove a radio did anything.

### Hardware-required — only a bench device can raise these

Every operation from Table B row 5 onward needs an attached device, a live SIM, or both,
before its cell can move past `implemented`. The runbook that captures each one is in
[`BENCH.md`](BENCH.md) (RB-1 … RB-18), and that document owns the per-runbook status; this
matrix links and does not restate it.

| Table B operations | What hardware is required | Where the evidence is captured |
|---|---|---|
| 1-3 | A device attached, for a real descriptor and udev capture; the derivations themselves are hardware-free | RB-9 fleet inventory, RB-2 slot-UID stability, RB-18 Sierra identity and composition |
| 4 | The device's control interface actually claimed by a driver and, for routers, a reachable web UI | RB-1 system-bus probe, RB-14 Huawei personality, RB-15 ZTE, RB-16 FM350 |
| 5-7 | A physical SIM, and a network the SIM registers on | RB-4 PIN/PUK, and the per-SKU captures RB-11 … RB-15 |
| 8-9 | A registered modem reporting live measurements | RB-11 … RB-15 |
| 10-12 | A disruptive write, its readback, and a re-enumeration | RB-5 certified USB-mode transition, RB-11 … RB-15 stage 2 |
| 13 | A covered Sierra unit, and a boot to prove the reconciler re-materialises the link | RB-12 Sierra locked-state capture, RB-18 |
| 14-16 | A SIM that can receive a message, open a session, and a GNSS antenna | RB-11 … RB-15 |
| 17-18 | A live bearer and a deliberate flap under load | RB-17 modem-flap resilience, RB-10 hub VBUS cycle, RB-6 usage accuracy |

Two consequences follow, and both are deliberate:

1. **No row in this matrix is `certified`, so no combination in it may be described as
   supported.** `mayClaimSupport` returns true for exactly one rung, and no cell reaches it.
2. **A bench run raises a cell; an edit here does not.** A cell moves when a capture under
   [`BENCH.md`](BENCH.md) lands and a human-reviewed commit records it, exactly like a
   certified-catalog entry. Editing a cell without that evidence is the same error as
   promoting a catalog entry from a synthetic bundle, which the ingestion code refuses
   outright.
