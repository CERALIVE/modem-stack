// MmDbusBackend — the real D-Bus `ModemManagerPort`, composed from the A3 parts.
//
// It fulfils the whole port: the read side delegates to A3.1's epoch-scoped observer;
// the mutations run through `MmMutations` (each serialized on the shared per-modem
// `ModemActor`, keyed on A3.2's STABLE key so serialization survives replug); the
// Signal.Setup lifecycle is driven off the observer's `onEpochRefresh` hook; and the
// read-only enrichment (firmware revision, eSIM, signal cadence, normalized cell info)
// is assembled on demand. One transport is shared by all of them.
//
// The `onEpochRefresh` hook is the single integration seam: on every current-epoch
// authoritative snapshot it (1) rebuilds the live path → stable-key map (so a mutation
// keys the actor by the durable identity, not the transient path) and (2) re-drives
// Signal.Setup for that epoch — applying to new modems, re-applying to survivors after
// an owner change, and never firing for a superseded epoch.

import type { DesiredRadio } from '../domain';
import { epochMillis } from '../domain';
import type {
	BandReadResult,
	InhibitLease,
	ModemManagerPort,
	ModemRef,
	NetworkScanResult,
	ObservationList,
	ObservationListener,
	Receipt,
	SimPukUnlockResult,
	SimUnlockResult,
	Unsubscribe,
} from '../ports';
import type { DbusTransport } from '../transport';
import { type CellReading, normalizeCellInfo } from './cell-info';
import { MM_BUS_NAME, MODEM_IFACE } from './constants';
import { buildEnrichment, type ModemEnrichment } from './enrichment';
import { modemIdentityFactsFromTree, resolveModemIdentities } from './identity-ladder';
import { type DecodedProps, fetchManagedObjects, pathsWithInterface } from './managed-objects';
import { MmMutations } from './mm-mutations';
import { ModemActor, type QuiesceHook } from './modem-actor';
import { createMmDbusObserver, type EpochRefreshEvent, type MmDbusObserver } from './observer';
import { type SignalCadence, SignalSetupManager } from './signal-setup';

export interface MmDbusBackendOptions {
	readonly transport: DbusTransport;
	readonly destination?: string;
	readonly actor?: ModemActor;
	/** NM quiesce hook for disruptive mode/slot changes (A3.3 default: no-op). */
	readonly quiesce?: QuiesceHook;
	/** Signal.Setup reporting interval in seconds. */
	readonly signalIntervalSeconds?: number;
	readonly scanTimeoutMs?: number;
	readonly now?: () => number;
}

/** The real D-Bus ModemManager backend: observation + mutations + Signal.Setup. */
export class MmDbusBackend implements ModemManagerPort {
	readonly #transport: DbusTransport;
	readonly #destination: string;
	readonly #now: () => number;
	readonly #observer: MmDbusObserver;
	readonly #mutations: MmMutations;
	readonly #signalSetup: SignalSetupManager;
	// Live modem path → durable stable key; rebuilt on every epoch snapshot.
	readonly #stableKeyByPath = new Map<string, string>();

