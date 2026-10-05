<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THREE-ARTIFACT MAP

| Directory | Artifact | Role |
|-----------|----------|------|
| `control/` | `@ceralive/modem-control` (npm) | TypeScript control library — domain model, ModemManager D-Bus backend, NetworkManager adapter, desired-state reconciler, injected admission/ownership/USB-hub ports, USB composition-mode model + evidence-bundle **ingestion seam**, data-usage sampler + the **usage-policy write surface**, capability-module **support-claim taxonomy + detection**, and the **band-lock** vocabulary + certification catalog (see §§ below). Published to public npm under `@ceralive` as **built ESM + `.d.ts`** across seven entry points (see § PUBLISHED PACKAGE SURFACE). |
| `cli/` | `modem-control` (bench CLI) | The iteration surface: `probe`/`watch`/`apply`/`set-usb-mode`/`usage`/`certify`/`hil-cycle`, compiled `arm64`+`amd64`, run against real modems. Not published to npm. |
| `packaging/` | ModemManager stack `.deb`s **+ the first-party companion** | Trixie rebuilds of ModemManager + libmbim + libqmi + libqrtr-glib — packaging only, not a fork. libmbim/libqmi/libqrtr-glib remain source-unmodified; ModemManager carries exactly three owner-approved, BELABOX-derived FM350-GL patches, hardware-validated on the carrier-mediated USB topology after restoring the original `ATZ0` first-enable override (see `POLICY.md` and `docs/adr/ADR-FM350-RNDIS-BEARER.md`) — PLUS `ceralive-modem-support`, the `Architecture: all` first-party companion that owns CeraLive's generic modem system assets. |

`control/` + `cli/` are one **Bun** workspace. `packaging/` builds in a **trixie** container —
the suite the device image runs; `build-stack.sh` refuses a container whose suite disagrees.

