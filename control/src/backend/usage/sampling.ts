import type { DesiredUsage } from '../../domain';
import { epochMillis } from '../../domain';
import { applySample, type BaselineKey, initialAccount, type SlotAccount } from './accounting';
import { cycleStart } from './billing-cycle';
import type { UsageObservation } from './sampler';

export interface UsageSamplingState {
	readonly bootId: string;
	readonly defaultCycleDay: number;
	readonly accounts: Map<string, SlotAccount>;
	readonly policies: Map<string, DesiredUsage>;
	readonly policyOverrides: ReadonlyMap<string, DesiredUsage>;
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
			continue;
		}
		const key: BaselineKey = {
			logicalSlotId: slotId,
			mappingGeneration: observation.mappingGeneration,
			ifname: observation.ifname,
			bootId: state.bootId,
		};
		const next = applySample(state.accounts.get(slotId), {
			key,
			current,
			confidence: observation.confidence,
			cycleStartMs,
		});
		state.accounts.set(slotId, next);
	}
}
