<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## BAND LOCK — THE ONE MODULE THAT IS STRICTER THAN THE FRAMEWORK FLOOR

`control/src/band/` is the first of the seven capability modules with real verbs
behind it. Two halves:

- **`band-names.ts`** — `MMModemBand` ↔ name, both directions. The D-Bus surface
  speaks numbers (`SupportedBands` / `CurrentBands` / `SetCurrentBands` are all
  `au`); every operator-facing surface speaks the name (`eutran-3`, `any`). ONE
  mapping so the two cannot disagree. It reproduces `mm-enums.h`'s actual shape:
  the GSM/UTRAN head (1..20) is IRREGULAR — `UTRAN_2` is 12 while `UTRAN_6` is 8 —
  so it is an explicit table and can only ever be one, while every later block is
  arithmetic by MM's own construction (`EUTRAN_n = 30 + n`, `CDMA_BCn = 128 + n`,
  `NGRAN_n = 300 + n`). Deriving those rather than transcribing ~350 constants is
  the point: a transcription is where a wrong band number hides, and a wrong band
  number locks a radio to a band the network does not operate on. A value this
  build does not name round-trips as `band-<n>` — never dropped, never guessed.
- **`certification.ts` + `certified-bands.json`** — the per-SKU proof gate.

**`encodeBandList` FAILS CLOSED AS A WHOLE.** One unplaceable name rejects the
entire selection rather than silently narrowing it: a partial band set is a
DIFFERENT lock from the one that was asked for, and applying it strands the radio
on bands nobody chose. `decodeBandList` is the mirror — a malformed member is
dropped rather than coerced, and MM's `unknown` (0) is dropped because it means
"the modem did not say", which is not a band an operator can select.

**There is no reset VERB, and there must not be one.** ModemManager releases a
band lock by setting exactly `MM_MODEM_BAND_ANY` (256); `setCurrentBands(modem,
['any'])` IS the reset. Adding a `resetBands` sibling would be a second way to
express one D-Bus call, and the two would eventually disagree about what "no
lock" means.

**Band-lock deliberately requires `certified`, not `capable`, to be OFFERED.**
That is a documented DEVIATION from `support-claim.ts`'s framework floor, and the
framework is right in general: hiding an uncertified-but-working control puts
hardware behind a paperwork gate. For this module the paperwork IS the safety
argument — a band the SIM's network does not operate on registers nowhere, and a
modem that does not honour a reset leaves an operator with no way back short of a
replug they may not be able to reach. So `isBandControlCertified` gates the
control, and the catalog demands FOUR separate proofs (`supportedRead`, `set`,
`readback`, `reset`), each `z.literal(true)`, so a half-certified entry cannot be
expressed at all: a reviewer with three of four has an uncertified SKU and the
file says so by OMITTING it. `readback` exists because an accepted-but-ignored
write is indistinguishable from success at the call site.

**The shipped catalog is EMPTY, and a test pins that.** No fleet modem has been
through the drill: the bench Quectel RM530N-GL's SIM never registers (phase-C
todo 2, blocker B2), so "re-registration proven" cannot be claimed on this bench
today. An entry is added by a human-reviewed commit carrying the transcript,
exactly like `usb-mode/certified-catalog.json`.

`setCurrentBands` runs QUIESCED through the shared `ModemActor` for the same
reason `setRadioModes` does: it re-registers the radio, so NM must stand down
before the bearer drops underneath it rather than after.

