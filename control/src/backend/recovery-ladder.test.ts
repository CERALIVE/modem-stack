// The recovery ladder — the safety gates are the whole point:
//   - disabled by default ⇒ literally ZERO side effects (throwing spies prove it)
//   - only a confident modem-fault may ever be disruptive
//   - budget → loop-stop marks a flapping modem degraded, never retried forever
//   - a successful step restores health and resets the budget
//   - rung 4 (power) is always unsupported in Phase A
//   - disruptive rungs route through the shared per-modem actor (serialisation)

import { describe, expect, test } from 'bun:test';
import { type DesiredRecovery, epochMillis, runtimePath } from '../domain';
import { ALLOW_ALL_INTERLOCK, type LifecycleInterlock } from './lifecycle-interlock';
import { ModemActor } from './modem-actor';
import { NONE_POWER_CAPABILITY, type PowerHook } from './power-contract';
import { DEFAULT_RECOVERY_BUDGET } from './recovery-budget';
import {
	RecoveryLadder,
	type RecoveryLadderConfig,
	type RecoveryRequest,
	type RecoverySteps,
	type StepOutcome,
} from './recovery-ladder';

const ENABLED: DesiredRecovery = { enabled: true };
const DISABLED: DesiredRecovery = { enabled: false };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface StepCalls {
	nmCycle: number;
	mmCycle: number;
	reset: number;
}

/** Steps that count calls and return a fixed outcome. */
function countingSteps(outcome: StepOutcome, calls: StepCalls): RecoverySteps {
	return {
		nmCycle: () => {
			calls.nmCycle += 1;
			return Promise.resolve(outcome);
		},
		mmCycle: () => {
			calls.mmCycle += 1;
			return Promise.resolve(outcome);
		},
		reset: () => {
			calls.reset += 1;
			return Promise.resolve(outcome);
		},
	};
}

/** Steps that throw if ever invoked — the strongest "zero side effects" proof. */
const throwingSteps: RecoverySteps = {
	nmCycle: () => Promise.reject(new Error('nmCycle must not fire')),
	mmCycle: () => Promise.reject(new Error('mmCycle must not fire')),
	reset: () => Promise.reject(new Error('reset must not fire')),
};

const throwingPowerHook: PowerHook = {
	capability: NONE_POWER_CAPABILITY,
	cycle: () => Promise.reject(new Error('power hook must not fire')),
};

const throwingInterlock: LifecycleInterlock = {
	canDisrupt: () => Promise.reject(new Error('interlock must not be consulted')),
};

function makeRequest(overrides: Partial<RecoveryRequest> = {}): RecoveryRequest {
	return {
		stableKey: 'slot:a',
		modem: runtimePath('/org/freedesktop/ModemManager1/Modem/0'),
		attribution: 'modem-fault',
		now: epochMillis(0),
		probeHealthy: () => Promise.resolve(false),
		...overrides,
	};
}

describe('RecoveryLadder — disabled by default fires ZERO steps', () => {
	test('recovery.enabled=false makes zero side-effecting calls, even for a clear modem-fault', async () => {
		const ladder = new RecoveryLadder({
			actor: new ModemActor(),
			steps: throwingSteps,
			powerHook: throwingPowerHook,
			interlock: throwingInterlock,
		});
		// If ANY of the throwing spies leaked through, run() would reject here.
		const outcome = await ladder.run(DISABLED, makeRequest({ attribution: 'modem-fault' }));
		expect(outcome.kind).toBe('disabled');
		expect(outcome.steps).toEqual([]);
		expect(outcome.degraded).toBe(false);
	});
});

describe('RecoveryLadder — attribution gating (never disrupt on non-modem-fault)', () => {
	for (const attribution of ['indeterminate', 'network-fault'] as const) {
		test(`enabled + '${attribution}' fires zero disruptive steps`, async () => {
			const ladder = new RecoveryLadder({
				actor: new ModemActor(),
				steps: throwingSteps,
				powerHook: throwingPowerHook,
				interlock: throwingInterlock,
			});
			const outcome = await ladder.run(ENABLED, makeRequest({ attribution }));
			expect(outcome.kind).toBe('not-attributed');
			expect(outcome.steps).toEqual([]);
		});
	}
});

describe('RecoveryLadder — budget, cooldown, loop-stop', () => {
	test('a flapping modem gets EXACTLY 2 attempts, then loop-stop marks it degraded', async () => {
		const calls: StepCalls = { nmCycle: 0, mmCycle: 0, reset: 0 };
		const ladder = new RecoveryLadder({
			actor: new ModemActor(),
			steps: countingSteps({ status: 'failed', reason: 'still broken' }, calls),
			config: { ...allowAll(), budget: { maxAttempts: 2, cooldownMs: 1000 } },
		});

		const a1 = await ladder.run(ENABLED, makeRequest({ now: epochMillis(0) }));
		const a2 = await ladder.run(ENABLED, makeRequest({ now: epochMillis(1000) }));
		const a3 = await ladder.run(ENABLED, makeRequest({ now: epochMillis(2000) }));

		expect(a1.kind).toBe('exhausted');
		expect(a2.kind).toBe('exhausted');
		expect(a3.kind).toBe('loop-stop');
		// Rung 1 fired exactly twice — the third invocation short-circuited.
		expect(calls.nmCycle).toBe(2);
		expect(a3.degraded).toBe(true);
		expect(ladder.budgetStateFor('slot:a').degraded).toBe(true);
	});

	test('a second attempt within the cooldown window is refused with zero steps', async () => {
		const calls: StepCalls = { nmCycle: 0, mmCycle: 0, reset: 0 };
		const ladder = new RecoveryLadder({
			actor: new ModemActor(),
			steps: countingSteps({ status: 'failed', reason: 'still broken' }, calls),
			config: { ...allowAll(), budget: { maxAttempts: 3, cooldownMs: 1000 } },
		});
		await ladder.run(ENABLED, makeRequest({ now: epochMillis(0) }));
		const soon = await ladder.run(ENABLED, makeRequest({ now: epochMillis(500) }));
		expect(soon.kind).toBe('cooldown');
		expect(calls.nmCycle).toBe(1);
	});
});

