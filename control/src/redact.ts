// Redaction — strip sensitive identifiers from any value before it is logged,
// serialized into a receipt, or written to a bundle.
//
// The sensitive CLASSES (draft §Oracle #1, round-5 auth semantics): ICCID, IMSI,
// EID, SIM PIN, SIM PUK, and APN / connection passwords. Redaction is KEY-BASED and
// RECURSIVE: it walks nested objects and arrays and replaces the value under any
// sensitive key with a fixed marker, no matter how deep — e.g. a password at
// `policy.connection.auth.password`, or an `iccid` inside an array of SIM slots.

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

function isSensitiveKey(key: string): boolean {
	const lower = key.toLowerCase();
	if (SENSITIVE_KEYS.has(lower)) {
		return true;
	}
	const dot = lower.lastIndexOf('.');
	return dot >= 0 && SENSITIVE_KEYS.has(lower.slice(dot + 1));
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
