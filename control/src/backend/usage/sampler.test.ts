// The sampler orchestration — ambiguous-identity pause, threshold advisory
// appear/clear, rate-limited persistence + shutdown flush, reboot re-baselining, and
// the queryable snapshot API the A6.1 bench CLI `usage` command consumes.

import { describe, expect, test } from 'bun:test';
import { type DesiredUsage, logicalSlotId } from '../../domain';
import type { CounterSource } from './proc-net-dev';
import { createUsageSampler, type UsageObservation } from './sampler';
import { type PersistedUsage, USAGE_SCHEMA_VERSION, type UsageStore } from './store';

const SLOT_A = logicalSlotId('slot-a');
const SLOT_B = logicalSlotId('slot-b');

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
	saves = 0;
	async load(bootId: string, nowMs: number): Promise<PersistedUsage> {
		return this.doc ?? { schemaVersion: USAGE_SCHEMA_VERSION, bootId, savedAtMs: nowMs, slots: [] };
	}
	async save(state: PersistedUsage): Promise<void> {
		this.saves += 1;
		this.doc = state;
	}
}

function obs(
	slot: string,
	ifname: string,
	usage: DesiredUsage = {},
	confidence: 'high' | 'medium' | 'low' = 'high',
	mappingGeneration = 0,
): UsageObservation {
	return { logicalSlotId: logicalSlotId(slot), mappingGeneration, ifname, confidence, usage };
}

describe('UsageSampler — snapshot API (A6.1 usage command)', () => {
	test('reports independent per-slot cumulative usage', async () => {
		const counters = new FakeCounters();
		const sampler = await createUsageSampler({
			bootId: 'boot-1',
			source: counters,
			store: new MemStore(),
			now: () => 1000,
		});
		counters.set('wwan0', 100);
		counters.set('wwan1', 5000);
		await sampler.sample([obs(SLOT_A, 'wwan0'), obs(SLOT_B, 'wwan1')]);
		counters.set('wwan0', 300);
		counters.set('wwan1', 5001);
		await sampler.sample([obs(SLOT_A, 'wwan0'), obs(SLOT_B, 'wwan1')]);

		const snap = sampler.snapshot();
		expect(snap.bootId).toBe('boot-1');
		expect(snap.slots).toHaveLength(2);
		const a = snap.slots.find((s) => s.logicalSlotId === 'slot-a');
		const b = snap.slots.find((s) => s.logicalSlotId === 'slot-b');
		expect(a?.cycleBytes).toBe(200);
		expect(a?.paused).toBe(false);
		expect(a?.thresholdExceeded).toBe(false);
		expect(b?.cycleBytes).toBe(1);
	});
});

describe('UsageSampler — ambiguous identity pauses sampling', () => {
	test('a low-confidence slot attributes nothing and reports paused', async () => {
		const counters = new FakeCounters();
		const sampler = await createUsageSampler({
			bootId: 'boot-1',
			source: counters,
			store: new MemStore(),
			now: () => 1000,
		});
		counters.set('wwan0', 100);
		await sampler.sample([obs(SLOT_A, 'wwan0')]);
		counters.set('wwan0', 400);
		await sampler.sample([obs(SLOT_A, 'wwan0')]);
		expect(sampler.snapshot().slots[0]?.cycleBytes).toBe(300);

		// Identity turns ambiguous — counter keeps climbing, nothing is attributed.
		counters.set('wwan0', 9999);
		await sampler.sample([obs(SLOT_A, 'wwan0', {}, 'low')]);
		const paused = sampler.snapshot().slots[0];
		expect(paused?.paused).toBe(true);
		expect(paused?.cycleBytes).toBe(300);
	});
});

describe('UsageSampler — threshold advisory appears and clears', () => {
	test('crossing thresholdBytes flags an advisory that clears on cycle rollover', async () => {
		const counters = new FakeCounters();
		let clock = Date.UTC(2024, 5, 15); // mid-June
		const usage: DesiredUsage = { cycleDay: 1, thresholdBytes: 1000 };
		const sampler = await createUsageSampler({
			bootId: 'boot-1',
			source: counters,
			store: new MemStore(),
			now: () => clock,
		});

		counters.set('wwan0', 0);
		await sampler.sample([obs(SLOT_A, 'wwan0', usage)]);
		counters.set('wwan0', 2000); // +2000 > 1000 threshold
		await sampler.sample([obs(SLOT_A, 'wwan0', usage)]);
		const exceeded = sampler.snapshot().slots[0];
		expect(exceeded?.cycleBytes).toBe(2000);
		expect(exceeded?.thresholdBytes).toBe(1000);
		expect(exceeded?.thresholdExceeded).toBe(true);

		// New billing cycle (July 1) → per-cycle total resets → advisory clears.
		clock = Date.UTC(2024, 6, 2);
		counters.set('wwan0', 2100); // +100 into the fresh cycle
		await sampler.sample([obs(SLOT_A, 'wwan0', usage)]);
		const cleared = sampler.snapshot().slots[0];
		expect(cleared?.cycleBytes).toBe(100);
		expect(cleared?.thresholdExceeded).toBe(false);
	});
});

