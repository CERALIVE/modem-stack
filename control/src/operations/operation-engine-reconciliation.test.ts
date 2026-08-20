import { afterEach, describe, expect, test } from 'bun:test';
import {
	createOperationEngineHarness,
	deferred,
	OPERATION_MODEM,
	operationExecution,
} from '../../test-support/operation-engine-fixture';
import type { OperationCompletion } from '../domain';
import type { OperationPreconditionPort } from './operation-engine';

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});

function harness(preconditions?: OperationPreconditionPort) {
	const created = createOperationEngineHarness(preconditions);
	disposals.push(created.dispose);
	return created;
}

describe('unknown-outcome reconciliation gate', () => {
	test('Given a timed-out write, When another mutation is invoked, Then it is blocked until reconciliation completes', async () => {
		const { engine, generation } = harness();
		const first = await engine.invoke(
			operationExecution(() => Promise.resolve({ status: 'timed-out' })),
		);
		let secondCalls = 0;
		const blocked = await engine.invoke(
			operationExecution(
				() => {
					secondCalls += 1;
					return Promise.resolve({ status: 'applied', value: 'lte' });
				},
				{ operationId: 'operation-2' },
			),
		);

		expect(first).toMatchObject({ status: 'unknown-outcome', requiresReconciliation: true });
		expect(blocked).toMatchObject({ status: 'refused', reason: 'reconciliation-required' });
		expect(secondCalls).toBe(0);
		expect(
			await engine.reconcile({
				physicalModemId: OPERATION_MODEM,
				generation: generation(),
				run: () => Promise.resolve({ status: 'reconciled' }),
			}),
		).toEqual({ status: 'reconciled', generation: generation() });
		expect(
			await engine.invoke(
				operationExecution(() => Promise.resolve({ status: 'applied', value: 'lte' }), {
					operationId: 'operation-3',
				}),
			),
		).toMatchObject({ status: 'applied' });
	});

	test('Given a completion from a replaced generation, When classified, Then its outcome is unknown', async () => {
		const { engine, replace } = harness();
		const started = deferred<void>();
		const completion = deferred<OperationCompletion<string>>();
		const pending = engine.invoke(
			operationExecution(() => {
				started.resolve();
				return completion.promise;
			}),
		);
		await started.promise;
		replace();
		completion.resolve({ status: 'applied', value: 'lte' });

		expect(await pending).toMatchObject({
			status: 'unknown-outcome',
			reason: 'stale-generation',
			requiresReconciliation: true,
		});
	});
});

describe('invoke-time gates and operation isolation', () => {
	test('Given a mutation waiting behind another write, When its live precondition changes, Then the queued mutation is refused without executing', async () => {
		let present = true;
		const checked: boolean[] = [];
		const { engine } = harness({
			check: () => {
				checked.push(present);
				return Promise.resolve(
					present ? { status: 'satisfied' } : { status: 'refused', reason: 'device-absent' },
				);
			},
		});
		const firstCompletion = deferred<OperationCompletion<string>>();
		const first = engine.invoke(operationExecution(() => firstCompletion.promise));
		let secondCalls = 0;
		const second = engine.invoke(
			operationExecution(
				() => {
					secondCalls += 1;
					return Promise.resolve({ status: 'applied', value: 'auto' });
				},
				{ operationId: 'operation-2' },
			),
		);
		await Promise.resolve();
		present = false;
		firstCompletion.resolve({ status: 'applied', value: 'lte' });

		expect(await first).toMatchObject({ status: 'applied' });
		expect(await second).toMatchObject({ status: 'refused', reason: 'device-absent' });
		expect(checked).toEqual([true, false]);
		expect(secondCalls).toBe(0);
	});

	test('Given a late duplicate completion from a replaced generation, When a newer operation is active, Then only its own completion can terminalize it', async () => {
		const { engine, generation, replace } = harness();
		const oldStarted = deferred<void>();
		const oldCompletion = deferred<OperationCompletion<string>>();
		const newerCompletion = deferred<OperationCompletion<string>>();
		const old = engine.invoke(
			operationExecution(() => {
				oldStarted.resolve();
				return oldCompletion.promise;
			}),
		);
		await oldStarted.promise;
		replace();
		oldCompletion.resolve({ status: 'applied', value: 'lte' });
		expect(await old).toMatchObject({ status: 'unknown-outcome', reason: 'stale-generation' });
		await engine.reconcile({
			physicalModemId: OPERATION_MODEM,
			generation: generation(),
			run: () => Promise.resolve({ status: 'reconciled' }),
		});
		const newer = engine.invoke(
			operationExecution(() => newerCompletion.promise, { operationId: 'operation-new' }),
		);
		let newerSettled = false;
		void newer.then(() => {
			newerSettled = true;
		});
		oldCompletion.resolve({ status: 'failed', reason: 'duplicate-late-reply' });
		await Promise.resolve();
		expect(newerSettled).toBe(false);
		newerCompletion.resolve({ status: 'applied', value: 'auto' });
		expect(await newer).toMatchObject({ status: 'applied', value: 'auto' });
	});
});
