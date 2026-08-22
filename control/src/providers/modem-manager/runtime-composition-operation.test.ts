import { afterEach, describe, expect, test } from 'bun:test';
import type { AtCommandSender } from '../../backend';
import { deviceGeneration, physicalModemId } from '../../domain';
import { createOperationEngine } from '../../operations';
import { deviceIfname, type MutationAdmissionPort, type ResourceOwnershipPort } from '../../ports';
import { createModemControlCompositionRoot } from '../../safety';
import type { RuntimeCompositionMode } from '../../usb-mode';
import type { ProviderExecutionContext } from '../contracts';
import {
	createRuntimeCompositionOperation,
	type RuntimeCompositionOperationDeps,
} from './runtime-composition-operation';

const MODEM = physicalModemId('serial:runtime-composition');
const GENERATION = deviceGeneration(7);
const CONTEXT: ProviderExecutionContext = {
	physicalModemId: MODEM,
	generation: GENERATION,
	transport: 'modemmanager',
	passiveFacts: [],
	composition: 'qmi',
	firmware: 'fixture',
	profile: 'generic-mm',
};

const roots: Array<{ dispose(): Promise<void> }> = [];

afterEach(async () => {
	for (const root of roots.splice(0).reverse()) await root.dispose();
});

function senderFor(responses: Readonly<Record<string, string>>, calls: string[]): AtCommandSender {
	return {
		send: (command) => {
			calls.push(command);
			return Promise.resolve({ ok: true, raw: responses[command] ?? 'OK' });
		},
	};
}

function operationDeps(overrides: Partial<RuntimeCompositionOperationDeps> = {}) {
	const transportCalls: string[] = [];
	const transitionCalls: RuntimeCompositionMode[] = [];
	const deps: RuntimeCompositionOperationDeps = {
		vendor: () => 'fibocom',
		provisioningEnabled: () => true,
		blockedReason: () => undefined,
		atSender: senderFor(
			{
				'AT+GTUSBMODE?': '+GTUSBMODE: 41\r\nOK',
				'AT+GTUSBMODE=?': '+GTUSBMODE: (40,41)\r\nOK',
			},
			transportCalls,
		),
		transition: (_context, _capability, target) => {
			transitionCalls.push(target);
			return Promise.resolve({
				status: 'succeeded',
				newIfname: deviceIfname('wwan1'),
				steps: ['postcondition-runtime-read'],
			});
		},
		...overrides,
	};
	return { deps, transportCalls, transitionCalls };
}

describe('runtime composition suppression matrix', () => {
	test.each([
		{
			name: 'unknown vendor',
			reason: 'unknown-vendor',
			overrides: { vendor: () => 'unlisted' },
			expectedTransportCalls: 0,
		},
		{
			name: 'provisioning disabled',
			reason: 'provisioning-disabled',
			overrides: { provisioningEnabled: () => false },
			expectedTransportCalls: 0,
		},
		{
			name: 'blocked by live state',
			reason: 'blocked-by-state',
			overrides: { blockedReason: () => 'streaming-active' },
			expectedTransportCalls: 0,
		},
		{
			name: 'no represented return path',
			reason: 'no-return-path',
			overrides: {
				atSender: senderFor(
					{
						'AT+GTUSBMODE?': '+GTUSBMODE: 42\r\nOK',
						'AT+GTUSBMODE=?': '+GTUSBMODE: (40,41)\r\nOK',
					},
					[],
				),
			},
			expectedTransportCalls: 2,
		},
	] as const)('emits distinct $reason for $name', async (fixture) => {
		const transportCalls: string[] = [];
		const created = operationDeps({
			...fixture.overrides,
			...(fixture.reason === 'no-return-path'
				? {
						atSender: senderFor(
							{
								'AT+GTUSBMODE?': '+GTUSBMODE: 42\r\nOK',
								'AT+GTUSBMODE=?': '+GTUSBMODE: (40,41)\r\nOK',
							},
							transportCalls,
						),
					}
				: {}),
		});
		const operation = createRuntimeCompositionOperation(created.deps);

		const state = await operation.capability(CONTEXT);

		expect(state.status).toBe('suppressed');
		if (state.status === 'suppressed') expect(state.reason).toBe(fixture.reason);
		expect(state.offerable).toEqual([]);
		expect(
			fixture.reason === 'no-return-path' ? transportCalls.length : created.transportCalls.length,
		).toBe(fixture.expectedTransportCalls);
	});

	test('an unknown vendor has zero offered targets and a forced mutation touches no transport', async () => {
		const created = operationDeps({ vendor: () => 'unlisted' });
		const operation = createRuntimeCompositionOperation(created.deps);

		const result = await operation.write(CONTEXT, 40);

		expect(result).toMatchObject({ status: 'refused', reason: 'unknown-vendor' });
		expect(created.transportCalls).toEqual([]);
		expect(created.transitionCalls).toEqual([]);
	});
});

