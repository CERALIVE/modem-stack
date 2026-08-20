// The ModemManager mutations — the disruptive-and-SIM half of `ModemManagerPort`.
//
// Every disruptive op runs through the shared per-modem `ModemActor` (serialized on
// the STABLE key, so two ops on one modem never interleave and a replug keeps the
// same queue). Mode and slot changes additionally run QUIESCED (NM briefly stands
// down first, via the actor's quiesce hook). PIN / PUK / scan serialize too but do
// NOT quiesce — they don't touch the bearer. NONE of these methods can reach a bearer
// or connect verb: the port has none, and the fake's tripwire proves it at test time.

import { decodeBandList, encodeBandList, isResetSelection } from '../band';
import type { DesiredRadio, RadioAccessTechnology } from '../domain';
import { epochMillis } from '../domain';
import type {
	BandReadResult,
	InhibitLease,
	ModemRef,
	NetworkScanResult,
	Receipt,
	ScannedNetwork,
	SimPukUnlockResult,
	SimUnlockResult,
} from '../ports';
import { receipt } from '../ports';
import type { DbusTransport } from '../transport';
import {
	MM_BUS_NAME,
	MM_MANAGER_IFACE,
	MM_ROOT_PATH,
	MODEM_IFACE,
	MODEM3GPP_IFACE,
} from './constants';
import {
	type DecodedProps,
	fetchManagedObjects,
	findInterface,
	numberProp,
	propValue,
	stringProp,
} from './managed-objects';
import type { ModemActor } from './modem-actor';
import { sendSimPin, sendSimPuk } from './sim-unlock';

/** MMModemMode bit per RAT family (2G/3G/4G/5G). */
const MODE_BIT: Record<RadioAccessTechnology, number> = { gsm: 2, umts: 4, lte: 8, '5gnr': 16 };

/** MMModem3gppNetworkAvailability → the port's availability. */
const AVAILABILITY: Record<number, ScannedNetwork['availability']> = {
	0: 'unknown',
	1: 'available',
	2: 'current',
	3: 'forbidden',
};

/** A network scan can take a long time — MM's own default is not enough. */
const DEFAULT_SCAN_TIMEOUT_MS = 300_000;

export interface MmMutationsDeps {
	readonly transport: DbusTransport;
	readonly actor: ModemActor;
	readonly destination?: string;
	/** Map a live modem path to its stable actor key (survives replug). */
	readonly resolveStableKey: (modem: ModemRef) => string;
	readonly scanTimeoutMs?: number;
	readonly now?: () => number;
}

/** The disruptive + SIM mutations of `ModemManagerPort`, serialized per modem. */
export class MmMutations {
	readonly #transport: DbusTransport;
	readonly #actor: ModemActor;
	readonly #destination: string;
	readonly #resolveStableKey: (modem: ModemRef) => string;
	readonly #scanTimeoutMs: number;
	readonly #now: () => number;

	constructor(deps: MmMutationsDeps) {
		this.#transport = deps.transport;
		this.#actor = deps.actor;
		this.#destination = deps.destination ?? MM_BUS_NAME;
		this.#resolveStableKey = deps.resolveStableKey;
		this.#scanTimeoutMs = deps.scanTimeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
		this.#now = deps.now ?? Date.now;
	}

