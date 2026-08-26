# ADR — Stay on TypeScript: no Rust migration for the modem control stack

**Status:** ACCEPTED. The project owner reviewed the Rust migration option and rejected it on
2026-08-24. The decision is final until one of the named revisit triggers in §6 fires; it is
not a deferral and carries no scheduled re-evaluation.
**Date:** 2026-08-24
**Deciders:** CeraLive project owner (decision); modem-stack maintainers (analysis and
recommendation).
**Supersedes:** nothing. **Amends:** nothing. It records the language decision that
[`AGENTS.md`](../../AGENTS.md) § WORKSPACE / TOOLCHAIN previously stated only as a fact
("Bun 1.4.0, strict TypeScript 7.0.2") with no rationale behind it.

---

## 1. What this ADR is for

Two questions arrived together while planning the `modem-stack-quality-compat` effort. The
first: should the ModemManager control path be rewritten in Rust, following the
`srtla-send-rs` precedent of a Rust core with a thin TypeScript client over a versioned
JSON-RPC socket? The second: what may this repository take from `irlserver/modem-metrics`,
an MIT-licensed Rust project covering some of the same ground?

Both were answered in the same review, and both answers need to outlive the effort that
produced them. Without this record the next person reading `control/src/providers/` sees a
pure-JS D-Bus stack with no explanation of why it is not Rust, and sees telemetry fields
whose shape was clearly informed by somebody else's work with no statement of what was and
was not taken. This document is that explanation.

---

## 2. Decision

**No Rust migration.** `@ceralive/modem-control` and the `modem-control` bench CLI stay
TypeScript on Bun. No Rust daemon, no `zbus` core, no napi addon, no bounded prototype spike,
and no Rust source file enters this repository under this decision.

The alternative that was on the table and is now closed: a Rust ModemManager daemon built on
hand-generated `zbus` proxies, fronted by a thin TypeScript client over a versioned JSON-RPC
Unix socket. It was assessed as a genuine reliability and ownership improvement in the
abstract. It was rejected because the specific improvement it offers is not the improvement
this stack needs, and the cost of getting it is paid in exactly the semantics that are
hardest to re-prove.

---

## 3. Rationale

### 3.1 The quality asymmetry runs the other way

The comparison that prompted the question is `irlserver/modem-metrics` (read at commit
`bf15066`), roughly 5,300 lines of Rust: a `zbus` ModemManager provider, a serial AT
provider, NETGEAR and Huawei HTTP providers, a GPS crate, an interface-metrics module, and an
NDJSON probe CLI.

It is a metrics project, and it is measurably narrower than this one on every axis that makes
modem control dangerous:

| Property | `irlserver/modem-metrics` | `modem-stack` |
|---|---|---|
| Control operations | none; it reads and reports | descriptor-gated read and write surface |
| Safety model | none | mutation admission, exclusive ownership, durable journal, armed rollback, required readback |
| Refusal vocabulary | none; errors are strings | typed refusal reasons across every provider |
| Redaction | none | key-based redaction classes for PII, credentials, SMS bodies, coordinates, USSD text |
| Hardware-integration tests | none | bench runbooks RB-1..RB-17 plus a private-session-bus integration suite |
| Test surface | none found | ~190 test files, including grep gates that fail the build on forbidden constructs |

Rust would not have produced any of that, and TypeScript did not prevent any of it. The
memory-safety and concurrency guarantees a Rust rewrite buys are real, but nothing in this
stack's defect history points at them: the fences that keep a modem from being stranded are
architectural, and they are already built. Rewriting them in a second language would put
every one of those guarantees back on the "unproven again" list to buy a class of safety this
codebase has not been failing on.

### 3.2 No mature ModemManager Rust binding exists

`zbus` 5.19 is the standard D-Bus crate and it is solid, but there is no maintained Rust
binding for ModemManager 1.24's interface surface. The realistic path is hand-generated
proxies via `zbus_xmlgen`, which means this repository would own and maintain the generated
binding for every MM interface it touches, and re-own it on every MM bump. That is a
permanent maintenance liability accepted in exchange for a benefit §3.1 already found to be
misaimed.

### 3.3 Migrating proven semantics is where the regressions live

The behaviours that would have to be re-implemented and re-proven are precisely the subtle
ones: epoch-scoped observer reconnection and row retention across daemon loss, device
generation fencing on async completion, the `unknown-outcome` uncertainty fence and its
durable journal counterpart, per-modem actor serialization with quiesce leases, the
one-bounded-attempt authentication rules in three router providers, and the redaction classes
that keep a voucher code or a coordinate out of a log line.

Each of those is currently pinned by tests that would not survive a language change intact.
A rewrite does not carry a test suite across; it carries the intent and re-expresses it, and
every re-expression is a chance to lose a distinction that took a hardware drill to find. The
`preferred: none` case, the `absent` versus `unknown` SIM split, and the `armed` versus
`executing` journal mapping are three examples where the right answer is one line different
from a plausible wrong one.

### 3.4 Pure-JS D-Bus is adequate under Bun

