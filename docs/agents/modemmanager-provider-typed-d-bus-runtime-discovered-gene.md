<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## MODEMMANAGER PROVIDER — TYPED D-BUS, RUNTIME-DISCOVERED GENERIC CONTROLS

`control/src/providers/modem-manager/` is the concrete `ProviderDefinition` for
`org.freedesktop.ModemManager1`. It composes the existing typed transport and adapters; it does
not introduce a second D-Bus stack. `ObjectManager.GetManagedObjects` supplies normalized
snapshots, while the existing epoch-scoped `MmDbusObserver` supplies signal-driven lifecycle
events and retains rows across daemon loss. A new or unknown model is selected by the live
`Modem` interface and receives mode, signal, SIM, and power reads from the properties it exports.
No model catalog participates in those generic reads.

The provider reuses `MmDbusBackend`/`MmMutations`, `MmLocation` plus the bounded
`location/fix-state.ts` machine, `createDbusSmsPort`, `MmUssd`, the band codec/certification split,
and FCC coverage. Band reads are generic; band writes remain refused until the embedding process
supplies a `bandSku` resolving to a catalog entry (see § RADIO CAPABILITY TRUTH). Its `modes`
operation surfaces the modem's own `(allowed, preferred)` catalog verbatim. `Location.Setup` still sends `signal_location=false`, SMS remains
read-only, and FCC remains policy/catalog-only. One shared `ModemActor` serializes every composed
adapter for a modem. The provider has no bearer/APN method; NetworkManager remains sole owner.

`errors.ts` maps typed daemon/transport failures to stable refusal reasons (`unauthorized`,
`unsupported`, `wrong-state`, `busy`, `not-found`, `timed-out`, `disconnected`, `failed`).
`forbidden-subprocess.test.ts` scans every production file in this provider and proves no path can
spawn `mmcli`, `qmicli`, or `mbimcli`; its detector has a non-vacuity control for all three names.
Private-session-bus coverage is `modem-manager-provider.integration.test.ts`. Operation-by-operation
detail (which reads are generic, which writes stay refused, and the exact refusal vocabulary) lives in
[`docs/MODEMMANAGER-PROVIDER.md`](../MODEMMANAGER-PROVIDER.md).

