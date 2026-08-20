import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';

import {
	appliedResult,
	completedEvent,
	createJournalHarness,
	failedResult,
	JOURNAL_MODEM_A,
	JOURNAL_MODEM_B,
	type JournalHarness,
	startedEvent,
	unknownOutcomeResult,
} from '../../test-support/journal-fixture';
import type { OperationExecution } from '../operations/contracts';
import { assertJournalIntact, JournalRecoveryError } from './recovery';
import { createFileJournalStore, JournalPathError } from './store';

let harness: JournalHarness;

beforeEach(async () => {
	harness = await createJournalHarness();
});

afterEach(async () => {
	await harness.dispose();
});

describe('the journal path is injected and has no default', () => {
	test('an empty path is refused rather than substituted', () => {
		expect(() => createFileJournalStore({ path: '' })).toThrow(JournalPathError);
		expect(() => createFileJournalStore({ path: '   ' })).toThrow(JournalPathError);
	});

	test('the store echoes back exactly the path it was handed', () => {
		expect(createFileJournalStore({ path: harness.path }).path).toBe(harness.path);
	});

	test('the engine journals to the injected path and nowhere else', async () => {
		const engine = harness.restart();
		await engine.record(startedEvent('op-1'));
		expect(engine.path).toBe(harness.path);
		await expect(stat(harness.path)).resolves.toBeDefined();
	});

	test('the journal file is created 0600 regardless of umask', async () => {
		await harness.restart().record(startedEvent('op-1'));
		expect((await stat(harness.path)).mode & 0o777).toBe(0o600);
	});
});

describe('the engine satisfies the operation engine journal hook', () => {
	test('an engine is assignable as an OperationExecution journal hook', async () => {
		const engine = harness.restart();
		const execution: Pick<OperationExecution<string, string>, 'journal'> = { journal: engine };
		await execution.journal?.record(startedEvent('op-hook'));
		const narrow = engine.hook<string, string>();
		await narrow.record(completedEvent('op-hook', appliedResult()));

		const recovery = await engine.recover();
		expect(recovery.records).toHaveLength(1);
		expect(recovery.records[0]?.disposition).toBe('resolved');
	});
});

