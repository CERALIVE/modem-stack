<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## UFI / HIMI PROVIDER (TODO 26) — READ-ONLY, PLUS THE QUALCOMM PROHIBITION FENCES

`control/src/providers/ufi-himi/` normalizes the Qualcomm UFI/HIMI telemetry the pure
parsers already own (`hardware/router-parsers.ts` → `observations/sources/ufi.ts`) into a
provider that is **read-only by construction, not by policy**. It adds a session and a
transport around those parsers and nothing else.

**Read-only is structural in three independent places.** HIMI is one endpoint
(`POST /himiapi/json`) with the verb in the body's `cmdid`, so a method restriction would
prove nothing; the command vocabulary is a frozen union instead — seven `get*` reads plus
`login` — and a write command is therefore UNREPRESENTABLE rather than refused. The
operations surface exposes `ProviderReadOperations` entries verbatim (a type with no
`write` member to omit), every descriptor carries
`support.write: {supported:false, reason:'ufi-himi-provider-is-read-only'}`, and a
structural test asserts the only callables reachable from `operations()` are the two
reads and the pure planner.

**`05c6:9024` is evidence of a COMPOSITION, not a permission** — RNDIS plus an ADB
interface. **`05c6:9091` is a firmware-chosen product id and is NOT proof of DIAG**; only
an interface descriptor (class `ff`, subclass `ff`, protocol `30`) proves a DIAG channel,
which is what `classifyUfiDiagEvidence()` encodes. Production never falls back to ADB,
SSH, telnet or DIAG under any circumstance, and `UFI_DIAG_PRODUCTION_ACCESS` is
`prohibited` unconditionally — a descriptor-confirmed channel raises only what a
SUPERVISED BENCH operator may attempt by hand ([`docs/UFI-DIAG-PROBE.md`](../UFI-DIAG-PROBE.md)).

**`prohibitions.ts` is INERT DATA, and the operations it names have no implementation
anywhere** — not a refused stub, not a disabled branch. NV/EFS/identity/calibration
writes, firmware flashing, EDL automation, blind driver/interface retries, DIAG writes,
the DIAG info probe (bench-supervised only) and shell transport fallback each answer a
typed reason. `planUfiOperation` takes no transport parameter and returns synchronously,
so `transportContacted: false` is a provable literal; a spy-transport test asserts ZERO
calls both there and for the same ids driven through the real `OperationEngine`, where
the inert descriptor refuses on three independent fences (read unsupported, write
unsupported, availability refused, plus an empty allowed-value set).
`no-write-path.test.ts` scans the comment-stripped provider source for the constructs a
write path would need — subprocess, raw socket, shell-fallback binary, DIAG device node,
mutating HTTP verb, write-shaped literal — each with a non-vacuity control.

Login is bounded to ONE attempt per physical modem per generation; a `SessionOut` drops
the cached session and surfaces as an honest `auth-expired` reading rather than a retry
loop. The admin password is EPHEMERAL BENCH INPUT (`UFI_BENCH_PASSWORD`), injected for a
supervised run only, and `credential-fence.test.ts` scans tracked and intended-untracked
files for it plus its base64/SHA-256 derivatives.

### Bench descriptor capture — tooling, schema, and measured composition

`control/scripts/ufi-himi-capture.sh` + `control/scripts/ufi-himi-evidence.ts` are the
read-only evidence-capture path for `05c6:9091`, and they live in `control/scripts/`
rather than in the provider directory on purpose: bench tooling is not published
(`files: ["dist"]`), and `no-write-path.test.ts` enumerates the provider directory
exactly, so a file added there would be a change to that gate. **No bundle CONTENT is
committed** — the redacted 2026-08-23 hardware bundle remains repo-local and gitignored.
That drill measured a four-interface QMI + ADB-class composition: interface 2 was claimed
by `qmi_wwan`, no `ff/ff/30` DIAG descriptor existed, and the HIMI identity endpoint was
unreachable through the target's own `wwan1`. The tracked classification is in
`docs/UFI-DIAG-PROBE.md`; no composition change was attempted.

- **The bundle is `manifest.json` + five capture files + one credential-gated HIMI file**,
  staged in a temp directory and moved into place as a unit, so a published path either
  holds a complete bundle or does not exist. With no matching device the script answers
  `device-not-present` on stdout and exits 3 having written nothing.
- **Per-step status is five-valued, not a boolean** — `captured` / `empty` /
  `tool-unavailable` / `unreachable` / `skipped-no-credential`. The bench image ships no
  `usbutils` (RB-9), so "no `lsusb` here" and "no device there" must not collapse.
- **Redaction happens at capture time and the rules have ONE implementation** — the
  script's `--redact-filter` mode, which the test EXECUTES rather than re-expressing. Two
  layers mirroring `redact.ts`: key-based masking plus a MAC/14+-digit backstop. The
  staged bundle is then swept and a surviving identifier DESTROYS it (exit 4); there is no
  override flag. `sweepUfiEvidenceText` is the tested twin of the script's own sweep, and
  two checkers that disagree fail the capture.
- **The descriptor triple and the driver binding are two facts and are never merged.**
  `classifyUfiInterfaceRole` answers `diag` only through `classifyUfiDiagEvidence` itself,
  so the bench analysis cannot drift from the shipped rule; `ff/ff/*` outside `30` stays
  `vendor-specific` and the CAPTURED binding says who claimed it. Upstream matching
  `05c6:9091` in `qmi_wwan.c` under an unrelated annotation, and QCSuper documenting the
  same id on a different device, are evidence about neither — only this unit's descriptor
  is.
- **A static gate scans both files** for `usb_modeswitch`, `setprop`, a shell-transport
  invocation, an emergency-download tool, `AT!`, an uppercase AT write form and a QMI
  write, each with a non-vacuity control, and asserts every command literal in them is a
  member of `UFI_COMMANDS`. Procedure: [`docs/UFI-DIAG-PROBE.md`](../UFI-DIAG-PROBE.md).
