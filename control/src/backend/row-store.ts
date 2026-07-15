// The observer's row bookkeeping — revisions, source health, and the discriminated
// list result — split out of the observer so each file stays focused.
//
// Removal lives ONLY in `reconcile`: a modem is dropped exactly when a current-epoch
// authoritative snapshot omits it. `markUnavailable` never removes — it flags rows
// stale and retains them, so the `ObservationList` failure arm always carries its rows.

import {
	type CellularSnapshot,
	createSnapshot,
	revision as makeRevision,
	markSourceUnavailable,
	type Revision,
} from '../domain';
import type { ObservationFailureReason, ObservationList } from '../ports';
import type { DecodedManagedObjects } from './managed-objects';
import { fingerprint, type MappedModem, mapModem, modemPaths } from './mapping';

interface Row {
	snapshot: CellularSnapshot;
	fingerprint: string;
}

export class ObservationRowStore {
	readonly #rows = new Map<string, Row>();
	#revCounter = 0;
	#sourceHealthy = false;
	#failureReason: ObservationFailureReason = 'not-started';

	/** Reconcile the authoritative tree into the rows. Returns whether rows changed.
	 *  This is the SOLE removal path — an omission from a current-epoch snapshot. */
	reconcile(tree: DecodedManagedObjects): boolean {
		let changed = false;
		const seen = new Set<string>();
		for (const path of modemPaths(tree)) {
			seen.add(path);
			if (this.#upsert(path, mapModem(tree, path))) {
				changed = true;
			}
		}
		for (const path of [...this.#rows.keys()]) {
			if (!seen.has(path)) {
				this.#rows.delete(path);
				changed = true;
			}
		}
		return changed;
	}

	/** Mark the source healthy after a successful reconcile. Returns whether health flipped. */
	markHealthy(): boolean {
		const flipped = !this.#sourceHealthy;
		this.#sourceHealthy = true;
		return flipped;
	}

	/** Flag every row stale (retained, never removed). Returns whether an emission is due. */
	markUnavailable(reason: ObservationFailureReason): boolean {
		const wasHealthy = this.#sourceHealthy;
		let changed = false;
		for (const [path, row] of this.#rows) {
			if (row.snapshot.sourceHealth === 'sourceUnavailable') {
				continue;
			}
			this.#rows.set(path, {
				snapshot: markSourceUnavailable(row.snapshot),
				fingerprint: row.fingerprint,
			});
			changed = true;
		}
		this.#sourceHealthy = false;
		this.#failureReason = reason;
		return changed || wasHealthy;
	}

	list(): ObservationList {
		const rows = [...this.#rows.values()].map((row) => row.snapshot);
		if (this.#sourceHealthy) {
			return { ok: true, rows };
		}
		return { ok: false, reason: this.#failureReason, rows };
	}

	#upsert(path: string, mapped: MappedModem): boolean {
		const fp = fingerprint(mapped);
		const existing = this.#rows.get(path);
		if (
			existing !== undefined &&
			existing.fingerprint === fp &&
			existing.snapshot.sourceHealth === 'live'
		) {
			return false;
		}
		this.#rows.set(path, {
			snapshot: createSnapshot({ ...mapped, revision: this.#nextRevision() }),
			fingerprint: fp,
		});
		return true;
	}

	#nextRevision(): Revision {
		this.#revCounter += 1;
		return makeRevision(this.#revCounter);
	}
}
