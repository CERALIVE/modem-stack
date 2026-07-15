// Recovery budget — the bounded-attempts / cooldown / loop-stop circuit breaker.
//
// A permanently-broken modem must not be recovered forever. The budget caps how many
// attempts may fire within a cooldown window; once the cap is spent it latches the
// modem `degraded` (the loop-stop), and no further attempt is allowed until an
// explicit reset. This module is a PURE reducer: it owns no clock and mutates
// nothing — the caller supplies `now` and stores the returned next state.

import type { EpochMillis } from '../domain';

/**
 * Recovery budget. `maxAttempts` recovery attempts are allowed before the loop-stop
 * engages; two attempts sooner than `cooldownMs` apart are refused (cooldown).
 */
export interface RecoveryBudget {
	readonly maxAttempts: number;
	readonly cooldownMs: number;
}

/** The Phase-A default: two attempts, 30s cooldown between them. */
export const DEFAULT_RECOVERY_BUDGET: RecoveryBudget = {
	maxAttempts: 2,
	cooldownMs: 30_000,
};

/**
 * Per-modem budget bookkeeping. `degraded` is a LATCH: once the loop-stop fires it
 * stays set until an explicit `markRecovered`, so a flapping modem is left degraded
 * rather than retried forever.
 */
export interface RecoveryBudgetState {
	readonly attempts: number;
	readonly degraded: boolean;
	readonly lastAttemptAt?: EpochMillis;
}

/** A fresh, un-attempted budget state. */
export const INITIAL_BUDGET_STATE: RecoveryBudgetState = {
	attempts: 0,
	degraded: false,
};

/** The verdict on whether a recovery attempt may proceed, plus the next state. */
export type BudgetDecision =
	| { readonly kind: 'proceed'; readonly state: RecoveryBudgetState }
	| {
			readonly kind: 'cooldown';
			readonly state: RecoveryBudgetState;
			readonly retryAfter: EpochMillis;
	  }
	| { readonly kind: 'loop-stop'; readonly state: RecoveryBudgetState };

/**
 * Decide whether a recovery attempt may proceed at `now`, returning the NEXT state:
 *   - already `degraded`            → loop-stop (latched; zero further attempts)
 *   - within `cooldownMs` of last   → cooldown  (refused; attempts NOT incremented)
 *   - budget already spent          → loop-stop (latch `degraded`)
 *   - otherwise                     → proceed   (attempts + 1; stamp `lastAttemptAt`)
 */
export function beginAttempt(
	state: RecoveryBudgetState,
	budget: RecoveryBudget,
	now: EpochMillis,
): BudgetDecision {
	if (state.degraded) {
		return { kind: 'loop-stop', state };
	}
	if (state.lastAttemptAt !== undefined && now - state.lastAttemptAt < budget.cooldownMs) {
		const retryAfter = (state.lastAttemptAt + budget.cooldownMs) as EpochMillis;
		return { kind: 'cooldown', state, retryAfter };
	}
	if (state.attempts >= budget.maxAttempts) {
		return { kind: 'loop-stop', state: { ...state, degraded: true } };
	}
	return {
		kind: 'proceed',
		state: { attempts: state.attempts + 1, degraded: false, lastAttemptAt: now },
	};
}

/** A successful recovery clears the counter and the degraded latch. */
export function markRecovered(): RecoveryBudgetState {
	return INITIAL_BUDGET_STATE;
}
