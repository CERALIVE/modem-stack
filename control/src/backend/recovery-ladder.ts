// The evidence-gated recovery ladder — disabled by default.
//
// A bounded four-rung ladder [1 nm-cycle: NM deactivate→reactivate exact pair; 2
// mm-cycle: MM disable→enable; 3 reset: MM Reset(); 4 power-cycle: power hook (only
// `none` → always unsupported)]. Every disruptive rung routes through A3.3's shared
// per-modem `ModemActor` (serialised behind all other disruptive ops) and consults
// the `LifecycleInterlock` first so it never disrupts a streaming modem. GATES, in
// order: recovery.enabled=false → zero steps · attribution≠modem-fault → zero steps ·
// budget spent / cooldown → zero steps · per-rung allowDisruptive · interlock.
// Disabled or un-attributed, NOT ONE side-effecting call is made.

import type { DesiredRecovery, EpochMillis } from '../domain';
import type { ModemRef } from '../ports';
import { ALLOW_ALL_INTERLOCK, type LifecycleInterlock } from './lifecycle-interlock';
import type { ModemActor } from './modem-actor';
import { NONE_POWER_HOOK, type PowerHook } from './power-contract';
import type { FaultAttribution } from './recovery-attribution';
import {
	beginAttempt,
	DEFAULT_RECOVERY_BUDGET,
	INITIAL_BUDGET_STATE,
	markRecovered,
	type RecoveryBudget,
	type RecoveryBudgetState,
} from './recovery-budget';

export const LADDER_ORDER = ['nmCycle', 'mmCycle', 'reset', 'powerCycle'] as const;
export type RecoveryRung = (typeof LADDER_ORDER)[number];

/** Context handed to each disruptive rung. */
export interface RecoveryStepContext {
	readonly stableKey: string;
	readonly modem: ModemRef;
	readonly at: EpochMillis;
}

/** Outcome of a disruptive rung (1–3). */
export interface StepOutcome {
	readonly status: 'applied' | 'failed';
	readonly reason: string;
}

/**
 * The disruptive recovery actions for rungs 1–3. Each is the raw effect only — the
 * ladder wraps every call in `actor.run(stableKey, …)`, so serialisation is the
 * ladder's job, not the step's. Phase A injects a fake in tests; the real D-Bus / NM
 * implementation (hardware-gated) is wired at the composition root.
 */
export interface RecoverySteps {
	/** Rung 1: NM deactivate then reactivate — an EXACT pair, never a bare deactivate. */
	nmCycle(context: RecoveryStepContext): Promise<StepOutcome>;
	/** Rung 2: MM disable then enable. */
	mmCycle(context: RecoveryStepContext): Promise<StepOutcome>;
	/** Rung 3: MM `Reset()`. */
	reset(context: RecoveryStepContext): Promise<StepOutcome>;
}

export interface RecoveryStepGate {
	readonly allowDisruptive: boolean;
}

/** The ladder's operational config: per-rung gates + the attempt budget. */
export interface RecoveryLadderConfig {
	readonly nmCycle: RecoveryStepGate;
	readonly mmCycle: RecoveryStepGate;
	readonly reset: RecoveryStepGate;
	readonly powerCycle: RecoveryStepGate;
	readonly budget: RecoveryBudget;
}

const ALLOW: RecoveryStepGate = { allowDisruptive: true };

/** Default config: every rung permitted, default budget. */
export const DEFAULT_LADDER_CONFIG: RecoveryLadderConfig = {
	nmCycle: ALLOW,
	mmCycle: ALLOW,
	reset: ALLOW,
	powerCycle: ALLOW,
	budget: DEFAULT_RECOVERY_BUDGET,
};

export interface RecoveryStepReport {
	readonly rung: RecoveryRung;
	readonly status: 'applied' | 'unsupported' | 'failed' | 'skipped' | 'blocked';
	readonly reason: string;
}

/** How a whole ladder invocation ended. */
export type RecoveryOutcomeKind =
	| 'disabled'
	| 'not-attributed'
	| 'cooldown'
	| 'loop-stop'
	| 'interlock-blocked'
	| 'recovered'
	| 'exhausted';

/** The result of one ladder invocation. */
export interface RecoveryOutcome {
	readonly kind: RecoveryOutcomeKind;
	readonly attribution: FaultAttribution;
	readonly steps: readonly RecoveryStepReport[];
	readonly degraded: boolean;
	readonly reason: string;
}

/** One recovery request for one modem at one instant. */
export interface RecoveryRequest {
	readonly stableKey: string;
	readonly modem: ModemRef;
	/** The pre-computed attribution (see `attributeFault`). */
	readonly attribution: FaultAttribution;
	readonly now: EpochMillis;
	/** Re-checked AFTER an applied rung; `true` ⇒ the modem recovered (ladder stops). */
	readonly probeHealthy: () => Promise<boolean>;
}

