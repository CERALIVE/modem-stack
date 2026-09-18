// An in-memory `DbusTransport` serving the SAME MM-faithful object model as
// `test-support/fake-mm`, with no bus and no daemon.
//
// `fake-mm/service.ts` is the right harness for proving the transport codec and the
// observer's epoch handling — it is a real service on a real session bus, which is the
// only way to prove those. It is the WRONG harness for a conformance matrix: every case
// would need `dbus-run-session`, so a matrix row would SKIP rather than run wherever a
// session bus is absent, and a matrix with holes in it answers nothing. This transport
// reuses `fake-mm/object-model.ts` verbatim — the same `ModemSpec`, the same property
// sets, the same separate `Modem` / `Modem3gpp` interfaces, the same `/SIM/<n>` objects
// and the same bearer objects — and converts that ENCODE-form tree into the DECODE form
// the transport hands back, so the model is shared rather than re-invented.
//
// It is also what makes the 16-modem scale fixture deterministic: subscription counts,
// `Signal.Setup` issue counts and refresh coalescing are all observable here without a
// bus in the middle, so a resource assertion measures the stack rather than the daemon.

import type {
	DbusTransport,
	DbusValue,
	MethodCall,
	MethodReply,
	SignalEvent,
	SignalListener,
	SignalSpec,
	Subscription,
	TransportEvent,
} from '../../src/transport';
import type {
	EncodeVariant,
	InterfaceEntry,
	ManagedObject,
	ManagedObjects,
	MmShape,
	ModemSpec,
	PropEntry,
} from '../fake-mm/object-model';
import { BUS_NAME, managedObjects, modemObjects, ROOT_PATH } from '../fake-mm/object-model';

const DBUS_DESTINATION = 'org.freedesktop.DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';
const OBJECT_MANAGER_IFACE = 'org.freedesktop.DBus.ObjectManager';

/** One recorded outgoing call — the resource ledger the scale fixture asserts against. */
export type RecordedCall = {
	readonly path: string;
	readonly interface: string;
	readonly member: string;
};

/**
 * An `a{sv}` member is ITSELF a variant on the wire, so its decode form is
 * `[key, {signature, value}][]` — not `[key, [signature, value]][]`. Recursing here is
 * what keeps this transport symmetric with the real codec; without it a `Modem.Signal`
 * RAT dict decodes into a shape no daemon ever sends and the suite proves nothing.
 */
function decodeVariant(variant: EncodeVariant): DbusValue {
	const [signature, value] = variant;
	if (signature.startsWith('a{s') && Array.isArray(value)) {
		return { signature, value: decodeProps(value as readonly PropEntry[]) };
	}
	return { signature, value: value as DbusValue };
}

function decodeProps(props: readonly PropEntry[]): DbusValue {
	return props.map(([name, variant]) => [name, decodeVariant(variant)] as unknown as DbusValue);
}

function decodeInterfaces(interfaces: readonly InterfaceEntry[]): DbusValue {
	return interfaces.map(([name, props]) => [name, decodeProps(props)] as unknown as DbusValue);
}

function decodeObject(object: ManagedObject): DbusValue {
	return [object[0], decodeInterfaces(object[1])] as unknown as DbusValue;
}

/** The ENCODE-form tree `fake-mm` builds, in the DECODE form the transport returns. */
export function decodeTree(tree: ManagedObjects): DbusValue {
	return tree.map(decodeObject) as unknown as DbusValue;
}

export type FakeMmTransportOptions = {
	readonly modems?: readonly ModemSpec[];
	readonly shape?: MmShape;
	/** The unique bus name this epoch owns — every emitted signal carries it. */
	readonly owner?: string;
};

/**
 * A scriptable in-memory ModemManager. `addModem` / `removeModem` emit the real
 * ObjectManager signals with the current epoch's `sender`, so the observer's epoch guard
 * is exercised rather than bypassed.
 */
export class FakeMmTransport implements DbusTransport {
	readonly calls: RecordedCall[] = [];
	readonly #specs = new Map<number, ModemSpec>();
	readonly #shape: MmShape;
	readonly #subscriptions = new Set<{ spec: SignalSpec; listener: SignalListener }>();
	readonly #handlers = new Map<TransportEvent, Set<(payload?: unknown) => void>>();
	#owner: string;
	#connected = false;

