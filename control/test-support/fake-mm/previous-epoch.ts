// The retained previous-epoch handle for `FakeModemManager.restartRetainingPrevious`.
//
// After a new owner replaces the old one, the OLD connection stays up. This handle
// lets a test emit a stale, old-epoch `InterfacesRemoved` from that connection and
// prove the observer ignores it (the signal's `sender` is not the current owner).

import type { BusSession } from './bus-session';
import { type MmShape, type ModemSpec, modemObjects } from './object-model';
import { emitInterfacesRemoved } from './signals';

export interface PreviousEpoch {
	readonly uniqueName: string | undefined;
	/** Emit an old-epoch `InterfacesRemoved` for a modem from the retained connection. */
	removeModem(index: number): void;
	stop(): Promise<void>;
}

export function makePreviousEpoch(
	previous: BusSession,
	specs: ReadonlyMap<number, ModemSpec>,
	shape: MmShape,
): PreviousEpoch {
	return {
		get uniqueName(): string | undefined {
			return previous.uniqueName;
		},
		removeModem(index: number): void {
			const spec = specs.get(index);
			if (spec === undefined) {
				return;
			}
			for (const [path, interfaces] of modemObjects(spec, shape)) {
				emitInterfacesRemoved(
					previous,
					path,
					interfaces.map(([name]) => name),
				);
			}
		},
		stop(): Promise<void> {
			return previous.disconnect();
		},
	};
}
