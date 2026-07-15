// The bench stack context — one live handle to the D-Bus + NetworkManager backends.
//
// `--bus-address` (or `MODEM_CONTROL_BUS_ADDRESS`) is the injection point that lets the
// harness-driven CLI tests and the compiled-probe smoke point the SAME command code at
// the A2.3 fake ModemManager service instead of the real system bus. Without it the CLI
// talks to the system bus, where a real ModemManager lives.
//
// The interlock is STUBBED as always-allow here: the bench has no streaming to interlock
// against. Phase B wires CeraUI's real streaming-admission check into `LifecycleInterlock`.

import {
	ALLOW_ALL_INTERLOCK,
	createMmDbusBackend,
	createUsbEnumerator,
	type LifecycleInterlock,
	type MmDbusBackend,
	type NetworkManagerPort,
	NmcliNmPort,
	SpawnNmcliRunner,
	type UsbDeviceSnapshot,
} from '@ceralive/modem-control';
import { createDbusTransport, type DbusTransport } from '@ceralive/modem-control/transport';

/** The default system-bus socket ModemManager listens on. */
const SYSTEM_BUS_ADDRESS = 'unix:path=/var/run/dbus/system_bus_socket';

/** Global options shared by every command. */
export interface GlobalOptions {
	/** Encoded D-Bus bus address (harness / smoke injection). */
	readonly busAddress?: string;
	/** Override the ModemManager bus name (defaults to the well-known name). */
	readonly destination?: string;
}

/**
 * Resolve the bus address the CLI connects to. Precedence: an explicit
 * `--bus-address`, then `MODEM_CONTROL_BUS_ADDRESS`, then the real system bus.
 */
export function resolveBusAddress(options: GlobalOptions): string {
	return options.busAddress ?? process.env.MODEM_CONTROL_BUS_ADDRESS ?? SYSTEM_BUS_ADDRESS;
}

/** A live handle to the bench stack backends — closed via `close()`. */
export interface StackContext {
	readonly transport: DbusTransport;
	readonly backend: MmDbusBackend;
	readonly nm: NetworkManagerPort;
	readonly destination: string;
	readonly interlock: LifecycleInterlock;
	enumerate(): Promise<readonly UsbDeviceSnapshot[]>;
	now(): number;
	close(): Promise<void>;
}

/** Injectable overrides so tests can drive the commands against the fakes. */
export interface StackContextDeps {
	readonly transport?: DbusTransport;
	readonly nm?: NetworkManagerPort;
	readonly enumerate?: () => Promise<readonly UsbDeviceSnapshot[]>;
	readonly now?: () => number;
}

/**
 * Build a stack context. In production every dependency is created from the resolved
 * bus address; a test injects a transport already pointed at the fake bus plus a fake
 * NetworkManager and a canned USB enumeration.
 */
export function createStackContext(
	options: GlobalOptions,
	deps: StackContextDeps = {},
): StackContext {
	const busAddress = resolveBusAddress(options);
	const ownsTransport = deps.transport === undefined;
	const transport = deps.transport ?? createDbusTransport({ busAddress });
	const backend = createMmDbusBackend(
		options.destination !== undefined
			? { transport, destination: options.destination }
			: { transport },
	);
	const nm = deps.nm ?? new NmcliNmPort({ runner: new SpawnNmcliRunner() });
	const enumerator = createUsbEnumerator();
	const enumerate = deps.enumerate ?? (() => enumerator.enumerate());
	const now = deps.now ?? Date.now;
	return {
		transport,
		backend,
		nm,
		destination: options.destination ?? 'org.freedesktop.ModemManager1',
		interlock: ALLOW_ALL_INTERLOCK,
		enumerate,
		now,
		async close(): Promise<void> {
			await backend.stop().catch(() => undefined);
			// Only disconnect a transport this context created; an injected one is the
			// caller's to close (the test owns its lifecycle).
			if (ownsTransport) {
				await transport.disconnect().catch(() => undefined);
			}
		},
	};
}