/** Dependencies the ladder is constructed with. */
export interface RecoveryLadderDeps {
	readonly actor: ModemActor;
	readonly steps: RecoverySteps;
	readonly powerHook?: PowerHook;
	readonly interlock?: LifecycleInterlock;
	readonly config?: RecoveryLadderConfig;
}

/**
 * The recovery ladder. Holds per-modem budget state keyed by stable key so the
 * loop-stop can latch a flapping modem `degraded` across invocations.
 */
export class RecoveryLadder {
	readonly #actor: ModemActor;
	readonly #steps: RecoverySteps;
	readonly #powerHook: PowerHook;
	readonly #interlock: LifecycleInterlock;
	readonly #config: RecoveryLadderConfig;
	readonly #states = new Map<string, RecoveryBudgetState>();

	constructor(deps: RecoveryLadderDeps) {
		this.#actor = deps.actor;
		this.#steps = deps.steps;
		this.#powerHook = deps.powerHook ?? NONE_POWER_HOOK;
		this.#interlock = deps.interlock ?? ALLOW_ALL_INTERLOCK;
		this.#config = deps.config ?? DEFAULT_LADDER_CONFIG;
	}

	/** The current budget state for a modem (for observability / assertions). */
	budgetStateFor(stableKey: string): RecoveryBudgetState {
		return this.#states.get(stableKey) ?? INITIAL_BUDGET_STATE;
	}

	/** Clear a modem's budget / degraded latch (operator un-degrade). */
	clear(stableKey: string): void {
		this.#states.delete(stableKey);
	}

	/** Run one recovery attempt. Enforces every gate before any side effect. */
	async run(recovery: DesiredRecovery, request: RecoveryRequest): Promise<RecoveryOutcome> {
		const { stableKey, attribution } = request;

		// GATE 1 — master switch. Disabled ⇒ literally zero steps, zero side effects.
		if (!recovery.enabled) {
			return this.#end('disabled', request, [], 'recovery disabled by policy');
		}
		// GATE 2 — attribution. Only a confident modem-fault may ever be disruptive.
		if (attribution !== 'modem-fault') {
			return this.#end(
				'not-attributed',
				request,
				[],
				`attribution '${attribution}' is never disruptive`,
			);
		}
		// GATE 3 — budget / cooldown / loop-stop.
		const decision = beginAttempt(this.budgetStateFor(stableKey), this.#config.budget, request.now);
		if (decision.kind === 'loop-stop') {
			this.#states.set(stableKey, decision.state);
			return this.#end(
				'loop-stop',
				request,
				[],
				'recovery budget exhausted — modem marked degraded',
			);
		}
		if (decision.kind === 'cooldown') {
			return this.#end('cooldown', request, [], 'within cooldown window — attempt refused');
		}
		this.#states.set(stableKey, decision.state);

		return this.#runRungs(request);
	}

	async #runRungs(request: RecoveryRequest): Promise<RecoveryOutcome> {
		const { stableKey } = request;
		const context: RecoveryStepContext = { stableKey, modem: request.modem, at: request.now };
		const steps: RecoveryStepReport[] = [];

		for (const rung of LADDER_ORDER) {
			if (!this.#config[rung].allowDisruptive) {
				steps.push({ rung, status: 'skipped', reason: 'allowDisruptive is false' });
				continue;
			}
			// Interlock BEFORE any disruptive step — never disrupt a streaming modem.
			const verdict = await this.#interlock.canDisrupt({ stableKey });
			if (!verdict.allow) {
				steps.push({ rung, status: 'blocked', reason: verdict.reason });
				return this.#end(
					'interlock-blocked',
					request,
					steps,
					`interlock blocked '${rung}': ${verdict.reason}`,
				);
			}
			const report = await this.#runRung(rung, context);
			steps.push(report);
			if (report.status === 'applied' && (await request.probeHealthy())) {
				this.#states.set(stableKey, markRecovered());
				return this.#end('recovered', request, steps, `recovered at rung '${rung}'`);
			}
		}
		return this.#end('exhausted', request, steps, 'ladder exhausted without restoring health');
	}

	async #runRung(rung: RecoveryRung, context: RecoveryStepContext): Promise<RecoveryStepReport> {
		if (rung === 'powerCycle') {
			const result = await this.#powerHook.cycle({ stableKey: context.stableKey, at: context.at });
			return { rung, status: result.status, reason: result.reason };
		}
		// Rungs 1–3 route through the shared per-modem actor for serialisation.
		const step = this.#steps[rung];
		const outcome = await this.#actor.run(context.stableKey, () => step(context));
		return { rung, status: outcome.status, reason: outcome.reason };
	}

	#end(
		kind: RecoveryOutcomeKind,
		request: RecoveryRequest,
		steps: readonly RecoveryStepReport[],
		reason: string,
	): RecoveryOutcome {
		return {
			kind,
			attribution: request.attribution,
			steps,
			degraded: this.budgetStateFor(request.stableKey).degraded,
			reason,
		};
	}
}
