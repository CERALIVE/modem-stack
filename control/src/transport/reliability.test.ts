// Reliability tests for the transport seam: reconnect after a bus restart, a ≥5000-event
// signal stream, late replies, and a 100-cycle subscribe/unsubscribe leak check.
//
// These run against dedicated private `dbus-daemon` instances (not the outer session
// bus): the reconnect test must kill and respawn its bus, which is only safe on a bus we
// own. That also makes this file self-contained — it needs no `dbus-run-session`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbusTransport } from './index';
import { createDbusTransport } from './index';
import {
	FAKE_IFACE,
	FAKE_PATH,
	type FakeService,
	startFakeService,
	TICK_MEMBER,
} from './test-support/fake-service';
import { PrivateBus } from './test-support/private-bus';

const HAS_DBUS_DAEMON = Bun.which('dbus-daemon') !== null;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await sleep(10);
	}
	throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
}

const tickSpec = { interface: FAKE_IFACE, member: TICK_MEMBER, path: FAKE_PATH };

describe.skipIf(!HAS_DBUS_DAEMON)('transport reliability (shared private bus)', () => {
	let bus: PrivateBus;
	let fake: FakeService;
	let transport: DbusTransport;

	beforeAll(async () => {
		bus = new PrivateBus();
		await bus.start();
		fake = await startFakeService({ socket: bus.socket });
		transport = createDbusTransport({ socket: bus.socket });
		await transport.connect();
	});

	afterAll(async () => {
		await transport.disconnect();
		await fake.stop();
		await bus.stop();
	});

	test('a late reply (reply delayed 600ms) still resolves the call correctly', async () => {
		const reply = await transport.callMethod({
			destination: fake.busName,
			path: FAKE_PATH,
			interface: FAKE_IFACE,
			member: 'SlowPing',
			signature: 'u',
			args: [600],
		});
		expect(reply.body[0]).toBe('pong');
	});

	test('a ≥5000-event signal stream is delivered completely, in order, as exact bigints', async () => {
		const total = 5000;
		const received: bigint[] = [];
		const subscription = await transport.subscribeSignal(tickSpec, (event) => {
			received.push(event.body[0] as bigint);
		});

		for (let seq = 0; seq < total; seq += 1) {
			fake.emitTick(BigInt(seq));
		}

		await waitFor(() => received.length >= total, 20_000, `${total} tick signals`);
		expect(received.length).toBe(total);
		expect(received[0]).toBe(0n);
		expect(received[total - 1]).toBe(BigInt(total - 1));
		// Order and exactness across the whole stream.
		let ordered = true;
		for (let i = 0; i < total; i += 1) {
			if (received[i] !== BigInt(i)) {
				ordered = false;
				break;
			}
		}
		expect(ordered).toBe(true);

		await subscription.unsubscribe();
	});

	test('100 subscribe/unsubscribe cycles leave no leaked listener', async () => {
		const baseline = transport.subscriptionCount();
		for (let cycle = 0; cycle < 100; cycle += 1) {
			const subscription = await transport.subscribeSignal(tickSpec, () => undefined);
			await subscription.unsubscribe();
		}
		expect(transport.subscriptionCount()).toBe(baseline);

		// Behavioural proof: after all those cycles a fresh subscriber receives each signal
		// exactly once — a leaked listener from an earlier cycle would double-deliver.
		let deliveries = 0;
		const subscription = await transport.subscribeSignal(tickSpec, () => {
			deliveries += 1;
		});
		fake.emitTick(1n);
		await waitFor(() => deliveries >= 1, 3_000, 'one tick after leak cycles');
		await sleep(100);
		expect(deliveries).toBe(1);
		await subscription.unsubscribe();
	});
});

test.skipIf(!HAS_DBUS_DAEMON)(
	'transport reconnects and resubscribes after a bus restart without a consumer-facing crash',
	async () => {
		const bus = new PrivateBus();
		await bus.start();
		let fake = await startFakeService({ socket: bus.socket });
		const transport = createDbusTransport({
			socket: bus.socket,
			reconnect: { initialDelayMs: 25, maxDelayMs: 200 },
		});

		const events: string[] = [];
		let consumerError: unknown = null;
		transport.on('disconnected', () => events.push('disconnected'));
		transport.on('reconnected', () => events.push('reconnected'));
		transport.on('error', (error) => {
			consumerError = error;
		});

		await transport.connect();

		const ticks: bigint[] = [];
		const subscription = await transport.subscribeSignal(tickSpec, (event) => {
			ticks.push(event.body[0] as bigint);
		});

		fake.emitTick(11n);
		await waitFor(() => ticks.includes(11n), 3_000, 'pre-restart tick');

		// Kill the bus mid-flight; the old fake dies with it.
		bus.kill();
		await waitFor(() => events.includes('disconnected'), 5_000, 'disconnected event');

		// Bring the bus back at the same socket; the transport must reconnect on its own.
		await bus.start();
		await waitFor(() => events.includes('reconnected'), 15_000, 'reconnected event');

		// A fresh producer on the restored bus; the transport auto-resubscribed, so its
		// signal must arrive without the caller re-subscribing.
		fake = await startFakeService({ socket: bus.socket });
		fake.emitTick(22n);
		await waitFor(() => ticks.includes(22n), 8_000, 'post-reconnect tick (resubscribe)');

		expect(events).toContain('disconnected');
		expect(events).toContain('reconnected');
		expect(ticks).toContain(11n);
		expect(ticks).toContain(22n);
		expect(consumerError).toBeNull();

		await subscription.unsubscribe();
		await transport.disconnect();
		await fake.stop();
		await bus.stop();
	},
	30_000,
);
