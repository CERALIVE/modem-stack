// The epoch-scoped ModemManager observer.
//
// `MmDbusObserver` implements the read-only `ModemObservationPort` over the A2.4
// transport, tested against the A2.3 fake. `start()` connects, subscribes to the four
// lifecycle signals, THEN takes the first authoritative `GetManagedObjects` snapshot —
// reconciling any signal that raced in between.
//
// SAFETY-CRITICAL — epoch-scoped removal (draft §Oracle round-3 #5). An "epoch" is one
// continuous ownership period of the MM bus name, tracked via `NameOwnerChanged`. A
// modem is REMOVED only when it is missing from a CURRENT-epoch authoritative snapshot.
// Owner loss, bus disconnect, and any signal whose `sender` is not the current owner
// (an OLD-epoch straggler) never remove a modem — they only ever mark it
// `sourceUnavailable`. The false-removal class is dead by construction: even the
// `ObservationList` failure arm retains its rows. Row bookkeeping lives in
// `ObservationRowStore`; this file owns epoch tracking, subscriptions, and refresh.

import type {
	ModemObservationPort,
	ObservationFailureReason,
	ObservationList,
	ObservationListener,
	Unsubscribe,
} from '../ports';
import type { DbusTransport, SignalEvent, Subscription } from '../transport';
import { MM_BUS_NAME } from './constants';
import type { DecodedManagedObjects } from './managed-objects';
import { subscribeObserverSignals, unsubscribeObserverSignals } from './observer/bus-lifecycle';
import { queryModemManagerOwner, readAuthoritativeTree } from './observer/epoch-reconcile';
import { isCurrentOwnerSignal, routeOwnerSignal } from './observer/signal-routing';
import { ObservationRowStore } from './row-store';

/**
 * A current-epoch authoritative snapshot, delivered to `onEpochRefresh` AFTER the
 * epoch guard passes. `epoch` is the owning MM unique bus name; `tree` is the decoded
 * `GetManagedObjects` payload the snapshot was reconciled from. The Signal.Setup
 * manager (A3.3) hooks this to (re-)apply cadence per modem per epoch, and the D-Bus
 * backend uses it to refresh its path→stable-key map.
 */
export interface EpochRefreshEvent {
	readonly epoch: string;
	readonly tree: DecodedManagedObjects;
}

export interface MmDbusObserverOptions {
	/** The transport to talk D-Bus over (A2.4). The observer connects it on `start()`. */
	readonly transport: DbusTransport;
	/** MM bus name override (defaults to `org.freedesktop.ModemManager1`). */
	readonly destination?: string;
	/**
	 * Called after EVERY successful current-epoch authoritative snapshot (start,
	 * hot-plug, epoch change, property change) — never for a superseded epoch. The
	 * hook fires whether or not any row changed, so a consumer always sees the live
	 * epoch + tree. It must not throw; a throw is swallowed so it can never break the
	 * observer's refresh loop.
	 */
	readonly onEpochRefresh?: (event: EpochRefreshEvent) => void;
}

export class MmDbusObserver implements ModemObservationPort {
	readonly #transport: DbusTransport;
	readonly #destination: string;
	readonly #onEpochRefresh: ((event: EpochRefreshEvent) => void) | undefined;
	readonly #store = new ObservationRowStore();
	readonly #listeners = new Set<ObservationListener>();
	readonly #subscriptions: Subscription[] = [];

	#currentOwner: string | undefined;
	#started = false;
	#stopped = false;
	#priming = false;
	#refreshDuringPrime = false;
	#refreshing = false;
	#refreshQueued = false;