describe('UsageSampler — rate-limited persistence + shutdown flush', () => {
	test('persists at most once per minute; flush forces an immediate write', async () => {
		const counters = new FakeCounters();
		const store = new MemStore();
		let clock = 1000;
		const sampler = await createUsageSampler({
			bootId: 'boot-1',
			source: counters,
			store,
			now: () => clock,
			persistIntervalMs: 60_000,
		});
		counters.set('wwan0', 100);
		await sampler.sample([obs(SLOT_A, 'wwan0')]); // t=1000, within interval → no save
		clock = 2000;
		await sampler.sample([obs(SLOT_A, 'wwan0')]); // t=2000, still within → no save
		expect(store.saves).toBe(0);

		await sampler.flush(); // shutdown hook — forces a write despite the rate limit
		expect(store.saves).toBe(1);

		clock = 62_000; // > 60s since the flush persist → next sample persists
		counters.set('wwan0', 150);
		await sampler.sample([obs(SLOT_A, 'wwan0')]);
		expect(store.saves).toBe(2);
	});

	test('a clean flush persists the latest cycle total', async () => {
		const counters = new FakeCounters();
		const store = new MemStore();
		const sampler = await createUsageSampler({
			bootId: 'boot-1',
			source: counters,
			store,
			now: () => 1000,
		});
		counters.set('wwan0', 100);
		await sampler.sample([obs(SLOT_A, 'wwan0')]);
		counters.set('wwan0', 500);
		await sampler.sample([obs(SLOT_A, 'wwan0')]);
		await sampler.flush();
		expect(store.doc?.slots[0]?.cycleBytes).toBe(400);
		expect(store.doc?.slots[0]?.lastObserved).toBe(500);
	});
});

describe('UsageSampler — reboot (new boot id) re-baselines without losing the cycle total', () => {
	test('same-boot reload resumes the baseline; a new boot id drops it', async () => {
		const counters = new FakeCounters();
		const store = new MemStore();
		const first = await createUsageSampler({
			bootId: 'boot-1',
			source: counters,
			store,
			now: () => 1000,
		});
		counters.set('wwan0', 100);
		await first.sample([obs(SLOT_A, 'wwan0')]);
		counters.set('wwan0', 300);
		await first.sample([obs(SLOT_A, 'wwan0')]);
		await first.flush();
		expect(store.doc?.slots[0]?.cycleBytes).toBe(200);

		// Same boot id → baseline resumes; counter continues from 300.
		const resumed = await createUsageSampler({
			bootId: 'boot-1',
			source: counters,
			store,
			now: () => 1000,
		});
		counters.set('wwan0', 350);
		await resumed.sample([obs(SLOT_A, 'wwan0')]);
		expect(resumed.snapshot().slots[0]?.cycleBytes).toBe(250);
		await resumed.flush();

		// Reboot: new boot id + counters reset to a low value. The cycle total is kept,
		// but the baseline is dropped so the reset is not mis-attributed.
		const rebooted = await createUsageSampler({
			bootId: 'boot-2',
			source: counters,
			store,
			now: () => 1000,
		});
		counters.set('wwan0', 50); // kernel counters reset on reboot
		await rebooted.sample([obs(SLOT_A, 'wwan0')]); // zero-delta re-baseline
		expect(rebooted.snapshot().slots[0]?.cycleBytes).toBe(250);
		counters.set('wwan0', 150);
		await rebooted.sample([obs(SLOT_A, 'wwan0')]);
		expect(rebooted.snapshot().slots[0]?.cycleBytes).toBe(350);
	});
});

