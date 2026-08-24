# Evidence-bundle ingestion — from a `certify` bundle to a reviewed catalog commit

This is the documented path between a bench capture and `certified-catalog.json`. It exists
so the transcription step — reading descriptor bytes out of a capture by eye and typing them
into a JSON file — stops being a place where a certification claim can quietly become wrong.

**It promotes nothing.** The seam is a pure transform that emits a *review artifact*. A
catalog addition remains what Phase A made it: a human-reviewed commit. Nothing here writes
a file, mutates the shipped catalog, or opens a PR.

Code: [`control/src/usb-mode/ingestion.ts`](../control/src/usb-mode/ingestion.ts),
[`promotion-review.ts`](../control/src/usb-mode/promotion-review.ts),
[`usb-devices-parse.ts`](../control/src/usb-mode/usb-devices-parse.ts).
Runbooks that produce its input: [`BENCH.md`](BENCH.md) RB-11 … RB-15.

---

## The rule the code enforces

> **A bundle marked `synthetic: true` is REFUSED for catalog promotion.**

Not by convention, not by a reviewer remembering — by `buildCatalogEntryCandidate`, which
returns a typed refusal (`reason: 'synthetic-bundle'`) before it looks at anything else. A
catalog entry asserts a certified hardware fact; synthetic evidence can never back one.

Classifier *fixtures* are a different matter: `buildClassifierFixture` **accepts** a
synthetic bundle and stamps `provenance.synthetic = true` on the result, because synthetic
fixtures are legitimate test data. The asymmetry is deliberate and is the whole design.

---

## What goes in, what comes out

```
modem-control certify <slot> [--transition <mode>]
        │
        ├─▶ bundle.json  ─┐
        └─▶ CERTIFY OK: sha256=<64hex> …
                          │
                          ▼
        control/src/usb-mode/  ingestion seam
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
  buildClassifierFixture()       buildCatalogEntryCandidate(claim)
  → UsbDeviceSnapshot            → CatalogEntry  (REFUSES synthetic:true)
    + provenance                    + evidenceBundleSha256
          └───────────────┬───────────────┘
                          ▼
              renderPromotionReview()
                → the PR comment a human reviews
                          ▼
              human-reviewed commit  ← the ONLY promotion
```

### Where each field comes from

| Output field | Source in the bundle |
|---|---|
| `vidPid` / `model` / `firmwarePrefix` | `sku` (the three catalog discriminators, captured together) |
| `bDeviceClass`, per-interface class/subclass/protocol, **per-interface driver** | the `usb-devices` text, parsed by `parseUsbDevices` |
| `physicalUid`, `ifname` | `usb.udevProperties` → `ID_PATH`, `INTERFACE` |
| `expectedDescriptors` | `transition.afterDescriptors` (stage 2 only) |
| `evidenceBundleSha256` | the sha256 `certify` printed for **this** bundle |
| `canonicalMode` | **the reviewer's stated claim** — never inferred |

`usb-devices` rather than `lsusb -v` because it is the only half of a base bundle that names
each interface's **bound kernel driver**, and `classifyDevice` decides `mm-managed` vs
`router-mode` partly on `qmi_wwan` / `cdc_ether` / `option` bindings.

`canonicalMode` is stated, not inferred, because a catalog entry is an assertion a human
signs. When the bundle carries transition evidence the seam cross-checks the claim against
the captured `transition.from` and refuses a mismatch rather than resolving it either way.

---

## Two stages, because the code says so

`certify --transition` refuses a SKU that is not already in the catalog, so an entry cannot
be authored in one pass. See [`BENCH.md` § Per-SKU certification](BENCH.md) for the full
table; in short:

1. **Stage 1** — `certify <slot>` → an entry with `permittedTransitions: []`, reviewed and
   merged.
2. **Stage 2** — `certify <slot> --transition <mode>` → **one** `permittedTransitions[]`
   element on that entry, carrying the stage-2 bundle's own sha256.

---

## Typed refusals

Every refusal is a named condition with an actionable `detail`, never a throw and never a
partial result.

