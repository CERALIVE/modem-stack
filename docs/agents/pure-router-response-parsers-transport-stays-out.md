<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## PURE ROUTER RESPONSE PARSERS — TRANSPORT STAYS OUT

`control/src/hardware/router-parsers.ts` owns the pure CeraUI migration seam for
SIM-presence evidence and Huawei HiLink, ZTE goform, and Qualcomm UFI/HIMI response
normalization. It is exported through the existing root and `./hardware` entry points;
no new package subpath exists. Empty/refused/malformed readings remain explicit unknown
states, vendor placeholders are omitted, and HiLink capability refusal preserves the
device code. The module accepts response bodies only: HTTP, authentication, interface
binding, retries, caching, and every write remain outside it. CeraUI keeps its adapters
until the explicit cutover todo; this migration creates no sibling path dependency.

The same transport-free migration seam also owns the remaining pure CeraUI compatibility
rules: portable USB physical identity/link-id derivation, modem display-name sanitation,
ModemManager enum normalization, USB-network classification and labels, capability-module
selection, and shadow-backend divergence folding. These helpers accept snapshots, primitive
values, or already-normalized records and return deterministic values only. They do not read
udev, invoke ModemManager, persist state, or alter CeraUI; CeraUI keeps its local adapters and
copies until the explicit consumer cutover.

### `parseZteDetails` MUST stay a superset of the consumer it replaces

The seam only works if adopting a packaged parser is a no-op for the shipped
consumer. It was not: an overlay of the 1.1 candidate over CeraUI's own tree found
this parser both NARROWER than the reader it is meant to retire and in disagreement
with it about one key name. Both are fixed here, and both are pinned by tests:

- **`band` and `network_band` are two readings, not one key.** `lte_band` is the
  SERVING cell's band and `wan_active_band` is the band the WAN leg is active on;
  they disagree the moment carrier aggregation is up. This parser previously folded
  all three spellings onto `network_band`, so a consumer rendering the serving band
  got the WAN leg's — or nothing. They are now separate and neither falls back to
  the other.
- **The carrier composition and the dongle's own counters are carried.**
  `lte_ca_{p,s}cell_{arfcn,band,bandwidth}`, `monthly_{tx_bytes,rx_bytes,time}` +
  `date_month`, and the five `realtime_*` counters now emit as `pcell_*` / `scell_*`
  / `monthly_*` (with `monthly_period`) / `session_*`. The `realtime_*` → `session_*`
  rename is deliberate: three of those five are cumulative counters, and the vendor's
  own prefix reads as "live rate" for all five.
- **`stated()` drops every vendor placeholder**, not only the single dash — `--`,
  `n/a` and `N/A` are unset markers on these firmwares too, and echoing one puts a
  value on screen that reads like a reading. This widening applies to
  `parseUfiDetails` as well, which shares the helper.

**`parseUfiDetails` is still NARROWER than CeraUI's UFI reader and takes a different
input shape** (three bodies here, five there — no `status`/`networkMode`). No
consumer probes for it today, so nothing is broken; a future cutover must reconcile
it before pointing CeraUI's UFI path at this one.