describe('UsageSampler — applyUsagePolicy (the setUsagePolicy live-apply seam)', () => {
	const AUG_16 = Date.UTC(2026, 7, 16, 12, 0, 0);

	async function samplerAt(now: number) {
		const counters = new FakeCounters();
		const sampler = await createUsageSampler({
			bootId: 'boot-1',
			source: counters,
			store: new MemStore(),
			now: () => now,
		});
		return { counters, sampler };
	}

	test('a threshold-only change takes effect immediately and resets nothing', async () => {
		const { counters, sampler } = await samplerAt(AUG_16);
		counters.set('wwan0', 100);
		await sampler.sample([obs(SLOT_A, 'wwan0')]);
		counters.set('wwan0', 900);
		await sampler.sample([obs(SLOT_A, 'wwan0')]);

		const applied = sampler.applyUsagePolicy(SLOT_A, { thresholdBytes: 500 });

		expect(applied.cycleReset).toBe(false);
		const slot = sampler.snapshot().slots[0];
		expect(slot?.cycleBytes).toBe(800);
		expect(slot?.thresholdBytes).toBe(500);
		expect(slot?.thresholdExceeded).toBe(true);
	});

	test('a CHANGED cycle day restarts the window at zero and re-anchors it', async () => {
		const { counters, sampler } = await samplerAt(AUG_16);
		counters.set('wwan0', 100);
		await sampler.sample([obs(SLOT_A, 'wwan0')]);
		counters.set('wwan0', 900);
		await sampler.sample([obs(SLOT_A, 'wwan0')]);
		expect(sampler.snapshot().slots[0]?.cycleBytes).toBe(800);

		const applied = sampler.applyUsagePolicy(SLOT_A, { cycleDay: 20 });

		expect(applied.cycleReset).toBe(true);
		expect(applied.cycleStartMs).toBe(Date.UTC(2026, 6, 20));
		const slot = sampler.snapshot().slots[0];
		expect(slot?.cycleBytes).toBe(0);
		expect(slot?.cycleStartMs).toBe(Date.UTC(2026, 6, 20));
		expect(slot?.cycleDay).toBe(20);
	});

	test('the BASELINE survives the reset, so the next sample attributes no jump', async () => {
		const { counters, sampler } = await samplerAt(AUG_16);
		counters.set('wwan0', 1_000_000);
		await sampler.sample([obs(SLOT_A, 'wwan0')]);

		sampler.applyUsagePolicy(SLOT_A, { cycleDay: 20 });
		counters.set('wwan0', 1_000_150);
		await sampler.sample([obs(SLOT_A, 'wwan0', { cycleDay: 20 })]);

		expect(sampler.snapshot().slots[0]?.cycleBytes).toBe(150);
	});

	test('re-applying the SAME cycle day is a no-op — repeated saves never zero a window', async () => {
		const { counters, sampler } = await samplerAt(AUG_16);
		counters.set('wwan0', 100);
		await sampler.sample([obs(SLOT_A, 'wwan0', { cycleDay: 20 })]);
		counters.set('wwan0', 400);
		await sampler.sample([obs(SLOT_A, 'wwan0', { cycleDay: 20 })]);

		const applied = sampler.applyUsagePolicy(SLOT_A, { cycleDay: 20 });

		expect(applied.cycleReset).toBe(false);
		expect(sampler.snapshot().slots[0]?.cycleBytes).toBe(300);
	});

	test('an applied policy OUTRANKS a stale observation on the next sample', async () => {
		const { counters, sampler } = await samplerAt(AUG_16);
		counters.set('wwan0', 100);
		await sampler.sample([obs(SLOT_A, 'wwan0', { thresholdBytes: 10 })]);

		sampler.applyUsagePolicy(SLOT_A, { thresholdBytes: 999 });
		// The composition root has not rebuilt its observations yet and still
		// carries the OLD policy — the write must not silently revert.
		await sampler.sample([obs(SLOT_A, 'wwan0', { thresholdBytes: 10 })]);

		expect(sampler.snapshot().slots[0]?.thresholdBytes).toBe(999);
	});

	test('applying to a slot never sampled creates it without claiming any bytes', async () => {
		const { sampler } = await samplerAt(AUG_16);

		const applied = sampler.applyUsagePolicy(SLOT_B, { cycleDay: 3, thresholdBytes: 7 });

		expect(applied.cycleReset).toBe(false);
		const slot = sampler.snapshot().slots[0];
		expect(slot?.logicalSlotId).toBe('slot-b');
		expect(slot?.cycleBytes).toBe(0);
		expect(slot?.cycleDay).toBe(3);
		expect(slot?.thresholdBytes).toBe(7);
	});

	test('a slot with no policy reports no cycleDay rather than the sampler default', async () => {
		const { counters, sampler } = await samplerAt(AUG_16);
		counters.set('wwan0', 10);
		await sampler.sample([obs(SLOT_A, 'wwan0')]);

		expect(sampler.snapshot().slots[0]?.cycleDay).toBeUndefined();
	});
});
