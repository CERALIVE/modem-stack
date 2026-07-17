// Characterization tests for the transport seam's reconnect / call-correlation / ordering
// edges — the behaviour that a later refactor (splitting transport.ts into lifecycle,
// call-dispatch, and signal modules) MUST preserve byte-for-byte at the observable level.
//
// These pin CURRENT behaviour, not aspirational behaviour: each assertion records what the
// unsplit transport.ts actually does today. If the split changes any of these observable
// facts, one of these tests goes red — which is the whole point.
//
// Like reliability.test.ts, these run against dedicated private `dbus-daemon` instances
// (each test owns one) so a destructive kill/restart is safe. That also makes the file
// self-contained — it needs no outer `dbus-run-session`.

import { describe, expect, test } from 'bun:test';
import { createDbusTransport } from './index';
import { FAKE_IFACE, FAKE_PATH, startFakeService, TICK_MEMBER } from './test-support/fake-service';
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

describe.skipIf(!HAS_DBUS_DAEMON)('transport characterization', () => {
	// (i) A call that times out, then the real reply lands AFTER the timeout already
	// settled the promise. The late reply must be silently ignored (each `bus.invoke`
	// owns its own reply closure, guarded by a `done` flag) — no crash, and no
	// mis-correlation onto a later, unrelated call.
	test('a reply arriving after the call already timed out is silently ignored', async () => {
		const bus = new PrivateBus();
		await bus.start();
		const fake = await startFakeService({ socket: bus.socket });
		const transport = createDbusTransport({ socket: bus.socket, reconnect: { enabled: false } });
		let errorEvents = 0;
		transport.on('error', () => {
			errorEvents += 1;
		});
		await transport.connect();

		// SlowPing replies after 400ms; the call's own timeout is 100ms, so it times out
		// first and the reply becomes a "late" one 300ms later.
		await expect(
			transport.callMethod({
				destination: fake.busName,
				path: FAKE_PATH,
				interface: FAKE_IFACE,
				member: 'SlowPing',
				signature: 'u',
				args: [400],
				timeoutMs: 100,
			}),
		).rejects.toThrow('timed out after 100ms');

		// Wait well past the 400ms reply so the ignored late reply has actually been
		// delivered to (and dropped by) the settled callback.
		await sleep(500);

		// No crash, no error event, still connected — the late reply disturbed nothing.
		expect(errorEvents).toBe(0);
		expect(transport.isConnected()).toBe(true);

		// And the pending machinery is intact: a fresh call correlates to its OWN reply,
		// proving the late reply was not mis-delivered to a later promise.
		const reply = await transport.callMethod({
			destination: fake.busName,
			path: FAKE_PATH,
			interface: FAKE_IFACE,
			member: 'Ping',
		});
		expect(reply.body[0]).toBe('pong');

		await transport.disconnect();
		await fake.stop();
		await bus.stop();
	});

	// (ii) A bus drop while a call is in flight. The in-flight call must reject, and the
	// observed ordering is pinned: the `disconnected` event is delivered BEFORE the call
	// rejection is observed. (In `#handleDrop`, pending calls are rejected and then
	// `disconnected` is emitted synchronously — but a promise rejection is observed on a
	// microtask, so the synchronous event listener runs first.)
	test('a mid-call bus drop rejects the in-flight call after emitting disconnected', async () => {
		const bus = new PrivateBus();
		await bus.start();
		const fake = await startFakeService({ socket: bus.socket });
		const transport = createDbusTransport({ socket: bus.socket, reconnect: { enabled: false } });

		const order: string[] = [];
		let rejection: unknown = null;
		transport.on('disconnected', () => order.push('disconnected'));
		await transport.connect();

		// A call that will never get a reply — the bus dies under it.
		const call = transport
			.callMethod({
				destination: fake.busName,
				path: FAKE_PATH,
				interface: FAKE_IFACE,
				member: 'SlowPing',
				signature: 'u',
				args: [5000],
			})
			.catch((error: unknown) => {
				order.push('call-rejected');
				rejection = error;
			});

		// Give the call time to reach the wire, then drop the bus under it.
		await sleep(30);
		bus.kill();

		await waitFor(
			() => order.includes('disconnected') && order.includes('call-rejected'),
			5000,
			'disconnected + call rejection',
		);
		await call;

		// Pinned ordering: the event precedes the observed rejection.
		expect(order).toEqual(['disconnected', 'call-rejected']);
		// Pinned rejection type: a DisconnectedError (the connection-end drop cause).
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).name).toBe('DisconnectedError');

		await transport.disconnect();
		// The fake died with its bus; stopping it would write to a closed stream. Leave it.
		await bus.stop();
	});

	// (iii) A drop that arrives while a reconnect is already running. The reconnect loop is
	// idempotent: `#handleDrop` early-returns whenever the state is already `disconnected`
	// or `reconnecting`, so repeated low-level drop signals never spawn a second reconnect
	// loop. The transport converges to a single connected state — exactly one `disconnected`
	// and one `reconnected`, no error, and it is not wedged.
	test('a drop during an in-flight reconnect does not double-schedule or wedge', async () => {
		const bus = new PrivateBus();
		await bus.start();
		let fake = await startFakeService({ socket: bus.socket });
		const transport = createDbusTransport({
			socket: bus.socket,
			reconnect: { initialDelayMs: 25, maxDelayMs: 100 },
		});

		const events: string[] = [];
		let errorEvents = 0;
		transport.on('disconnected', () => events.push('disconnected'));
		transport.on('reconnected', () => events.push('reconnected'));
		transport.on('error', () => {
			errorEvents += 1;
		});
		await transport.connect();

		const ticks: bigint[] = [];
		const subscription = await transport.subscribeSignal(tickSpec, (event) => {
			ticks.push(event.body[0] as bigint);
		});

		fake.emitTick(11n);
		await waitFor(() => ticks.includes(11n), 3000, 'pre-drop tick');

		// Drop the bus and leave it down long enough for the reconnect loop to spin through
		// several failed establish attempts before the bus returns.
		bus.kill();
		await waitFor(() => events.includes('disconnected'), 5000, 'disconnected');
		await sleep(150);
		await bus.start();
		await waitFor(() => events.includes('reconnected'), 15000, 'reconnected');

		// A settle window to catch any spurious extra event from a double-scheduled loop.
		await sleep(300);

		expect(events.filter((event) => event === 'disconnected')).toHaveLength(1);
		expect(events.filter((event) => event === 'reconnected')).toHaveLength(1);
		expect(errorEvents).toBe(0);

		// Not wedged: a fresh producer's signal flows through the auto-resubscribed rule.
		fake = await startFakeService({ socket: bus.socket });
		fake.emitTick(22n);
		await waitFor(() => ticks.includes(22n), 8000, 'post-reconnect tick');
		expect(transport.subscriptionCount()).toBe(1);

		await subscription.unsubscribe();
		await transport.disconnect();
		await fake.stop();
		await bus.stop();
	}, 30000);

	// (iv) A subscription added AND one removed while a reconnect is in progress. Because
	// mutating a subscription while disconnected only touches the in-memory match-rule
	// refcount (the bus call is skipped when not connected), and `#establish()` re-issues
	// every live rule on reconnect, the refcounting must end up correct: the added
	// subscription is registered (receives signals) and the removed one is not.
	test('subscriptions mutated during reconnect end up correctly (un)registered', async () => {
		const bus = new PrivateBus();
		await bus.start();
		const transport = createDbusTransport({
			socket: bus.socket,
			reconnect: { initialDelayMs: 25, maxDelayMs: 100 },
		});

		const events: string[] = [];
		transport.on('disconnected', () => events.push('disconnected'));
		transport.on('reconnected', () => events.push('reconnected'));
		await transport.connect();

		// `removed` is a path-filtered rule; `added` is a distinct (no-path) rule that still
		// matches the same emitted Tick — so their match-rule strings differ and are tracked
		// independently.
		const removedTicks: bigint[] = [];
		const addedTicks: bigint[] = [];
		const removed = await transport.subscribeSignal(tickSpec, (event) => {
			removedTicks.push(event.body[0] as bigint);
		});
		expect(transport.subscriptionCount()).toBe(1);

		// Drop the bus; while the reconnect loop is running, mutate the subscription set.
		bus.kill();
		await waitFor(() => events.includes('disconnected'), 5000, 'disconnected');

		await removed.unsubscribe();
		const added = await transport.subscribeSignal(
			{ interface: FAKE_IFACE, member: TICK_MEMBER },
			(event) => {
				addedTicks.push(event.body[0] as bigint);
			},
		);
		expect(transport.subscriptionCount()).toBe(1);

		// Bring the bus back; `#establish()` re-issues exactly the rules still in the
		// refcount map — the `added` one, not the `removed` one.
		await bus.start();
		await waitFor(() => events.includes('reconnected'), 15000, 'reconnected');

		const fake = await startFakeService({ socket: bus.socket });
		fake.emitTick(33n);
		await waitFor(() => addedTicks.includes(33n), 8000, 'added-subscription tick');

		// Grace to prove the removed subscription genuinely receives nothing.
		await sleep(200);
		expect(addedTicks).toEqual([33n]);
		expect(removedTicks).toEqual([]);
		expect(transport.subscriptionCount()).toBe(1);

		await added.unsubscribe();
		await transport.disconnect();
		await fake.stop();
		await bus.stop();
	}, 30000);
});