	setRadioModes(modem: ModemRef, preference: DesiredRadio): Promise<Receipt> {
		const allowed = maskOf(preference.allowedSet ?? new Set(preference.preferenceOrdered));
		const preferred = preference.preferenceOrdered[0];
		const preferredMask = preferred !== undefined ? MODE_BIT[preferred] : 0;
		if (allowed === 0) {
			return Promise.resolve(receipt('radio', 'failed', 'no radio modes were requested'));
		}
		return this.#actor.runQuiesced({ stableKey: this.#resolveStableKey(modem) }, async () => {
			try {
				await this.#transport.callMethod({
					destination: this.#destination,
					path: modem,
					interface: MODEM_IFACE,
					member: 'SetCurrentModes',
					signature: '(uu)',
					args: [[allowed, preferredMask]],
				});
				return receipt('radio', 'applied', 'radio mode preference applied');
			} catch (error) {
				return receipt('radio', 'failed', `SetCurrentModes failed: ${describe(error)}`);
			}
		});
	}

	async readBands(modem: ModemRef): Promise<BandReadResult> {
		try {
			const tree = await fetchManagedObjects(this.#transport, this.#destination);
			const props = findInterface(tree, modem, MODEM_IFACE);
			if (props === undefined) {
				return { ok: false, reason: 'the modem exports no Modem interface' };
			}
			return {
				ok: true,
				bands: {
					supported: decodeBandList(propValue(props, 'SupportedBands')),
					current: decodeBandList(propValue(props, 'CurrentBands')),
				},
			};
		} catch (error) {
			return { ok: false, reason: `reading bands failed: ${describe(error)}` };
		}
	}

	// Quiesced like `setRadioModes`, and for the same reason: a band change
	// re-registers the radio, so NM must stand down before the bearer drops
	// underneath it rather than after.
	setCurrentBands(modem: ModemRef, bands: readonly string[]): Promise<Receipt> {
		if (bands.length === 0) {
			return Promise.resolve(receipt('band', 'failed', 'no bands were requested'));
		}
		const encoded = encodeBandList(bands);
		if (!encoded.ok) {
			return Promise.resolve(
				receipt('band', 'unsupported', `this build does not know the band "${encoded.unknown}"`),
			);
		}
		const values = encoded.values;
		return this.#actor.runQuiesced({ stableKey: this.#resolveStableKey(modem) }, async () => {
			try {
				await this.#transport.callMethod({
					destination: this.#destination,
					path: modem,
					interface: MODEM_IFACE,
					member: 'SetCurrentBands',
					signature: 'au',
					args: [values],
				});
				return receipt(
					'band',
					'applied',
					isResetSelection(bands) ? 'band lock released' : `bands set to ${bands.join(', ')}`,
				);
			} catch (error) {
				return receipt('band', 'failed', `SetCurrentBands failed: ${describe(error)}`);
			}
		});
	}

	async setPrimarySimSlot(modem: ModemRef, slotIndex: number): Promise<Receipt> {
		const slots = await this.#readSlotCount(modem);
		if (slots === undefined) {
			return receipt('simSlot', 'failed', 'could not read the modem SIM-slot list');
		}
		if (slots <= 1) {
			return receipt('simSlot', 'unsupported', 'single-slot modem has no primary slot to select');
		}
		if (slotIndex < 1 || slotIndex > slots) {
			return receipt('simSlot', 'failed', `slot ${slotIndex} is out of range (1..${slots})`);
		}
		return this.#actor.runQuiesced({ stableKey: this.#resolveStableKey(modem) }, async () => {
			try {
				await this.#transport.callMethod({
					destination: this.#destination,
					path: modem,
					interface: MODEM_IFACE,
					member: 'SetPrimarySimSlot',
					signature: 'u',
					args: [slotIndex],
				});
				return receipt('simSlot', 'applied', `primary SIM slot set to ${slotIndex}`);
			} catch (error) {
				return receipt('simSlot', 'failed', `SetPrimarySimSlot failed: ${describe(error)}`);
			}
		});
	}

	sendPin(modem: ModemRef, pin: string): Promise<SimUnlockResult> {
		return this.#actor.run(this.#resolveStableKey(modem), () =>
			sendSimPin(this.#transport, this.#destination, modem, pin),
		);
	}

	sendPuk(modem: ModemRef, puk: string, newPin: string): Promise<SimPukUnlockResult> {
		return this.#actor.run(this.#resolveStableKey(modem), () =>
			sendSimPuk(this.#transport, this.#destination, modem, puk, newPin),
		);
	}

	scanNetworks(modem: ModemRef): Promise<NetworkScanResult> {
		return this.#actor.run(this.#resolveStableKey(modem), async () => {
			try {
				const reply = await this.#transport.callMethod({
					destination: this.#destination,
					path: modem,
					interface: MODEM3GPP_IFACE,
					member: 'Scan',
					timeoutMs: this.#scanTimeoutMs,
				});
				return { ok: true, networks: parseScan(reply.body[0]) };
			} catch (error) {
				return { ok: false, reason: `network scan failed: ${describe(error)}` };
			}
		});
	}

	async inhibit(uid: string): Promise<InhibitLease> {
		await this.#inhibitDevice(uid, true);
		return { uid, acquiredAt: epochMillis(this.#now()) };
	}

	async uninhibit(lease: InhibitLease): Promise<void> {
		await this.#inhibitDevice(lease.uid, false);
	}

	#inhibitDevice(uid: string, inhibit: boolean): Promise<unknown> {
		return this.#transport.callMethod({
			destination: this.#destination,
			path: MM_ROOT_PATH,
			interface: MM_MANAGER_IFACE,
			member: 'InhibitDevice',
			signature: 'sb',
			args: [uid, inhibit],
		});
	}

	async #readSlotCount(modem: ModemRef): Promise<number | undefined> {
		try {
			const tree = await fetchManagedObjects(this.#transport, this.#destination);
			const slots = propValue(findInterface(tree, modem, MODEM_IFACE), 'SimSlots');
			return Array.isArray(slots) ? slots.length : undefined;
		} catch {
			return undefined;
		}
	}
}

/** OR of the MMModemMode bits for a set of RATs. */
function maskOf(rats: ReadonlySet<RadioAccessTechnology>): number {
	let mask = 0;
	for (const rat of rats) {
		mask |= MODE_BIT[rat];
	}
	return mask;
}

/** Parse a `Modem3gpp.Scan` reply (`aa{sv}` → dicts) into scanned networks. */
function parseScan(value: unknown): readonly ScannedNetwork[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const networks: ScannedNetwork[] = [];
	for (const entry of value as DecodedProps[]) {
		const operatorCode = stringProp(entry, 'operator-code');
		if (operatorCode === undefined) {
			continue;
		}
		const name = stringProp(entry, 'operator-long') ?? stringProp(entry, 'operator-short');
		const availability = AVAILABILITY[numberProp(entry, 'status') ?? 0] ?? 'unknown';
		networks.push({
			operatorCode,
			...(name !== undefined ? { operatorName: name } : {}),
			availability,
		});
	}
	return networks;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
