// Lifecycle tests for the transport seam: cancellable reconnect backoff, observable teardown
// failures, and the unified timing policy.
//
// Unlike reliability.test.ts and characterization.test.ts, these drive an INJECTED fake bus
// rather than a private `dbus-daemon`. The paths under test are exactly the ones a real daemon
// cannot be made to take on demand — a `bus.disconnect()` that rejects, a `connection.end()`
// that throws, a handshake that never completes — and a timing assertion measured against a
// live socket would be a flake generator. Nothing here needs `dbus-run-session`, so these run
// on every machine rather than skipping where the daemon is absent.

import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type {
	CreateClientOptions,
	RawBus,
	RawConnection,
	RawMessage,
	ReplyCallback,
} from './dbus-native';
import type { BusFactory } from './transport';
import {
	createDbusTransportForTest,
	DEFAULT_TRANSPORT_TIMING,
	TransportTeardownFailure,
} from './transport';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await sleep(5);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

// `stall` never resolves the handshake either way, which is the only way to reach the connect
// timeout without waiting on a real socket.
type HandshakeOutcome = 'succeed' | 'fail' | 'stall';

interface FakeBusBehaviour {
	readonly handshake: HandshakeOutcome;
	readonly endThrows?: boolean;
	readonly disconnectRejects?: boolean;
}

// A real EventEmitter underneath, so `listenerCount` is a measurement rather than a fixture —
// that is what makes the leak assertions mean anything.
class FakeConnection implements RawConnection {
	readonly #emitter = new EventEmitter();
	readonly #endThrows: boolean;
	endCalls = 0;

	constructor(endThrows: boolean) {
		this.#endThrows = endThrows;
		this.#emitter.setMaxListeners(0);
	}

	on(event: string, handler: (...args: unknown[]) => void): void {
		this.#emitter.on(event, handler);
	}

	once(event: string, handler: (...args: unknown[]) => void): void {
		this.#emitter.once(event, handler);
	}

	removeListener(event: string, handler: (...args: unknown[]) => void): void {
		this.#emitter.removeListener(event, handler);
	}

	removeAllListeners(event?: string): void {
		this.#emitter.removeAllListeners(event);
	}

	listenerCount(event: string): number {
		return this.#emitter.listenerCount(event);
	}

	end(): void {
		this.endCalls += 1;
		if (this.#endThrows) {
			throw new Error('fake connection.end() failed');
		}
	}

	emit(event: string, ...args: unknown[]): void {
		this.#emitter.emit(event, ...args);
	}
}

class FakeBus implements RawBus {
	readonly connection: FakeConnection;
	readonly matches: string[] = [];
	readonly #behaviour: FakeBusBehaviour;
	disconnectCalls = 0;
	invokes = 0;

	constructor(behaviour: FakeBusBehaviour) {
		this.#behaviour = behaviour;
		this.connection = new FakeConnection(behaviour.endThrows ?? false);
	}

	// The transport attaches its handshake listeners synchronously in a Promise executor that
	// runs after the factory returns, so the outcome must be deferred by at least a macrotask.
	arm(): void {
		setTimeout(() => {
			if (this.#behaviour.handshake === 'succeed') {
				this.connection.emit('connect');
			} else if (this.#behaviour.handshake === 'fail') {
				this.connection.emit('error', new Error('fake handshake refused'));
			}
		}, 0);
	}

	// A call that never gets a reply — the per-call timeout is what the policy test measures.
	invoke(_message: RawMessage, _callback: ReplyCallback): void {
		this.invokes += 1;
	}

	async addMatch(rule: string): Promise<unknown> {
		this.matches.push(rule);
		return undefined;
	}

	async removeMatch(_rule: string): Promise<unknown> {
		return undefined;
	}

	async disconnect(): Promise<void> {
		this.disconnectCalls += 1;
		if (this.#behaviour.disconnectRejects === true) {
			throw new Error('fake bus.disconnect() failed');
		}
	}
}

interface ScriptedBuses {
	readonly factory: BusFactory;
	readonly buses: FakeBus[];
}

// The last behaviour repeats, so a script's tail describes "and every reconnect attempt after
// that", which is what the backoff tests need.
function scriptedBuses(script: readonly FakeBusBehaviour[]): ScriptedBuses {
	const buses: FakeBus[] = [];
	const factory: BusFactory = (_options: CreateClientOptions): RawBus => {
		const behaviour = script[Math.min(buses.length, script.length - 1)];
		if (behaviour === undefined) {
			throw new Error('scriptedBuses called with an empty script');
		}
		const bus = new FakeBus(behaviour);
		buses.push(bus);
		bus.arm();
		return bus;
	};
	return { factory, buses };
}

