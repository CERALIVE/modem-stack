// Raw-payload helpers — the retention half of normalization.
//
// Every normalizer builds ONE flat `RawFieldRecord` out of whatever bodies it was
// handed, keyed by `<body>.<provider-native field>`, and reads its metrics out of
// that same record. Reading from the retained copy rather than from the original
// bodies is what makes the no-drop property hold by construction instead of by
// discipline: a field a metric consumed is necessarily a field the diagnostics block
// already carries.

import type { RawFieldRecord, RawFieldValue } from './provenance';

export function rawKey(body: string, field: string): string {
	return `${body}.${field}`;
}

/** Prefix a provider's flat record with the body it came from. */
export function prefixRawRecord(
	body: string,
	record: Readonly<Record<string, RawFieldValue>> | undefined,
): RawFieldRecord {
	const out: Record<string, RawFieldValue> = {};
	for (const [field, value] of Object.entries(record ?? {})) {
		out[rawKey(body, field)] = value;
	}
	return out;
}

export function mergeRawRecords(...records: readonly RawFieldRecord[]): RawFieldRecord {
	return Object.assign({}, ...records) as RawFieldRecord;
}

export function rawString(record: RawFieldRecord, key: string): string | undefined {
	const value = record[key];
	if (typeof value === 'string') {
		const trimmed = value.trim();
		return trimmed === '' ? undefined : trimmed;
	}
	return typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

export function rawNumber(record: RawFieldRecord, key: string): number | undefined {
	const value = record[key];
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}
	if (typeof value !== 'string' || value.trim() === '') {
		return undefined;
	}
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function rawStringArray(record: RawFieldRecord, key: string): readonly string[] | undefined {
	const value = record[key];
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string')
		: undefined;
}

export function hasRawField(record: RawFieldRecord, key: string): boolean {
	return Object.hasOwn(record, key);
}

/**
 * One member of a D-Bus STRUCT retained verbatim.
 *
 * ModemManager's `SignalQuality` is a `(ub)` and its `CurrentModes` is a `(uu)`, so
 * retaining them verbatim means the raw record holds an ARRAY where a naive read
 * expects a scalar. A caller that flattened the struct before retention would keep the
 * first member and silently drop the second — the recency flag, and the preferred mode
 * — which is the drop this layer exists to prevent. A scalar answers at index 0, so a
 * source that already flattened (mmcli, or a pre-existing fixture) still decodes.
 */
export function rawStructMember(
	record: RawFieldRecord,
	key: string,
	index: number,
): RawFieldValue | undefined {
	const value = record[key];
	if (Array.isArray(value)) return value[index];
	return index === 0 ? value : undefined;
}

export function rawNumberAt(
	record: RawFieldRecord,
	key: string,
	index: number,
): number | undefined {
	const member = rawStructMember(record, key, index);
	if (typeof member === 'number') return Number.isFinite(member) ? member : undefined;
	if (typeof member !== 'string' || member.trim() === '') return undefined;
	const parsed = Number.parseFloat(member);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function rawBooleanAt(
	record: RawFieldRecord,
	key: string,
	index: number,
): boolean | undefined {
	const member = rawStructMember(record, key, index);
	return typeof member === 'boolean' ? member : undefined;
}

const XML_LEAF = /<([A-Za-z_][\w.-]*)>([^<]*)<\/\1>/g;

/**
 * Flatten every leaf element of an XML body into `<body>.<Tag>` entries.
 *
 * A repeated tag — HiLink's `<NetworkMode>` list repeats `<Index>` once per mode —
 * would otherwise overwrite its predecessors, so the second and later occurrences are
 * suffixed `#2`, `#3`, …. Losing a repeat is exactly the silent drop this layer
 * exists to prevent, and the suffix keeps the original tag name legible.
 */
export function flattenXmlBody(body: string, name: string): RawFieldRecord {
	const out: Record<string, RawFieldValue> = {};
	const seen = new Map<string, number>();
	for (const match of body.matchAll(XML_LEAF)) {
		const tag = match[1] ?? '';
		const count = (seen.get(tag) ?? 0) + 1;
		seen.set(tag, count);
		out[rawKey(name, count === 1 ? tag : `${tag}#${count}`)] = (match[2] ?? '').trim();
	}
	return out;
}

/** Parse a JSON object body, or `undefined` when the bytes are not a JSON object. */
export function parseJsonObject(body: string): Readonly<Record<string, unknown>> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch (error) {
		if (!(error instanceof SyntaxError)) {
			throw error;
		}
		return undefined;
	}
	return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
		? (parsed as Readonly<Record<string, unknown>>)
		: undefined;
}

/** Parse a JSON object body into a flat record, or `undefined` when it is not one. */
export function parseJsonRecord(body: string): Readonly<Record<string, RawFieldValue>> | undefined {
	const parsed = parseJsonObject(body);
	if (parsed === undefined) {
		return undefined;
	}
	const out: Record<string, RawFieldValue> = {};
	for (const [field, value] of Object.entries(parsed)) {
		out[field] = normalizeRawValue(value);
	}
	return out;
}

/**
 * A nested object has no flat representation, so its JSON text is kept.
 *
 * Serializing rather than dropping is the whole contract of this layer: a payload
 * this record cannot model structurally is still a payload a diagnostician can read.
 */
export function normalizeRawValue(value: unknown): RawFieldValue {
	if (value === null) {
		return null;
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(normalizeRawValue);
	}
	// A nested object has no flat representation; keep its JSON text rather than drop it.
	return JSON.stringify(value);
}