| `reason` | What it means |
|---|---|
| `sha256-malformed` | the sha is not 64 lowercase hex — checked before the bundle is read |
| `bundle-malformed` | the bundle fails the ingestion view schema |
| `sku-missing` | the capture matched no USB device to the slot; the promotion gate remains strict even if capture wiring regresses |
| `device-not-in-capture` | the SKU's VID:PID is absent from the `usb-devices` text |
| `device-ambiguous` | two or more devices share that VID:PID — a fixture must name one physical device (this bench has an identical Huawei HiLink pair) |
| `no-interfaces-captured` | the device parsed with zero interfaces; such a fixture classifies nothing |
| `synthetic-bundle` | **catalog promotion only** — the bundle is `synthetic: true` |
| `transition-mode-mismatch` | the claimed `canonicalMode` contradicts the captured `transition.from` |
| `entry-schema-invalid` | the candidate fails the authoritative `catalogEntrySchema` (e.g. a router-mode SKU declaring a transition) |

### The view schema is deliberately non-strict

The authoritative bundle schema lives beside the `certify` command in `cli/`, which depends
on `control/` and not the reverse. Ingestion therefore validates a **view**: the subset it
reads, with unknown fields ignored. Adding a field to the bundle can never break ingestion —
which is the point.

---

## Worked example (synthetic — the refusal path)

Generated by running the seam over a synthetic bundle whose SKU is the repo's existing
`CERALIVE-SYNTHETIC-TEST-SKU`. This is the output verbatim, not a mock-up. It is the
promotion path's **failure** leg, and it is the leg that matters: a synthetic bundle must
produce a loud refusal, not a quiet acceptance.

````markdown
## Catalog promotion review — RB-11

Evidence: `test-results/modem-phase-b/08/quectel-rm530n-gl/bundle.json`

Generated by the `control/src/usb-mode/` ingestion seam. **This comment promotes
nothing** — the promotion is the human-reviewed commit that follows it.

### ❌ Catalog entry — REFUSED

**Reason:** `synthetic-bundle`

> bundle for slot 'Modem/2' is marked synthetic:true; a catalog entry requires a real capture (synthetic:false)

This is a typed refusal from the ingestion seam, not a review opinion. Fix the
capture and re-run the runbook; do not hand-author the artifact around it.

### Proposed classifier fixture (`control/src/backend/device-classifier.test.ts`)

> ⚠️ Derived from a **synthetic** bundle — valid as test data, never as certification evidence.

```ts
const FIXTURE: UsbDeviceSnapshot = {
  "vendorId": "2c7c",
  "productId": "0125",
  "model": "CERALIVE-SYNTHETIC-TEST-SKU",
  "firmwareRevision": "SYNTHETICFW01",
  "bDeviceClass": 0,
  "interfaces": [
    { "interfaceClass": 255, "interfaceSubClass": 0, "interfaceProtocol": 0, "driver": "option" },
    { "interfaceClass": 255, "interfaceSubClass": 255, "interfaceProtocol": 255, "driver": "qmi_wwan" }
  ],
  "udevProperties": {
    "ID_PATH": "platform-xhci-hcd.0.auto-usb-0:1.4.4",
    "INTERFACE": "wwan0"
  },
  "physicalUid": "platform-xhci-hcd.0.auto-usb-0:1.4.4",
  "ifname": "wwan0"
};
```

### No checklist

The catalog entry was refused, so there is nothing to review. A checklist here
would invite a reviewer to approve an artifact that does not exist.
````

The fixture half still renders, correctly: a synthetic fixture is usable test data, and its
provenance says exactly what it is.

### The accepted rendering, for reference

> **This is a RENDERING ILLUSTRATION, not evidence.** It is the same fabricated bundle with
> its `synthetic` flag flipped to `false`, so a reviewer can see the template they will
> receive. **No such capture exists**, no hardware was involved, and
> `certified-catalog.json` is unchanged by this document. The seam's own test suite
> (`control/src/usb-mode/ingestion.test.ts`) is what proves the accepted path.

````markdown
### Proposed `certified-catalog.json` entry

```json
{
  "vidPid": "2c7c:0125",
  "model": "CERALIVE-SYNTHETIC-TEST-SKU",
  "firmwarePrefix": "SYNTHETICFW01",
  "canonicalMode": "qmi",
  "permittedTransitions": []
}
```

### Reviewer checklist (every box is a human judgement)

