import type { DesiredUsage } from '../../domain';
import { epochMillis } from '../../domain';
import {
	applySample,
	type BaselineKey,
	initialAccount,
	type SlotAccount,
	sameBaselineKey,
} from './accounting';
import { cycleStart } from './billing-cycle';
import type { UsageObservation } from './sampler';

/**
 * One slot's throughput measurement.
 *
 * `sampledAtMs` is when the counter behind the current baseline was read; without it
 * there is no interval to divide a delta by. `bytesPerSecond` is ABSENT — never zero —
 * whenever this pass had no measurable interval, and that is a frequent, real answer:
 * the first sample, a rebaseline, a paused slot, an interface missing from the counter
 * table, and a counter that went BACKWARDS each produce one.
 *
 * The backwards case is the one worth spelling out. `/proc/net/dev` counters are
 * per-interface and cumulative, and they restart at zero when the interface is
 * re-created — a modem replug, a `wwan0` teardown, a driver reload. Subtracting across
 * that boundary yields a negative number, and both obvious repairs report something
 * untrue: clamping to zero shows an idle link that was in fact carrying traffic, while
 * taking the raw post-reset value shows every byte since the interface came up as if it
 * had all moved inside one sampling interval. Reporting NOTHING is the honest answer,
 * and `applySample` rebases the baseline in the same pass so the NEXT interval measures
 * correctly rather than inheriting the gap.
 *
 * Idea provenance: `irlserver/modem-metrics` (MIT) — concepts adopted, no source code
 * copied. See `docs/adr/ADR-STAY-TYPESCRIPT.md`.
 */
export interface SlotRate {
	readonly sampledAtMs: number;
	readonly bytesPerSecond?: number;
}

export interface UsageSamplingState {
	readonly bootId: string;
	readonly defaultCycleDay: number;
	readonly accounts: Map<string, SlotAccount>;
	readonly policies: Map<string, DesiredUsage>;
	readonly policyOverrides: ReadonlyMap<string, DesiredUsage>;
	readonly rates: Map<string, SlotRate>;
}

interface RateInput {
	readonly key: BaselineKey;
	readonly current: number;
	readonly confidence: UsageObservation['confidence'];
}

/**
 * Measure one interval, or state that there was none. Pure — the caller supplies the
 * prior account, the prior rate sample and `now`. Every early return is a case where a
 * number could be produced but would not be a measurement; see `SlotRate`.
 */
function measureRate(
	prior: SlotAccount | undefined,
	priorRate: SlotRate | undefined,
	input: RateInput,
	now: number,
): SlotRate {
	const unmeasured: SlotRate = { sampledAtMs: now };
	if (input.confidence === 'low') {
		return unmeasured;
	}
	if (
		prior === undefined ||
		prior.paused ||
		prior.key === undefined ||
		prior.lastObserved === undefined
	) {
		return unmeasured;
	}
	if (!sameBaselineKey(prior.key, input.key)) {
		return unmeasured;
	}
	// No prior rate sample means no interval was ever measured under this baseline —
	// it was restored from disk, or the interface was absent from the last pass. The
	// elapsed wall time is then a gap, not a sampling interval.
	if (priorRate === undefined) {
		return unmeasured;
	}
	if (input.current < prior.lastObserved) {
		return unmeasured;
	}
	const elapsedMs = now - priorRate.sampledAtMs;
	if (elapsedMs <= 0) {
		return unmeasured;
	}
	return {
		sampledAtMs: now,
		bytesPerSecond: ((input.current - prior.lastObserved) * 1000) / elapsedMs,
	};
}

export function applyUsageSamples(
	state: UsageSamplingState,
	observations: readonly UsageObservation[],
	counters: ReadonlyMap<string, number>,
	now: number,
): void {
	for (const observation of observations) {
		const slotId = observation.logicalSlotId as string;
		const usage = state.policyOverrides.get(slotId) ?? observation.usage;
		state.policies.set(slotId, usage);
		const cycleDay = usage.cycleDay ?? state.defaultCycleDay;
		const cycleStartMs = cycleStart(epochMillis(now), cycleDay);
		const current = counters.get(observation.ifname);
		if (current === undefined) {
			if (!state.accounts.has(slotId)) {
				state.accounts.set(slotId, initialAccount(cycleStartMs));
			}
			// The counter was not readable this pass. Dropping the rate sample costs
			// the NEXT pass its rate too, which is the point: whatever moved while the
			// interface was missing did not move inside one sampling interval, and
			// dividing it by one would render an invented spike.
			state.rates.delete(slotId);
			continue;
		}
		const key: BaselineKey = {
			logicalSlotId: slotId,
			mappingGeneration: observation.mappingGeneration,
			ifname: observation.ifname,
			bootId: state.bootId,
		};
		const prior = state.accounts.get(slotId);
		const rateInput: RateInput = { key, current, confidence: observation.confidence };
		state.rates.set(slotId, measureRate(prior, state.rates.get(slotId), rateInput, now));
		const next = applySample(prior, { ...rateInput, cycleStartMs });
		state.accounts.set(slotId, next);
	}
}
