// Minimal fake D-Bus service built on the SAME `@httptoolkit/dbus-native` library, for
// the half-(a) conformance tests. It is deliberately tiny — a handful of echo/describe
// methods and one signal — NOT the MM-faithful object model (root ObjectManager, Modem /
// Modem3gpp interfaces, SIM objects, bearer tripwires); that richer fake is task A2.3.
//
// The service runs with `ReturnLongjs: true` so 64-bit values it receives survive as
// Long objects and re-marshal losslessly on echo. Decode-direction methods return fixed,
// hand-built values in the library's native encode shape; encode-direction methods report
// back a canonical string of what they received, so the tests never depend on this
// transport's own codec to judge it.

import * as dbusNativeModule from '@httptoolkit/dbus-native';

export const FAKE_BUS_NAME = 'tv.ceralive.ModemStackFake';
export const FAKE_PATH = '/tv/ceralive/fake';
export const FAKE_IFACE = 'tv.ceralive.ModemStackFake.Conformance';
export const TICK_MEMBER = 'Tick';

export const INT64_MAX = 2n ** 63n - 1n;
export const UINT64_MAX = 2n ** 64n - 1n;

type MethodImpl = (...args: unknown[]) => unknown;

interface FakeBus {
	connection: {
		on(event: string, handler: (...args: unknown[]) => void): void;
		once(event: string, handler: (...args: unknown[]) => void): void;
		removeListener(event: string, handler: (...args: unknown[]) => void): void;
	};
	requestName(name: string, flags: number): Promise<unknown>;
	setMethodCallHandler(
		path: string,
		iface: string,
		member: string,
		handler: [MethodImpl, string],
	): void;
	sendSignal(path: string, iface: string, member: string, signature: string, args: unknown[]): void;
	disconnect(): Promise<void>;
}

interface FakeModule {
	createClient(options: { busAddress?: string; socket?: string; ReturnLongjs?: boolean }): FakeBus;
}

const fakeModule = ((dbusNativeModule as { default?: unknown }).default ??
	dbusNativeModule) as unknown as FakeModule;

// Fixed GetManagedObjects reply in library-native encode shape: object path → interface
// name → property name → variant [signature, value]. Exercises the real MM
// `a{oa{sa{sv}}}` nesting plus a 64-bit variant (t = 2^64-1) and a string variant.
function managedObjectsValue(): unknown {
	return [
		[
			'/org/freedesktop/ModemManager1/Modem/0',
			[
				[
					'org.freedesktop.ModemManager1.Modem',
					[
						['SupportedCapabilities', ['t', UINT64_MAX.toString()]],
						['SignalQuality', ['u', 87]],
						['DeviceIdentifier', ['s', 'fake-device-0']],
					],
				],
			],
		],
	];
}

export interface FakeService {
	readonly busName: string;
	emitTick(seq: bigint): void;
	stop(): Promise<void>;
}

export interface FakeServiceOptions {
	readonly busAddress?: string;
	readonly socket?: string;
}

export async function startFakeService(options: FakeServiceOptions): Promise<FakeService> {
	const clientOptions: { busAddress?: string; socket?: string; ReturnLongjs?: boolean } = {
		ReturnLongjs: true,
	};
	if (options.socket !== undefined) {
		clientOptions.socket = options.socket;
	} else if (options.busAddress !== undefined) {
		clientOptions.busAddress = options.busAddress;
	}

	const bus = fakeModule.createClient(clientOptions);

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

	// After connect, swallow late socket errors so a killed bus (reconnect test) does not
	// surface an unhandled EventEmitter 'error' from this helper's dead connection.
	bus.connection.on('error', () => undefined);

	const define = (member: string, impl: MethodImpl, resultSignature: string): void => {
		bus.setMethodCallHandler(FAKE_PATH, FAKE_IFACE, member, [impl, resultSignature]);
	};

	define('Ping', () => 'pong', 's');
	// The library awaits a Promise returned by a handler, so this replies after a delay —
	// used to prove a late reply still resolves the caller's method call.
	define(
		'SlowPing',
		(delayMs) => new Promise((resolve) => setTimeout(() => resolve('pong'), Number(delayMs))),
		's',
	);
	define('GetManagedObjects', () => managedObjectsValue(), 'a{oa{sa{sv}}}');
	define('GetInt64', () => INT64_MAX.toString(), 'x');
	define('GetUint64', () => UINT64_MAX.toString(), 't');
	// Echo re-marshals the received Long — an exact 64-bit round-trip through the daemon.
	define('EchoInt64', (value) => value, 'x');
	define('EchoUint64', (value) => value, 't');
	// Describe reports the received value's exact decimal string, judging the transport's
	// encode without re-encoding anything.
	define('DescribeInt64', (value) => String(value), 's');
	define('DescribeUint64', (value) => String(value), 's');

	await bus.requestName(FAKE_BUS_NAME, 0);

	return {
		busName: FAKE_BUS_NAME,
		emitTick(seq: bigint): void {
			bus.sendSignal(FAKE_PATH, FAKE_IFACE, TICK_MEMBER, 't', [seq.toString()]);
		},
		async stop(): Promise<void> {
			await bus.disconnect().catch(() => undefined);
		},
	};
}
