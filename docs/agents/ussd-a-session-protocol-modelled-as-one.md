<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## USSD — A SESSION PROTOCOL, MODELLED AS ONE

`control/src/ussd/` is the gated USSD module: a pure session machine (`session.ts`), a
refusal taxonomy with its registration reader (`refusal.ts` + `registration.ts`), the four
D-Bus calls (`calls.ts`), and the adapter that drives them (`mm-ussd.ts`).

**LEASE-ONLY, never journaled.** A USSD session cannot re-register the radio, so it takes
the per-modem mutation lease and carries no pre-state and no rollback — the split todo 29's
`MutationAdmissionPort` enforces in the TYPE SYSTEM, so this classification is not a
convention that can drift.

**USSD is a SESSION protocol, not request/response, and that is why the machine exists.**
`Initiate` opens a dialogue the network may hold open pending a `Respond`; a session that is
neither responded to nor cancelled stays open NETWORK-side, consuming a scarce
per-subscriber slot and failing the next `Initiate` with a busy error nobody can see the
cause of. "Which verb is legal right now" is therefore a real question with a real wrong
answer, and answering it inside the D-Bus adapter would make it untestable without a bus.

Four properties are load-bearing:

- **Three of the seven states are LOCAL.** `initiating` / `responding` / `cancelling` have
  no counterpart in MM's `MMModem3gppUssdSessionState`, because MM has no state for "we
  dispatched a call and the reply has not landed". Without them a second `initiate` racing
  the first would be judged against `idle` and let through — exactly the double-open the
  network answers busy.
- **An illegal verb is REFUSED with a typed reason, never thrown and never ignored**, and
  the machine does not move. A refusal at an RPC boundary must name what the caller can do
  about it; a throw becomes an opaque failure and a silent no-op becomes a UI that spins.
- **`lte-only-unsupported` is claimed ONLY on a positively PS-only registration.** USSD is a
  circuit-switched supplementary service, so a modem attached LTE/5G-SA with no CS domain
  and no CSFB can only carry it where the operator deployed USSI (3GPP TS 24.390) — and
  where they did not, the modem answers a generic unsupported/failed error indistinguishable
  from "this modem has no USSD interface". Reporting that as a device limitation would send
  an operator hunting for a firmware fix for a network policy. `registration.ts` derives the
  fact rather than guessing: `AccessTechnologies` all packet-only ⇒ no CS domain, EXCEPT
  that MM's two CSFB registration states (`*_CSFB_NOT_PREFERRED`, 9 and 10) override it
  outright. An unread registration stays `undefined` and can only ever make the refusal LESS
  specific.
- **An unanswered session is closed at a bound AND the network release is attempted.** The
  machine closes `timed-out` first — that is the operator's answer whether or not the
  release lands — and the modem-side `Cancel` is best-effort afterwards, because a modem
  that did not answer the dialogue may not answer this either and a timeout must still
  terminate. A `closed` machine accepts nothing, so a finished session cannot be
  resurrected; the adapter's per-modem map starts each new dialogue from a fresh machine.

**Carrier text is redacted by FIELD NAME, which is why the fields are named as they are.**
`../redact.ts` is key-based, so `ussdCommand` / `ussdResponse` / `ussdReply` (rather than the
shorter names that read better) ARE the guarantee. BOTH directions are sensitive, not just
the reply: a USSD dialogue is how a subscriber tops up a prepaid line, so the command
routinely carries a voucher code and the reply a balance or a one-time code.
`NetworkNotification` / `NetworkRequest` are MM's own property names for network-initiated
USSD text and are included so a raw property dump cannot leak what the call path masks.
Nothing in `calls.ts` logs, and every error it raises is re-thrown untouched so the
classifier — not a string built around the payload — decides what the caller is told.

**Status: `implemented-but-uncertified`.** Only the bench Quectel has a SIM and it never
registers, so no bench modem can open a USSD session (phase-C todo 2, BLOCKER B4). The state
machine, the refusal classifier, the timeout path and the redaction are fixture-proven; the
live balance-check drill has not run.

