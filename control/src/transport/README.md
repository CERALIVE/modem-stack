# D-Bus transport seam

A minimal internal transport interface over [`@httptoolkit/dbus-native`](https://www.npmjs.com/package/@httptoolkit/dbus-native).
Everything the rest of `@ceralive/modem-control` needs to talk to ModemManager over
D-Bus goes through the `DbusTransport` interface exported by [`index.ts`](./index.ts) —
method calls, signal subscriptions, and reconnect. The A3.x D-Bus backend builds
directly on this shape.

## Why this library

`@httptoolkit/dbus-native` is a pure-JavaScript D-Bus client (no libdbus / native
addon), which is the deciding factor: it imports and runs under **Bun 1.3.14** with
**EXTERNAL** auth on a session bus — session-verified during A2.4, and pinned exactly at
`0.1.5`. A native-addon client (anything binding libdbus) is a portability and
cross-compile liability for the arm64 + amd64 device image; a pure-JS client is not.

## The fallback

If `@httptoolkit/dbus-native` proves inadequate — an un-fixable marshalling bug, an
unmaintained upstream, or a Bun incompatibility introduced by a future runtime bump —
the documented fallback is [`@particle/dbus-next`](https://www.npmjs.com/package/@particle/dbus-next),
which is also pure-JS and was verified importable under Bun during planning (draft
ledger §dbus-native). It is **not** implemented here; this note records the escape hatch.
Because the entire library surface is quarantined behind this seam (see below), swapping
to it would touch only [`dbus-native.ts`](./dbus-native.ts), [`transport.ts`](./transport.ts),
and [`codec.ts`](./codec.ts) — never a caller.

## The seam contract

* **No library types leak.** `index.ts` re-exports only the transport's own types
  (`DbusValue`, `DbusVariant`, `MethodCall`, `SignalEvent`, …). The raw library types
  live in [`dbus-native.ts`](./dbus-native.ts) and go no further. A guard test asserts
  the package entry (`../index.ts`) never re-exports the library.
* **Lossless 64-bit.** D-Bus `x` (INT64) and `t` (UINT64) are `bigint` end-to-end, never
  a JS `number`. On decode the library runs with `ReturnLongjs: true` and we convert its
  Long.js objects to `bigint` via their exact decimal string; on encode we require a
  `bigint` and hand the library a decimal string (its only lossless 64-bit input).
  Passing a `number` for a 64-bit field throws `BigIntRequiredError`.
* **`h` is unsupported.** UNIX_FD / file-descriptor passing is rejected up front with a
  typed `UnsupportedSignatureError` — in an outgoing signature, a reply/signal signature,
  or nested in a variant — never silently dropped or coerced.
* **Variants round-trip.** A decoded variant keeps its inner signature
  (`DbusVariant { signature, value }`), so encode/decode is symmetric.

## Conformance

Tests run under `dbus-run-session -- bun test control/src/transport` and prove the seam
two independent ways:

1. **Same library** ([`conformance-same-lib.test.ts`](./conformance-same-lib.test.ts)) —
   round-trips representative signatures against a minimal fake service built on the same
   `@httptoolkit/dbus-native`.
2. **Independent producer** ([`conformance-python.test.ts`](./conformance-python.test.ts)) —
   round-trips against a `python3-dbus` (`dbus-python`) service in a subprocess,
   exercising `a{oa{sa{sv}}}`, `x`/`t` above 2^53, variants, and `PropertiesChanged`
   invalidations. A different implementation on the wire is the real proof our codec is
   correct, not merely self-consistent.

Plus [`reliability.test.ts`](./reliability.test.ts): reconnect after a bus restart
(against a dedicated private `dbus-daemon`), a ≥5000-event signal stream, late replies,
and a 100-cycle subscribe/unsubscribe listener-leak check.

The `test-support/` fakes here are intentionally minimal — just enough to round-trip the
signatures under test. The MM-faithful fake service (root ObjectManager, `Modem` /
`Modem3gpp` interfaces, SIM objects, bearer tripwires) is a separate, later task (A2.3).
