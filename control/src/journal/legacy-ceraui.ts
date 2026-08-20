// COMPATIBILITY READ PATH for the mutation journal CeraUI already writes.
//
// WHY THIS EXISTS AT ALL. CeraUI has kept a durable modem-mutation journal since
// long before this package had one, and devices in the field have those files on
// disk right now. The two shapes are genuinely different — this package's journal
// is an append-only EVENT LOG in one file, CeraUI's is a directory of per-modem
// LATEST-STATE SNAPSHOTS, one JSON document per modem, rewritten whole on every
// transition. Neither can be re-labelled into the other, so the bridge is a READER:
// it decodes CeraUI's shape into the SAME `JournalOperationRecord` model
// `recovery.ts` produces, so a consumer enumerates pending and unknown-outcome work
// across both without CeraUI having to change its file format first.
//
// NOTHING HERE WRITES. This module reads and decodes; it never rewrites, repairs,
// migrates in place, or deletes a slot. CeraUI's own reader leaves an unreadable
// slot on disk deliberately, and a second reader that "cleaned up" behind it would
// destroy the evidence CeraUI kept on purpose.
//
// THE DIRECTORY IS INJECTED, exactly like the native store's path — this module
// hardcodes no location, and the path-injection gate covers it.
//
// THE SLOT FILENAME IS A HASH, and `legacyMutationSlotName` mirrors that rule so a
// consumer can address ONE modem's slot without scanning. It is a RULE-D MIRROR of
// CeraUI's helper, never a shared import — the same relationship the support-claim
// ladder and the redaction key sets already have with their CeraUI twins.
//
// TWO MAPPING DECISIONS CARRY WEIGHT:
//
//  * `armed` maps to `pending` and `executing` maps to `unknown-outcome`. They are
//    not the same fact. `armed` says the pre-state was captured and the write had
//    not been dispatched, so the device is untouched. `executing` says the write
//    WAS dispatched and no terminal state was ever recorded — which is precisely
//    what this package calls an unknown outcome. Collapsing them would either
//    invent certainty about a dispatched write or manufacture doubt about one that
//    never left.
//
//  * `kind` is validated as a NON-EMPTY STRING, not against a frozen enum.
//    CeraUI's runtime enum spreads its capability-module mutation kinds into the
//    list, so the vocabulary grows on CeraUI's release cycle. Freezing a copy here
//    would make this reader reject a perfectly valid file the day CeraUI adds a
//    capability module — a compatibility reader that fails closed on new-but-valid
//    input is worse than no reader at all.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { decodeJournalDocument, type JournalDecodeResult, journalSchema } from './codec';
import type { JournalDescriptorEvidence } from './entry';
import {
	type JournalOperationRecord,
	type JournalRecovery,
	type JournalRecoveryDisposition,
	summarizeJournalRecords,
} from './recovery';
import type { JournalDamageRecord } from './store';

/** The `version` literal CeraUI's schema pins. */
export const LEGACY_CERAUI_JOURNAL_VERSION = 1;

/** CeraUI's cap on retained history entries per slot. */
export const LEGACY_CERAUI_HISTORY_CAP = 32;

export const LEGACY_CERAUI_MUTATION_STATES = [
	'armed',
	'executing',
	'completed',
	'failed',
	'acknowledged',
	'device-absent-quarantine',
	'decommissioned',
	'recommission-pending',
] as const;
export type LegacyCeraUiMutationState = (typeof LEGACY_CERAUI_MUTATION_STATES)[number];

export const LEGACY_CERAUI_ACK_MODES = ['verified-rollback', 'force-rebaseline'] as const;
export type LegacyCeraUiAckMode = (typeof LEGACY_CERAUI_ACK_MODES)[number];

export interface LegacyCeraUiHistoryEntry {
	readonly state: LegacyCeraUiMutationState;
	readonly at: number;
	readonly detail?: string;
}

