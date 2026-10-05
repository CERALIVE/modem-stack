<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## USB-COMPOSITION SWITCH — RUNTIME OFFER, TIERED PROOF

The ModemManager provider's `usbComposition` operation derives its targets from the
device's own vendor READ + TEST replies through `resolveRuntimeCompositionCapability`.
It never turns a model-catalog miss into `uncertified`. The only operator-facing
suppressions are the exact literals `unknown-vendor`, `no-return-path`,
`blocked-by-state`, and `provisioning-disabled`; every suppressed state carries zero
offerable targets. An unknown vendor, a disabled provisioning setting, or a live-state
block is decided before any AT transport call. A known device is offered only when its
enumeration contains its current mode, proving that the represented vocabulary includes
a return path.

The AT fence widened by name, not by pattern. `AT_RUNTIME_QUERY_ALLOWLIST` contains only
the four vendors' exact READ/TEST forms. `RUNTIME_COMPOSITION_SET_REGISTRY` builds one
validated SET form per vendor, and only the selected enumerated target is unioned into
the held lease. Capability reads send no SET form. The operation descriptor keeps the
shared mutation admission lease, durable journal, armed rollback, and required readback;
the existing transition still keeps fail-closed identity, the streaming interlock, MM
inhibit/uninhibit, and the bounded drop/re-enumeration wait.

Both READ/TEST replies must also carry `AtResponse.ok === true` before either raw body is
parsed. A failed current OR enumeration query is suppressed as `no-return-path` with no
current mode, no enumerated modes, and no offerable targets — even when its raw body contains
a syntactically valid vendor line before `ERROR`. Multiline response parsing may decode only
a transport-successful reply; it can never promote failed AT traffic into a write surface.

Success has two proof tiers. **Tier 1 remains strongest and unchanged:** when a reviewed
catalog transition matches the exact SET command, the re-enumerated canonical mode and
USB descriptors must both match its `expectedDescriptors`. **Tier 2 is explicitly
weaker:** when no reviewed transition exists, the re-enumerated device must report the
raw target through its own vendor READ. AT `OK` is proof in neither tier. The catalog
therefore remains valuable evidence without being a model allowlist for an interrogable
device. This change is composition-only; band writes retain their separate four-proof
certification gate.

