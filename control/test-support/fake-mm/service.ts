// A scriptable, MM-faithful fake `org.freedesktop.ModemManager1` service.
//
// It serves a REAL ModemManager object model on a private session bus: a root
// ObjectManager, modems with SEPARATE `Modem` + `Modem.Modem3gpp` interfaces, SIMs
// as separate `/SIM/<n>` objects reached via each modem's `Sim` path, and bearers
// that are observable in the tree but THROW on any connect method (the tripwire
// proving nothing in the stack ever activates a bearer through MM). Scenarios drive
// it through the methods below: add/remove modems, hot-swap SIMs, emit invalidated
// or changed `PropertiesChanged`, configure `Scan`, delay replies, drop/reclaim the
// bus name (real `NameOwnerChanged`), and restart under a fresh owner.
//
// The A3.x D-Bus backend is written and tested against THIS service. Method wiring
// lives in `handlers.ts`, signal emission in `signals.ts`, the object model in
// `object-model.ts`; this file holds the scenario state and public API.

import { type BusAddress, BusSession, pickAddress } from './bus-session';
import { type HandlerContext, registerModemHandlers, registerRoot } from './handlers';
import {
	BUS_NAME,
	type MmShape,
	MODEM_IFACE,
	type ModemSpec,
	managedObjects,
	modemObjects,
	modemPath,
	type PropEntry,
	type ScannedNetworkEntry,
	SIM_IFACE,
	type SimSpec,
	scanEntry,
	simObject,
	simPath,
} from './object-model';
import { emitInterfacesAdded, emitInterfacesRemoved, emitPropertiesChanged } from './signals';

const TRIPWIRE_ERROR = 'tv.ceralive.FakeModemManager.Error.BearerTripwire';

export interface FakeModemManagerOptions extends BusAddress {
	readonly shape?: MmShape;
	readonly modems?: readonly ModemSpec[];
}

export class FakeModemManager {
	readonly busName = BUS_NAME;
	readonly #address: BusAddress;
	readonly #shape: MmShape;
	readonly #specs = new Map<number, ModemSpec>();
	readonly #scans = new Map<number, readonly ScannedNetworkEntry[]>();
	readonly #expectedPins = new Map<string, string>();
	readonly #ctx: HandlerContext;
	#session: BusSession;
	#replyDelayMs = 0;