/** One CeraUI slot document, decoded verbatim. `preState` is kept opaque. */
export interface LegacyCeraUiMutationEntry {
	readonly version: typeof LEGACY_CERAUI_JOURNAL_VERSION;
	readonly stableKey: string;
	readonly kind: string;
	readonly state: LegacyCeraUiMutationState;
	readonly attemptId: string;
	readonly startedAt: number;
	readonly updatedAt: number;
	/** The rollback target. Opaque by design — its shape is the mutation kind's. */
	readonly preState: Readonly<Record<string, unknown>>;
	readonly detail?: string;
	readonly acknowledgedMode?: LegacyCeraUiAckMode;
	readonly history: readonly LegacyCeraUiHistoryEntry[];
}

export interface LegacyCeraUiJournalRead {
	/** The same recovery model `reconstructJournalRecovery` produces. */
	readonly recovery: JournalRecovery;
	/** The decoded slot documents, verbatim, so `preState` survives the read. */
	readonly entries: readonly LegacyCeraUiMutationEntry[];
}

export interface LegacyCeraUiJournalOptions {
	/** REQUIRED. The embedding process owns where CeraUI put its journal. */
	readonly dir: string;
}

/**
 * The slot filename CeraUI derives from a stable key.
 *
 * RULE-D MIRROR of CeraUI's own helper. It is a plain lowercase-hex SHA-256 of the
 * key's UTF-8 bytes; the key itself never appears in the filename in plaintext.
 */
export function legacyMutationSlotName(stableKey: string): string {
	return createHash('sha256').update(stableKey, 'utf8').digest('hex');
}

function parseHistoryEntry(raw: unknown): LegacyCeraUiHistoryEntry {
	const source = journalSchema.record(raw, 'history[]');
	const detail = journalSchema.optionalString(source, 'detail');
	return {
		state: journalSchema.member(source, 'state', LEGACY_CERAUI_MUTATION_STATES),
		at: journalSchema.requiredNonNegativeInteger(source, 'at'),
		...(detail === undefined ? {} : { detail }),
	};
}

/** Validate one slot document. Throws the codec's metadata-only schema errors. */
export function validateLegacyCeraUiEntry(raw: unknown): LegacyCeraUiMutationEntry {
	const source = journalSchema.record(raw, 'entry');
	if (source.version !== LEGACY_CERAUI_JOURNAL_VERSION) throw journalSchema.schemaVersionError();
	const history = source.history;
	if (!Array.isArray(history) || history.length > LEGACY_CERAUI_HISTORY_CAP) {
		throw journalSchema.schemaError('history');
	}
	const detail = journalSchema.optionalString(source, 'detail');
	const acknowledgedMode =
		source.acknowledgedMode === undefined
			? undefined
			: journalSchema.member(source, 'acknowledgedMode', LEGACY_CERAUI_ACK_MODES);
	return {
		version: LEGACY_CERAUI_JOURNAL_VERSION,
		stableKey: journalSchema.requiredString(source, 'stableKey'),
		kind: journalSchema.requiredString(source, 'kind'),
		state: journalSchema.member(source, 'state', LEGACY_CERAUI_MUTATION_STATES),
		attemptId: journalSchema.requiredString(source, 'attemptId'),
		startedAt: journalSchema.requiredNonNegativeInteger(source, 'startedAt'),
		updatedAt: journalSchema.requiredNonNegativeInteger(source, 'updatedAt'),
		preState: journalSchema.record(source.preState, 'preState'),
		...(detail === undefined ? {} : { detail }),
		...(acknowledgedMode === undefined ? {} : { acknowledgedMode }),
		history: history.map(parseHistoryEntry),
	};
}

/** Decode one slot document's text. Never throws; returns a typed failure. */
export function decodeLegacyCeraUiEntry(
	text: string,
): JournalDecodeResult<LegacyCeraUiMutationEntry> {
	return decodeJournalDocument(text, validateLegacyCeraUiEntry);
}

const DISPOSITION_BY_STATE: Readonly<
	Record<LegacyCeraUiMutationState, JournalRecoveryDisposition>
> = {
	// Pre-state captured, write never dispatched: the device is untouched.
	armed: 'pending',
	// Dispatched with no terminal record — this package's `unknown-outcome`.
	executing: 'unknown-outcome',
	completed: 'resolved',
	// CeraUI's replay keeps these on disk and refuses further mutations until an
	// operator acknowledges. That is a KNOWN bad ending, not an unknown one.
	failed: 'blocked',
	acknowledged: 'resolved',
	'device-absent-quarantine': 'blocked',
	decommissioned: 'blocked',
	'recommission-pending': 'blocked',
};