	readonly #onDisconnected = (): void => this.#handleSourceGone('source-unavailable');
	readonly #onReconnected = (): void => {
		void this.#adoptCurrentOwner();
	};

	constructor(options: MmDbusObserverOptions) {
		this.#transport = options.transport;
		this.#destination = options.destination ?? MM_BUS_NAME;
		this.#onEpochRefresh = options.onEpochRefresh;
	}

	async start(): Promise<ObservationList> {
		if (this.#started) {
			return this.#store.list();
		}
		this.#started = true;
		this.#priming = true;
		await this.#transport.connect();
		this.#transport.on('disconnected', this.#onDisconnected);
		this.#transport.on('reconnected', this.#onReconnected);
		await this.#subscribeAll();
		await this.#adoptCurrentOwner();
		this.#priming = false;
		if (this.#refreshDuringPrime) {
			this.#refreshDuringPrime = false;
			this.#scheduleRefresh();
		}
		return this.#store.list();
	}

	observe(listener: ObservationListener): Unsubscribe {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	async stop(): Promise<void> {
		if (this.#stopped) {
			return;
		}
		this.#stopped = true;
		this.#transport.off('disconnected', this.#onDisconnected);
		this.#transport.off('reconnected', this.#onReconnected);
		const subscriptions = this.#subscriptions.splice(0);
		await unsubscribeObserverSignals(subscriptions);
		this.#listeners.clear();
	}

	// ── signal subscription ────────────────────────────────────────────────────────

	async #subscribeAll(): Promise<void> {
		this.#subscriptions.push(
			...(await subscribeObserverSignals(this.#transport, {
				onObjectSignal: (event) => this.#onObjectSignal(event),
				onNameOwnerChanged: (event) => this.#onNameOwnerChanged(event),
			})),
		);
	}

	// ── epoch tracking ───────────────────────────────────────────────────────────

	async #adoptCurrentOwner(): Promise<void> {
		const owner = await this.#queryOwner();
		if (owner === undefined) {
			this.#handleSourceGone('source-unavailable');
			return;
		}
		this.#currentOwner = owner;
		await this.#runRefresh(owner);
	}

	async #queryOwner(): Promise<string | undefined> {
		return queryModemManagerOwner(this.#transport);
	}

	#onNameOwnerChanged(event: SignalEvent): void {
		const routed = routeOwnerSignal(event);
		if (routed.kind === 'unrelated') {
			return;
		}
		if (routed.kind === 'lost') {
			// Owner lost — stale, never a removal.
			this.#handleSourceGone('source-unavailable');
			return;
		}
		if (routed.owner === this.#currentOwner) {
			return;
		}
		// New epoch: everything goes stale until the fresh snapshot restores it.
		if (this.#store.markUnavailable('source-unavailable')) {
			this.#emit();
		}
		this.#currentOwner = routed.owner;
		this.#scheduleRefresh();
	}

	#onObjectSignal(event: SignalEvent): void {
		// Epoch guard: a signal from anyone but the current owner is an OLD-epoch
		// straggler and must never drive a removal (draft §Oracle round-3 #5).
		if (!isCurrentOwnerSignal(event, this.#currentOwner)) {
			return;
		}
		if (this.#priming) {
			this.#refreshDuringPrime = true;
			return;
		}
		this.#scheduleRefresh();
	}

	// ── authoritative refresh ──────────────────────────────────────────────────────

	#scheduleRefresh(): void {
		const owner = this.#currentOwner;
		if (owner === undefined || this.#stopped) {
			return;
		}
		if (this.#refreshing) {
			this.#refreshQueued = true;
			return;
		}
		void this.#runRefresh(owner);
	}

	async #runRefresh(epochOwner: string): Promise<void> {
		this.#refreshing = true;
		try {
			const tree = await readAuthoritativeTree(this.#transport, this.#destination);
			// Late reply from a superseded epoch — discard (draft §Oracle round-3 #5).
			if (this.#currentOwner !== epochOwner || this.#stopped) {
				return;
			}
			const rowsChanged = this.#store.reconcile(tree);
			const healthChanged = this.#store.markHealthy();
			this.#notifyEpochRefresh(epochOwner, tree);
			if (rowsChanged || healthChanged) {
				this.#emit();
			}
		} catch {
			if (this.#currentOwner === epochOwner && !this.#stopped) {
				this.#markUnavailable('bus-error');
			}
		} finally {
			this.#refreshing = false;
			if (this.#refreshQueued && !this.#stopped) {
				this.#refreshQueued = false;
				this.#scheduleRefresh();
			}
		}
	}

	// ── source-unavailable transitions ─────────────────────────────────────────────

	#handleSourceGone(reason: ObservationFailureReason): void {
		this.#currentOwner = undefined;
		this.#markUnavailable(reason);
	}

	#markUnavailable(reason: ObservationFailureReason): void {
		if (this.#store.markUnavailable(reason)) {
			this.#emit();
		}
	}

	#notifyEpochRefresh(epoch: string, tree: DecodedManagedObjects): void {
		if (this.#onEpochRefresh === undefined) {
			return;
		}
		try {
			this.#onEpochRefresh({ epoch, tree });
		} catch {
			// A consumer's hook must never break the observer's refresh loop.
		}
	}

	#emit(): void {
		const list = this.#store.list();
		for (const listener of [...this.#listeners]) {
			listener(list);
		}
	}
}

/** Construct an epoch-scoped ModemManager observer over an A2.4 transport. */
export function createMmDbusObserver(options: MmDbusObserverOptions): MmDbusObserver {
	return new MmDbusObserver(options);
}
