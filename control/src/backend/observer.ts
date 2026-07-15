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
import {
	DBUS_DESTINATION,
	DBUS_IFACE,
	DBUS_PATH,
	MM_BUS_NAME,
	MM_ROOT_PATH,
	OBJECT_MANAGER_IFACE,
	PROPERTIES_IFACE,
} from './constants';
import { asManagedObjects } from './managed-objects';
import { ObservationRowStore } from './row-store';

export interface MmDbusObserverOptions {
	/** The transport to talk D-Bus over (A2.4). The observer connects it on `start()`. */
	readonly transport: DbusTransport;
	/** MM bus name override (defaults to `org.freedesktop.ModemManager1`). */
	readonly destination?: string;
}

export class MmDbusObserver implements ModemObservationPort {
	readonly #transport: DbusTransport;
	readonly #destination: string;
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
		const subs = this.#subscriptions.splice(0);
		await Promise.all(subs.map((sub) => sub.unsubscribe().catch(() => undefined)));
		this.#listeners.clear();
	}

	// ── signal subscription ────────────────────────────────────────────────────────

	async #subscribeAll(): Promise<void> {
		const om = { interface: OBJECT_MANAGER_IFACE, path: MM_ROOT_PATH } as const;
		this.#subscriptions.push(
			await this.#transport.subscribeSignal({ ...om, member: 'InterfacesAdded' }, (event) =>
				this.#onObjectSignal(event),
			),
			await this.#transport.subscribeSignal({ ...om, member: 'InterfacesRemoved' }, (event) =>
				this.#onObjectSignal(event),
			),
			await this.#transport.subscribeSignal(
				{ interface: PROPERTIES_IFACE, member: 'PropertiesChanged' },
				(event) => this.#onObjectSignal(event),
			),
			await this.#transport.subscribeSignal(
				{ interface: DBUS_IFACE, member: 'NameOwnerChanged' },
				(event) => this.#onNameOwnerChanged(event),
			),
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
		try {
			const reply = await this.#transport.callMethod({
				destination: DBUS_DESTINATION,
				path: DBUS_PATH,
				interface: DBUS_IFACE,
				member: 'GetNameOwner',
				signature: 's',
				args: [MM_BUS_NAME],
			});
			const owner = reply.body[0];
			return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
		} catch {
			// NameHasNoOwner (or a transient failure) → no current epoch yet.
			return undefined;
		}
	}

	#onNameOwnerChanged(event: SignalEvent): void {
		if (event.body[0] !== MM_BUS_NAME) {
			return;
		}
		const newOwner = typeof event.body[2] === 'string' ? event.body[2] : '';
		if (newOwner.length === 0) {
			// Owner lost — stale, never a removal.
			this.#handleSourceGone('source-unavailable');
			return;
		}
		if (newOwner === this.#currentOwner) {
			return;
		}
		// New epoch: everything goes stale until the fresh snapshot restores it.
		if (this.#store.markUnavailable('source-unavailable')) {
			this.#emit();
		}
		this.#currentOwner = newOwner;
		this.#scheduleRefresh();
	}

	#onObjectSignal(event: SignalEvent): void {
		// Epoch guard: a signal from anyone but the current owner is an OLD-epoch
		// straggler and must never drive a removal (draft §Oracle round-3 #5).
		if (this.#currentOwner === undefined || event.sender !== this.#currentOwner) {
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
			const reply = await this.#transport.callMethod({
				destination: this.#destination,
				path: MM_ROOT_PATH,
				interface: OBJECT_MANAGER_IFACE,
				member: 'GetManagedObjects',
			});
			// Late reply from a superseded epoch — discard (draft §Oracle round-3 #5).
			if (this.#currentOwner !== epochOwner || this.#stopped) {
				return;
			}
			const rowsChanged = this.#store.reconcile(asManagedObjects(reply.body[0]));
			const healthChanged = this.#store.markHealthy();
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
