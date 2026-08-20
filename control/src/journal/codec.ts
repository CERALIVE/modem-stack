// Line codec for the journal: exactly one entry per line, JSON, no wrapper.
//
// WHY DECODING RETURNS A RESULT INSTEAD OF THROWING. A journal is read at exactly
// one moment — recovery after an unclean restart — and that is the moment a throw
// is most expensive: it aborts the read at the first damaged byte and takes every
// still-valid entry after it with it. The whole point of this module is that a
// damaged record is DATA, reported alongside the records that survived, so nothing
// earlier or later is discarded to make one bad line disappear.
//
// FAILURES NAME A FIELD, NEVER CONTENT. Same rule the two policy stores follow: a
// classification carries the offending field name and a byte count, never the bytes
// themselves, because a journal line can hold provider identifiers and refusal
// reasons and a log line is the wrong place to reproduce them.

import {
	type JournalDescriptorEvidence,
	type JournalEntry,
	type JournalOutcome,
	MODEM_CONTROL_JOURNAL_SCHEMA_VERSION,
} from './entry';

/** Why one record could not be read. `field` names the offending key, never its value. */
export interface JournalDecodeFailure {
	readonly code:
		| 'empty'
		| 'invalid-json'
		| 'not-an-object'
		| 'unsupported-schema-version'
		| 'schema-mismatch'
		| 'unreadable';
	readonly field?: string;
	/** Byte offset for a JSON syntax error, when the runtime reported one. */
	readonly offset?: number;
}

export type JournalDecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly failure: JournalDecodeFailure };

class SchemaError extends Error {
	constructor(readonly field: string) {
		super(`schema-mismatch: ${field}`);
	}
}

class SchemaVersionError extends Error {
	constructor() {
		super('unsupported-schema-version');
	}
}

function record(raw: unknown, field: string): Record<string, unknown> {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SchemaError(field);
	return raw as Record<string, unknown>;
}

function requiredString(source: Record<string, unknown>, field: string): string {
	const value = source[field];
	if (typeof value !== 'string' || value.length === 0) throw new SchemaError(field);
	return value;
}

function optionalString(source: Record<string, unknown>, field: string): string | undefined {
	const value = source[field];
	if (value === undefined) return undefined;
	if (typeof value !== 'string') throw new SchemaError(field);
	return value;
}

function requiredNonNegativeInteger(source: Record<string, unknown>, field: string): number {
	const value = source[field];
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new SchemaError(field);
	}
	return value;
}

function requiredStringArray(source: Record<string, unknown>, field: string): readonly string[] {
	const value = source[field];
	if (!Array.isArray(value) || value.some((member) => typeof member !== 'string')) {
		throw new SchemaError(field);
	}
	return value as readonly string[];
}

function member<T extends string>(
	source: Record<string, unknown>,
	field: string,
	allowed: readonly T[],
): T {
	const value = source[field];
	if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
		throw new SchemaError(field);
	}
	return value as T;
}

const AUTHORITIES = ['provider', 'controller', 'hardware'] as const;
const IMPACTS = ['read', 'write', 'session', 'disruptive', 'recovery'] as const;
const CONFIDENCES = ['high', 'medium', 'low', 'unknown'] as const;
const UNKNOWN_OUTCOME_REASONS = [
	'stale-generation',
	'write-reply-timed-out',
	'write-reply-dropped',
] as const;

function parseDescriptor(raw: unknown): JournalDescriptorEvidence {
	const source = record(raw, 'descriptor');
	return {
		descriptorId: requiredString(source, 'descriptorId'),
		provider: requiredString(source, 'provider'),
		authority: member(source, 'authority', AUTHORITIES),
		mutationImpact: member(source, 'mutationImpact', IMPACTS),
		profiles: requiredStringArray(source, 'profiles'),
		firmware: requiredStringArray(source, 'firmware'),
		confidence: member(source, 'confidence', CONFIDENCES),
	};
}

