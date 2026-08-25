// Counter-reset-aware throughput — the rules that decide when a rate exists at all.
//
// Driven through the real `UsageSampler` rather than against `measureRate` directly,
// because the property under test spans three modules: `sampling.ts` decides there is
// no interval, `accounting.ts` rebases the baseline in the same pass, and `policy.ts`
// omits the key from the projected snapshot. A unit test of any one of them would pass
// while an operator still saw an invented spike.

import { describe, expect, test } from 'bun:test';
import { type DesiredUsage, logicalSlotId } from '../../domain';
import type { CounterSource } from './proc-net-dev';
import { createUsageSampler, type UsageObservation, type UsageSnapshot } from './sampler';
import { type PersistedUsage, USAGE_SCHEMA_VERSION, type UsageStore } from './store';

const SLOT_A = logicalSlotId('slot-a');

class FakeCounters implements CounterSource {
	readonly #map = new Map<string, number>();
	set(ifname: string, value: number): void {
		this.#map.set(ifname, value);
	}
	clear(ifname: string): void {
		this.#map.delete(ifname);
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

function obs(
	ifname: string,
	confidence: 'high' | 'medium' | 'low' = 'high',
	mappingGeneration = 0,
	usage: DesiredUsage = {},
): UsageObservation {
	return { logicalSlotId: SLOT_A, mappingGeneration, ifname, confidence, usage };
}

function harness(store: UsageStore = new MemStore()) {
	const counters = new FakeCounters();
	let clock = 1_000_000;
	const build = () =>
		createUsageSampler({ bootId: 'boot-1', source: counters, store, now: () => clock });
	return {
		counters,
		store,
		build,
		advance: (ms: number) => {
			clock += ms;
		},
		at: () => clock,
	};
}

const slot = (snapshot: UsageSnapshot) => snapshot.slots[0];

describe('usage throughput — a measured interval produces a rate', () => {
	test('a steady climb over a known interval reports bytes per second', async () => {
		const h = harness();
		const sampler = await h.build();
		h.counters.set('wwan0', 1000);
		await sampler.sample([obs('wwan0')]);
		h.advance(10_000);
		h.counters.set('wwan0', 21_000);
		await sampler.sample([obs('wwan0')]);

		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBe(2000);
	});

	test('the FIRST sample reports no rate — a rebaseline is not a measurement', async () => {
		const h = harness();
		const sampler = await h.build();
		h.counters.set('wwan0', 1000);
		await sampler.sample([obs('wwan0')]);

		const first = slot(sampler.snapshot());
		expect(first?.rateBytesPerSecond).toBeUndefined();
		expect(first?.cycleBytes).toBe(0);
	});

	test('a clock that did not advance yields no rate rather than Infinity', async () => {
		const h = harness();
		const sampler = await h.build();
		h.counters.set('wwan0', 1000);
		await sampler.sample([obs('wwan0')]);
		h.counters.set('wwan0', 5000);
		await sampler.sample([obs('wwan0')]);

		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBeUndefined();
	});
});

describe('usage throughput — A COUNTER RESET (the rollback fixture)', () => {
	test('a backwards counter reports NO rate, and the next interval is measured correctly', async () => {
		const h = harness();
		const sampler = await h.build();

		// Two honest intervals first, so the assertions below cannot pass vacuously.
		h.counters.set('wwan0', 1_000_000);
		await sampler.sample([obs('wwan0')]);
		h.advance(10_000);
		h.counters.set('wwan0', 1_050_000);
		await sampler.sample([obs('wwan0')]);
		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBe(5000);
		expect(slot(sampler.snapshot())?.cycleBytes).toBe(50_000);

		// THE RESET: the interface was re-created and its counter restarted near zero.
		h.advance(10_000);
		h.counters.set('wwan0', 4000);
		await sampler.sample([obs('wwan0')]);

		const reset = slot(sampler.snapshot());
		// No rate at all — not a negative one, and not 4000/10s either, which would
		// report the whole post-reset total as if it had moved in this one interval.
		expect(reset?.rateBytesPerSecond).toBeUndefined();
		// The cycle total is untouched: the reset attributed nothing.
		expect(reset?.cycleBytes).toBe(50_000);

		// THE REBASELINE IS THE OTHER HALF. The next interval must be measured from
		// the post-reset value (4000), never from the stale pre-reset one.
		h.advance(10_000);
		h.counters.set('wwan0', 34_000);
		await sampler.sample([obs('wwan0')]);

		const recovered = slot(sampler.snapshot());
		expect(recovered?.rateBytesPerSecond).toBe(3000);
		expect(recovered?.cycleBytes).toBe(80_000);
	});

	test('a counter resetting to exactly zero is still a reset, not a full-total rate', async () => {
		const h = harness();
		const sampler = await h.build();
		h.counters.set('wwan0', 900_000);
		await sampler.sample([obs('wwan0')]);
		h.advance(5000);
		h.counters.set('wwan0', 0);
		await sampler.sample([obs('wwan0')]);

		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBeUndefined();
	});
});

describe('usage throughput — every other unmeasurable interval', () => {
	test('an ambiguous-identity pause reports no rate, and neither does the resume', async () => {
		const h = harness();
		const sampler = await h.build();
		h.counters.set('wwan0', 1000);
		await sampler.sample([obs('wwan0')]);
		h.advance(10_000);
		h.counters.set('wwan0', 3000);
		await sampler.sample([obs('wwan0')]);
		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBe(200);

		h.advance(10_000);
		h.counters.set('wwan0', 99_000);
		await sampler.sample([obs('wwan0', 'low')]);
		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBeUndefined();

		// The resume is a zero-delta rebaseline, so it has no interval either.
		h.advance(10_000);
		h.counters.set('wwan0', 100_000);
		await sampler.sample([obs('wwan0')]);
		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBeUndefined();
	});

	test('a remap reports no rate — the two counters are not one counter', async () => {
		const h = harness();
		const sampler = await h.build();
		h.counters.set('wwan0', 1000);
		await sampler.sample([obs('wwan0')]);
		h.advance(10_000);
		h.counters.set('wwan0', 3000);
		await sampler.sample([obs('wwan0')]);
		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBe(200);

		h.advance(10_000);
		await sampler.sample([obs('wwan0', 'high', 1)]);
		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBeUndefined();
	});

	test('an interface missing from the counter table costs the RETURN sample its rate too', async () => {
		const h = harness();
		const sampler = await h.build();
		h.counters.set('wwan0', 1000);
		await sampler.sample([obs('wwan0')]);
		h.advance(10_000);
		h.counters.set('wwan0', 3000);
		await sampler.sample([obs('wwan0')]);
		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBe(200);

		h.advance(10_000);
		h.counters.clear('wwan0');
		await sampler.sample([obs('wwan0')]);
		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBeUndefined();

		// Whatever moved while the interface was gone did not move inside ONE
		// interval, so the pass that finds it again still reports nothing.
		h.advance(10_000);
		h.counters.set('wwan0', 500_000);
		await sampler.sample([obs('wwan0')]);
		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBeUndefined();

		h.advance(10_000);
		h.counters.set('wwan0', 510_000);
		await sampler.sample([obs('wwan0')]);
		expect(slot(sampler.snapshot())?.rateBytesPerSecond).toBe(1000);
	});
});