The performance argument for Rust does not apply to this workload. The control path is
event-driven and low-rate: property changes, signal subscriptions, and a handful of method
calls per modem per minute. It is not a hot loop, not a codec, and not a packet path. The
typed pure-JavaScript D-Bus transport under Bun handles it with headroom, and the production
provider already spawns no subprocess at all (`forbidden-subprocess.test.ts` proves no path
can reach `mmcli`, `qmicli`, or `mbimcli`).

`srtla-send-rs` is not a counter-precedent. That component sits in the media path, where
per-packet cost and jitter are the product. This one does not.

---

## 4. What this decision does NOT do

- It does not claim Rust is the wrong language in general, or that the daemon shape assessed
  here is a bad design. It says this stack does not need it.
- It does not forbid Rust elsewhere in CeraLive. `srtla-send-rs` is unaffected.
- It does not authorize adopting any code from `irlserver/modem-metrics`. See §5.
- It does not schedule a re-evaluation. There is no "revisit in six months" clause here, and
  a future change may not cite this document as evidence that a migration was planned.

---

## 5. Attribution: `irlserver/modem-metrics`

`irlserver/modem-metrics` (`github.com/irlserver/modem-metrics`, read at commit `bf15066`) is
**MIT-licensed**. Its license permits code reuse. **No source code from it was copied into
this repository, in any form, at any point.** No file, function, type, constant table, or
test fixture originates there. What was taken is a small set of CONCEPTS, re-expressed from
scratch against this package's own contracts:

- **Signal telemetry breadth.** The idea that a directly-managed ModemManager modem should
  report RF detail well beyond a quality percentage: RSRP, RSRQ, SINR, cell identity, tracking
  area, operator identity, and serving band. This repository had that breadth only on the
  router providers; the concept is what prompted extending it to the MM path. The
  implementation is our own, through `ObservationEnvelope` with per-metric provenance and the
  four-state `readMetric` vocabulary, neither of which exists in their model.
- **Counter-reset-aware rates.** The idea that a byte counter running backwards means the
  counter was reset, so the correct response is to emit no rate for that interval and
  rebaseline, rather than to publish a negative or wildly large figure. Applied in
  `control/src/backend/usage/sampler.ts` under our existing window and anchor rules.
- **Availability framing.** The idea that "is this source reachable" and "is this source
  healthy" are separate questions that must not collapse into one status. This reinforced the
  existing separation between an unavailable observation and a fresh observation whose metrics
  are unknown with a reason.

Several parts of their design were examined and deliberately NOT adopted: the raw serial AT
provider (it competes with ModemManager for the port), shallow AT response parsing, an
unversioned NDJSON output contract, URL-based device identity, first-bearer-only byte
counters, and treating an untyped extras bag as part of the contract.

Credit for the ideas above belongs to that project's author. Responsibility for everything in
this repository, including the way those ideas are expressed here, belongs to CeraLive.

---

## 6. Revisit triggers

The decision in §2 stands until one of these specific conditions is met. Each is a fact
somebody can check, not a judgement call:

| # | Trigger | Why it would reopen the question |
|---|---|---|
| 1 | A maintained, third-party-owned Rust binding for ModemManager's current interface surface exists, with a release history and more than one maintainer. | It removes §3.2 entirely: the generated-proxy maintenance liability disappears. |
| 2 | A defect class attributable to the runtime, not the architecture, is measured on a board: a memory-safety fault, a data race, or a GC pause that misses a control deadline. | It would be the first evidence that §3.1's "misaimed benefit" reading is wrong. |
| 3 | The control path acquires a sustained high-rate workload, for example continuous per-packet or per-frame processing rather than event-driven property changes. | It invalidates §3.4's adequacy argument on its own terms. |
| 4 | Bun or the pure-JS D-Bus transport stops being viable for this workload: an upstream deprecation, an unfixed protocol defect, or a loss of maintenance. | The current runtime choice would no longer be available, so the comparison restarts from scratch. |
| 5 | The project owner reverses the decision. | It was an owner decision; it is theirs to change. |

A trigger firing reopens the QUESTION. It does not pre-approve a migration, and it does not
make any part of §3 obsolete on its own.

---

## 7. Evidence index

| Source | What it carries |
|--------|-----------------|
| `github.com/irlserver/modem-metrics` @ `bf15066` | The Rust metrics project surveyed in §3.1 and credited in §5: workspace layout, provider set, absence of control operations, absence of tests, MIT license text. |
| `github.com/dbus2/zbus` | The D-Bus crate assessed in §3.2 (5.19 at review time), including `zbus_xmlgen` as the proxy-generation path. |
| `github.com/linux-mobile-broadband/ModemManager` | Read at tag `1.24.2` for the interface surface a hand-generated binding would have to cover. |
| [`AGENTS.md`](../../AGENTS.md) § WORKSPACE / TOOLCHAIN | The toolchain this decision preserves: Bun 1.4.0, strict TypeScript 7.0.2, Biome. |
| [`AGENTS.md`](../../AGENTS.md) §§ safety model | The admission, ownership, journal, rollback, readback and redaction fences §3.1 and §3.3 describe. |
| `control/src/providers/modem-manager/forbidden-subprocess.test.ts` | The proof cited in §3.4 that the production MM path spawns no CLI. |
| `srtla-send-rs/docs/adr/ADR-001-control-protocol.md` (workspace sibling) | The Rust-core-plus-thin-TS-client precedent §3.4 distinguishes this stack from. |
