// The adversarial accounting matrix — pure, deterministic proofs that per-slot usage
// is attributed correctly across remaps, swaps, reuse, resets, pauses, and rollovers.

import { describe, expect, test } from 'bun:test';
import { type IdentityConfidence, logicalSlotId } from '../../domain';
import { applySample, type BaselineKey, type SlotAccount } from './accounting';

const SLOT_A = logicalSlotId('slot-a');
const SLOT_B = logicalSlotId('slot-b');
const SLOT_C = logicalSlotId('slot-c');
const BOOT = 'boot-uuid-1';

interface Step {
	readonly slot: string;
	readonly gen: number;
	readonly ifname: string;
	readonly current: number;
	readonly confidence?: IdentityConfidence;
	readonly cycleStartMs?: number;
}

function key(slot: string, gen: number, ifname: string): BaselineKey {
	return { logicalSlotId: slot, mappingGeneration: gen, ifname, bootId: BOOT };
}

function step(prior: SlotAccount | undefined, s: Step): SlotAccount {
	return applySample(prior, {
		key: key(s.slot, s.gen, s.ifname),
		current: s.current,
		confidence: s.confidence ?? 'high',
		cycleStartMs: s.cycleStartMs ?? 1000,
	});
}

describe('applySample — two modems tracked independently', () => {
	test('separate slots never cross-contaminate', () => {
		let a = step(undefined, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 100 });
		let b = step(undefined, { slot: SLOT_B, gen: 0, ifname: 'wwan1', current: 5000 });
		a = step(a, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 300 });
		b = step(b, { slot: SLOT_B, gen: 0, ifname: 'wwan1', current: 5001 });
		expect(a.cycleBytes).toBe(200);
		expect(b.cycleBytes).toBe(1);
	});
});

describe('applySample — A/B ifname swap follows the slot, not the interface', () => {
	test('each slot keeps its own total across a swap and re-baselines zero-delta', () => {
		// Prime: A on wwan0, B on wwan1.
		let a = step(undefined, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 100 });
		let b = step(undefined, { slot: SLOT_B, gen: 0, ifname: 'wwan1', current: 1000 });
		a = step(a, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 200 });
		b = step(b, { slot: SLOT_B, gen: 0, ifname: 'wwan1', current: 1100 });
		expect(a.cycleBytes).toBe(100);
		expect(b.cycleBytes).toBe(100);

		// Swap: A now maps to wwan1, B to wwan0 (mapping generation bumps for both).
		// First post-swap sample must be zero-delta despite the large counter change.
		a = step(a, { slot: SLOT_A, gen: 1, ifname: 'wwan1', current: 1100 });
		b = step(b, { slot: SLOT_B, gen: 1, ifname: 'wwan0', current: 200 });
		expect(a.cycleBytes).toBe(100);
		expect(b.cycleBytes).toBe(100);

		// Subsequent growth attributes to the correct slot on its new interface.
		a = step(a, { slot: SLOT_A, gen: 1, ifname: 'wwan1', current: 1150 });
		b = step(b, { slot: SLOT_B, gen: 1, ifname: 'wwan0', current: 260 });
		expect(a.cycleBytes).toBe(150);
		expect(b.cycleBytes).toBe(160);
	});
});

describe('applySample — old ifname reused by a different slot (no bleed)', () => {
	test('a new slot inheriting an old interface starts from zero', () => {
		let a = step(undefined, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 100 });
		a = step(a, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 500 });
		expect(a.cycleBytes).toBe(400);

		// Slot C now occupies wwan0. Its own account starts fresh (zero-delta baseline).
		let c = step(undefined, { slot: SLOT_C, gen: 0, ifname: 'wwan0', current: 500 });
		c = step(c, { slot: SLOT_C, gen: 0, ifname: 'wwan0', current: 700 });
		expect(c.cycleBytes).toBe(200);
		// A's total is untouched — no bleed either direction.
		expect(a.cycleBytes).toBe(400);
	});
});

describe('applySample — rename-first-sample is zero-delta', () => {
	test('the first sample after a remap never reports a spurious jump', () => {
		let s = step(undefined, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 100 });
		s = step(s, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 200 });
		expect(s.cycleBytes).toBe(100);
		// Rename wwan0 → wwan5 with a huge counter: must NOT attribute 9M.
		s = step(s, { slot: SLOT_A, gen: 1, ifname: 'wwan5', current: 9_000_000 });
		expect(s.cycleBytes).toBe(100);
	});
});

describe('applySample — reset-then-positive', () => {
	test('a counter reset clamps to zero, then normal increases resume', () => {
		let s = step(undefined, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 1000 });
		s = step(s, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 1500 });
		expect(s.cycleBytes).toBe(500);
		// Interface recreated: counter drops to 50 (decrease) → clamp + rebase.
		s = step(s, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 50 });
		expect(s.cycleBytes).toBe(500);
		// Growth from the rebased baseline is tracked again.
		s = step(s, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 250 });
		expect(s.cycleBytes).toBe(700);
	});

	test('a decrease never produces a negative delta', () => {
		let s = step(undefined, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 800 });
		s = step(s, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 300 });
		expect(s.cycleBytes).toBe(0);
		expect(s.cycleBytes).toBeGreaterThanOrEqual(0);
	});
});

describe('applySample — ambiguous identity pauses sampling', () => {
	test('low confidence attributes nothing and re-baselines zero-delta on resume', () => {
		let s = step(undefined, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 100 });
		s = step(s, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 300 });
		expect(s.cycleBytes).toBe(200);
		// Identity turns ambiguous → paused; the counter keeps climbing unattributed.
		s = step(s, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 9999, confidence: 'low' });
		expect(s.paused).toBe(true);
		expect(s.cycleBytes).toBe(200);
		// Confidence returns: resume is zero-delta, so the paused-window bytes are NOT
		// back-attributed; only growth after resume counts.
		s = step(s, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 9999 });
		expect(s.paused).toBe(false);
		expect(s.cycleBytes).toBe(200);
		s = step(s, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 10_099 });
		expect(s.cycleBytes).toBe(300);
	});
});

describe('applySample — cycle rollover resets the per-cycle total', () => {
	test('crossing into a newer cycle zeroes cycleBytes but keeps the baseline', () => {
		let s = step(undefined, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 100 });
		s = step(s, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 600 });
		expect(s.cycleBytes).toBe(500);
		// New cycle boundary — cycleBytes resets, counter continuity preserved.
		s = step(s, { slot: SLOT_A, gen: 0, ifname: 'wwan0', current: 650, cycleStartMs: 2000 });
		expect(s.cycleStartMs).toBe(2000);
		expect(s.cycleBytes).toBe(50);
	});
});