function parseOutcome(raw: unknown): JournalOutcome {
	const source = record(raw, 'outcome');
	switch (member(source, 'status', ['applied', 'refused', 'failed', 'unknown-outcome'] as const)) {
		case 'applied':
			return { status: 'applied' };
		case 'refused':
			return { status: 'refused', reason: requiredString(source, 'reason') };
		case 'failed':
			return { status: 'failed', reason: requiredString(source, 'reason') };
		case 'unknown-outcome':
			return {
				status: 'unknown-outcome',
				reason: member(source, 'reason', UNKNOWN_OUTCOME_REASONS),
			};
	}
}

function parseEntry(raw: unknown): JournalEntry {
	const source = record(raw, 'entry');
	if (source.schemaVersion !== MODEM_CONTROL_JOURNAL_SCHEMA_VERSION) throw new SchemaVersionError();
	const base = {
		schemaVersion: MODEM_CONTROL_JOURNAL_SCHEMA_VERSION,
		operationId: requiredString(source, 'operationId'),
		physicalModemId: requiredString(source, 'physicalModemId'),
		generation: requiredNonNegativeInteger(source, 'generation'),
		recordedAtMs: requiredNonNegativeInteger(source, 'recordedAtMs'),
		descriptor: parseDescriptor(source.descriptor),
	} as const;
	if (member(source, 'phase', ['started', 'completed'] as const) === 'started') {
		return { ...base, phase: 'started' };
	}
	return { ...base, phase: 'completed', outcome: parseOutcome(source.outcome) };
}

/** Classify a decode failure into a metadata-only result (never raw content). */
function classify(error: unknown): JournalDecodeFailure {
	if (error instanceof SchemaVersionError) return { code: 'unsupported-schema-version' };
	if (error instanceof SchemaError) return { code: 'schema-mismatch', field: error.field };
	if (error instanceof SyntaxError) {
		const offset = /position (\d+)/.exec(error.message)?.[1];
		return offset === undefined
			? { code: 'invalid-json' }
			: { code: 'invalid-json', offset: Number(offset) };
	}
	return { code: 'unreadable' };
}

/**
 * Serialize one entry to a single line WITHOUT its terminator.
 *
 * Keys are emitted in a fixed order because the round-trip tests compare bytes,
 * and byte comparison is the only assertion that catches a field a reader silently
 * dropped (`JSON.parse` + a permissive validator will happily lose one and still
 * report success — the same trap the srtla telemetry byte-parity suite exists for).
 */
export function encodeJournalEntry(entry: JournalEntry): string {
	const descriptor = {
		descriptorId: entry.descriptor.descriptorId,
		provider: entry.descriptor.provider,
		authority: entry.descriptor.authority,
		mutationImpact: entry.descriptor.mutationImpact,
		profiles: entry.descriptor.profiles,
		firmware: entry.descriptor.firmware,
		confidence: entry.descriptor.confidence,
	};
	const base = {
		schemaVersion: entry.schemaVersion,
		phase: entry.phase,
		operationId: entry.operationId,
		physicalModemId: entry.physicalModemId,
		generation: entry.generation,
		recordedAtMs: entry.recordedAtMs,
		descriptor,
	};
	return JSON.stringify(entry.phase === 'started' ? base : { ...base, outcome: entry.outcome });
}

/** Decode one line. An empty/whitespace-only line is reported, never silently dropped. */
export function decodeJournalEntry(line: string): JournalDecodeResult<JournalEntry> {
	if (line.trim().length === 0) return { ok: false, failure: { code: 'empty' } };
	try {
		return { ok: true, value: parseEntry(JSON.parse(line)) };
	} catch (error) {
		return { ok: false, failure: classify(error) };
	}
}

/** Decode an arbitrary JSON document with a caller-supplied validator. */
export function decodeJournalDocument<T>(
	text: string,
	validate: (raw: unknown) => T,
): JournalDecodeResult<T> {
	if (text.trim().length === 0) return { ok: false, failure: { code: 'empty' } };
	try {
		return { ok: true, value: validate(JSON.parse(text)) };
	} catch (error) {
		return { ok: false, failure: classify(error) };
	}
}

/** The validator helpers the legacy reader reuses, so both shapes fail the same way. */
export const journalSchema = {
	record,
	requiredString,
	optionalString,
	requiredNonNegativeInteger,
	member,
	schemaError(field: string): Error {
		return new SchemaError(field);
	},
	schemaVersionError(): Error {
		return new SchemaVersionError();
	},
} as const;
