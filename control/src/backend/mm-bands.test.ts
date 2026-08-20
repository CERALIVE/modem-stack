import { describe, expect, it } from 'bun:test';

import type { ModemRef } from '../ports';
import type { DbusTransport, MethodCall, MethodReply } from '../transport';
import { variant } from '../transport';
import { MODEM_IFACE } from './constants';
import { MmMutations } from './mm-mutations';
import { ModemActor } from './modem-actor';

const MODEM = '/org/freedesktop/ModemManager1/Modem/0' as ModemRef;

// One managed-objects tree carrying the RM530N-GL-shaped band properties, in the
// `au` encoding `GetManagedObjects` really returns them in.
function tree(supported: number[], current: number[]): unknown {
	return [
		[
			MODEM,
			[
				[
					MODEM_IFACE,
					[
						['SupportedBands', variant('au', supported)],
						['CurrentBands', variant('au', current)],
					],
				],
			],
		],
	];
}

interface Harness {
	readonly transport: DbusTransport;
	readonly calls: MethodCall[];
}

function harness(options: {
	readonly managed?: unknown;
	readonly setFails?: Error;
	readonly getFails?: Error;
}): Harness {
	const calls: MethodCall[] = [];
	const transport = {
		connect: () => Promise.resolve(),
		disconnect: () => Promise.resolve(),
		isConnected: () => true,
		callMethod: (call: MethodCall): Promise<MethodReply> => {
			calls.push(call);
			if (call.member === 'GetManagedObjects') {
				if (options.getFails !== undefined) return Promise.reject(options.getFails);
				return Promise.resolve({ body: [options.managed ?? []] } as unknown as MethodReply);
			}
			if (options.setFails !== undefined) return Promise.reject(options.setFails);
			return Promise.resolve({ body: [] } as unknown as MethodReply);
		},
		subscribeSignal: () => Promise.reject(new Error('unused')),
		on: () => undefined,
		off: () => undefined,
		subscriptionCount: () => 0,
	} as unknown as DbusTransport;
	return { transport, calls };
}

function mutations(h: Harness): MmMutations {
	return new MmMutations({
		transport: h.transport,
		actor: new ModemActor(),
		resolveStableKey: () => 'stable-0',
	});
}

describe('readBands', () => {
	it('decodes SupportedBands and CurrentBands off the real property shape', async () => {
		const h = harness({ managed: tree([31, 33, 37, 378], [256]) });
		const result = await mutations(h).readBands(MODEM);
		expect(result).toEqual({
			ok: true,
			bands: {
				supported: ['eutran-1', 'eutran-3', 'eutran-7', 'ngran-78'],
				current: ['any'],
			},
		});
	});

	it('reports an EMPTY supported set as a real reading, not a failure', async () => {
		const h = harness({ managed: tree([], []) });
		const result = await mutations(h).readBands(MODEM);
		expect(result).toEqual({ ok: true, bands: { supported: [], current: [] } });
	});

	it('reports a modem with no Modem interface as a FAILED read', async () => {
		const h = harness({ managed: [] });
		const result = await mutations(h).readBands(MODEM);
		expect(result.ok).toBe(false);
	});

	it('never throws when the bus call fails', async () => {
		const h = harness({ getFails: new Error('bus is gone') });
		const result = await mutations(h).readBands(MODEM);
		expect(result).toEqual({ ok: false, reason: 'reading bands failed: bus is gone' });
	});
});

describe('setCurrentBands', () => {
	it('calls Modem.SetCurrentBands with the `au` values, on the modem object', async () => {
		const h = harness({});
		const result = await mutations(h).setCurrentBands(MODEM, ['eutran-3', 'ngran-78']);
		expect(result.status).toBe('applied');
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]).toMatchObject({
			path: MODEM,
			interface: MODEM_IFACE,
			member: 'SetCurrentBands',
			signature: 'au',
			args: [[33, 378]],
		});
	});

	it('releases the lock by setting exactly `any` — MM has no reset verb', async () => {
		const h = harness({});
		const result = await mutations(h).setCurrentBands(MODEM, ['any']);
		expect(result).toEqual({
			dimension: 'band',
			status: 'applied',
			reason: 'band lock released',
		});
		expect(h.calls[0]).toMatchObject({ args: [[256]] });
	});

	it('DISPATCHES NOTHING for a band this build cannot place', async () => {
		const h = harness({});
		const result = await mutations(h).setCurrentBands(MODEM, ['eutran-3', 'nonsense']);
		expect(result.status).toBe('unsupported');
		expect(h.calls).toHaveLength(0);
	});

	it('dispatches nothing for an empty selection', async () => {
		const h = harness({});
		const result = await mutations(h).setCurrentBands(MODEM, []);
		expect(result.status).toBe('failed');
		expect(h.calls).toHaveLength(0);
	});

	it('reports a refused write as failed rather than throwing', async () => {
		const h = harness({
			setFails: new Error('org.freedesktop.ModemManager1.Error.Core.Unsupported'),
		});
		const result = await mutations(h).setCurrentBands(MODEM, ['eutran-3']);
		expect(result.status).toBe('failed');
		expect(result.reason).toContain('SetCurrentBands failed');
	});
});