function teardownReports(transport: {
	on(event: 'error', handler: (payload?: unknown) => void): void;
}): TransportTeardownFailure[] {
	const reports: TransportTeardownFailure[] = [];
	transport.on('error', (payload) => {
		if (payload instanceof TransportTeardownFailure) {
			reports.push(payload);
		}
	});
	return reports;
}

test('disconnect() during reconnect backoff resolves promptly instead of waiting the delay out', async () => {
	const { factory, buses } = scriptedBuses([{ handshake: 'succeed' }, { handshake: 'fail' }]);
	const transport = createDbusTransportForTest(
		{
			reconnect: { initialDelayMs: 30_000, maxDelayMs: 30_000 },
			timing: { connectTimeoutMs: 50 },
		},
		factory,
	);
	transport.on('error', () => undefined);
	let dropped = false;
	transport.on('disconnected', () => {
		dropped = true;
	});

	await transport.connect();
	expect(transport.isConnected()).toBe(true);

	// Drop the connection under the transport. Its first reconnect attempt fails, and the loop
	// parks in a 30s backoff — an interval no honest close should ever have to sit through.
	const first = buses[0];
	if (first === undefined) {
		throw new Error('the initial connect created no bus');
	}
	first.connection.emit('end');
	await waitFor(() => dropped && buses.length >= 2, 5_000, 'the first failed reconnect attempt');
	await sleep(50);

	const startedAt = Date.now();
	await transport.disconnect();
	const elapsedMs = Date.now() - startedAt;
	expect(elapsedMs).toBeLessThan(100);

	// And the loop is genuinely gone rather than merely unawaited: no further attempt is made.
	const attemptsAtClose = buses.length;
	await sleep(200);
	expect(buses.length).toBe(attemptsAtClose);
}, 15_000);

test('a connection.end() that throws while abandoning a failed connect is reported', async () => {
	const { factory, buses } = scriptedBuses([{ handshake: 'fail', endThrows: true }]);
	const transport = createDbusTransportForTest(
		{ reconnect: { enabled: false }, timing: { connectTimeoutMs: 50 } },
		factory,
	);
	const reports = teardownReports(transport);

	await expect(transport.connect()).rejects.toThrow('fake handshake refused');

	expect(reports).toHaveLength(1);
	const report = reports[0];
	if (report === undefined) {
		throw new Error('no teardown report was emitted');
	}
	expect(report.phase).toBe('establish-abort');
	expect(report.step).toBe('connection-end');
	expect(report.name).toBe('TransportTeardownFailure');
	expect(report.cause).toBeInstanceOf(Error);
	expect(buses[0]?.connection.endCalls).toBe(1);
});

test('a bus.disconnect() that rejects is reported and never rejects disconnect()', async () => {
	const { factory, buses } = scriptedBuses([{ handshake: 'succeed', disconnectRejects: true }]);
	const transport = createDbusTransportForTest({ reconnect: { enabled: false } }, factory);
	const reports = teardownReports(transport);

	await transport.connect();
	await transport.disconnect();

	expect(transport.isConnected()).toBe(false);
	expect(buses[0]?.disconnectCalls).toBe(1);
	expect(reports).toHaveLength(1);
	const report = reports[0];
	if (report === undefined) {
		throw new Error('no teardown report was emitted');
	}
	expect(report.phase).toBe('disconnect');
	expect(report.step).toBe('bus-disconnect');
});

test('a teardown failure with no error listener attached does not throw', async () => {
	const { factory } = scriptedBuses([{ handshake: 'succeed', disconnectRejects: true }]);
	const transport = createDbusTransportForTest({ reconnect: { enabled: false } }, factory);

	await transport.connect();
	// Node re-throws an unobserved EventEmitter 'error'. A report about a failed teardown must
	// not become the crash it is describing.
	await transport.disconnect();
	expect(transport.isConnected()).toBe(false);
});

