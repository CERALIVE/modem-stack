// The observation contract — the read side shared by every ModemManager backend.
//
// `ModemObservationPort` is the NARROW port: it observes modems and reports them as
// a stream of discriminated list results. It carries NO mutation methods at all.
// The full `ModemManagerPort` (mutations) EXTENDS this, so a shadow / read-only
// consumer can depend on observation alone and never gain a mutating verb.

import type { CellularSnapshot } from '../domain';

/** Cancels a subscription created by `observe`. Calling it twice is a no-op. */
export type Unsubscribe = () => void;

/** Why an observation could not produce an authoritative list this cycle. */
export type ObservationFailureReason = 'not-started' | 'source-unavailable' | 'bus-error';

/**
 * The result of listing modems — DISCRIMINATED on `ok`, and it NEVER throws away
 * rows. Even the failure arm carries `rows`: the last-known modems are RETAINED so
 * a source drop can never be mistaken for a removal. Real removal is only ever
 * expressed by an `ok: true` snapshot that OMITS a modem (A3.1 epoch authority) —
 * the false-removal class is dead by construction.
 */
export type ObservationList<T = CellularSnapshot> =
	| { readonly ok: true; readonly rows: readonly T[] }
	| {
			readonly ok: false;
			readonly reason: ObservationFailureReason;
			/** Retained rows from the last authoritative snapshot — never dropped. */
			readonly rows: readonly T[];
	  };

/** A subscriber to the ongoing observation stream. */
export type ObservationListener<T = CellularSnapshot> = (list: ObservationList<T>) => void;

/**
 * The read-only observation port. `start()` connects, subscribes, and resolves the
 * first AUTHORITATIVE list; `observe()` streams every subsequent list (each snapshot
 * carrying a monotonic revision); `stop()` tears the subscription down. No method
 * here can change modem state — that narrowness is the whole point of the port.
 */
export interface ModemObservationPort {
	/** Connect, subscribe, and resolve the first authoritative observation list. */
	start(): Promise<ObservationList>;
	/** Subscribe to the ongoing stream of observation lists. Returns an unsubscribe. */
	observe(listener: ObservationListener): Unsubscribe;
	/** Tear down the subscription and release the source. Idempotent. */
	stop(): Promise<void>;
}