describe('runtime composition offered transition', () => {
	test('the offered set comes from READ plus TEST and never sends a SET during capability read', async () => {
		const created = operationDeps();
		const operation = createRuntimeCompositionOperation(created.deps);

		const state = await operation.capability(CONTEXT);

		expect(state).toEqual({
			status: 'available',
			current: 41,
			enumerated: [40, 41],
			offerable: [40],
		});
		expect(created.transportCalls).toEqual(['AT+GTUSBMODE?', 'AT+GTUSBMODE=?']);
		expect(created.transportCalls.some((command) => command.includes('='))).toBe(true);
		expect(created.transportCalls.some((command) => command === 'AT+GTUSBMODE=40')).toBe(false);
	});

	test('the operation descriptor drives admission, journal and readback through OperationEngine', async () => {
		const events: string[] = [];
		const admission: MutationAdmissionPort = {
			acquire: () => {
				events.push('lease:acquire');
				return Promise.resolve({
					status: 'admitted',
					lease: {
						release: () => {
							events.push('lease:release');
							return Promise.resolve();
						},
					},
				});
			},
		};
		const ownership: ResourceOwnershipPort = {
			acquire: () => Promise.resolve({ status: 'refused', reason: 'already-owned' }),
		};
		const root = createModemControlCompositionRoot({ admission, ownership });
		roots.push(root);
		const engine = createOperationEngine({
			root,
			currentGeneration: () => GENERATION,
			preconditions: { check: () => Promise.resolve({ status: 'satisfied' }) },
		});
		let current = 41;
		const transportCalls: string[] = [];
		const created = operationDeps({
			atSender: {
				send: (command) => {
					transportCalls.push(command);
					return Promise.resolve({
						ok: true,
						raw:
							command === 'AT+GTUSBMODE?'
								? `+GTUSBMODE: ${current}\r\nOK`
								: '+GTUSBMODE: (40,41)\r\nOK',
					});
				},
			},
			transition: (_context, _capability, target) => {
				current = Number(target);
				events.push('transition');
				return Promise.resolve({
					status: 'succeeded',
					newIfname: deviceIfname('wwan1'),
					steps: ['postcondition-runtime-read'],
				});
			},
		});
		const operation = createRuntimeCompositionOperation(created.deps);
		const descriptor = await operation.describe(CONTEXT);

		const result = await engine.invoke({
			operationId: 'runtime-composition-1',
			physicalModemId: MODEM,
			descriptor,
			input: 40,
			execute: async () => {
				const write = await operation.write(CONTEXT, 40);
				return write.status === 'applied'
					? { status: 'applied', value: write.value }
					: { status: 'failed', reason: write.reason };
			},
			readback: async () => {
				events.push('readback');
				const read = await operation.read(CONTEXT);
				return read.status === 'applied'
					? { status: 'applied', value: read.value }
					: { status: 'failed', reason: read.reason };
			},
			rollback: () => {
				events.push('rollback');
				return Promise.resolve({ status: 'applied', value: undefined });
			},
			journal: {
				record: (event) => {
					events.push(`journal:${event.phase}`);
					return Promise.resolve();
				},
			},
		});

		expect(result.status).toBe('applied');
		expect(events).toEqual([
			'lease:acquire',
			'journal:started',
			'transition',
			'readback',
			'journal:completed',
			'lease:release',
		]);
		expect(descriptor.rollback.required).toBe(true);
		expect(transportCalls).toHaveLength(6);
	});

	test('a definite failed offered transition fires the armed rollback hook', async () => {
		const events: string[] = [];
		const admission: MutationAdmissionPort = {
			acquire: () =>
				Promise.resolve({
					status: 'admitted',
					lease: { release: () => Promise.resolve() },
				}),
		};
		const ownership: ResourceOwnershipPort = {
			acquire: () => Promise.resolve({ status: 'refused', reason: 'already-owned' }),
		};
		const root = createModemControlCompositionRoot({ admission, ownership });
		roots.push(root);
		const engine = createOperationEngine({
			root,
			currentGeneration: () => GENERATION,
			preconditions: { check: () => Promise.resolve({ status: 'satisfied' }) },
		});
		const created = operationDeps({
			transition: () =>
				Promise.resolve({
					status: 'failed',
					degraded: true,
					reason: 'runtime readback mismatch',
					steps: ['postcondition-runtime-read'],
				}),
		});
		const operation = createRuntimeCompositionOperation(created.deps);
		const descriptor = await operation.describe(CONTEXT);

		const result = await engine.invoke({
			operationId: 'runtime-composition-rollback',
			physicalModemId: MODEM,
			descriptor,
			input: 40,
			execute: async () => {
				const write = await operation.write(CONTEXT, 40);
				return write.status === 'applied'
					? { status: 'applied', value: write.value }
					: { status: 'failed', reason: write.reason };
			},
			readback: () => Promise.resolve({ status: 'failed', reason: 'not-reached' }),
			rollback: () => {
				events.push('rollback');
				return Promise.resolve({ status: 'applied', value: undefined });
			},
			journal: {
				record: (event) => {
					events.push(`journal:${event.phase}`);
					return Promise.resolve();
				},
			},
		});

		expect(result).toMatchObject({ status: 'failed', reason: 'runtime readback mismatch' });
		expect(events).toEqual(['journal:started', 'rollback', 'journal:completed']);
	});
});
