<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## GPS / LOCATION — A LIVE FIX, AND DELIBERATELY NO HISTORY

`control/src/ports/location.ts` + `control/src/location/` +
`control/src/backend/mm-location.ts` are the gated GNSS module. The port is
`getLocationStatus` / `enableGnss` / `disableGnss` / `readFix` and nothing else, and it
is deliberately NOT part of `ModemManagerPort` — a consumer that only reconciles radio
and SIM state has no business holding a handle that can read a position.

**The privacy fence is a PRODUCT rule, not a phase limitation.** There is no history
verb, no track verb, no export verb and no upload verb, and none may be added: a fix is
held in memory for a live display and is gone the moment GNSS is switched off or the fix
goes stale. `ports/location-fence.test.ts` fails the build if a member whose name implies
history, tracking, persistence or upload ever appears on the port.

Four decisions are load-bearing and easy to undo by accident:

- **`Location.Setup`'s `signal_location` argument is ALWAYS false.** Passing `true` makes
  ModemManager broadcast the `Location` property over `PropertiesChanged`, which would put
  the operator's coordinates on the system bus for every listener — including this
  package's own observer, whose snapshots are logged. The fix is fetched by an explicit
  `GetLocation` call instead, so a coordinate only ever exists where somebody asked for one.
- **GNSS runs through `actor.run`, NOT `actor.runQuiesced`.** Quiescing exists to stop
  NetworkManager racing a disruptive change and it costs a bearer deactivation; dropping a
  link on a bonded device to switch a GPS receiver on would be an absurd trade.
  `Location.Setup` touches no bearer, so per-modem serialization is all that is needed.
- **Disable clears ONLY the GNSS bits.** `3gpp-lac-ci` is the existing cell-info module's
  source, so blanking the whole mask would silently switch off a neighbouring feature the
  operator never touched. For the same reason `3gpp-lac-ci` is absent from `GNSS_SOURCES`,
  and the `Location` interface merely being exported is NOT a GNSS claim — MM exports it
  for 3GPP-LAC/CID-only devices (the fleet's FM350-GL is exactly one), so a GNSS source
  must appear in `Location.Capabilities`.
- **Acquisition is BOUNDED and a fix EXPIRES.** `location/fix-state.ts` is a pure, total
  machine with no clock and no I/O — the caller supplies `at` on every event, which is what
  makes both bounds testable without waiting. Past `acquireTimeoutMs` (120 s) the state
  becomes an honest terminal `no-fix` rather than an endless spinner; a fix older than
  `fixTtlMs` (30 s) is dropped. A fix is reachable ONLY through `renderableFix`, which
  answers only in the `fix` state, so no code path can render a position the modem has
  stopped reporting.

`gps-nmea` is decoded locally (`location/nmea.ts` — GGA only, checksum-verified) because it
is the one GNSS source every GNSS-capable fleet modem advertises while MM's pre-decoded
`gps-raw` dict is not guaranteed. GGA is the sentence used because it carries fix QUALITY
alongside the position, so "the receiver has not locked on" is decoded rather than inferred.
A `gps-raw` entry that exists but carries no usable coordinate pair is NOT a fix — MM
populates the key as soon as the source is switched on.

Coordinates are their own redaction class (`latitude` / `longitude` / `altitude` / `lat` /
`lon` / `lng` / `nmea` / `nmeasentences` / `coordinates`), so a fix that reaches a log line,
a receipt or a bundle comes out as the marker.

**Status: `implemented-but-uncertified`.** Three fleet modems advertise GNSS, so the
capability gate is satisfied, but whether a GNSS antenna is physically attached to the bench
Quectel is unanswered (phase-C todo 2, `needs-user` N1), so the live-fix drill has not run.
The capability, no-fix, disable, expiry and redaction paths are fixture-proven; the
acquire-a-real-fix path is not.

