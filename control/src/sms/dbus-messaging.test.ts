// The Messaging adapter, driven over a fake transport.
//
// The claims under test are the ones that only show up against a live bus: the
// inbox is listed ONCE and never re-listed on a tick, an arrival reaches the
// consumer through the `Added` signal, a message that vanished between the list
// and its read is skipped rather than failing the whole inbox, and a reconnect
// republishes an authoritative list instead of a stream of Added events.

import { describe, expect, test } from 'bun:test';
import type { SmsInboxEvent } from '../ports/sms';
import type {
	DbusTransport,
	DbusValue,
	MethodCall,
	MethodReply,
	SignalListener,
	SignalSpec,
	Subscription,
	TransportEvent,
} from '../transport';
import { createDbusSmsPort, smsFromProps } from './dbus-messaging';
import { createSmsInboxStore } from './inbox-store';

const MODEM = '/org/freedesktop/ModemManager1/Modem/0';
const variant = (signature: string, value: DbusValue): DbusValue => ({ signature, value });

const props = (over: Record<string, DbusValue> = {}): DbusValue =>
	Object.entries({
		State: variant('u', 3),
		Number: variant('s', '85573'),
		Text: variant('s', 'neutral body'),
		Timestamp: variant('s', '2025-08-21T17:20:16-05'),
		...over,
	}).map(([key, value]) => [key, value] as unknown as DbusValue);

interface FakeBus {
	readonly transport: DbusTransport;
	readonly calls: MethodCall[];
	inbox: string[];
	missing: Set<string>;
	listError?: Error;
	emitSignal(member: string, body: DbusValue[]): void;
	emitReconnect(): void;
	subscriptions: number;
}

function fakeBus(): FakeBus {
	const calls: MethodCall[] = [];
	const listeners = new Map<string, Set<SignalListener>>();
	const handlers = new Map<TransportEvent, Set<(payload?: unknown) => void>>();
	const bus: FakeBus = {
		calls,
		inbox: [],
		missing: new Set<string>(),
		subscriptions: 0,
		transport: {
			async connect(): Promise<void> {},
			async disconnect(): Promise<void> {},
			isConnected: () => true,
			async callMethod(call: MethodCall): Promise<MethodReply> {
				calls.push(call);
				if (call.member === 'List') {
					if (bus.listError !== undefined) {
						throw bus.listError;
					}
					return { signature: 'ao', body: [bus.inbox as unknown as DbusValue] };
				}
				if (bus.missing.has(call.path)) {
					throw new Error('No such object');
				}
				return { signature: 'a{sv}', body: [props()] };
			},
			async subscribeSignal(spec: SignalSpec, listener: SignalListener): Promise<Subscription> {
				const key = spec.member;
				const set = listeners.get(key) ?? new Set<SignalListener>();
				set.add(listener);
				listeners.set(key, set);
				bus.subscriptions += 1;
				return {
					async unsubscribe(): Promise<void> {
						set.delete(listener);
						bus.subscriptions -= 1;
					},
				};
			},
			on(event: TransportEvent, handler: (payload?: unknown) => void): void {
				const set = handlers.get(event) ?? new Set<(payload?: unknown) => void>();
				set.add(handler);
				handlers.set(event, set);
			},
			off(event: TransportEvent, handler: (payload?: unknown) => void): void {
				handlers.get(event)?.delete(handler);
			},
			subscriptionCount: () => bus.subscriptions,
		} as unknown as DbusTransport,
		emitSignal(member: string, body: DbusValue[]): void {
			for (const listener of listeners.get(member) ?? []) {
				listener({
					path: MODEM,
					interface: 'org.freedesktop.ModemManager1.Modem.Messaging',
					member,
					sender: undefined,
					signature: 'ob',
					body,
				});
			}
		},
		emitReconnect(): void {
			for (const handler of handlers.get('reconnected') ?? []) {
				handler();
			}
		},
	};
	return bus;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('smsFromProps', () => {
	test('maps MMSmsState by ordinal and keeps the raw timestamp', () => {
		const message = smsFromProps(
			'/org/freedesktop/ModemManager1/SMS/36',
			props() as unknown as never,
		);
		expect(message).toEqual({
			id: '36',
			from: '85573',
			text: 'neutral body',
			timestamp: '2025-08-21T17:20:16-05',
			state: 'received',
		});
	});

	test('an out-of-range state ordinal folds to `unknown`, never a number', () => {
		const message = smsFromProps(
			'/org/freedesktop/ModemManager1/SMS/1',
			props({ State: variant('u', 99) }) as unknown as never,
		);
		expect(message.state).toBe('unknown');
	});

	test('an absent body reports `` rather than dropping the field', () => {
		const message = smsFromProps(
			'/org/freedesktop/ModemManager1/SMS/1',
			props({ Text: variant('s', '') }) as unknown as never,
		);
		expect(message.text).toBe('');
		expect(message.from).toBe('85573');
	});
});

describe('list()', () => {
	test('reads every message once, newest first', async () => {
		const bus = fakeBus();
		bus.inbox = ['/org/freedesktop/ModemManager1/SMS/1', '/org/freedesktop/ModemManager1/SMS/2'];
		const port = createDbusSmsPort({ transport: bus.transport, modemPath: MODEM });

		const result = await port.list();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages.map((entry) => entry.id)).toEqual(['2', '1']);
		}
		expect(bus.calls.filter((call) => call.member === 'List')).toHaveLength(1);
		expect(bus.calls.filter((call) => call.member === 'GetAll')).toHaveLength(2);
	});

	test('a message that vanished between list and read is SKIPPED', async () => {
		const bus = fakeBus();
		bus.inbox = ['/org/freedesktop/ModemManager1/SMS/1', '/org/freedesktop/ModemManager1/SMS/2'];
		bus.missing.add('/org/freedesktop/ModemManager1/SMS/2');
		const port = createDbusSmsPort({ transport: bus.transport, modemPath: MODEM });

		const result = await port.list();
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.messages.map((entry) => entry.id)).toEqual(['1']);
		}
	});

	test('a failed LIST is a typed refusal, never an empty inbox', async () => {
		const bus = fakeBus();
		bus.listError = new Error('error: modem has no messaging capabilities');
		const port = createDbusSmsPort({ transport: bus.transport, modemPath: MODEM });

		const result = await port.list();
		expect(result).toEqual({ ok: false, reason: 'unsupported' });
	});

	test('the read is bounded BEFORE any per-message call', async () => {
		const bus = fakeBus();
		bus.inbox = Array.from(
			{ length: 120 },
			(_, index) => `/org/freedesktop/ModemManager1/SMS/${index}`,
		);
		const port = createDbusSmsPort({ transport: bus.transport, modemPath: MODEM });

		const result = await port.list();
		expect(result.ok && result.messages).toHaveLength(50);
		expect(bus.calls.filter((call) => call.member === 'GetAll')).toHaveLength(50);
	});
});

