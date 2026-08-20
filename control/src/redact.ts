// Redaction — strip sensitive identifiers from any value before it is logged,
// serialized into a receipt, or written to a bundle.
//
// The sensitive CLASSES (draft §Oracle #1, round-5 auth semantics): ICCID, IMSI,
// EID, SIM PIN, SIM PUK, and APN / connection passwords, PLUS the GNSS coordinate
// class below. Redaction is KEY-BASED and RECURSIVE: it walks nested objects and
// arrays and replaces the value under any sensitive key with a fixed marker, no
// matter how deep — e.g. a password at `policy.connection.auth.password`, or an
// `iccid` inside an array of SIM slots.

/** The marker substituted for every redacted value. */
export const REDACTED = '[redacted]';

// Leaf key names carrying a sensitive value, matched case-insensitively. The match
// is EXACT (or exact on the last dotted segment), so NM-style keys like
// `gsm.password` are caught while non-secret siblings like `gsm.password-flags`
// (a "0"/"4" flag, not a secret) are not.
const SENSITIVE_KEYS: ReadonlySet<string> = new Set<string>([
	'iccid',
	'imsi',
	'eid',
	'pin',
	'pin2',
	'newpin',
	'puk',
	'puk2',
	'password',
	'passwd',
	'subscriptionid',
]);

// GNSS coordinate keys. A fix says where the operator physically is, so it is
// sensitive for a reason none of the keys above share, and it gets its own set so
// the privacy fence stays readable: the GPS module keeps a fix in memory for a
// live display and NEVER persists, uploads, or logs one.
//
// Scoped to a GNSS fix on purpose. `3gpp-lac-ci` (coarse cell location) is NOT
// here — it is the existing cell-info module's deliberate, separately-gated output,
// and silently blanking it would break a surface that already ships.
const LOCATION_KEYS: ReadonlySet<string> = new Set<string>([
	'latitude',
	'longitude',
	'altitude',
	'lat',
	'lon',
	'lng',
	'nmea',
	'nmeasentences',
	'coordinates',
]);

/**
 * SMS content is its own key class, and it may NOT be folded into
 * `SENSITIVE_KEYS` above. That set matches a leaf name exactly (or the last
 * dotted segment), so adding `text` / `number` / `sender` to it would redact
 * every unrelated `text` and `number` in the package — a receipt's reason text,
 * a slot number, a signal reading. These keys are matched WHOLE after case- AND
 * separator-folding, so only a key that genuinely names message content or an
 * originator is scrubbed.
 *
 * A message body routinely carries a one-time code (the bench SIM's inbox holds
 * a literal "Tu pin es: …") and a sender number identifies the subscriber, so
 * both are treated exactly like a PIN: never rendered anywhere.
 *
 * This mirrors CeraUI's `isSmsSensitiveKey` (`helpers/logger.ts`) key-for-key.
 * It is a Rule-D MIRROR, never a shared import — the two halves are kept honest
 * by their tests, not by a path.
 */
const SMS_SENSITIVE_KEYS: ReadonlySet<string> = new Set<string>([
	'smstext',
	'smsbody',
	'smsfrom',
	'smssender',
	'smsnumber',
	'messagetext',
	'messagebody',
	'msisdn',
	'sender',
	'sms.content.text',
	'sms.content.number',
]);

/** Whole-key SMS-content test, case- and separator-insensitive. */
export function isSmsSensitiveKey(key: string): boolean {
	return SMS_SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

/**
 * USSD carrier text — its own class, for the same reason SMS is: `reply`,
 * `command`, and `response` are far too common to redact by leaf name, so these
 * are matched WHOLE after case- and separator-folding.
 *
 * BOTH DIRECTIONS are sensitive, not just the reply. A USSD dialogue is how a
 * subscriber tops up a prepaid line, so the COMMAND routinely carries a voucher
 * code (`*123*<16 digits>#`) and the reply carries a balance, a subscriber
 * number, or a one-time code. `NetworkNotification` / `NetworkRequest` are
 * ModemManager's own property names for network-initiated USSD text and are
 * included so a raw property dump cannot leak what the call path masks.
 *
 * This is why the USSD module names its carrier-text fields `ussdCommand`,
 * `ussdResponse`, and `ussdReply` rather than the shorter names that read better:
 * redaction here is key-based, so the FIELD NAME is the guarantee.
 */
const USSD_SENSITIVE_KEYS: ReadonlySet<string> = new Set<string>([
	'ussd',
	'ussdcommand',
	'ussdreply',
	'ussdresponse',
	'ussdtext',
	'networknotification',
	'networkrequest',
]);

/** Whole-key USSD-content test, case- and separator-insensitive. */
export function isUssdSensitiveKey(key: string): boolean {
	return USSD_SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''));
}

/**
 * The SIM's OWN number (MSISDN) — its own class, matched WHOLE after case-,
 * separator- AND dot-folding so ModemManager's `Modem.OwnNumbers` and mmcli's
 * `modem.generic.own-numbers` are both caught by one rule.
 *
 * It cannot join `SENSITIVE_KEYS`: that set matches a leaf name, and `number` /
 * `numbers` are far too common — a slot number and a band count would both
 * vanish. `msisdn` stays in the SMS set (its historical home) and is not
 * duplicated here.
 *
 * It is DISPLAYED to the operator behind an explicit reveal. That is a
 * rendering decision about a surface the subscriber already owns; it does not
 * make the value loggable, so it is redacted exactly like a PIN.
 */
const OWN_NUMBER_SENSITIVE_KEYS: ReadonlySet<string> = new Set<string>([
	'ownnumber',
	'ownnumbers',
	'phonenumber',
	'phonenumbers',
	'simnumber',
	'subscribernumber',
	'modemgenericownnumbers',
	'modemownnumbers',
]);

/** Whole-key own-number test, case-, separator- and dot-insensitive. */
export function isOwnNumberSensitiveKey(key: string): boolean {
	return OWN_NUMBER_SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_.-]/g, ''));
}

function isSensitiveKey(key: string): boolean {
	const lower = key.toLowerCase();
	if (SENSITIVE_KEYS.has(lower) || LOCATION_KEYS.has(lower)) {
		return true;
	}
	if (isSmsSensitiveKey(key) || isUssdSensitiveKey(key) || isOwnNumberSensitiveKey(key)) {
		return true;
	}
	const dot = lower.lastIndexOf('.');
	if (dot < 0) {
		return false;
	}
	const leaf = lower.slice(dot + 1);
	return SENSITIVE_KEYS.has(leaf) || LOCATION_KEYS.has(leaf);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const proto = Object.getPrototypeOf(value) as unknown;
	return proto === Object.prototype || proto === null;
}

function redactValue(value: unknown, underSensitiveKey: boolean): unknown {
	if (underSensitiveKey) {
		return REDACTED;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item, false));
	}
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			out[key] = redactValue(child, isSensitiveKey(key));
		}
		return out;
	}
	return value;
}

/**
 * Return a deep copy of `value` with every sensitive field redacted. Plain objects
 * and arrays are walked recursively; all other values (primitives, and opaque
 * objects like `Date` / `Set` / `Map`) are returned unchanged. The input is never
 * mutated.
 */
export function redact(value: unknown): unknown {
	return redactValue(value, false);
}
