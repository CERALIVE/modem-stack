// Replay: fold a journal back into "what was in flight when we died".
//
// This is the whole reason the journal exists. `operations/operation-engine.ts`
// keeps its uncertainty fence in a `Set<PhysicalModemId>` on the engine instance,
// so a process death drops it and the next mutation proceeds as if nothing were
// outstanding. Folding the journal reconstructs that set from disk.
//
// THE FOLD IS ORDER-SENSITIVE AND LAST-WRITE-WINS PER OPERATION. Entries are
// applied in file order, keyed by (physical modem, operation id, generation). A
// second `started` on a live key is a re-run and re-opens the record rather than
// being deduplicated away — the journal records attempts, and hiding a second
// attempt would make a retry loop invisible in exactly the forensics the file is
// kept for.
//
// FOUR DISPOSITIONS, AND TWO OF THEM MEAN "RECONCILE BEFORE MUTATING AGAIN":
//
//   pending          a start with no completion — the process died inside the
//                    operation, so whether the device changed is unknown.
//   unknown-outcome  a completion the engine itself classified unknown: a stale
//                    generation, or a write reply that timed out or was dropped.
//   resolved         a definite ending (applied / refused / failed). The engine
//                    treats a definite failure as definite; so does this.
//   blocked          a terminal state a human must clear. Native journals never
//                    produce it today — it exists because CeraUI's own mutation
//                    journal HAS such states (`failed`, quarantine, decommission)
//                    and `legacy-ceraui.ts` maps onto this same model. Folding
//                    those into `resolved` would report an operator-blocked device
//                    as healthy; folding them into `unknown-outcome` would claim
//                    uncertainty about an outcome that is actually known.
//
// `reconciliationRequired` deliberately covers `pending` + `unknown-outcome` only.
// A blocked record is a KNOWN bad ending awaiting acknowledgement, and answering
// it with a reconciliation pass would silently clear a state that exists precisely
// so it cannot be cleared silently.

import { DomainError } from '../domain';
import type { JournalDescriptorEvidence, JournalEntry, JournalOutcome } from './entry';
import type { JournalDamageRecord, JournalReadResult } from './store';

export type JournalRecoveryDisposition = 'pending' | 'unknown-outcome' | 'resolved' | 'blocked';

/** Where a record came from. Also tells a consumer how to read `physicalModemId`. */
export type JournalRecordOrigin = 'native' | 'legacy-ceraui';

/**
 * One operation reconstructed from the journal.
 *
 * `physicalModemId` is TEXT, not the branded `PhysicalModemId`, and that is
 * deliberate: for a `legacy-ceraui` record it holds CeraUI's own `stableKey`,
 * which is a different identity vocabulary and would be REFUSED by
 * `physicalModemId()`'s constructor. Coercing it would either throw on a
 * perfectly valid legacy file or launder a foreign identity into a branded type
 * that promises it came from the serial / ID_PATH ladder. `origin` is what tells
 * a consumer which vocabulary it is holding.
 */
export interface JournalOperationRecord {
	readonly operationId: string;
	readonly physicalModemId: string;
	readonly generation: number;
	readonly descriptor: JournalDescriptorEvidence;
	readonly disposition: JournalRecoveryDisposition;
	readonly origin: JournalRecordOrigin;
	readonly startedAtMs: number;
	readonly updatedAtMs: number;
	readonly attempts: number;
	readonly outcome?: JournalOutcome;
}

export interface JournalRecovery {
	/** Every reconstructed operation, in first-appearance order. */
	readonly records: readonly JournalOperationRecord[];
	readonly pending: readonly JournalOperationRecord[];
	readonly unknownOutcome: readonly JournalOperationRecord[];
	readonly blocked: readonly JournalOperationRecord[];
	/** Distinct modem identities that must be reconciled before the next mutation. */
	readonly reconciliationRequired: readonly string[];
	readonly damage: readonly JournalDamageRecord[];
}

/** Raised only by `assertJournalIntact`; recovery itself always returns a report. */
export class JournalRecoveryError extends DomainError {
	override readonly name = 'JournalRecoveryError';
	readonly damage: readonly JournalDamageRecord[];

	constructor(damage: readonly JournalDamageRecord[]) {
		super(`journal recovery found ${damage.length} damaged record(s)`);
		this.damage = damage;
	}
}

/**
 * Escalate a damaged journal to a throw, for a caller that wants fail-closed.
 *
 * Kept SEPARATE from `reconstructJournalRecovery` on purpose: recovery must be
 * able to hand back the survivors even when part of the file is unreadable, so
 * the decision to refuse to proceed belongs to the caller, after it has seen
 * what did survive.
 */
export function assertJournalIntact(recovery: JournalRecovery): void {
	if (recovery.damage.length > 0) throw new JournalRecoveryError(recovery.damage);
}

function keyOf(entry: JournalEntry): string {
	return `${entry.physicalModemId}\u0000${entry.operationId}\u0000${entry.generation}`;
}

function dispositionOf(outcome: JournalOutcome): JournalRecoveryDisposition {
	return outcome.status === 'unknown-outcome' ? 'unknown-outcome' : 'resolved';
}

/** Fold decoded entries into per-operation records. Pure; no clock, no I/O. */
export function reconstructJournalRecovery(read: JournalReadResult): JournalRecovery {
	const byKey = new Map<string, JournalOperationRecord>();
	const order: string[] = [];

	for (const { entry } of read.entries) {
		const key = keyOf(entry);
		const previous = byKey.get(key);
		if (previous === undefined) order.push(key);

		if (entry.phase === 'started') {
			byKey.set(key, {
				operationId: entry.operationId,
				physicalModemId: entry.physicalModemId,
				generation: entry.generation,
				descriptor: entry.descriptor,
				disposition: 'pending',
				origin: 'native',
				// The FIRST start is when this operation began; a re-run does not
				// rewrite history, it increments the attempt count.
				startedAtMs: previous?.startedAtMs ?? entry.recordedAtMs,
				updatedAtMs: entry.recordedAtMs,
				attempts: (previous?.attempts ?? 0) + 1,
			});
			continue;
		}

		byKey.set(key, {
			operationId: entry.operationId,
			physicalModemId: entry.physicalModemId,
			generation: entry.generation,
			descriptor: entry.descriptor,
			disposition: dispositionOf(entry.outcome),
			origin: 'native',
			startedAtMs: previous?.startedAtMs ?? entry.recordedAtMs,
			updatedAtMs: entry.recordedAtMs,
			// A completion with no start is a journal whose head was never written;
			// counting it as one attempt is more honest than reporting zero.
			attempts: previous?.attempts ?? 1,
			outcome: entry.outcome,
		});
	}

	const records = order
		.map((key) => byKey.get(key))
		.filter((value): value is JournalOperationRecord => value !== undefined);
	return summarizeJournalRecords(records, read.damage);
}

/** Build the summary views over already-reconstructed records (native or legacy). */
export function summarizeJournalRecords(
	records: readonly JournalOperationRecord[],
	damage: readonly JournalDamageRecord[],
): JournalRecovery {
	const pending = records.filter((record) => record.disposition === 'pending');
	const unknownOutcome = records.filter((record) => record.disposition === 'unknown-outcome');
	const blocked = records.filter((record) => record.disposition === 'blocked');
	const reconciliationRequired = [
		...new Set([...pending, ...unknownOutcome].map((record) => record.physicalModemId)),
	].sort();
	return { records, pending, unknownOutcome, blocked, reconciliationRequired, damage };
}