	constructor(options: MmDbusBackendOptions) {
		this.#transport = options.transport;
		this.#destination = options.destination ?? MM_BUS_NAME;
		this.#now = options.now ?? Date.now;
		const actor = options.actor ?? new ModemActor(options.quiesce);
		this.#signalSetup = new SignalSetupManager({
			transport: this.#transport,
			destination: this.#destination,
			...(options.signalIntervalSeconds !== undefined
				? { intervalSeconds: options.signalIntervalSeconds }
				: {}),
		});
		this.#observer = createMmDbusObserver({
			transport: this.#transport,
			destination: this.#destination,
			onEpochRefresh: (event) => this.#onEpochRefresh(event),
		});
		this.#mutations = new MmMutations({
			transport: this.#transport,
			actor,
			destination: this.#destination,
			resolveStableKey: (modem) => this.#stableKeyByPath.get(modem) ?? modem,
			...(options.scanTimeoutMs !== undefined ? { scanTimeoutMs: options.scanTimeoutMs } : {}),
			now: this.#now,
		});
	}

	// ── observation (delegated to the A3.1 observer) ────────────────────────────────

	start(): Promise<ObservationList> {
		return this.#observer.start();
	}

	observe(listener: ObservationListener): Unsubscribe {
		return this.#observer.observe(listener);
	}

	stop(): Promise<void> {
		return this.#observer.stop();
	}

	// ── mutations (serialized per modem through the shared actor) ────────────────────

	setRadioModes(modem: ModemRef, preference: DesiredRadio): Promise<Receipt> {
		return this.#mutations.setRadioModes(modem, preference);
	}

	setModeCombination(modem: ModemRef, allowed: number, preferred: number): Promise<Receipt> {
		return this.#mutations.setModeCombination(modem, allowed, preferred);
	}

	setPrimarySimSlot(modem: ModemRef, slotIndex: number): Promise<Receipt> {
		return this.#mutations.setPrimarySimSlot(modem, slotIndex);
	}

	readBands(modem: ModemRef): Promise<BandReadResult> {
		return this.#mutations.readBands(modem);
	}

	setCurrentBands(modem: ModemRef, bands: readonly string[]): Promise<Receipt> {
		return this.#mutations.setCurrentBands(modem, bands);
	}

	sendPin(modem: ModemRef, pin: string): Promise<SimUnlockResult> {
		return this.#mutations.sendPin(modem, pin);
	}

	sendPuk(modem: ModemRef, puk: string, newPin: string): Promise<SimPukUnlockResult> {
		return this.#mutations.sendPuk(modem, puk, newPin);
	}

	scanNetworks(modem: ModemRef): Promise<NetworkScanResult> {
		return this.#mutations.scanNetworks(modem);
	}

	inhibit(uid: string): Promise<InhibitLease> {
		return this.#mutations.inhibit(uid);
	}

	uninhibit(lease: InhibitLease): Promise<void> {
		return this.#mutations.uninhibit(lease);
	}

	// ── enrichment (additive, read-only, never gating) ──────────────────────────────

	/** Whether periodic signal reporting is configured for a modem (Signal.Setup). */
	signalCadence(modem: ModemRef): SignalCadence {
		return this.#signalSetup.cadenceFor(modem);
	}

	/** Read the normalized visible-cell list for a modem via `Modem.GetCellInfo`. */
	async readCellInfo(modem: ModemRef): Promise<readonly CellReading[]> {
		const provenance = { source: modem, observedAt: epochMillis(this.#now()) };
		try {
			const reply = await this.#transport.callMethod({
				destination: this.#destination,
				path: modem,
				interface: MODEM_IFACE,
				member: 'GetCellInfo',
			});
			const cells = Array.isArray(reply.body[0])
				? (reply.body[0] as unknown as DecodedProps[])
				: [];
			return normalizeCellInfo(cells, provenance);
		} catch {
			return [];
		}
	}

	/** Assemble the full read-only enrichment (revision, eSIM, cadence, cell info). */
	async readEnrichment(modem: ModemRef): Promise<ModemEnrichment> {
		const [tree, cellInfo] = await Promise.all([
			fetchManagedObjects(this.#transport, this.#destination),
			this.readCellInfo(modem),
		]);
		return buildEnrichment(tree, modem, this.#signalSetup.cadenceFor(modem), cellInfo);
	}

	#onEpochRefresh(event: EpochRefreshEvent): void {
		this.#refreshStableKeys(event);
		this.#signalSetup.applyForEpoch(event.epoch, event.tree);
	}

	#refreshStableKeys(event: EpochRefreshEvent): void {
		const paths = pathsWithInterface(event.tree, MODEM_IFACE);
		const facts = paths.map((path) => modemIdentityFactsFromTree(event.tree, path));
		const resolved = resolveModemIdentities(facts);
		this.#stableKeyByPath.clear();
		paths.forEach((path, index) => {
			const entry = resolved[index];
			if (entry !== undefined) {
				this.#stableKeyByPath.set(path, entry.stableKey);
			}
		});
	}
}

/** Construct the real D-Bus ModemManager backend over an A2.4 transport. */
export function createMmDbusBackend(options: MmDbusBackendOptions): MmDbusBackend {
	return new MmDbusBackend(options);
}
