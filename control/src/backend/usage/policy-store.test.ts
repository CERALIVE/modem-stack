// Usage-policy persistence contract — mode 0600 (real fs.stat), fail-soft
// corruption recovery with METADATA-ONLY logging, and the per-slot selector.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createUsagePolicyFileStore,
	isValidCycleDay,
	isValidThresholdBytes,
	type PersistedUsagePolicy,
	selectUsagePolicy,
	USAGE_POLICY_SCHEMA_VERSION,
	type UsagePolicyLogEvent,
} from './policy-store';

let dir: string;
let path: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'usage-policy-'));
	path = join(dir, 'policy.json');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const sample: PersistedUsagePolicy = {
	schemaVersion: USAGE_POLICY_SCHEMA_VERSION,
	savedAtMs: 1_700_000_000_000,
	slots: [
		{ logicalSlotId: 'slot-a', cycleDay: 15, thresholdBytes: 5_000_000_000 },
		{ logicalSlotId: 'slot-b', cycleDay: 1 },
		{ logicalSlotId: 'slot-c', thresholdBytes: 0 },
	],
};

describe('UsagePolicyStore — versioned round-trip', () => {
	test('save then load returns identical, schema-versioned state', async () => {
		const store = createUsagePolicyFileStore({ path });
		await store.save(sample);
		expect(await store.load(1)).toEqual(sample);
	});

	test('an absent file loads as a fresh empty document and writes nothing', async () => {
		const store = createUsagePolicyFileStore({ path });
		const loaded = await store.load(4242);
		expect(loaded).toEqual({
			schemaVersion: USAGE_POLICY_SCHEMA_VERSION,
			savedAtMs: 4242,
			slots: [],
		});
		expect(readFile(path, 'utf8')).rejects.toThrow();
	});

	test('the written file is mode 0600 regardless of umask', async () => {
		const store = createUsagePolicyFileStore({ path });
		await store.save(sample);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});
});

describe('UsagePolicyStore — fail-soft corruption', () => {
	test('invalid JSON is replaced by a fresh 0600 file and logged as METADATA ONLY', async () => {
		const events: UsagePolicyLogEvent[] = [];
		await writeFile(path, '{"schemaVersion":1,"slots":');
		const store = createUsagePolicyFileStore({ path, logger: (e) => events.push(e) });

		const loaded = await store.load(7);

		expect(loaded.slots).toEqual([]);
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe('corrupt-policy');
		expect(events[0]?.reason).toContain('invalid-json');
		expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	test.each([
		[
			'schemaVersion',
			JSON.stringify({ ...sample, schemaVersion: 99 }),
			'schema-mismatch: schemaVersion',
		],
		['savedAtMs', JSON.stringify({ ...sample, savedAtMs: 'soon' }), 'schema-mismatch: savedAtMs'],
		['slots', JSON.stringify({ ...sample, slots: {} }), 'schema-mismatch: slots'],
		[
			'logicalSlotId',
			JSON.stringify({ ...sample, slots: [{ cycleDay: 3 }] }),
			'schema-mismatch: logicalSlotId',
		],
		[
			'cycleDay',
			JSON.stringify({ ...sample, slots: [{ logicalSlotId: 'a', cycleDay: 32 }] }),
			'schema-mismatch: cycleDay',
		],
		[
			'thresholdBytes',
			JSON.stringify({ ...sample, slots: [{ logicalSlotId: 'a', thresholdBytes: -1 }] }),
			'schema-mismatch: thresholdBytes',
		],
	])('a bad %s is rejected by name and never throws', async (_field, text, reason) => {
		const events: UsagePolicyLogEvent[] = [];
		await writeFile(path, text);
		const store = createUsagePolicyFileStore({ path, logger: (e) => events.push(e) });

		expect((await store.load(9)).slots).toEqual([]);
		expect(events[0]?.reason).toBe(reason);
	});

	test('the corruption log carries a byte count and NEVER the file content', async () => {
		const secretish = JSON.stringify({ schemaVersion: 1, slots: 'iccid-8991101200003204514' });
		const events: UsagePolicyLogEvent[] = [];
		await writeFile(path, secretish);
		const store = createUsagePolicyFileStore({ path, logger: (e) => events.push(e) });

		await store.load(11);

		expect(events[0]?.bytes).toBe(Buffer.byteLength(secretish, 'utf8'));
		expect(JSON.stringify(events[0])).not.toContain('8991101200003204514');
	});
});

describe('selectUsagePolicy', () => {
	test('returns the slot policy, omitting fields the slot never set', () => {
		expect(selectUsagePolicy(sample, 'slot-a')).toEqual({
			cycleDay: 15,
			thresholdBytes: 5_000_000_000,
		});
		expect(selectUsagePolicy(sample, 'slot-b')).toEqual({ cycleDay: 1 });
		expect(selectUsagePolicy(sample, 'slot-c')).toEqual({ thresholdBytes: 0 });
	});

	test('an unknown slot answers "no policy set", not a default', () => {
		expect(selectUsagePolicy(sample, 'nope')).toEqual({});
	});
});

describe('validators', () => {
	test.each([
		[1, true],
		[31, true],
		[15, true],
		[0, false],
		[32, false],
		[1.5, false],
		[Number.NaN, false],
		['3', false],
	])('isValidCycleDay(%p) === %p', (value, expected) => {
		expect(isValidCycleDay(value)).toBe(expected);
	});

	test.each([
		[0, true],
		[5_000_000_000, true],
		[-1, false],
		[1.5, false],
		[Number.POSITIVE_INFINITY, false],
		['5', false],
	])('isValidThresholdBytes(%p) === %p', (value, expected) => {
		expect(isValidThresholdBytes(value)).toBe(expected);
	});
});
