<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## CERTIFICATION EVIDENCE → CATALOG (evidence-gated, human-reviewed)

A SKU reaches `control/src/usb-mode/certified-catalog.json` only through a captured
`certify` bundle and a human-reviewed commit. The path is documented in
[`docs/CATALOG-INGESTION.md`](../CATALOG-INGESTION.md) and implemented as a pure
transform in `control/src/usb-mode/{ingestion,promotion-review,usb-devices-parse}.ts`.

- **`synthetic: true` is REFUSED for catalog promotion by the code**, not by convention
  (`buildCatalogEntryCandidate` → typed `reason: 'synthetic-bundle'`). Classifier fixtures
  may be synthetic; their provenance says so. That asymmetry is the design.
- **Certification is two-stage** because `certify --transition` refuses a SKU that is not
  already in the catalog: stage 1 merges an entry with `permittedTransitions: []`, stage 2
  adds one transition carrying its own `evidenceBundleSha256`.
- **`canonicalMode` is a reviewer's stated claim, never inferred**; when transition evidence
  exists the seam cross-checks it against the captured `transition.from`.
- Per-SKU capture runbooks are `docs/BENCH.md` **RB-11 … RB-15** (RB-16 is the FM350
  USB-vs-PCIe probe — its 2026-08-16 bench run found the unit not connected, so
  `docs/FM350-DECISION.md`'s three-gate ledger stays OPEN with the probe evidence recorded;
  RB-17 is modem-flap resilience). All are `[PARTIAL]` — the **six-entry** status ledger is
  in `docs/BENCH.md` § "Per-SKU certification". B1 is cleared; B3 is partially cleared
  (`socat` permits a manual query-only AT session, but `benchAtSender` still rejects sends);
  B4 remains open. The hardware-proven capture defects B2/B5/B6 were fixed in software on
  2026-08-20: USB snapshots retain their `/sys` path, `certify` correlates MM
  `Device`/`Physdev` to the most-specific USB parent, `skuOf` receives MM `Modem.Revision`
  rather than USB `ID_REVISION`, and the shared redactor masks MM/mmcli IMEI and equipment-
  identifier spellings while preserving model/vendor/SKU facts. Realistic RM530N tests pin
  `0504` versus `RM530NGLAAR05A01M4G`. The snapshot contract lives in
  `control/src/backend/usb-device-snapshot.ts` and remains re-exported by the classifier. The
  fixed build has **not** been rerun on the board, so no post-fix hardware bundle, certified
  SKU, or promoted matrix row is claimed.
- **Bench composition evidence** for the SIMCom SIM7600G-H and the carrier-mounted Fibocom
  FM350-GL is recorded in [`docs/COMPOSITION-EVIDENCE.md`](../COMPOSITION-EVIDENCE.md) —
  descriptors, driver bindings, firmware revisions, and the read-back state of each vendor's
  USB-mode command (`AT+CUSBPIDSWITCH`, `AT+GTUSBMODE`), captured **non-mutatingly**
  (bare-execute / READ `?` / TEST `=?` forms only; no SET form was ever sent). It certifies
  nothing: the SIMCom's PID→composition mapping is unproven so its target modes stay
  UNCERTIFIED and HIDDEN, and the FM350 gains **no** classifier entry for its `0e8d:7127`
  carrier id — `docs/FM350-DECISION.md` is unchanged.
- The full bench-runbook ladder, RB-1 through RB-18, lives in `docs/BENCH.md`: RB-9 is the
  fleet-inventory capture (one identity bundle per acquired physical unit), RB-10 is the
  hub VBUS port-cycle verification backing the PowerHook above, RB-11..15/17 are the
  per-SKU/flap-resilience captures documented above, RB-16 is the FM350 probe, and RB-18 is
  the Sierra identity/composition capture. Its 2026-08-25 run is an honest
  `device-not-present` skip: no Sierra VID was attached, `certify` was not invoked, and no
  bundle or certification claim exists.

### Sierra classifier groundwork — exact evidence, never a support claim

`backend/device-classifier.ts` carries exact application-mode Sierra family rows for
EM74xx, EM75xx, and EM919x-class devices, including Sierra's `1199` VID and the HP/Dell
rebrands represented in ModemManager's pinned FCC mapping. Rows are evidence-tiered:
`modemmanager-1.24.2-fcc` means the VID:PID occurs in the pinned release's available-tier
mapping; `mainline-kernel` means Linux's qmi_wwan/qcserial tables name that family. A row can
label a known family but cannot make a device `mm-managed` — live control-interface/driver
evidence remains the only authority for that class, and an unknown Sierra PID remains
unknown. Every classifier fixture is stamped `synthetic: true`, so it cannot cross the
catalog-promotion gate.

### Telit / u-blox / NETGEAR groundwork — and the mixed-VID trap

