<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## POLICY

`packaging/` is a **no-fork** effort: the first release carried zero quilt patches; adding a
patch later is an architecture gate (rationale + filed upstream MR + review). The sole current
exception is the exact three-patch BELABOX-derived FM350-GL series approved by the project
owner on 2026-08-22; its MR is still drafted, not filed, and its hardware drill remains open.
This narrow exception does not weaken the default that udev/plugin/device-support improvements
go **upstream first**. The Phase A → Phase B scope boundary is **version-gated at
`v1.0.0`**: CeraUI / device-image / apt integration is out of scope through `v0.2.0` and
authorized from the `v1.0.0` tag forward. Full terms: `POLICY.md` §4.
The Fibocom **FM350** modem (PCIe / `mtk_t7xx`) is documented-**deferred**, not supported —
rationale, source cites, and the open gates are recorded in `docs/FM350-DECISION.md`.

