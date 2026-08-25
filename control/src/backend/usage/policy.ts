import type { DesiredUsage } from '../../domain';
import { epochMillis } from '../../domain';
import type { SlotAccount } from './accounting';
import { initialAccount } from './accounting';
import { cycleStart } from './billing-cycle';
import type { SlotUsageSnapshot, UsageSnapshot } from './sampler';
import type { SlotRate } from './sampling';

export interface UsagePolicyState {
	readonly bootId: string;
	readonly defaultCycleDay: number;
	readonly accounts: Map<string, SlotAccount>;
	readonly policies: Map<string, DesiredUsage>;
	readonly policyOverrides: Map<string, DesiredUsage>;
}

export interface UsagePolicyApplicationResult {
	readonly cycleStartMs: number;
	readonly cycleReset: boolean;
	readonly dirty: boolean;
}

export function applyPolicy(
	state: UsagePolicyState,
	logicalSlotId: string,
	usage: DesiredUsage,
	now: number,
): UsagePolicyApplicationResult {
	state.policyOverrides.set(logicalSlotId, usage);
	state.policies.set(logicalSlotId, usage);
	const cycleStartMs = cycleStart(
		epochMillis(now),
		usage.cycleDay ?? state.defaultCycleDay,
	) as number;
	const account = state.accounts.get(logicalSlotId);
	if (account === undefined) {
		state.accounts.set(logicalSlotId, initialAccount(cycleStartMs));
		return { cycleStartMs, cycleReset: false, dirty: true };
	}
	if (account.cycleStartMs === cycleStartMs) {
		return { cycleStartMs, cycleReset: false, dirty: false };
	}
	state.accounts.set(logicalSlotId, { ...account, cycleBytes: 0, cycleStartMs });
	return { cycleStartMs, cycleReset: true, dirty: true };
}

export interface UsageProjectionState {
	readonly bootId: string;
	readonly accounts: ReadonlyMap<string, SlotAccount>;
	readonly policies: ReadonlyMap<string, DesiredUsage>;
	readonly rates: ReadonlyMap<string, SlotRate>;
}

export function projectUsageSnapshot(
	state: UsageProjectionState,
	generatedAtMs: number,
): UsageSnapshot {
	const slots: SlotUsageSnapshot[] = [];
	for (const [slotId, account] of state.accounts) {
		const policy = state.policies.get(slotId);
		const thresholdBytes = policy?.thresholdBytes;
		// An unmeasured interval OMITS the key rather than reporting 0 — see `SlotRate`.
		const bytesPerSecond = state.rates.get(slotId)?.bytesPerSecond;
		slots.push({
			logicalSlotId: slotId,
			cycleBytes: account.cycleBytes,
			cycleStartMs: account.cycleStartMs,
			paused: account.paused,
			...(policy?.cycleDay !== undefined ? { cycleDay: policy.cycleDay } : {}),
			...(thresholdBytes !== undefined ? { thresholdBytes } : {}),
			thresholdExceeded: thresholdBytes !== undefined && account.cycleBytes > thresholdBytes,
			...(bytesPerSecond !== undefined ? { rateBytesPerSecond: bytesPerSecond } : {}),
		});
	}
	return { bootId: state.bootId, generatedAtMs, slots };
}