The same table carries ten exact Telit (`1bc7`) rows, six u-blox (`1546`) LARA-R6/LARA-L6
rows, and ONE NETGEAR (`0846`) row. `CELLULAR_MODEL_EVIDENCE_SOURCES` now pins each tier's
provenance so a reviewer can re-derive any row; a test asserts every tier a row uses has a
pin. **No provider was added for any of these vendors** — this is classifier and doc
groundwork only.

- **A third evidence tier exists: `usb-ids-registry`,** the weakest of the three. It is used
  ONLY where no kernel modem driver claims the id at all — which is itself the evidence
  that the device is a router appliance rather than a controllable module. The NETGEAR
  LB1120 (`0846:68e1`) is the sole row at that tier.
- **`CellularModelEvidence.familyKind` is an OPTIONAL, positive `router-webui` claim, and
  its ABSENCE IS NOT A CLAIM.** Silence does not mean "modem module"; it means nothing here
  asserts otherwise — the same tri-state discipline `fcc/coverage.ts` uses for `unknown`. A
  test pins that exactly one row carries it. It still decides no device class: NETGEAR
  classifies `router-mode` because its interfaces say so, and a test proves the class is
  unchanged when the same composition is presented under an unlisted PID.
- **`0846` is deliberately ABSENT from `CELLULAR_USB_VENDOR_IDS`, and that absence is
  load-bearing.** The USB ID Repository's `0846` block is dominated by NETGEAR Wi-Fi and
  Ethernet adapters — `68e1` is the only cellular entry — so a vendor-keyed rule would
  report a Wi-Fi dongle as a cellular uplink. `1546` has the same shape (u-blox GNSS
  receivers share it with cellular modules) but predates this work and stays; treat a
  vendor-only match on it as WEAK evidence. `1bc7` IS added, because that range is Telit
  cellular modules end to end. Consequence worth knowing: the LB1120 tether currently
  reads `wired-ethernet` from `classifyUsbNetDevice`, which is honest — a known gap, not a
  guess.

### `docs/VENDOR-QUIRKS.md` — sourced, and capped at `implemented`

[`docs/VENDOR-QUIRKS.md`](../VENDOR-QUIRKS.md) records the per-vendor behaviours that make
one module behave differently from another on Linux, with a citation for every claim
(pinned to MM `1.24.2`, a named Linux commit, `usb.ids` `2026.06.26`, OpenWrt's `qmi.sh`,
`usb-modeswitch-data`, and the BELABOX tutorial wiki). Two properties are the whole point:

- **No row sits above `implemented` on the five-state ladder, and none may.** `capable`
  needs a live probe and `certified` needs a hardware drill; a document can produce
  neither. Rows for surfaces this repo ships no code for read `unavailable`, which is
  BELOW `implemented`, not above it.
- **Nothing in it is on a write path, and nothing in it may be put on one.** A quirk is a
  description of somebody else's firmware. It may inform a classifier LABEL, a diagnostic
  READ, or a doc — never an AT command, a QMI/MBIM write, a composition switch, or a band
  lock. An unsourced operator report is recorded AS unsourced and claims nothing.

### `docs/COMPAT-MATRIX.md` — the one tracked support matrix

[`docs/COMPAT-MATRIX.md`](../COMPAT-MATRIX.md) is the single vendor × firmware ×
composition × operation matrix: 22 hardware rows (the six long-standing vendor families plus
the Sierra, Telit, u-blox and NETGEAR groundwork rows) against 18 operations spanning first
enumeration through a sustained bonded uplink.

- **Every claim cell is a member of the five-state ladder in `capability/support-claim.ts`,
  and there is no second status vocabulary.** No "partial", no "works", no tick-and-cross.
  198 cells, all of them `implemented` or `unavailable`; `enabled` / `capable` / `certified`
  appear in the matrix nowhere, for exactly the reason `VENDOR-QUIRKS.md` is capped the same
  way. It follows that **no combination in the repository is `certified`, so none may be
  described as supported.**
- **It states which claims are hardware-free and which are hardware-required**, and links
  each hardware-required operation to its RB runbook. `BENCH.md` remains the sole owner of
  per-runbook status; the matrix links and restates none of it. A cell is raised by a bench
  capture plus a reviewed commit, never by an edit to the matrix.
- **The NETGEAR LB1120 gap is recorded rather than smoothed over**: the row labels the
  family `router-webui`, but with no positive cellular evidence the tether classifies
  `wired-ethernet`, so no operation in this stack reaches it. Its column is mostly
  `unavailable` as a consequence, and the phone-tether row reads the same way for the same
  reason.
- It also records one discrepancy in `VENDOR-QUIRKS.md`: the Sierra row's "no `AT!` form
  exists anywhere in this repository" is true of the `providers/ufi-himi` gate it cites, but
  `usb-mode/runtime-capability.ts` carries Sierra's reviewed `AT!USBCOMP` forms, which is
  what makes the composition-switch operation `implemented` for Sierra.

