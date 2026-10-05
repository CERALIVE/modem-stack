<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## SMS — LIST / READ AND OBSERVATION, PERMANENTLY

`control/src/ports/sms.ts` + `control/src/sms/` are the read-only SMS surface:
`SmsObservationPort` is `list()` / `observe()` / `stop()` and nothing else. There is
no verb here that composes, stores, sends, or deletes a message, and none may be
added — sending or deleting is billable, irreversible, and turns a diagnostic read
into real control over the subscriber's account. That is PERMANENT policy, not a
phase limitation; CeraUI has carried the same contract since Phase A.

**Two grep gates, and they enforce different vocabularies.**
`control/src/sms/readonly-gate.test.ts` scans the whole SMS surface (the port
included) for the D-Bus write verbs (`Messaging.Create` / `Delete`, `Sms.Send` /
`Store`), the mmcli spellings, and the identifiers a hand-rolled write path would
use; it also asserts the only D-Bus METHODS called are `List` + `GetAll` and the
only SIGNALS subscribed are `Added` + `Deleted`. Those two sets are asserted
SEPARATELY because both are spelled `member: 'X'` and only an outgoing `callMethod`
can mutate a device. CeraUI's `tests/modem-sms-readonly-gate.test.ts` is the other
half, extended by this work to cover the D-Bus verbs its mmcli-flag patterns could
not spell. Neither gate may be deleted or narrowed to land a write path.

**LIST ONCE, then follow the signals.** `createDbusSmsPort`
(`sms/dbus-messaging.ts`) calls `Messaging.List` once and folds `Added`/`Deleted`
from then on. Re-listing on a poll tick is the anti-pattern this port exists to
remove: it costs one method call per stored message per tick and still cannot report
an arrival sooner than the tick it lands on. The ONE re-list is on a transport
RECONNECT, where the events that occurred while the bus was down were never
delivered — and it is published as `resynced`, which the store applies by REPLACING
its rows. Folding a fresh list as a series of `Added` events would keep a message
deleted during the outage forever, and is exactly how a restart comes to duplicate
an inbox it already held.

**Duplicate suppression is not identity-based, because MM's own duplicate is not
byte-identical.** ModemManager announces a message while it is `receiving` and again
once it is `received`, so `createSmsInboxStore` (`sms/inbox-store.ts`) updates a row
whose content CHANGED and no-ops one that is verbatim. A store that skipped on "have
I seen this id" would keep the empty `receiving` row forever.

**`sms/mmcli-parse.ts` is a CLI grammar living beside a D-Bus adapter, deliberately.**
`mmcli` is a client of the SAME daemon, and CeraUI has read its inbox through it on
real hardware since Phase A — so owning the grammar here is what makes the port's
output provable against that reader on captured output (`sms/parse.test.ts` pins the
golden values; CeraUI's `modem-sms-port-parity.test.ts` pins the identical ones), and
what lets a consumer move its parsing onto this package without moving its transport
in the same change. Four behaviours in it are load-bearing and each fails silently if
dropped: the octal unescape is per-BYTE then UTF-8 (`\302\241` is two bytes, not two
characters); the service-centre timestamp's HOURS-ONLY offset (`…-05`) is widened to
`-05:00` or every message scores undated and "newest first" degrades to object-index
order, which MM reuses; the list is cut to `SMS_INBOX_CAP` (50) BEFORE any per-message
read; and an absent `modem.messaging.sms` VALUE is an empty inbox while a missing KEY
is drift.

**Nothing here puts message content into an error, a log, or a receipt.** A body
routinely carries a one-time code and a sender identifies the subscriber, so a
malformed record reports the KEY NAMES it found and nothing else, and the module
never logs at all. `redact.ts`'s `isSmsSensitiveKey` is the value-side class; it is
its own set rather than additions to `SENSITIVE_KEYS` because that set matches leaf
names exactly, so adding `text` / `number` / `sender` would blank a receipt reason, a
slot number, and a signal reading across the package. It mirrors CeraUI's
`helpers/logger.ts` set key-for-key — a Rule-D MIRROR, never a shared import.

**HONEST STATUS: no live receive has been drilled.** Only the Quectel has a SIM and
it never registers, so no bench modem can receive an SMS (todo-2 BLOCKER B4). Every
claim here is fixture-proven, including the restart-recovery behaviour; what is
missing is the board measurement, not the behaviour.

