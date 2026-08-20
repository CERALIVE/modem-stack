import { afterEach, describe, expect, test } from 'bun:test';
import {
	createOperationEngineHarness,
	operationDescriptor,
	operationExecution,
} from '../../test-support/operation-engine-fixture';

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});

function harness() {
	const created = createOperationEngineHarness();
	disposals.push(created.dispose);
	return created;
}

describe('retry classification', () => {
	test('Given an idempotent read transient failure, When invoked, Then one automatic retry succeeds', async () => {
		const { engine } = harness();
		let calls = 0;
		const result = await engine.invoke(
			operationExecution(
				() => {
					calls += 1;
					return Promise.resolve(
						calls === 1
							? { status: 'failed', reason: 'transient' }
							: { status: 'applied', value: 'auto' },
					);
				},
				{
					descriptor: operationDescriptor({
						mutationImpact: 'read',
						retryClass: 'idempotent-read',
						admission: { required: false },
					}),
				},
			),
		);

		expect(result).toMatchObject({ status: 'applied', value: 'auto' });
		expect(calls).toBe(2);
	});

	test('Given a non-idempotent read failure, When invoked, Then the engine never retries it', async () => {
		const { engine } = harness();
		let calls = 0;
		const result = await engine.invoke(
			operationExecution(
				() => {
					calls += 1;
					return Promise.resolve({ status: 'failed', reason: 'terminal' });
				},
				{
					descriptor: operationDescriptor({
						mutationImpact: 'read',
						retryClass: 'never',
						admission: { required: false },
					}),
				},
			),
		);

		expect(result).toMatchObject({ status: 'failed', reason: 'terminal' });
		expect(calls).toBe(1);
	});
});

describe('descriptor hooks', () => {
	test('Given required readback and journal hooks, When a write applies, Then both hooks fire', async () => {
		const { engine } = harness();
		const phases: string[] = [];
		const result = await engine.invoke(
			operationExecution(() => Promise.resolve({ status: 'applied', value: 'lte' }), {
				descriptor: operationDescriptor({
					readback: {
						required: true,
						reason: 'confirm mode',
						matches: (input, value) => input === value,
					},
					journal: { required: true, reason: 'record mutation' },
				}),
				readback: () => {
					phases.push('readback');
					return Promise.resolve({ status: 'applied', value: 'lte' });
				},
				journal: {
					record: (event) => {
						phases.push(`journal:${event.phase}`);
						return Promise.resolve();
					},
				},
			}),
		);

		expect(result).toMatchObject({ status: 'applied' });
		expect(phases).toEqual(['journal:started', 'readback', 'journal:completed']);
	});

	test('Given required rollback and a definite write failure, When invoked, Then rollback fires once', async () => {
		const { engine } = harness();
		let rollbackCalls = 0;
		const result = await engine.invoke(
			operationExecution(() => Promise.resolve({ status: 'failed', reason: 'provider-failed' }), {
				descriptor: operationDescriptor({ rollback: { required: true, reason: 'restore mode' } }),
				rollback: () => {
					rollbackCalls += 1;
					return Promise.resolve({ status: 'applied', value: undefined });
				},
			}),
		);

		expect(result).toMatchObject({ status: 'failed', reason: 'provider-failed' });
		expect(rollbackCalls).toBe(1);
	});
});
