// The transaction journal's ENTRY vocabulary.
//
// The journal exists to answer ONE question after an unclean restart: which
// mutations were in flight, and which of them ended in an outcome nobody can
// read off the device. `operations/operation-engine.ts` already closes a
// per-modem gate when a write classifies `unknown-outcome`, but that gate lives
// in a `Set` on the engine instance — a process death takes it with it. Writing
// the same two facts down is what makes the gate survive the process.
//
// WHY AN EVENT LOG AND NOT A LATEST-STATE SNAPSHOT. A started event and its
// completion are two facts separated by exactly the window a crash lands in, so
// the shape has to be able to hold the first without the second. A document that
// only ever carries "the current state" cannot distinguish "we never dispatched"
// from "we dispatched and the reply never came" unless it spends a state name on
// each — which is how CeraUI's own mutation journal does it (see
// `legacy-ceraui.ts`, which reads that shape). Both are legitimate; this one is
// append-only because appending is the only write that cannot lose a prior fact.
//
// WHAT IS DELIBERATELY NOT RECORDED: the operation's INPUT and the operation's
// RETURNED VALUE. An input is routinely a PIN, a PUK, or a USSD command carrying
// a voucher code, and a returned value is routinely a message body or a location
// fix — all of them classes `../redact.ts` masks everywhere else. The journal
// records THAT an operation ran and HOW it ended, never WHAT was sent or read.
// A caller that needs a rollback payload owns persisting it beside the journal
// under its own redaction decision.

import type {
	MutationImpact,
	OperationConfidence,
	OperationDescriptor,
	OperationResult,
} from '../domain';

/** The current on-disk schema version for one journal line. */
export const MODEM_CONTROL_JOURNAL_SCHEMA_VERSION = 1;

/** The two phases the operation engine emits, mirrored one-to-one on disk. */
export type JournalPhase = 'started' | 'completed';

/**
 * How an operation ended, projected from `OperationResult` WITHOUT its value.
 *
 * `unknown-outcome` keeps the frozen domain reason union verbatim rather than
 * widening to `string`, because those three reasons are the entire vocabulary a
 * recovery pass branches on and a fourth spelling would silently read as an
 * ordinary failure.
 */
export type JournalOutcome =
	| { readonly status: 'applied' }
	| { readonly status: 'refused'; readonly reason: string }
	| { readonly status: 'failed'; readonly reason: string }
	| {
			readonly status: 'unknown-outcome';
			readonly reason: 'stale-generation' | 'write-reply-timed-out' | 'write-reply-dropped';
	  };

/**
 * The descriptor facts a recovery pass needs, flattened out of the descriptor.
 *
 * The descriptor itself is not persisted: it carries FUNCTIONS (`readback.matches`,
 * the constraint predicates) that no serialization round-trips, so storing it would
 * produce a document that reads back as a different object than it was written from.
 * These are the fields that answer "what was being changed, by whom, on what
 * evidence" — everything a human or a reconciler needs to judge a stranded write.
 */
export interface JournalDescriptorEvidence {
	readonly descriptorId: string;
	readonly provider: string;
	readonly authority: 'provider' | 'controller' | 'hardware';
	readonly mutationImpact: MutationImpact;
	readonly profiles: readonly string[];
	readonly firmware: readonly string[];
	readonly confidence: OperationConfidence;
}

interface JournalEntryBase {
	readonly schemaVersion: typeof MODEM_CONTROL_JOURNAL_SCHEMA_VERSION;
	readonly operationId: string;
	/** The serialized `PhysicalModemId`. Stored as text; branding is a compile-time fact. */
	readonly physicalModemId: string;
	/** The serialized `DeviceGeneration` the operation was fenced to. */
	readonly generation: number;
	readonly recordedAtMs: number;
	readonly descriptor: JournalDescriptorEvidence;
}

/**
 * One journal line.
 *
 * The two members differ in SHAPE, not just in a label: a `started` entry has no
 * `outcome` KEY at all. That is the same rule `observations/reading.ts` follows —
 * a consumer cannot read an outcome off a phase that has none, so "in flight" can
 * never be mistaken for "ended with an unset outcome".
 */
export type JournalEntry =
	| (JournalEntryBase & { readonly phase: 'started' })
	| (JournalEntryBase & { readonly phase: 'completed'; readonly outcome: JournalOutcome });

/** Flatten a descriptor down to the serializable evidence the journal keeps. */
export function journalDescriptorEvidence<I, O>(
	descriptor: OperationDescriptor<I, O>,
): JournalDescriptorEvidence {
	return {
		descriptorId: descriptor.id,
		provider: descriptor.provider,
		authority: descriptor.authority,
		mutationImpact: descriptor.mutationImpact,
		profiles: [...descriptor.evidence.profiles],
		firmware: [...descriptor.evidence.firmware],
		confidence: descriptor.confidence,
	};
}

/** Project a result onto its journalable outcome, dropping the value by design. */
export function journalOutcome<O>(result: OperationResult<O>): JournalOutcome {
	switch (result.status) {
		case 'applied':
			return { status: 'applied' };
		case 'refused':
			return { status: 'refused', reason: result.reason };
		case 'failed':
			return { status: 'failed', reason: result.reason };
		case 'unknown-outcome':
			return { status: 'unknown-outcome', reason: result.reason };
	}
}

/** True when an outcome leaves the device in a state nobody has read back. */
export function outcomeRequiresReconciliation(outcome: JournalOutcome): boolean {
	return outcome.status === 'unknown-outcome';
}
