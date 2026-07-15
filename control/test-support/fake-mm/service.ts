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
import { simLockError, submitPin, submitPuk, type UnlockOutcome } from './unlock-state';

/** One recorded `Signal.Setup` call — the modem, its rate, and the serving epoch owner. */
export interface SignalSetupCall {
	readonly modemIndex: number;
	readonly rate: number;
	readonly owner: string | undefined;
}

import { makePreviousEpoch, type PreviousEpoch } from './previous-epoch';
import { emitInterfacesAdded, emitInterfacesRemoved, emitPropertiesChanged } from './signals';

const TRIPWIRE_ERROR = 'tv.ceralive.FakeModemManager.Error.BearerTripwire';

// DBus name-request flags. A current owner claims with ALLOW_REPLACEMENT so a fresh
// epoch can take the name over WITHOUT the old connection dropping — the state a
// `restartRetainingPrevious()` needs to emit a genuine old-epoch straggler signal.
const NAME_FLAG_ALLOW_REPLACEMENT = 0x1;
const NAME_FLAG_REPLACE_EXISTING = 0x2;

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
	readonly #cells = new Map<number, readonly (readonly PropEntry[])[]>();
	readonly #expectedPins = new Map<string, string>();
	readonly #expectedPuks = new Map<string, string>();
	readonly #callLog: string[] = [];
	readonly #signalSetupLog: SignalSetupCall[] = [];
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
			cellInfo: (index) => this.#cells.get(index) ?? [],
			submitPin: (index, sp, pin) => this.#submitPin(index, sp, pin),
			submitPuk: (index, sp, puk, newPin) => this.#submitPuk(index, sp, puk, newPin),
			recordSignalSetup: (index, rate) => this.#recordSignalSetup(index, rate),
			tripwire: (iface, member) => this.#tripwire(iface, member),
			delay: (value) => this.#delay(value),
			traced: (member, index, produce) => this.#traced(member, index, produce),
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
		await session.requestName(BUS_NAME, NAME_FLAG_ALLOW_REPLACEMENT);
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

	/** Make a SIM demand a specific PUK; a wrong `SendPuk` throws the MM SimPuk error. */
	expectPuk(simIndex: number, puk: string): void {
		this.#expectedPuks.set(simPath(simIndex), puk);
	}

	/** Configure what `Modem.GetCellInfo` returns for a modem (`aa{sv}` encode form). */
	configureCellInfo(modemIndex: number, cells: readonly (readonly PropEntry[])[]): void {
		this.#cells.set(modemIndex, cells);
	}

	/** The ordered disruptive-op call log (`member:start:<idx>` / `member:end:<idx>`). */
	get callLog(): readonly string[] {
		return [...this.#callLog];
	}

	/** Every recorded `Signal.Setup` call, in order, tagged with its serving owner. */
	get signalSetupCalls(): readonly SignalSetupCall[] {
		return [...this.#signalSetupLog];
	}

	/** Reset the call + Signal.Setup logs (use between scenario phases). */
	clearLogs(): void {
		this.#callLog.length = 0;
		this.#signalSetupLog.length = 0;
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
		await this.#session.requestName(BUS_NAME, NAME_FLAG_ALLOW_REPLACEMENT);
	}

	/** Restart under a FRESH connection (new unique owner = new epoch), re-serving the model. */
	async restart(): Promise<void> {
		const previous = this.#session;
		this.#session = await BusSession.connect(this.#address);
		this.#registerAll();
		await this.#session.requestName(BUS_NAME, NAME_FLAG_ALLOW_REPLACEMENT);
		await previous.disconnect();
	}

	/**
	 * Restart to a NEW epoch that REPLACES the old owner while KEEPING the previous
	 * connection alive. The new connection takes the name via REPLACE_EXISTING (the old
	 * claim allowed replacement), so `NameOwnerChanged` (old → new) fires with both
	 * connections up. The returned handle can emit stale old-epoch signals.
	 */
	async restartRetainingPrevious(): Promise<PreviousEpoch> {
		const handle = makePreviousEpoch(this.#session, new Map(this.#specs), this.#shape);
		this.#session = await BusSession.connect(this.#address);
		this.#registerAll();
		await this.#session.requestName(
			BUS_NAME,
			NAME_FLAG_ALLOW_REPLACEMENT | NAME_FLAG_REPLACE_EXISTING,
		);
		return handle;
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

	#submitPin(index: number, simObjectPath: string, pin: unknown): null {
		return this.#applyUnlock(index, simObjectPath, (spec) =>
			submitPin(spec, this.#expectedPins.get(simObjectPath), pin),
		);
	}

	#submitPuk(index: number, simObjectPath: string, puk: unknown, _newPin: unknown): null {
		return this.#applyUnlock(index, simObjectPath, (spec) =>
			submitPuk(spec, this.#expectedPuks.get(simObjectPath), puk),
		);
	}

	#applyUnlock(
		index: number,
		simObjectPath: string,
		run: (spec: ModemSpec) => UnlockOutcome,
	): null {
		const spec = this.#specs.get(index);
		if (spec === undefined) {
			return null;
		}
		const outcome = run(spec);
		this.#specs.set(index, outcome.next);
		if (outcome.reject !== undefined) {
			simLockError(simObjectPath, outcome.reject);
		}
		return null;
	}

	#recordSignalSetup(index: number, rate: unknown): void {
		this.#signalSetupLog.push({
			modemIndex: index,
			rate: typeof rate === 'number' ? rate : Number(rate),
			owner: this.#session.uniqueName,
		});
	}

	#traced<T>(member: string, index: number, produce: () => T): T | Promise<T> {
		this.#callLog.push(`${member}:start:${index}`);
		const finish = (): T => {
			const value = produce();
			this.#callLog.push(`${member}:end:${index}`);
			return value;
		};
		if (this.#replyDelayMs <= 0) {
			return finish();
		}
		return new Promise<T>((resolve, reject) => {
			setTimeout(() => {
				try {
					resolve(finish());
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			}, this.#replyDelayMs);
		});
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
