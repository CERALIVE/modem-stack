// What the persisted usage document carries — and the one thing it must not.
//
// The counter BASELINE resumes across a same-boot reload because a cumulative total is
// still true after a restart. A THROUGHPUT is not: it is a measurement over an interval
// whose two ends one process observed, and a restart observed neither. This suite pins
// that negative from both sides — the bytes on disk, and the behaviour after a reload.

import { describe, expect, test } from 'bun:test';
import { logicalSlotId } from '../../domain';
import { persistedUsageState } from './persistence';
import type { CounterSource } from './proc-net-dev';
import { createUsageSampler, type UsageObservation } from './sampler';
import { type PersistedUsage, USAGE_SCHEMA_VERSION, type UsageStore } from './store';

const SLOT_A = logicalSlotId('slot-a');
const RATE_TOKENS = ['rate', 'bytesPerSecond', 'sampledAt', 'throughput'];

class FakeCounters implements CounterSource {
	readonly #map = new Map<string, number>();
	set(ifname: string, value: number): void {
		this.#map.set(ifname, value);
	}
	async read(): Promise<ReadonlyMap<string, number>> {
		return new Map(this.#map);
	}
}

class MemStore implements UsageStore {
	doc: PersistedUsage | null = null;
	async load(bootId: string, nowMs: number): Promise<PersistedUsage> {
		return this.doc ?? { schemaVersion: USAGE_SCHEMA_VERSION, bootId, savedAtMs: nowMs, slots: [] };
	}
	async save(state: PersistedUsage): Promise<void> {
		this.doc = state;
	}
}

const obs = (ifname: string): UsageObservation => ({
	logicalSlotId: SLOT_A,
	mappingGeneration: 0,
	ifname,
	confidence: 'high',
	usage: {},
});

describe('persisted usage state — no throughput reaches the disk', () => {
	test('a slot that WAS measuring a rate serializes only the cumulative facts', async () => {
		const counters = new FakeCounters();
		const store = new MemStore();
		let clock = 1_000_000;
		const sampler = await createUsageSampler({
			bootId: 'boot-1',
			source: counters,
			store,
			now: () => clock,
		});

		counters.set('wwan0', 1000);
		await sampler.sample([obs('wwan0')]);
		clock += 10_000;
		counters.set('wwan0', 21_000);
		await sampler.sample([obs('wwan0')]);
		// Non-vacuity: there IS a live rate to leak at the moment of the flush.
		expect(sampler.snapshot().slots[0]?.rateBytesPerSecond).toBe(2000);

		await sampler.flush();

		const written = store.doc;
		expect(written?.slots[0]?.cycleBytes).toBe(20_000);
		expect(written?.slots[0]?.lastObserved).toBe(21_000);
		const serialized = JSON.stringify(written);
		for (const token of RATE_TOKENS) {
			expect(serialized.toLowerCase()).not.toContain(token.toLowerCase());
		}
	});

	test('a same-boot reload resumes the baseline but restarts unmeasured', async () => {
		const counters = new FakeCounters();
		const store = new MemStore();
		let clock = 1_000_000;
		const options = { bootId: 'boot-1', source: counters, store, now: () => clock };

		const first = await createUsageSampler(options);
		counters.set('wwan0', 1000);
		await first.sample([obs('wwan0')]);
		clock += 10_000;
		counters.set('wwan0', 21_000);
		await first.sample([obs('wwan0')]);
		await first.flush();

		const reloaded = await createUsageSampler(options);
		clock += 10_000;
		counters.set('wwan0', 41_000);
		await reloaded.sample([obs('wwan0')]);

		const resumed = reloaded.snapshot().slots[0];
		// The baseline survived: 41_000 - 21_000 is attributed, not the whole counter.
		expect(resumed?.cycleBytes).toBe(40_000);
		// The rate did not: this process never observed the start of that interval.
		expect(resumed?.rateBytesPerSecond).toBeUndefined();

		// And the pass after it — both ends now observed here — measures normally.
		clock += 10_000;
		counters.set('wwan0', 51_000);
		await reloaded.sample([obs('wwan0')]);
		expect(reloaded.snapshot().slots[0]?.rateBytesPerSecond).toBe(1000);
	});

	test('persistedUsageState emits no rate field even for a fully-populated account', () => {
		const state = persistedUsageState(
			'boot-1',
			5000,
			new Map([
				[
					'slot-a',
					{
						cycleBytes: 42,
						cycleStartMs: 1,
						paused: false,
						key: {
							logicalSlotId: 'slot-a',
							mappingGeneration: 0,
							ifname: 'wwan0',
							bootId: 'boot-1',
						},
						lastObserved: 99,
					},
				],
			]),
		);

		expect(Object.keys(state.slots[0] ?? {}).sort()).toEqual([
			'cycleBytes',
			'cycleStartMs',
			'ifname',
			'lastObserved',
			'logicalSlotId',
			'mappingGeneration',
		]);
	});
});
