// The shared per-modem disruptive-operation actor.
//
// EVERY disruptive modem operation funnels through ONE serialization queue PER
// MODEM: radio-mode changes and primary-slot changes (A3.3), the recovery ladder
// (A3.4), and USB-mode / AT transitions (A4.2) all route through the SAME actor so
// two disruptive ops on ONE modem can never interleave. Ops on DIFFERENT modems run
// independently — each modem owns its own queue.
//
// The queue is keyed on the STABLE identity key (A3.2's `stableKey`), NOT the
// transient D-Bus object path. A modem that unplugs and replugs into the same slot
// resolves to the same stable key, so serialization survives the replug (the path
// changed, the queue did not).
//
// Mode and slot changes additionally coordinate with NetworkManager through the
// `QuiesceHook` — before a disruptive change NM briefly deactivates the connection so
// it cannot race MM's own re-activation, then reactivates it on release. In A3.3 the
// hook is a NO-OP stub with the exact lease shape A4.1's real nmcli adapter will fill
// in (`NetworkManagerPort.acquireQuiesceLease`).

import type { ConnectionId, DeviceIfname } from '../ports';

/** What a quiesce lease is taken over — the modem, and (once A4.1 knows them) its
 *  NM connection + device. In A3.3 only `stableKey` is populated. */
export interface QuiesceTarget {
	readonly stableKey: string;
	readonly connectionId?: ConnectionId;
	readonly deviceIfname?: DeviceIfname;
}

/** A held quiesce lease — released (reactivating the connection) when the op ends. */
export interface QuiesceLeaseHandle {
	release(): Promise<void>;
}

/**
 * The NM-quiesce coordination hook the actor calls around a disruptive mode/slot
 * change. A4.1 wires the real `nmcli` lease (verify-active → `device disconnect` →
 * hold → reactivate); A3.3 ships `NO_OP_QUIESCE`, whose call site + shape are the
 * exact seam A4.1 fills in.
 */
export interface QuiesceHook {
	acquire(target: QuiesceTarget): Promise<QuiesceLeaseHandle>;
}

const NO_OP_LEASE: QuiesceLeaseHandle = {
	release(): Promise<void> {
		return Promise.resolve();
	},
};

/** The A3.3 default quiesce hook — acquires nothing, releases nothing. */
export const NO_OP_QUIESCE: QuiesceHook = {
	acquire(): Promise<QuiesceLeaseHandle> {
		return Promise.resolve(NO_OP_LEASE);
	},
};

/**
 * A per-modem serialized actor. `run` serializes a task behind every prior task for
 * the same stable key; `runQuiesced` additionally holds an NM quiesce lease for the
 * task's duration. Different stable keys never block one another.
 */
export class ModemActor {
	readonly #quiesce: QuiesceHook;
	// Tail of each modem's queue — a promise that settles when the last-enqueued task
	// for that key finishes (errors swallowed so the chain never breaks).
	readonly #tails = new Map<string, Promise<void>>();

	constructor(quiesce: QuiesceHook = NO_OP_QUIESCE) {
		this.#quiesce = quiesce;
	}

	/** Run `task` serialized behind every prior task for `stableKey`. */
	run<T>(stableKey: string, task: () => Promise<T>): Promise<T> {
		const prior = this.#tails.get(stableKey) ?? Promise.resolve();
		// `then(task, task)` runs `task` whether the prior task resolved OR rejected,
		// so one failure never stalls the queue.
		const result = prior.then(task, task);
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.#tails.set(stableKey, settled);
		// Drop the entry once this task was the last one, to bound the map.
		void settled.then(() => {
			if (this.#tails.get(stableKey) === settled) {
				this.#tails.delete(stableKey);
			}
		});
		return result;
	}

	/**
	 * Run `task` serialized for `target.stableKey` with an NM quiesce lease held for
	 * its whole duration — the lease is always released, even if `task` throws.
	 */
	runQuiesced<T>(target: QuiesceTarget, task: () => Promise<T>): Promise<T> {
		return this.run(target.stableKey, async () => {
			const lease = await this.#quiesce.acquire(target);
			try {
				return await task();
			} finally {
				await lease.release();
			}
		});
	}

	/** Number of modems with a live queue — exposed for leak / idle assertions. */
	get activeKeyCount(): number {
		return this.#tails.size;
	}
}
