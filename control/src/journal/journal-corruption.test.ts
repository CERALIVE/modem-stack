import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, readFile, writeFile } from 'node:fs/promises';

import {
	appliedResult,
	completedEvent,
	createJournalHarness,
	type JournalHarness,
	startedEvent,
	unknownOutcomeResult,
} from '../../test-support/journal-fixture';
import { decodeJournalEntry } from './codec';
import { assertJournalIntact, JournalRecoveryError } from './recovery';
import { decodeJournalText } from './store';

let harness: JournalHarness;

beforeEach(async () => {
	harness = await createJournalHarness();
});

afterEach(async () => {
	await harness.dispose();
});

/** Write three good operations, then damage only the LAST line on disk. */
async function seedThenCorruptTrailingLine(trailing: string): Promise<void> {
	const writer = harness.restart();
	await writer.record(startedEvent('op-1'));
	await writer.record(completedEvent('op-1', appliedResult()));
	await writer.record(startedEvent('op-2'));
	await writer.record(completedEvent('op-2', unknownOutcomeResult('write-reply-timed-out')));
	await writer.record(startedEvent('op-3'));
	await appendFile(harness.path, trailing);
}

describe('a corrupt TRAILING entry never discards the earlier valid ones', () => {
	test('truncated JSON on the last line is reported, and lines 1-5 survive', async () => {
		await seedThenCorruptTrailingLine('{"schemaVersion":1,"phase":"star\n');

		const recovery = await harness.restart().recover();

		// The five valid records are all still there.
		expect(recovery.records.map((record) => record.operationId)).toEqual(['op-1', 'op-2', 'op-3']);
		expect(recovery.pending.map((record) => record.operationId)).toEqual(['op-3']);
		expect(recovery.unknownOutcome.map((record) => record.operationId)).toEqual(['op-2']);

		// And the damage is reported as a TYPED record naming the trailing line.
		expect(recovery.damage).toHaveLength(1);
		expect(recovery.damage[0]?.location).toEqual({ kind: 'line', line: 6, trailing: true });
		expect(recovery.damage[0]?.failure.code).toBe('invalid-json');
		expect(recovery.damage[0]?.bytes).toBeGreaterThan(0);
	});

	test('the typed recovery error is raised on demand and carries the damage', async () => {
		await seedThenCorruptTrailingLine('{"schemaVersion":1,"phase":"star\n');
		const recovery = await harness.restart().recover();

		expect(() => assertJournalIntact(recovery)).toThrow(JournalRecoveryError);
		try {
			assertJournalIntact(recovery);
		} catch (error) {
			expect(error).toBeInstanceOf(JournalRecoveryError);
			expect((error as JournalRecoveryError).damage).toEqual(recovery.damage);
		}
	});

	test('a torn line with NO terminator is still reported, not swallowed', async () => {
		await seedThenCorruptTrailingLine('{"schemaVersion":1,"operationId":"op-4"');

		const recovery = await harness.restart().recover();
		expect(recovery.records).toHaveLength(3);
		expect(recovery.damage).toHaveLength(1);
		expect(recovery.damage[0]?.location).toEqual({ kind: 'line', line: 6, trailing: true });
	});

	test('a well-formed line carrying a future schema version is typed as such', async () => {
		await seedThenCorruptTrailingLine(`${JSON.stringify({ schemaVersion: 99 })}\n`);

		const recovery = await harness.restart().recover();
		expect(recovery.records).toHaveLength(3);
		expect(recovery.damage[0]?.failure).toEqual({ code: 'unsupported-schema-version' });
	});

	test('a valid JSON object missing a required field names the FIELD, not the bytes', async () => {
		await seedThenCorruptTrailingLine(
			`${JSON.stringify({ schemaVersion: 1, phase: 'started', operationId: 'op-4' })}\n`,
		);

		const recovery = await harness.restart().recover();
		expect(recovery.records).toHaveLength(3);
		expect(recovery.damage[0]?.failure).toEqual({
			code: 'schema-mismatch',
			field: 'physicalModemId',
		});
		// Metadata only: the classification must never carry file content.
		expect(JSON.stringify(recovery.damage[0]?.failure)).not.toContain('op-4');
	});
});

