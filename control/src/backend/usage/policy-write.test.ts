// `setUsagePolicy` contract — tri-state merge, typed refusals, persist-before-apply
// ordering, and the live-sampler cycle-reset rule.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesiredUsage } from '../../domain';
import {
	createUsagePolicyFileStore,
	type PersistedUsagePolicy,
	selectUsagePolicy,
	USAGE_POLICY_SCHEMA_VERSION,
	type UsagePolicyStore,
} from './policy-store';
import { getUsagePolicy, setUsagePolicy, type UsagePolicyTarget } from './policy-write';

let dir: string;
let path: string;
let store: UsagePolicyStore;

const SLOT = 'slot-a';
const NOW = 1_700_000_000_000;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'usage-policy-write-'));
	path = join(dir, 'policy.json');
	store = createUsagePolicyFileStore({ path });
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function recordingSampler(): UsagePolicyTarget & {
	calls: { slot: string; usage: DesiredUsage; at?: number }[];
} {
	const calls: { slot: string; usage: DesiredUsage; at?: number }[] = [];
	return {
		calls,
		applyUsagePolicy(slot, usage, at) {
			calls.push({ slot, usage, ...(at !== undefined ? { at } : {}) });
			return { cycleStartMs: NOW, cycleReset: true };
		},
	};
}

describe('setUsagePolicy — persistence', () => {
	test('writes a policy that reads back through getUsagePolicy', async () => {
		const result = await setUsagePolicy(
			{ store, now: () => NOW },
			{ logicalSlotId: SLOT, cycleDay: 15, thresholdBytes: 5_000_000_000 },
		);

		expect(result.status).toBe('applied');
		expect(await getUsagePolicy({ store }, SLOT)).toEqual({
			cycleDay: 15,
			thresholdBytes: 5_000_000_000,
		});
	});

	test('an OMITTED field is left alone — a threshold write never drops the cycle day', async () => {
		await setUsagePolicy({ store }, { logicalSlotId: SLOT, cycleDay: 9 });

		await setUsagePolicy({ store }, { logicalSlotId: SLOT, thresholdBytes: 100 });

		expect(await getUsagePolicy({ store }, SLOT)).toEqual({ cycleDay: 9, thresholdBytes: 100 });
	});

	test('an explicit null CLEARS that field and leaves the sibling standing', async () => {
		await setUsagePolicy({ store }, { logicalSlotId: SLOT, cycleDay: 9, thresholdBytes: 100 });

		await setUsagePolicy({ store }, { logicalSlotId: SLOT, cycleDay: null });

		expect(await getUsagePolicy({ store }, SLOT)).toEqual({ thresholdBytes: 100 });
	});

	test('clearing BOTH fields removes the row rather than storing an empty one', async () => {
		await setUsagePolicy({ store }, { logicalSlotId: SLOT, cycleDay: 9, thresholdBytes: 100 });

		await setUsagePolicy({ store }, { logicalSlotId: SLOT, cycleDay: null, thresholdBytes: null });

		expect((await store.load(NOW)).slots).toEqual([]);
	});

	test('a write to one slot never disturbs another', async () => {
		await setUsagePolicy({ store }, { logicalSlotId: 'slot-a', cycleDay: 1 });
		await setUsagePolicy({ store }, { logicalSlotId: 'slot-b', cycleDay: 20 });

		await setUsagePolicy({ store }, { logicalSlotId: 'slot-a', cycleDay: 5 });

		const state = await store.load(NOW);
		expect(selectUsagePolicy(state, 'slot-a')).toEqual({ cycleDay: 5 });
		expect(selectUsagePolicy(state, 'slot-b')).toEqual({ cycleDay: 20 });
		expect(state.slots).toHaveLength(2);
	});
});