/**
 * The descriptor evidence a legacy entry can honestly supply.
 *
 * CeraUI's journal predates `OperationDescriptor`, so there is no descriptor to
 * flatten. Every field below is either a fact the file actually carries (the
 * mutation kind) or an explicit statement that the file carries nothing:
 * `confidence: 'unknown'` rather than a borrowed default, and empty evidence
 * arrays rather than invented profiles. `mutationImpact: 'write'` is a fact, not a
 * guess — CeraUI's file is a MUTATION journal and records nothing else.
 */
export function legacyDescriptorEvidence(kind: string): JournalDescriptorEvidence {
	return {
		descriptorId: kind,
		provider: 'ceraui-legacy',
		authority: 'controller',
		mutationImpact: 'write',
		profiles: [],
		firmware: [],
		confidence: 'unknown',
	};
}

/** Project one decoded slot onto the shared recovery record model. */
export function legacyOperationRecord(entry: LegacyCeraUiMutationEntry): JournalOperationRecord {
	const disposition = DISPOSITION_BY_STATE[entry.state];
	return {
		operationId: entry.attemptId,
		// CeraUI's `stableKey`, NOT a `PhysicalModemId` — see the note on the field.
		physicalModemId: entry.stableKey,
		// CeraUI's journal has no device-generation fence; 0 records "unfenced"
		// rather than claiming a generation the file never carried.
		generation: 0,
		descriptor: legacyDescriptorEvidence(entry.kind),
		disposition,
		origin: 'legacy-ceraui',
		startedAtMs: entry.startedAt,
		updatedAtMs: entry.updatedAt,
		// One slot is one attempt; CeraUI rewrites the slot rather than appending.
		attempts: 1,
		// `outcome` is deliberately ABSENT for every legacy record, including the
		// `unknown-outcome` one. `JournalOutcome`'s unknown reason union is the
		// frozen domain vocabulary — `stale-generation` / `write-reply-timed-out` /
		// `write-reply-dropped` — and CeraUI's `executing` state asserts none of
		// them: it says a write was dispatched and never concluded, not why. Naming
		// one anyway would be the invented reading this package refuses everywhere
		// else. The disposition carries the fact; the reason stays unclaimed.
	};
}

/**
 * Read a whole CeraUI journal directory.
 *
 * An unreadable or non-conforming slot is reported as damage and LEFT IN PLACE;
 * every readable slot still comes back. That is the same non-truncating contract
 * the native store makes, applied to a directory instead of a file.
 */
export async function readLegacyCeraUiJournal(
	options: LegacyCeraUiJournalOptions,
): Promise<LegacyCeraUiJournalRead> {
	let names: string[];
	try {
		names = await readdir(options.dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return { recovery: summarizeJournalRecords([], []), entries: [] };
		}
		return {
			recovery: summarizeJournalRecords(
				[],
				[{ location: { kind: 'file' }, bytes: 0, failure: { code: 'unreadable' } }],
			),
			entries: [],
		};
	}

	const entries: LegacyCeraUiMutationEntry[] = [];
	const damage: JournalDamageRecord[] = [];
	// Sorted so a recovery report is stable across filesystems that do not order
	// `readdir`; the slot names are hashes, so the order carries no other meaning.
	for (const name of [...names].sort()) {
		if (!name.endsWith('.json')) continue;
		let text: string;
		try {
			text = await readFile(join(options.dir, name), 'utf8');
		} catch {
			damage.push({
				location: { kind: 'slot', slot: name },
				bytes: 0,
				failure: { code: 'unreadable' },
			});
			continue;
		}
		const decoded = decodeLegacyCeraUiEntry(text);
		if (decoded.ok) {
			entries.push(decoded.value);
			continue;
		}
		damage.push({
			location: { kind: 'slot', slot: name },
			bytes: Buffer.byteLength(text, 'utf8'),
			failure: decoded.failure,
		});
	}

	return {
		recovery: summarizeJournalRecords(entries.map(legacyOperationRecord), damage),
		entries,
	};
}
