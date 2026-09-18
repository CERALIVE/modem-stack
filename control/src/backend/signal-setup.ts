// Signal.Setup(interval) full-lifecycle management, epoch-scoped.
//
// ModemManager's `Modem.Signal.Setup(rate)` turns on periodic extended signal
// reporting. Its lifecycle mirrors the observer's epochs (A3.1):
//
//   - applied once when the backend starts observing a modem;
//   - applied to a hot-plugged modem the moment it appears (`InterfacesAdded`);
//   - RE-APPLIED to every surviving modem after every owner-epoch change (a fresh MM
//     owner has none of the previous owner's cadence configured);
//   - NEVER applied for an OLD epoch — a setup scheduled for an epoch that is no
//     longer current is dropped before the call ever goes out.
//
// A modem that lacks the `Modem.Signal` interface entirely reports
// `signalCadence: 'unsupported'` and is never called — a soft capability gap, never
// a start failure. The manager is driven purely by the observer's `onEpochRefresh`
// hook: every current-epoch snapshot re-drives it, and it de-dupes per (epoch, modem)
// so a modem is set up exactly once per epoch.

import type { DbusTransport } from '../transport';
import { MM_BUS_NAME, MODEM_IFACE } from './constants';
import type { DecodedManagedObjects } from './managed-objects';
import { hasInterface, pathsWithInterface } from './managed-objects';

/** Whether periodic signal reporting is configured for a modem. */
export type SignalCadence = 'active' | 'unsupported' | 'unknown';

/** The `Modem.Signal` interface — absent means signal cadence is unsupported. */
const SIGNAL_IFACE = 'org.freedesktop.ModemManager1.Modem.Signal';

/**
 * MM's default reporting rate is seconds; callers pass whole seconds.
 *
 * It is a DEFAULT and not a constant: extended signal costs a modem-side poll per tick,
 * so an embedding process running a bonded uplink may want it faster than a bench tool
 * does. The rate is therefore injectable end to end — `SignalSetupManagerOptions`,
 * `MmDbusBackendOptions.signalIntervalSeconds` and
 * `ModemManagerProviderOptions.signalIntervalSeconds` are the same seam at three levels
 * — and this value is what an absent injection resolves to, at every one of them.
 */
export const DEFAULT_SIGNAL_INTERVAL_SECONDS = 5;

export interface SignalSetupManagerOptions {
	readonly transport: DbusTransport;
	/** MM bus name override (defaults to `org.freedesktop.ModemManager1`). */
	readonly destination?: string;
	/**
	 * Reporting interval in seconds passed to `Signal.Setup`.
	 *
	 * `Setup` takes a `u`, so a fractional or negative rate has no wire representation
	 * and is refused HERE rather than marshalled into whatever the codec makes of it —
	 * a modem silently polling at the wrong cadence is a defect nothing downstream can
	 * see. An absent value is not a refusal; it takes the default.
	 */
	readonly intervalSeconds?: number;
}

export function resolveSignalInterval(intervalSeconds: number | undefined): number {
	if (intervalSeconds === undefined) {
		return DEFAULT_SIGNAL_INTERVAL_SECONDS;
	}
	if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
		throw new RangeError(
			`Signal.Setup interval must be a positive whole number of seconds, got ${intervalSeconds}`,
		);
	}
	return intervalSeconds;
}

/**
 * Drives `Signal.Setup` across the modem fleet, keyed to the observer's epochs. Feed
 * it every `onEpochRefresh` event; it applies setup to each modem exactly once per
 * epoch, re-applies to survivors on a new epoch, and never calls for an old one.
 */
export class SignalSetupManager {
	readonly #transport: DbusTransport;
	readonly #destination: string;
	readonly #interval: number;
	#currentEpoch: string | undefined;
	// Guards double-issue within an epoch: `${epoch}\u0000${modemPath}`.
	readonly #applied = new Set<string>();
	readonly #cadence = new Map<string, SignalCadence>();

	constructor(options: SignalSetupManagerOptions) {
		this.#transport = options.transport;
		this.#destination = options.destination ?? MM_BUS_NAME;
		this.#interval = resolveSignalInterval(options.intervalSeconds);
	}

	/** The rate every `Signal.Setup` on this manager carries — injected, or the default. */
	get intervalSeconds(): number {
		return this.#interval;
	}

	/** The last-known cadence for a modem path (`'unknown'` until first applied). */
	cadenceFor(modemPath: string): SignalCadence {
		return this.#cadence.get(modemPath) ?? 'unknown';
	}

	/**
	 * Apply `Signal.Setup` for the current epoch's modems. New epoch ⇒ every survivor
	 * is re-applied; an already-applied (epoch, modem) is skipped. Modems absent from
	 * this snapshot keep their last cadence but are not re-driven.
	 */
	applyForEpoch(epoch: string, tree: DecodedManagedObjects): void {
		this.#currentEpoch = epoch;
		for (const modemPath of pathsWithInterface(tree, MODEM_IFACE)) {
			const key = `${epoch}\u0000${modemPath}`;
			if (this.#applied.has(key)) {
				continue;
			}
			this.#applied.add(key);
			void this.#setupOne(epoch, modemPath, tree);
		}
	}

	async #setupOne(epoch: string, modemPath: string, tree: DecodedManagedObjects): Promise<void> {
		// Epoch changed out from under us before we could issue the call — drop it, so
		// no Signal.Setup ever fires for a superseded epoch.
		if (this.#currentEpoch !== epoch) {
			return;
		}
		if (!hasInterface(tree, modemPath, SIGNAL_IFACE)) {
			this.#cadence.set(modemPath, 'unsupported');
			return;
		}
		if (this.#currentEpoch !== epoch) {
			return;
		}
		try {
			await this.#transport.callMethod({
				destination: this.#destination,
				path: modemPath,
				interface: SIGNAL_IFACE,
				member: 'Setup',
				signature: 'u',
				args: [this.#interval],
			});
			this.#cadence.set(modemPath, 'active');
		} catch {
			// A Setup call that errors is a soft gap — surfaced as unsupported, never a
			// start failure.
			this.#cadence.set(modemPath, 'unsupported');
		}
	}
}