- [ ] The bundle at `…/bundle.json` was captured by **RB-11** on real hardware, and its `CERTIFY OK` line reads `synthetic=false`.
- [ ] The bundle sha256 in the entry matches the sha256 the capture printed — recomputed, not copied from this comment.
- [ ] `canonicalMode: "qmi"` is the mode the device was actually observed in, not the mode it was expected to be in.
- [ ] `permittedTransitions: []` is correct for this stage — a stage-1 entry never declares a transition.
- [ ] No claim in `docs/MODEM-SUPPORT-MATRIX.md` is being changed by this commit without its own evidence.
````

Every box is a human judgement a machine cannot tick. That is why the checklist exists and
why the seam stops one step short of the commit.

## Runtime composition switching does not wait for promotion

Catalog promotion is still the only path to the strongest composition postcondition, but
it is no longer the source of the provider's offered target set. For a vendor whose exact
READ, TEST, and SET forms are in the reviewed runtime registries, the ModemManager provider
asks the device for its current mode and enumerated modes. It offers a target only when the
same enumeration contains the current mode, so the represented vocabulary includes a return
path. A catalog miss on that interrogable device is not an `uncertified` suppression.

The transition uses the catalog when an entry matches the selected exact SET command:
canonical mode plus `expectedDescriptors` remain the strongest, tier-1 proof. Without such
an entry, tier 2 requires a post-re-enumeration vendor READ to report the target. Tier 2 is
weaker because it proves the modem's reported setting but not the reviewed descriptor
composition. AT `OK` proves neither tier. This runtime fallback changes no promotion rule,
does not add entries, and does not apply to band certification.

---

## Using it

```ts
import {
  buildCatalogEntryCandidate,
  buildClassifierFixture,
  renderPromotionReview,
} from '@ceralive/modem-control';

const request = { bundle: JSON.parse(bundleJson), bundleSha256: shaFromCertifyOkLine };

const comment = renderPromotionReview({
  context: { runbook: 'RB-11', evidencePath: 'test-results/modem-phase-b/08/…/bundle.json' },
  entry: buildCatalogEntryCandidate(request, { canonicalMode: 'qmi' }),
  fixture: buildClassifierFixture(request),
});
```

Post `comment` on the PR that proposes the catalog change. A refused promotion still renders
a comment — a silently-absent comment is indistinguishable from a forgotten run.

---

## Bench reality — pre-fix captures remain unpromotable

A non-mutating capture pass against the SIMCom SIM7600G-H and the carrier-mounted Fibocom
FM350-GL ([`COMPOSITION-EVIDENCE.md`](COMPOSITION-EVIDENCE.md)) ran the real
`modem-control certify` on real hardware. Both runs printed a valid
`CERTIFY OK … synthetic=false` line, and **neither bundle was promotable**. The three capture
defects below were fixed in software on 2026-08-20, but the fixed build has not been rerun on
the board. The historical bundles stay destroyed/unpromotable and prove no post-fix behavior.
[`BENCH.md`](BENCH.md) carries the hardware-status ledger.

| Defect | Historical effect and current software behavior |
|---|---|
| **B2** — target USB parent was matched by an unpopulated `ifname` | Pre-fix bundles had no `sku` and empty `udevProperties`, and the seam correctly refused `sku-missing`. The enumerator now retains its `/sys` path and `certify` matches MM `Device`/`Physdev` to the most-specific USB parent |
| **B5** — `imei` / `EquipmentIdentifier` spellings were outside the shared redaction class | Pre-fix fleet-wide managed objects leaked every modem's IMEI. Shared-redactor and bundle regressions now mask MM property, bare/camel/separator, and dotted keyfile spellings while preserving model/vendor/SKU facts |
| **B6** — `firmwarePrefix` came from USB `ID_REVISION` / `bcdDevice` | Pre-fix entries would have been keyed on `0318` / `0001`. `captureBase` now derives the discriminator from MM `Modem.Revision`; the RM530N regression distinguishes `0504` from `RM530NGLAAR05A01M4G` |

None was a flaw in the seam itself: its typed refusals were the correct response to broken
capture input. No SKU may reach `certified-catalog.json` from this evidence until a new
post-fix board capture passes the stage-1 checks and human review.