test('the new teardown failure paths leak no connection listener', async () => {
	const { factory, buses } = scriptedBuses([
		{ handshake: 'succeed', disconnectRejects: true },
		{ handshake: 'fail', endThrows: true },
	]);
	const transport = createDbusTransportForTest(
		{
			reconnect: { initialDelayMs: 20_000, maxDelayMs: 20_000 },
			timing: { connectTimeoutMs: 50 },
		},
		factory,
	);
	transport.on('error', () => undefined);
	let dropped = false;
	transport.on('disconnected', () => {
		dropped = true;
	});

	await transport.connect();
	const subscription = await transport.subscribeSignal(
		{ interface: 'tv.ceralive.Fake', member: 'Tick' },
		() => undefined,
	);

	const first = buses[0];
	if (first === undefined) {
		throw new Error('the initial connect created no bus');
	}
	first.connection.emit('end');
	await waitFor(() => dropped && buses.length >= 2, 5_000, 'the failed reconnect attempt');
	await sleep(50);

	await subscription.unsubscribe();
	await transport.disconnect();

	expect(transport.subscriptionCount()).toBe(0);
	expect(buses).toHaveLength(2);
	for (const bus of buses) {
		expect(bus.connection.listenerCount('message')).toBe(0);
		expect(bus.connection.listenerCount('end')).toBe(0);
		expect(bus.connection.listenerCount('connect')).toBe(0);
		// Exactly one listener survives on each abandoned connection: the deliberate swallow the
		// transport installs so a late socket error cannot crash the process.
		expect(bus.connection.listenerCount('error')).toBe(1);
	}
});

test('repeated drop signals produce one disconnected event and one reconnect loop', async () => {
	const { factory, buses } = scriptedBuses([{ handshake: 'succeed' }, { handshake: 'fail' }]);
	const transport = createDbusTransportForTest(
		{
			reconnect: { initialDelayMs: 20_000, maxDelayMs: 20_000 },
			timing: { connectTimeoutMs: 50 },
		},
		factory,
	);
	transport.on('error', () => undefined);
	let disconnects = 0;
	transport.on('disconnected', () => {
		disconnects += 1;
	});

	await transport.connect();
	const first = buses[0];
	if (first === undefined) {
		throw new Error('the initial connect created no bus');
	}
	first.connection.emit('end');
	first.connection.emit('error', new Error('a second drop signal'));
	first.connection.emit('end');

	await waitFor(() => buses.length >= 2, 5_000, 'the single reconnect attempt');
	await sleep(150);

	expect(disconnects).toBe(1);
	// Two loops would each be establishing against the same script, so a second attempt would
	// show up as a third bus well inside the 20s backoff.
	expect(buses).toHaveLength(2);

	await transport.disconnect();
});

test('the timing policy keeps the values this transport has always used', () => {
	expect(DEFAULT_TRANSPORT_TIMING.connectTimeoutMs).toBe(2_000);
	expect(DEFAULT_TRANSPORT_TIMING.callTimeoutMs).toBe(30_000);
});

test('an injected connect bound is the one the handshake enforces', async () => {
	const { factory } = scriptedBuses([{ handshake: 'stall' }]);
	const transport = createDbusTransportForTest(
		{ reconnect: { enabled: false }, timing: { connectTimeoutMs: 40 } },
		factory,
	);
	transport.on('error', () => undefined);

	await expect(transport.connect()).rejects.toThrow('bus connect timed out after 40ms');

	await transport.disconnect();
});

test('an injected call bound reaches the call dispatcher', async () => {
	const { factory } = scriptedBuses([{ handshake: 'succeed' }]);
	const transport = createDbusTransportForTest(
		{ reconnect: { enabled: false }, timing: { callTimeoutMs: 40 } },
		factory,
	);

	await transport.connect();
	await expect(
		transport.callMethod({
			destination: 'tv.ceralive.Fake',
			path: '/tv/ceralive/Fake',
			interface: 'tv.ceralive.Fake',
			member: 'Ping',
		}),
	).rejects.toThrow('timed out after 40ms');

	await transport.disconnect();
});

test('the standalone callTimeoutMs option still applies when no timing policy is given', async () => {
	const { factory } = scriptedBuses([{ handshake: 'succeed' }]);
	const transport = createDbusTransportForTest(
		{ reconnect: { enabled: false }, callTimeoutMs: 40 },
		factory,
	);

	await transport.connect();
	await expect(
		transport.callMethod({
			destination: 'tv.ceralive.Fake',
			path: '/tv/ceralive/Fake',
			interface: 'tv.ceralive.Fake',
			member: 'Ping',
		}),
	).rejects.toThrow('timed out after 40ms');

	await transport.disconnect();
});