	constructor(options: FakeMmTransportOptions = {}) {
		this.#shape = options.shape ?? '1.24';
		this.#owner = options.owner ?? ':1.42';
		for (const spec of options.modems ?? []) this.#specs.set(spec.index, spec);
	}

	get owner(): string {
		return this.#owner;
	}

	/** Every `Signal.Setup` call issued, in order — one per (epoch, modem) or it is a bug. */
	get signalSetupCalls(): readonly RecordedCall[] {
		return this.calls.filter(
			(call) => call.member === 'Setup' && call.interface.endsWith('.Signal'),
		);
	}

	get managedObjectsCalls(): readonly RecordedCall[] {
		return this.calls.filter((call) => call.member === 'GetManagedObjects');
	}

	async connect(): Promise<void> {
		this.#connected = true;
	}

	async disconnect(): Promise<void> {
		this.#connected = false;
		this.#subscriptions.clear();
	}

	isConnected(): boolean {
		return this.#connected;
	}

	async callMethod(call: MethodCall): Promise<MethodReply> {
		this.calls.push({ path: call.path, interface: call.interface, member: call.member });
		if (call.interface === DBUS_IFACE && call.member === 'GetNameOwner') {
			return { signature: 's', body: [this.#owner] };
		}
		if (call.interface === OBJECT_MANAGER_IFACE && call.member === 'GetManagedObjects') {
			return { signature: 'a{oa{sa{sv}}}', body: [this.tree()] };
		}
		return { signature: '', body: [] };
	}

	async subscribeSignal(spec: SignalSpec, listener: SignalListener): Promise<Subscription> {
		const entry = { spec, listener };
		this.#subscriptions.add(entry);
		return {
			unsubscribe: async () => {
				this.#subscriptions.delete(entry);
			},
		};
	}

	on(event: TransportEvent, handler: (payload?: unknown) => void): void {
		const set = this.#handlers.get(event) ?? new Set();
		set.add(handler);
		this.#handlers.set(event, set);
	}

	off(event: TransportEvent, handler: (payload?: unknown) => void): void {
		this.#handlers.get(event)?.delete(handler);
	}

	subscriptionCount(): number {
		return this.#subscriptions.size;
	}

	tree(): DbusValue {
		return decodeTree(managedObjects([...this.#specs.values()], this.#shape));
	}

	/** Attach a modem and announce it exactly as MM does — one signal per object. */
	addModem(spec: ModemSpec): void {
		this.#specs.set(spec.index, spec);
		for (const object of modemObjects(spec, this.#shape)) {
			this.#emit({
				path: ROOT_PATH,
				interface: OBJECT_MANAGER_IFACE,
				member: 'InterfacesAdded',
				sender: this.#owner,
				signature: 'oa{sa{sv}}',
				body: [object[0], decodeInterfaces(object[1])],
			});
		}
	}

	removeModem(index: number): void {
		const spec = this.#specs.get(index);
		if (spec === undefined) return;
		this.#specs.delete(index);
		for (const [path, interfaces] of modemObjects(spec, this.#shape)) {
			this.#emit({
				path: ROOT_PATH,
				interface: OBJECT_MANAGER_IFACE,
				member: 'InterfacesRemoved',
				sender: this.#owner,
				signature: 'oas',
				body: [path, interfaces.map(([name]) => name) as unknown as DbusValue],
			});
		}
	}

	/** Hand the well-known name to a NEW unique owner — a genuine epoch change. */
	takeOverAs(owner: string): void {
		const previous = this.#owner;
		this.#owner = owner;
		this.#emit({
			path: '/org/freedesktop/DBus',
			interface: DBUS_IFACE,
			member: 'NameOwnerChanged',
			sender: DBUS_DESTINATION,
			signature: 'sss',
			body: [BUS_NAME, previous, owner],
		});
	}

	#emit(event: SignalEvent): void {
		for (const { spec, listener } of [...this.#subscriptions]) {
			if (spec.interface !== event.interface || spec.member !== event.member) continue;
			if (spec.path !== undefined && spec.path !== event.path) continue;
			listener(event);
		}
	}
}
