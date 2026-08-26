// The `Signal.Setup` reporting rate is INJECTED, and 5s is only what an absent
// injection resolves to.
//
// These run without a bus on purpose: the epoch lifecycle is proven against the real
// fake MM service in `test-support/signal-setup.test.ts`, and what is asserted here is
// the ARGUMENT the call carries, which a recording transport answers exactly. The
// once-per-(epoch, modem) semantics are the conformance-scale pin and are untouched.

import { describe, expect, test } from 'bun:test';
import type { DbusTransport, MethodCall, MethodReply, SignalSpec } from '../transport';
import { MODEM_IFACE } from './constants';
import type { DecodedManagedObjects } from './managed-objects';
import {
	DEFAULT_SIGNAL_INTERVAL_SECONDS,
	resolveSignalInterval,
	SignalSetupManager,
} from './signal-setup';

const SIGNAL_IFACE = `${MODEM_IFACE}.Signal`;
const MODEM_PATH = '/org/freedesktop/ModemManager1/Modem/0';

const TREE: DecodedManagedObjects = [
	[
		MODEM_PATH,
		[
			[MODEM_IFACE, []],
			[SIGNAL_IFACE, []],
		],
	],
];

function recordingTransport(): { transport: DbusTransport; calls: MethodCall[] } {
	const calls: MethodCall[] = [];
	const transport: DbusTransport = {
		connect: () => Promise.resolve(),
		disconnect: () => Promise.resolve(),
		isConnected: () => true,
		callMethod: (call: MethodCall): Promise<MethodReply> => {
			calls.push(call);
			return Promise.resolve({ signature: '', body: [] });
		},
		subscribeSignal: (_spec: SignalSpec) =>
			Promise.resolve({ unsubscribe: () => Promise.resolve() }),
		on: () => {},
		off: () => {},
		subscriptionCount: () => 0,
	};
	return { transport, calls };
}

async function setupArgs(intervalSeconds?: number): Promise<readonly unknown[]> {
	const { transport, calls } = recordingTransport();
	const manager = new SignalSetupManager({
		transport,
		...(intervalSeconds === undefined ? {} : { intervalSeconds }),
	});
	manager.applyForEpoch('epoch-1', TREE);
	await Promise.resolve();
	const setup = calls.find((call) => call.member === 'Setup');
	if (setup === undefined) {
		throw new Error('no Signal.Setup call was issued');
	}
	return setup.args ?? [];
}

describe('Signal.Setup rate injection', () => {
	test('Given no injected rate, when setup runs, then the call carries the 5s default', async () => {
		expect(DEFAULT_SIGNAL_INTERVAL_SECONDS).toBe(5);
		expect(await setupArgs()).toEqual([5]);
	});

	test('Given an injected rate, when setup runs, then the call carries THAT rate', async () => {
		expect(await setupArgs(1)).toEqual([1]);
		expect(await setupArgs(30)).toEqual([30]);
	});

	test('Given an injected rate, when the manager is constructed, then it reports the rate it will send', () => {
		const { transport } = recordingTransport();

		expect(new SignalSetupManager({ transport }).intervalSeconds).toBe(5);
		expect(new SignalSetupManager({ transport, intervalSeconds: 2 }).intervalSeconds).toBe(2);
	});

	test('Given a rate `Setup(u)` cannot carry, when resolved, then it is refused rather than marshalled', () => {
		for (const rate of [0, -1, 2.5, Number.NaN]) {
			expect(() => resolveSignalInterval(rate)).toThrow(RangeError);
		}
		expect(resolveSignalInterval(undefined)).toBe(DEFAULT_SIGNAL_INTERVAL_SECONDS);
	});

	test('Given one epoch, when applied twice, then Setup is issued ONCE per (epoch, modem)', async () => {
		const { transport, calls } = recordingTransport();
		const manager = new SignalSetupManager({ transport, intervalSeconds: 3 });

		manager.applyForEpoch('epoch-1', TREE);
		manager.applyForEpoch('epoch-1', TREE);
		await Promise.resolve();

		expect(calls.filter((call) => call.member === 'Setup')).toHaveLength(1);
	});
});