describe('RecoveryLadder — a successful step restores health', () => {
	test('rung 1 succeeding + a healthy probe → recovered, later rungs never run, budget reset', async () => {
		const calls: StepCalls = { nmCycle: 0, mmCycle: 0, reset: 0 };
		const ladder = new RecoveryLadder({
			actor: new ModemActor(),
			steps: countingSteps({ status: 'applied', reason: 'nm reactivated' }, calls),
		});
		const outcome = await ladder.run(
			ENABLED,
			makeRequest({ probeHealthy: () => Promise.resolve(true) }),
		);
		expect(outcome.kind).toBe('recovered');
		expect(calls.nmCycle).toBe(1);
		expect(calls.mmCycle).toBe(0);
		expect(calls.reset).toBe(0);
		expect(ladder.budgetStateFor('slot:a').attempts).toBe(0);
		expect(outcome.degraded).toBe(false);
	});
});

describe('RecoveryLadder — rung 4 (power) is always unsupported', () => {
	test('with rungs 1-3 gated off, the power rung runs and reports unsupported', async () => {
		const ladder = new RecoveryLadder({
			actor: new ModemActor(),
			// Throwing steps prove rungs 1-3 are skipped (allowDisruptive:false), not run.
			steps: throwingSteps,
			config: {
				nmCycle: { allowDisruptive: false },
				mmCycle: { allowDisruptive: false },
				reset: { allowDisruptive: false },
				powerCycle: { allowDisruptive: true },
				budget: DEFAULT_RECOVERY_BUDGET,
			},
		});
		const outcome = await ladder.run(ENABLED, makeRequest());
		expect(outcome.kind).toBe('exhausted');
		const power = outcome.steps.find((s) => s.rung === 'powerCycle');
		expect(power?.status).toBe('unsupported');
		expect(power?.reason).toContain('none');
		// The gated rungs are reported skipped, never executed.
		expect(outcome.steps.filter((s) => s.status === 'skipped').map((s) => s.rung)).toEqual([
			'nmCycle',
			'mmCycle',
			'reset',
		]);
	});
});

describe('RecoveryLadder — interlock blocks disruption', () => {
	test('a denying interlock stops the ladder before any step fires', async () => {
		const calls: StepCalls = { nmCycle: 0, mmCycle: 0, reset: 0 };
		const denying: LifecycleInterlock = {
			canDisrupt: () => Promise.resolve({ allow: false, reason: 'modem is streaming' }),
		};
		const ladder = new RecoveryLadder({
			actor: new ModemActor(),
			steps: countingSteps({ status: 'applied', reason: 'x' }, calls),
			interlock: denying,
		});
		const outcome = await ladder.run(ENABLED, makeRequest());
		expect(outcome.kind).toBe('interlock-blocked');
		expect(calls.nmCycle).toBe(0);
		expect(outcome.steps[0]?.status).toBe('blocked');
		expect(outcome.reason).toContain('streaming');
	});
});

describe('RecoveryLadder — disruptive steps route through the shared actor', () => {
	test('two same-key recoveries serialise their steps (no interleave)', async () => {
		const order: string[] = [];
		const slowSteps: RecoverySteps = {
			nmCycle: async () => {
				order.push('start');
				await sleep(20);
				order.push('end');
				return { status: 'failed', reason: 'still broken' };
			},
			mmCycle: () => Promise.resolve({ status: 'failed', reason: 'x' }),
			reset: () => Promise.resolve({ status: 'failed', reason: 'x' }),
		};
		const ladder = new RecoveryLadder({
			actor: new ModemActor(),
			// Only rung 1 is enabled so the serialisation of nmCycle is unambiguous.
			steps: slowSteps,
			interlock: ALLOW_ALL_INTERLOCK,
			config: {
				nmCycle: { allowDisruptive: true },
				mmCycle: { allowDisruptive: false },
				reset: { allowDisruptive: false },
				powerCycle: { allowDisruptive: false },
				budget: { maxAttempts: 5, cooldownMs: 0 },
			},
		});
		await Promise.all([
			ladder.run(ENABLED, makeRequest({ now: epochMillis(0) })),
			ladder.run(ENABLED, makeRequest({ now: epochMillis(1) })),
		]);
		// Serialised through the actor ⇒ the first nmCycle fully completes before the second.
		expect(order).toEqual(['start', 'end', 'start', 'end']);
	});
});

/** Every rung allowed — the shared base for budget-focused configs. */
function allowAll(): Omit<RecoveryLadderConfig, 'budget'> {
	return {
		nmCycle: { allowDisruptive: true },
		mmCycle: { allowDisruptive: true },
		reset: { allowDisruptive: true },
		powerCycle: { allowDisruptive: true },
	};
}