describe('damage in the MIDDLE does not truncate the tail either', () => {
	test('lines after a corrupt line are still decoded', async () => {
		const first = harness.restart();
		await first.record(startedEvent('op-1'));
		await first.record(startedEvent('op-2'));
		const text = await readFile(harness.path, 'utf8');
		const lines = text.split('\n').filter((line) => line.length > 0);
		await writeFile(harness.path, `${lines[0]}\n{ not json }\n${lines[1]}\n`);

		const recovery = await harness.restart().recover();
		expect(recovery.records.map((record) => record.operationId)).toEqual(['op-1', 'op-2']);
		expect(recovery.damage).toHaveLength(1);
		expect(recovery.damage[0]?.location).toEqual({ kind: 'line', line: 2, trailing: false });
	});

	test('two damaged lines are both reported, and neither hides the other', async () => {
		await writeFile(harness.path, '{ bad one }\n{"schemaVersion":2}\n');
		const recovery = await harness.restart().recover();
		expect(recovery.records).toEqual([]);
		expect(recovery.damage.map((record) => record.failure.code)).toEqual([
			'invalid-json',
			'unsupported-schema-version',
		]);
	});
});

describe('a torn trailing line is CLOSED before the next append', () => {
	test('appending after a torn write does not corrupt the new entry too', async () => {
		const writer = harness.restart();
		await writer.record(startedEvent('op-1'));
		// Simulate a process killed mid-write: a partial line with no terminator.
		await appendFile(harness.path, '{"schemaVersion":1,"phase":"comp');

		// A fresh engine (new process) appends the next operation.
		await harness.restart().record(startedEvent('op-2'));

		const recovery = await harness.restart().recover();
		// The torn record is still damaged — it really was lost — but the NEW one
		// decoded cleanly instead of being glued onto the garbage.
		expect(recovery.records.map((record) => record.operationId)).toEqual(['op-1', 'op-2']);
		expect(recovery.damage).toHaveLength(1);
		expect(recovery.damage[0]?.location).toEqual({ kind: 'line', line: 2, trailing: false });
	});

	test('the damaged bytes are PRESERVED on disk, never rewritten away', async () => {
		const writer = harness.restart();
		await writer.record(startedEvent('op-1'));
		await appendFile(harness.path, '{"torn":true');

		await harness.restart().recover();
		await harness.restart().record(startedEvent('op-2'));

		expect(await readFile(harness.path, 'utf8')).toContain('{"torn":true');
	});
});

describe('non-vacuity: the corruption detectors really fire', () => {
	test('a clean journal produces no damage at all', async () => {
		const writer = harness.restart();
		await writer.record(startedEvent('op-1'));
		await writer.record(completedEvent('op-1', appliedResult()));
		expect((await harness.restart().recover()).damage).toEqual([]);
	});

	test('decodeJournalText keeps survivors on either side of every failure', () => {
		const line = (id: string): string =>
			JSON.stringify({
				schemaVersion: 1,
				phase: 'started',
				operationId: id,
				physicalModemId: 'serial:x',
				generation: 1,
				recordedAtMs: 1,
				descriptor: {
					descriptorId: 'd',
					provider: 'p',
					authority: 'provider',
					mutationImpact: 'write',
					profiles: [],
					firmware: [],
					confidence: 'high',
				},
			});
		const result = decodeJournalText(`${line('a')}\nbroken\n${line('b')}\nalso broken\n`);
		expect(result.entries.map((record) => record.entry.operationId)).toEqual(['a', 'b']);
		expect(result.damage.map((record) => record.location)).toEqual([
			{ kind: 'line', line: 2, trailing: false },
			{ kind: 'line', line: 4, trailing: true },
		]);
	});

	test('an empty line decodes to a typed empty failure rather than a silent skip', () => {
		expect(decodeJournalEntry('   ')).toEqual({ ok: false, failure: { code: 'empty' } });
	});
});
