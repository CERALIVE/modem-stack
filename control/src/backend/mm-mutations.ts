import type { DesiredRadio } from '../domain';
import type {
	BandReadResult,
	InhibitLease,
	ModemRef,
	NetworkScanResult,
	Receipt,
	SimPukUnlockResult,
	SimUnlockResult,
} from '../ports';
import type { DbusTransport } from '../transport';
import { MM_BUS_NAME } from './constants';
import { readBands, setCurrentBands } from './mm-mutations/bands';
import type { MmMutationContext } from './mm-mutations/context';
import { inhibitDevice, uninhibitDevice } from './mm-mutations/inhibit';
import { setModeCombination, setRadioModes } from './mm-mutations/modes';
import { scanNetworks } from './mm-mutations/scan';
import { setPrimarySimSlot, unlockWithPin, unlockWithPuk } from './mm-mutations/sim';
import type { ModemActor } from './modem-actor';

const DEFAULT_SCAN_TIMEOUT_MS = 300_000;

export interface MmMutationsDeps {
	readonly transport: DbusTransport;
	readonly actor: ModemActor;
	readonly destination?: string;
	readonly resolveStableKey: (modem: ModemRef) => string;
	readonly scanTimeoutMs?: number;
	readonly now?: () => number;
}

export class MmMutations {
	readonly #context: MmMutationContext;
	readonly #scanTimeoutMs: number;
	readonly #now: () => number;

	constructor(deps: MmMutationsDeps) {
		this.#context = {
			transport: deps.transport,
			actor: deps.actor,
			destination: deps.destination ?? MM_BUS_NAME,
			resolveStableKey: deps.resolveStableKey,
		};
		this.#scanTimeoutMs = deps.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
		this.#now = deps.now ?? Date.now;
	}

	setRadioModes(modem: ModemRef, preference: DesiredRadio): Promise<Receipt> {
		return setRadioModes(this.#context, modem, preference);
	}

	setModeCombination(modem: ModemRef, allowed: number, preferred: number): Promise<Receipt> {
		return setModeCombination(this.#context, modem, allowed, preferred);
	}

	readBands(modem: ModemRef): Promise<BandReadResult> {
		return readBands(this.#context, modem);
	}

	setCurrentBands(modem: ModemRef, bands: readonly string[]): Promise<Receipt> {
		return setCurrentBands(this.#context, modem, bands);
	}

	setPrimarySimSlot(modem: ModemRef, slotIndex: number): Promise<Receipt> {
		return setPrimarySimSlot(this.#context, modem, slotIndex);
	}

	sendPin(modem: ModemRef, pin: string): Promise<SimUnlockResult> {
		return unlockWithPin(this.#context, modem, pin);
	}

	sendPuk(modem: ModemRef, puk: string, newPin: string): Promise<SimPukUnlockResult> {
		return unlockWithPuk(this.#context, modem, puk, newPin);
	}

	scanNetworks(modem: ModemRef): Promise<NetworkScanResult> {
		return scanNetworks(this.#context, modem, this.#scanTimeoutMs);
	}

	inhibit(uid: string): Promise<InhibitLease> {
		return inhibitDevice(this.#context, uid, this.#now);
	}

	uninhibit(lease: InhibitLease): Promise<void> {
		return uninhibitDevice(this.#context, lease);
	}
}
