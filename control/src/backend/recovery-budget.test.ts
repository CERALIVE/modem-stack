// Recovery budget — pure reducer proof: bounded attempts, cooldown refusal, and the
// loop-stop latch that marks a flapping modem degraded.

import { describe, expect, test } from 'bun:test';
import { epochMillis } from '../domain';
import {
	beginAttempt,
	INITIAL_BUDGET_STATE,
	markRecovered,
	type RecoveryBudget,
	type RecoveryBudgetState,
} from './recovery-budget';

const budget: RecoveryBudget = { maxAttempts: 2, cooldownMs: 1000 };

describe('beginAttempt — budget / cooldown / loop-stop', () => {
	test('a fresh modem proceeds and increments attempts', () => {
		const decision = beginAttempt(INITIAL_BUDGET_STATE, budget, epochMillis(0));
		expect(decision.kind).toBe('proceed');
		expect(decision.state.attempts).toBe(1);
		expect(decision.state.lastAttemptAt).toBe(epochMillis(0));
	});

	test('a second attempt sooner than cooldownMs is refused (not counted)', () => {
		const first = beginAttempt(INITIAL_BUDGET_STATE, budget, epochMillis(0));
		const second = beginAttempt(first.state, budget, epochMillis(500));
		expect(second.kind).toBe('cooldown');
		// Attempts unchanged — a refused attempt does not spend budget.
		expect(second.state.attempts).toBe(1);
		if (second.kind === 'cooldown') {
			expect(second.retryAfter).toBe(epochMillis(1000));
		}
	});

	test('exactly maxAttempts proceed, then the loop-stop latches degraded', () => {
		let state: RecoveryBudgetState = INITIAL_BUDGET_STATE;
		// Attempt 1 at t=0, attempt 2 at t=1000 (past cooldown) both proceed.
		const a1 = beginAttempt(state, budget, epochMillis(0));
		expect(a1.kind).toBe('proceed');
		state = a1.state;
		const a2 = beginAttempt(state, budget, epochMillis(1000));
		expect(a2.kind).toBe('proceed');
		state = a2.state;
		expect(state.attempts).toBe(2);
		// Attempt 3 past cooldown: budget spent → loop-stop, degraded latched.
		const a3 = beginAttempt(state, budget, epochMillis(2000));
		expect(a3.kind).toBe('loop-stop');
		expect(a3.state.degraded).toBe(true);
	});

	test('once degraded, every further attempt is loop-stopped (latched)', () => {
		const degraded: RecoveryBudgetState = { attempts: 2, degraded: true };
		const again = beginAttempt(degraded, budget, epochMillis(999_999));
		expect(again.kind).toBe('loop-stop');
		expect(again.state.degraded).toBe(true);
	});

	test('markRecovered clears the counter and the degraded latch', () => {
		expect(markRecovered()).toEqual(INITIAL_BUDGET_STATE);
		const reset = markRecovered();
		expect(reset.attempts).toBe(0);
		expect(reset.degraded).toBe(false);
	});
});