describe('replay after an unclean restart', () => {
	test('N entries survive dropping the engine and enumerate for reconciliation', async () => {
		const writer = harness.restart();
		// Five operations: one clean, one stranded mid-flight, two unknown outcomes
		// on two different modems, and one definite failure.
		await writer.record(startedEvent('op-applied'));
		await writer.record(completedEvent('op-applied', appliedResult()));
		await writer.record(startedEvent('op-stranded'));
		await writer.record(startedEvent('op-timeout'));
		await writer.record(
			completedEvent('op-timeout', unknownOutcomeResult('write-reply-timed-out')),
		);
		await writer.record(startedEvent('op-stale', { physicalModemId: JOURNAL_MODEM_B }));
		await writer.record(
			completedEvent('op-stale', unknownOutcomeResult('stale-generation'), {
				physicalModemId: JOURNAL_MODEM_B,
			}),
		);
		await writer.record(startedEvent('op-failed'));
		await writer.record(completedEvent('op-failed', failedResult('device-refused')));

		// The "crash": the engine instance is dropped with no shutdown of any kind.
		// A brand-new engine reconstructs purely from what reached the disk.
		const recovery = await harness.restart().recover();

		expect(recovery.damage).toEqual([]);
		expect(recovery.records.map((record) => record.operationId)).toEqual([
			'op-applied',
			'op-stranded',
			'op-timeout',
			'op-stale',
			'op-failed',
		]);

		expect(recovery.pending.map((record) => record.operationId)).toEqual(['op-stranded']);
		expect(recovery.unknownOutcome.map((record) => record.operationId)).toEqual([
			'op-timeout',
			'op-stale',
		]);
		expect(recovery.blocked).toEqual([]);
		expect(recovery.reconciliationRequired).toEqual(
			[JOURNAL_MODEM_A as string, JOURNAL_MODEM_B as string].sort(),
		);
	});

	test('a definite failure is resolved, never folded into reconciliation', async () => {
		const writer = harness.restart();
		await writer.record(startedEvent('op-failed'));
		await writer.record(completedEvent('op-failed', failedResult('device-refused')));

		const recovery = await harness.restart().recover();
		expect(recovery.records[0]?.disposition).toBe('resolved');
		expect(recovery.records[0]?.outcome).toEqual({ status: 'failed', reason: 'device-refused' });
		expect(recovery.reconciliationRequired).toEqual([]);
	});

	test('the unknown-outcome reason survives the round trip verbatim', async () => {
		const writer = harness.restart();
		await writer.record(startedEvent('op-dropped'));
		await writer.record(completedEvent('op-dropped', unknownOutcomeResult('write-reply-dropped')));

		const recovery = await harness.restart().recover();
		expect(recovery.records[0]?.outcome).toEqual({
			status: 'unknown-outcome',
			reason: 'write-reply-dropped',
		});
	});

	test('a re-run of the same operation counts attempts instead of hiding one', async () => {
		const writer = harness.restart();
		await writer.record(startedEvent('op-retried'));
		await writer.record(startedEvent('op-retried'));
		await writer.record(completedEvent('op-retried', appliedResult()));

		const recovery = await harness.restart().recover();
		expect(recovery.records).toHaveLength(1);
		expect(recovery.records[0]?.attempts).toBe(2);
		expect(recovery.records[0]?.disposition).toBe('resolved');
	});

	test('descriptor evidence is what a reconciler reads back', async () => {
		await harness.restart().record(startedEvent('op-evidence'));
		const recovery = await harness.restart().recover();
		expect(recovery.records[0]?.descriptor).toEqual({
			descriptorId: 'set-usb-mode',
			provider: 'fixture-provider',
			authority: 'provider',
			mutationImpact: 'write',
			profiles: ['fixture'],
			firmware: ['1.0'],
			confidence: 'high',
		});
	});

	test('an empty journal recovers as empty, not as damaged', async () => {
		const recovery = await harness.restart().recover();
		expect(recovery.records).toEqual([]);
		expect(recovery.damage).toEqual([]);
		expect(() => assertJournalIntact(recovery)).not.toThrow();
	});

	test('neither the input nor the returned value is ever written to disk', async () => {
		const writer = harness.restart();
		await writer.record(startedEvent('op-secret', { input: '8462-PUK-SECRET' }));
		await writer.record(completedEvent('op-secret', appliedResult('9911-READBACK-SECRET')));

		const text = await readFile(harness.path, 'utf8');
		expect(text).not.toContain('8462-PUK-SECRET');
		expect(text).not.toContain('9911-READBACK-SECRET');
		expect(text).not.toContain('input');
		expect(text).not.toContain('value');
	});
});

describe('appends are additive and ordered', () => {
	test('a second engine over the same path appends rather than replaces', async () => {
		await harness.restart().record(startedEvent('op-first'));
		await harness.restart().record(startedEvent('op-second'));

		const recovery = await harness.restart().recover();
		expect(recovery.records.map((record) => record.operationId)).toEqual(['op-first', 'op-second']);
	});

	test('concurrent appends serialize into whole lines', async () => {
		const engine = harness.restart();
		await Promise.all(
			Array.from({ length: 12 }, (_unused, index) => engine.record(startedEvent(`op-${index}`))),
		);

		const recovery = await engine.recover();
		expect(recovery.damage).toEqual([]);
		expect(recovery.records).toHaveLength(12);
	});

	test('every written line is newline-terminated', async () => {
		const engine = harness.restart();
		await engine.record(startedEvent('op-1'));
		await engine.record(completedEvent('op-1', appliedResult()));
		const text = await readFile(harness.path, 'utf8');
		expect(text.endsWith('\n')).toBe(true);
		expect(text.split('\n').filter((line) => line.length > 0)).toHaveLength(2);
	});
});

describe('JournalRecoveryError', () => {
	test('assertJournalIntact does not throw on a clean journal', async () => {
		await harness.restart().record(startedEvent('op-1'));
		const recovery = await harness.restart().recover();
		expect(() => assertJournalIntact(recovery)).not.toThrow();
	});

	test('the error carries the damage rather than only a message', () => {
		const damage = [
			{ location: { kind: 'file' }, bytes: 0, failure: { code: 'unreadable' } },
		] as const;
		const error = new JournalRecoveryError(damage);
		expect(error.damage).toEqual(damage);
		expect(error.name).toBe('JournalRecoveryError');
	});
});