	private constructor(session: BusSession, shape: MmShape, address: BusAddress) {
		this.#session = session;
		this.#shape = shape;
		this.#address = address;
		this.#ctx = {
			tree: () => managedObjects([...this.#specs.values()], this.#shape),
			scanReply: (index) => (this.#scans.get(index) ?? []).map(scanEntry),
			checkPin: (path, pin) => this.#checkPin(path, pin),
			tripwire: (iface, member) => this.#tripwire(iface, member),
			delay: (value) => this.#delay(value),
		};
	}

	static async start(options: FakeModemManagerOptions): Promise<FakeModemManager> {
		const session = await BusSession.connect(options);
		const fake = new FakeModemManager(session, options.shape ?? '1.24', pickAddress(options));
		for (const spec of options.modems ?? []) {
			fake.#specs.set(spec.index, spec);
		}
		fake.#registerAll();
		// Claiming the name completes only after Hello, so `uniqueName` is set afterwards.
		await session.requestName(BUS_NAME);
		return fake;
	}

	get uniqueName(): string | undefined {
		return this.#session.uniqueName;
	}

	get shape(): MmShape {
		return this.#shape;
	}

	/** Add a modem and announce it: `InterfacesAdded` for the modem, its SIMs, its bearer. */
	addModem(spec: ModemSpec): void {
		this.#specs.set(spec.index, spec);
		registerModemHandlers(this.#session, spec, this.#ctx);
		for (const object of modemObjects(spec, this.#shape)) {
			emitInterfacesAdded(this.#session, object);
		}
	}

	/** Remove a modem and announce it: `InterfacesRemoved` for each of its objects. */
	removeModem(index: number): void {
		const spec = this.#specs.get(index);
		if (spec === undefined) {
			return;
		}
		this.#specs.delete(index);
		for (const [path, interfaces] of modemObjects(spec, this.#shape)) {
			emitInterfacesRemoved(
				this.#session,
				path,
				interfaces.map(([name]) => name),
			);
		}
	}

	/** Hot-swap the SIM: remove the old SIM object, add the new one, invalidate `Sim`. */
	replaceSim(modemIndex: number, replacement: SimSpec): void {
		const spec = this.#specs.get(modemIndex);
		if (spec === undefined) {
			return;
		}
		const newSim: SimSpec = { ...replacement, active: true };
		const next: ModemSpec = { ...spec, sims: [newSim] };
		this.#specs.set(modemIndex, next);
		registerModemHandlers(this.#session, next, this.#ctx);
		for (const sim of spec.sims) {
			emitInterfacesRemoved(this.#session, simPath(sim.index), [SIM_IFACE]);
		}
		emitInterfacesAdded(this.#session, simObject(newSim));
		// The modem's `Sim` path changed — MM invalidates it so the client re-reads.
		emitPropertiesChanged(this.#session, modemPath(modemIndex), MODEM_IFACE, [], ['Sim']);
	}

	/** Configure what `Modem3gpp.Scan` returns for a modem. */
	configureScan(modemIndex: number, networks: readonly ScannedNetworkEntry[]): void {
		this.#scans.set(modemIndex, networks);
	}

	/** Make a SIM demand a specific PIN; a wrong `SendPin` throws the MM SimPin error. */
	expectPin(simIndex: number, pin: string): void {
		this.#expectedPins.set(simPath(simIndex), pin);
	}

	/** Delay every subsequent method reply by `ms` (0 disables) — late-reply scenarios. */
	setReplyDelay(ms: number): void {
		this.#replyDelayMs = ms;
	}

	/** Emit a `PropertiesChanged` carrying new VALUES in the changed dict. */
	changeProperties(path: string, iface: string, changed: readonly PropEntry[]): void {
		emitPropertiesChanged(this.#session, path, iface, changed, []);
	}

	/** Emit an INVALIDATED-ONLY `PropertiesChanged`: empty changed dict, names invalidated. */
	invalidateProperties(path: string, iface: string, names: readonly string[]): void {
		emitPropertiesChanged(this.#session, path, iface, [], names);
	}

	/** Release the well-known name — the daemon emits a real `NameOwnerChanged` (owner → ""). */
	async dropName(): Promise<void> {
		await this.#session.releaseName(BUS_NAME);
	}

	/** Re-claim the name on the SAME connection — `NameOwnerChanged` ("" → owner). */
	async reclaimName(): Promise<void> {
		await this.#session.requestName(BUS_NAME);
	}

	/** Restart under a FRESH connection (new unique owner = new epoch), re-serving the model. */
	async restart(): Promise<void> {
		const previous = this.#session;
		this.#session = await BusSession.connect(this.#address);
		this.#registerAll();
		await this.#session.requestName(BUS_NAME);
		await previous.disconnect();
	}

	async stop(): Promise<void> {
		await this.#session.disconnect();
	}

	#registerAll(): void {
		registerRoot(this.#session, this.#ctx);
		for (const spec of this.#specs.values()) {
			registerModemHandlers(this.#session, spec, this.#ctx);
		}
	}

	#checkPin(path: string, pin: unknown): null {
		const expected = this.#expectedPins.get(path);
		if (expected !== undefined && pin !== expected) {
			const error = new Error(`incorrect PIN for ${path}`) as Error & { dbusName?: string };
			error.dbusName = 'org.freedesktop.ModemManager1.Error.MobileEquipment.SimPin';
			throw error;
		}
		return null;
	}

	#tripwire(iface: string, member: string): never {
		const error = new Error(
			`TRIPWIRE: ${iface}.${member} was called — the controller must NEVER touch bearers; ` +
				'NetworkManager owns activation (see the ownership matrix).',
		) as Error & { dbusName?: string };
		error.dbusName = TRIPWIRE_ERROR;
		throw error;
	}

	#delay<T>(value: T): T | Promise<T> {
		if (this.#replyDelayMs <= 0) {
			return value;
		}
		return new Promise<T>((resolve) => setTimeout(() => resolve(value), this.#replyDelayMs));
	}
}

export { TRIPWIRE_ERROR };