describe('setUsagePolicy — typed refusals', () => {
	test.each([
		[{ logicalSlotId: '', cycleDay: 1 }, 'invalid-slot-id'],
		[{ logicalSlotId: SLOT, cycleDay: 0 }, 'invalid-cycle-day'],
		[{ logicalSlotId: SLOT, cycleDay: 32 }, 'invalid-cycle-day'],
		[{ logicalSlotId: SLOT, cycleDay: 3.5 }, 'invalid-cycle-day'],
		[{ logicalSlotId: SLOT, thresholdBytes: -1 }, 'invalid-threshold-bytes'],
		[{ logicalSlotId: SLOT, thresholdBytes: 1.5 }, 'invalid-threshold-bytes'],
	] as const)('%p is rejected as %s and writes nothing', async (request, reason) => {
		const result = await setUsagePolicy({ store }, request);

		expect(result).toMatchObject({ status: 'rejected', reason });
		expect((await store.load(NOW)).slots).toEqual([]);
	});

	test('a refusal is returned, never thrown', async () => {
		expect(setUsagePolicy({ store }, { logicalSlotId: SLOT, cycleDay: 99 })).resolves.toMatchObject(
			{ status: 'rejected' },
		);
	});

	test('a store that throws yields a typed failure and never reaches the sampler', async () => {
		const sampler = recordingSampler();
		const broken: UsagePolicyStore = {
			load: async () => ({
				schemaVersion: USAGE_POLICY_SCHEMA_VERSION,
				savedAtMs: NOW,
				slots: [],
			}),
			save: async () => {
				throw new Error('disk full');
			},
		};

		const result = await setUsagePolicy(
			{ store: broken, sampler },
			{ logicalSlotId: SLOT, cycleDay: 3 },
		);

		expect(result).toMatchObject({ status: 'failed', reason: 'disk full' });
		expect(sampler.calls).toEqual([]);
	});
});

describe('setUsagePolicy — live apply', () => {
	test('the merged policy (not the raw request) reaches the sampler', async () => {
		await setUsagePolicy({ store }, { logicalSlotId: SLOT, cycleDay: 9 });
		const sampler = recordingSampler();

		const result = await setUsagePolicy(
			{ store, sampler, now: () => NOW },
			{ logicalSlotId: SLOT, thresholdBytes: 250 },
		);

		expect(sampler.calls).toEqual([
			{ slot: SLOT, usage: { cycleDay: 9, thresholdBytes: 250 }, at: NOW },
		]);
		expect(result).toMatchObject({ status: 'applied', applied: { cycleReset: true } });
	});

	test('with no sampler the write is persistence-only and reports no application', async () => {
		const result = await setUsagePolicy({ store }, { logicalSlotId: SLOT, cycleDay: 2 });

		expect(result).toEqual({ status: 'applied', logicalSlotId: SLOT, usage: { cycleDay: 2 } });
	});

	test('a sampler that throws is a typed failure AFTER the write already landed', async () => {
		const result = await setUsagePolicy(
			{
				store,
				sampler: {
					applyUsagePolicy() {
						throw new Error('sampler gone');
					},
				},
			},
			{ logicalSlotId: SLOT, cycleDay: 4 },
		);

		expect(result).toMatchObject({ status: 'failed', reason: 'sampler gone' });
		expect(await getUsagePolicy({ store }, SLOT)).toEqual({ cycleDay: 4 });
	});
});

describe('getUsagePolicy', () => {
	test('an unwritten slot answers "no policy set"', async () => {
		expect(await getUsagePolicy({ store }, 'never-written')).toEqual({});
	});

	test('reads a policy laid down by a previous process', async () => {
		const seeded: PersistedUsagePolicy = {
			schemaVersion: USAGE_POLICY_SCHEMA_VERSION,
			savedAtMs: NOW,
			slots: [{ logicalSlotId: SLOT, cycleDay: 28 }],
		};
		await store.save(seeded);

		expect(await getUsagePolicy({ store }, SLOT)).toEqual({ cycleDay: 28 });
	});
});
