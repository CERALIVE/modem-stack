// The journal engine: the operation engine's journal hook, plus replay.
//
// `OperationExecution.journal` (todo 20's `OperationJournalHook`) is the seam the
// operation engine already calls at `started` and at `completed`, and a descriptor
// that declares `journal: { required: true }` is REFUSED outright when no hook is
// supplied. This class is the durable implementation of that seam: it flattens the
// event onto a journal entry and appends it, and it reads the same file back.
//
// THE ENGINE HOLDS NO PATH. It holds a `JournalStore`, and the store was handed a
// path by whoever composed it. That is the same injection shape todo 19 used for
// the ownership lock (`FlockResourceOwnershipOptions.lockPath` is REQUIRED and the
// adapter substitutes nothing) and the same reason: an embedding process owns its
// filesystem layout, and a library that guesses one is a library that writes to the
// wrong disk on a device it has never seen.
//
// THE CLOCK IS INJECTED TOO. `now` defaults to `Date.now`, but a test that wants
// deterministic timestamps supplies its own — the observation layer's rule that
// this package never stamps data with a time it did not come from applies here as
// well, and a replay assertion over timestamps must not be a race.

import type { OperationJournalEvent, OperationJournalHook } from '../operations/contracts';
import { type JournalEntry, journalDescriptorEvidence, journalOutcome } from './entry';
import { type JournalRecovery, reconstructJournalRecovery } from './recovery';
import type { JournalStore } from './store';

export interface JournalEngineOptions {
	/** The store — and therefore the path — is supplied by the composition root. */
	readonly store: JournalStore;
	readonly now?: () => number;
}

export class JournalEngine {
	readonly #store: JournalStore;
	readonly #now: () => number;

	constructor(options: JournalEngineOptions) {
		this.#store = options.store;
		this.#now = options.now ?? (() => Date.now());
	}

	/** Where this engine journals to; useful in a recovery log line. */
	get path(): string {
		return this.#store.path;
	}

	/**
	 * The `OperationJournalHook` implementation.
	 *
	 * Generic per CALL rather than per instance, so one engine journals every
	 * descriptor in the process. A generic method satisfies the non-generic
	 * `OperationJournalHook<I, O>` member by instantiation, which is what lets an
	 * `OperationExecution` take the engine itself as its `journal`.
	 */
	record<I, O>(event: OperationJournalEvent<I, O>): Promise<void> {
		return this.#store.append(entryFor(event, this.#now()));
	}

	/** An explicitly typed hook, for a caller that prefers a narrow object. */
	hook<I, O>(): OperationJournalHook<I, O> {
		return { record: (event) => this.record(event) };
	}

	/** Read the journal back and reconstruct what was in flight. */
	async recover(): Promise<JournalRecovery> {
		return reconstructJournalRecovery(await this.#store.read());
	}
}

function entryFor<I, O>(event: OperationJournalEvent<I, O>, recordedAtMs: number): JournalEntry {
	const base = {
		schemaVersion: 1,
		operationId: event.operationId,
		physicalModemId: event.physicalModemId as string,
		generation: event.generation as number,
		recordedAtMs,
		descriptor: journalDescriptorEvidence(event.descriptor),
	} as const;
	return event.phase === 'started'
		? { ...base, phase: 'started' }
		: { ...base, phase: 'completed', outcome: journalOutcome(event.result) };
}

export function createJournalEngine(options: JournalEngineOptions): JournalEngine {
	return new JournalEngine(options);
}
