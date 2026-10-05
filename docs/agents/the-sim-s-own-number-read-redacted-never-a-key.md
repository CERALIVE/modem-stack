<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE SIM'S OWN NUMBER — READ, REDACTED, NEVER A KEY

`Modem.OwnNumbers` is the MSISDN the carrier wrote into the SIM. `mapping.ts`
`readOwnNumbers` folds it onto `ModemIdentity.ownNumbers`
(`readonly SubscriberNumber[]`, branded like `SubscriptionId` because it is the
same PII class), and `redact.ts` gains `isOwnNumberSensitiveKey` for it.

Four decisions carry weight:

- **ABSENT, EMPTY and BLANK all read as NOT REPORTED.** Most SIMs carry no
  MSISDN in their elementary files at all, so an empty `as` is the ordinary
  answer — publishing `[]` would invite a consumer to render "no numbers" as a
  finding rather than as silence. The key is omitted instead.
- **The array is KEPT, not collapsed to a first element.** MM's property is `as`
  and a dual-number SIM is expressible; dropping the tail would be a silent
  loss. The bench Quectel RM530N-GL reports exactly one (`+573115422359`), which
  is what the fixtures use.
- **It is its OWN redaction class, not an addition to `SENSITIVE_KEYS`.** That
  set matches a leaf name, so `number` / `numbers` there would blank a slot
  index and a band count package-wide. `msisdn` stays where it already lived, in
  the SMS set, and is not duplicated. Mirrors CeraUI's
  `isOwnNumberSensitiveKey` (`helpers/logger.ts`) — a Rule-D MIRROR, never a
  shared import.
- **It may never bind policy.** `PolicyBindingKey` enumerates its fields, so the
  addition cannot leak into a durable key by construction — the same protection
  `subscriptionId` already relies on. It IS displayed to an operator behind an
  explicit reveal; that is a rendering decision and does not make it loggable.

Coverage: `control/src/backend/mapping.test.ts` (the read matrix, the
fingerprint bump, and the everything-else-untouched control) plus the three
own-number blocks in `control/src/redact.test.ts`.

