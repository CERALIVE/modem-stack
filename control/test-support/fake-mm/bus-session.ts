// A thin typed facade over one `@httptoolkit/dbus-native` client connection.
//
// The fake service owns a bus connection whose whole job is to serve the MM object
// model and emit its signals. This wrapper hides the untyped library surface behind
// a small, purpose-built API (connect, claim/release a name, register a method
// handler, emit a signal, disconnect) and applies the two Bun survival rules A2.4
// discovered: run with `ReturnLongjs: true`, and after connect attach a no-op
// `error` listener so a killed/closed bus never re-throws an EventEmitter error and
// crashes the test process.

import * as dbusNativeModule from '@httptoolkit/dbus-native';

/** A method-call handler: receives the decoded arg list, returns the reply value. */
export type MethodImpl = (...args: unknown[]) => unknown;

/** Where to reach the bus — a session address or a private-bus socket path. */
export interface BusAddress {
	readonly busAddress?: string;
	readonly socket?: string;
}

interface RawConnection {
	on(event: string, handler: (...args: unknown[]) => void): void;
	once(event: string, handler: (...args: unknown[]) => void): void;
	removeListener(event: string, handler: (...args: unknown[]) => void): void;
}

interface RawBus {
	name?: string;
	connection: RawConnection;
	requestName(name: string, flags: number): Promise<unknown>;
	releaseName(name: string): Promise<unknown>;
	setMethodCallHandler(
		path: string,
		iface: string,
		member: string,
		handler: [MethodImpl, string],
	): void;
	sendSignal(path: string, iface: string, member: string, signature: string, args: unknown[]): void;
	disconnect(): Promise<void>;
}

interface RawModule {
	createClient(options: { busAddress?: string; socket?: string; ReturnLongjs?: boolean }): RawBus;
}

const rawModule = ((dbusNativeModule as { default?: unknown }).default ??
	dbusNativeModule) as unknown as RawModule;

/** Narrow a `BusAddress` to exactly one populated field (socket wins). */
export function pickAddress(address: BusAddress): BusAddress {
	if (address.socket !== undefined) {
		return { socket: address.socket };
	}
	if (address.busAddress !== undefined) {
		return { busAddress: address.busAddress };
	}
	return {};
}

export class BusSession {
	readonly #bus: RawBus;

	private constructor(bus: RawBus) {
		this.#bus = bus;
	}

	static async connect(address: BusAddress): Promise<BusSession> {
		const options: { busAddress?: string; socket?: string; ReturnLongjs?: boolean } = {
			ReturnLongjs: true,
		};
		if (address.socket !== undefined) {
			options.socket = address.socket;
		} else if (address.busAddress !== undefined) {
			options.busAddress = address.busAddress;
		}
		const bus = rawModule.createClient(options);
		await new Promise<void>((resolve, reject) => {
			const onConnect = (): void => {
				bus.connection.removeListener('error', onError);
				resolve();
			};
			const onError = (error: unknown): void => {
				bus.connection.removeListener('connect', onConnect);
				reject(error instanceof Error ? error : new Error(String(error)));
			};
			bus.connection.once('connect', onConnect);
			bus.connection.once('error', onError);
		});
		// Swallow late socket errors from a killed/closed bus (see A2.4 reconnect notes).
		bus.connection.on('error', () => undefined);
		return new BusSession(bus);
	}

	/** The connection's unique bus name — populated once `Hello` (and thus the first
	 *  awaited name request) has completed. */
	get uniqueName(): string | undefined {
		return this.#bus.name;
	}

	async requestName(name: string, flags = 0): Promise<void> {
		await this.#bus.requestName(name, flags);
	}

	async releaseName(name: string): Promise<void> {
		await this.#bus.releaseName(name);
	}

	handle(
		path: string,
		iface: string,
		member: string,
		impl: MethodImpl,
		resultSignature: string,
	): void {
		this.#bus.setMethodCallHandler(path, iface, member, [impl, resultSignature]);
	}

	emit(path: string, iface: string, member: string, signature: string, args: unknown[]): void {
		this.#bus.sendSignal(path, iface, member, signature, args);
	}

	async disconnect(): Promise<void> {
		await this.#bus.disconnect().catch(() => undefined);
	}
}
