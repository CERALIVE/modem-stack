// The bounded D-Bus signal window — the production capture seam.
//
// A certification bundle records a BOUNDED slice of ModemManager's signal traffic:
// `PropertiesChanged` plus interface add/remove, capped at N signals OR N milliseconds,
// whichever comes first. It is never an unbounded capture — the window always closes and
// the subscriptions are always torn down. Only property NAMES are recorded, never their
// values, so no subscriber secret can ride out through a signal body.

import type { DbusTransport, SignalEvent, Subscription } from '@ceralive/modem-control/transport';
import type { SignalRecord } from './bundle-schema';

// The two well-known D-Bus signal interfaces the window subscribes to. These standard
// names are not re-exported by `@ceralive/modem-control`, so — like the observer's own
// `constants.ts` — this module keeps its own copies rather than reaching into internals.
const PROPERTIES_IFACE = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';

/** How the signal window is bounded. */
export interface SignalWindowBound {
	readonly maxSignals: number;
	readonly windowMs: number;
}

/** A short, safe default window for a bench capture. */
export const DEFAULT_SIGNAL_WINDOW: SignalWindowBound = { maxSignals: 32, windowMs: 3000 };

/** Extract the changed property NAMES from a `PropertiesChanged` body (never values). */
function changedNames(entries: SignalEvent['body'][number] | undefined): string[] {
	if (!Array.isArray(entries)) {
		return [];
	}
	return entries.flatMap((entry) =>
		Array.isArray(entry) && typeof entry[0] === 'string' ? [entry[0]] : [],
	);
}

/** Extract the invalidated property names from a `PropertiesChanged` body. */
function invalidatedNames(names: SignalEvent['body'][number] | undefined): string[] {
	return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
}

function toRecord(event: SignalEvent, atMs: number): SignalRecord {
	const isPropsChanged = event.member === 'PropertiesChanged';
	return {
		atMs,
		path: event.path,
		interface: event.interface,
		member: event.member,
		changed: isPropsChanged ? changedNames(event.body[1]) : [],
		invalidated: isPropsChanged ? invalidatedNames(event.body[2]) : [],
	};
}

/**
 * Build a bounded-signal-window capture over a live transport. The returned function
 * subscribes, collects up to `bound.maxSignals` signals or waits `bound.windowMs`, then
 * unsubscribes and resolves — whichever limit is hit first.
 */
export function createTransportSignalWindow(
	transport: DbusTransport,
	now: () => number,
	bound: SignalWindowBound = DEFAULT_SIGNAL_WINDOW,
): () => Promise<readonly SignalRecord[]> {
	return async () => {
		const records: SignalRecord[] = [];
		const subscriptions: Subscription[] = [];
		return new Promise<readonly SignalRecord[]>((resolve) => {
			let closed = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const close = async (): Promise<void> => {
				if (closed) {
					return;
				}
				closed = true;
				if (timer !== undefined) {
					clearTimeout(timer);
				}
				await Promise.all(subscriptions.map((s) => s.unsubscribe().catch(() => undefined)));
				resolve(records);
			};

			const onSignal = (event: SignalEvent): void => {
				if (closed) {
					return;
				}
				records.push(toRecord(event, now()));
				if (records.length >= bound.maxSignals) {
					void close();
				}
			};

			timer = setTimeout(() => void close(), bound.windowMs);
			void Promise.all([
				transport.subscribeSignal(
					{ interface: PROPERTIES_IFACE, member: 'PropertiesChanged' },
					onSignal,
				),
				transport.subscribeSignal(
					{ interface: OBJECT_MANAGER_IFACE, member: 'InterfacesAdded' },
					onSignal,
				),
				transport.subscribeSignal(
					{ interface: OBJECT_MANAGER_IFACE, member: 'InterfacesRemoved' },
					onSignal,
				),
			])
				.then((subs) => {
					if (closed) {
						void Promise.all(subs.map((s) => s.unsubscribe().catch(() => undefined)));
						return;
					}
					subscriptions.push(...subs);
				})
				.catch(() => void close());
		});
	};
}