describe('observe() — signals, never a poll', () => {
	test('an arrival reaches the consumer through Added', async () => {
		const bus = fakeBus();
		const port = createDbusSmsPort({ transport: bus.transport, modemPath: MODEM });
		const seen: SmsInboxEvent[] = [];
		port.observe((event) => seen.push(event));
		await settle();

		bus.emitSignal('Added', ['/org/freedesktop/ModemManager1/SMS/9', true]);
		await settle();

		expect(seen.filter((event) => event.kind === 'added')).toHaveLength(1);
		await port.stop();
	});

	test('Deleted names the retired row by index', async () => {
		const bus = fakeBus();
		const port = createDbusSmsPort({ transport: bus.transport, modemPath: MODEM });
		const seen: SmsInboxEvent[] = [];
		port.observe((event) => seen.push(event));
		await settle();

		bus.emitSignal('Deleted', ['/org/freedesktop/ModemManager1/SMS/9']);
		await settle();

		expect(seen).toContainEqual({ kind: 'deleted', id: '9' });
		await port.stop();
	});

	test('observing NEVER re-lists on its own — only wiring and reconnects list', async () => {
		const bus = fakeBus();
		bus.inbox = ['/org/freedesktop/ModemManager1/SMS/1'];
		const port = createDbusSmsPort({ transport: bus.transport, modemPath: MODEM });
		port.observe(() => undefined);
		await settle();

		const afterWiring = bus.calls.filter((call) => call.member === 'List').length;
		bus.emitSignal('Added', ['/org/freedesktop/ModemManager1/SMS/2', true]);
		bus.emitSignal('Deleted', ['/org/freedesktop/ModemManager1/SMS/1']);
		await settle();

		expect(bus.calls.filter((call) => call.member === 'List')).toHaveLength(afterWiring);
		await port.stop();
	});

	test('a reconnect resyncs — and the store does not double the inbox', async () => {
		const bus = fakeBus();
		bus.inbox = ['/org/freedesktop/ModemManager1/SMS/1', '/org/freedesktop/ModemManager1/SMS/2'];
		const port = createDbusSmsPort({ transport: bus.transport, modemPath: MODEM });
		const store = createSmsInboxStore();
		port.observe((event) => store.apply(event));
		await settle();
		expect(store.size()).toBe(2);

		bus.emitReconnect();
		await settle();

		expect(store.size()).toBe(2);
		await port.stop();
	});

	test('stop() releases every subscription and detaches the reconnect handler', async () => {
		const bus = fakeBus();
		const port = createDbusSmsPort({ transport: bus.transport, modemPath: MODEM });
		port.observe(() => undefined);
		await settle();
		expect(bus.subscriptions).toBe(2);

		await port.stop();
		expect(bus.subscriptions).toBe(0);

		const before = bus.calls.length;
		bus.emitReconnect();
		await settle();
		expect(bus.calls).toHaveLength(before);
	});
});
