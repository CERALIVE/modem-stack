// The persisted usage document — what survives a restart, and what deliberately does not.
//
// THROUGHPUT IS NOT PERSISTED, and its absence from `PersistedSlot` is a decision
// rather than an omission. A rate is a measurement over an interval whose two ends this
// process observed; a restart observed neither. Writing the last rate down would
// republish a figure measured before the gap as though it described now, and writing
// the baseline's sample TIME down would invite the next sample to divide a whole
// downtime's bytes by one sampling interval — the same invented spike `sampling.ts`
// refuses for a missing interface. So the counter BASELINE resumes across a same-boot
// reload (that is a cumulative total, and it is still true) while the rate restarts
// unmeasured. `persistence.test.ts` pins the negative.

import type { SlotAccount } from './accounting';
import type { PersistedSlot, PersistedUsage } from './store';
import { USAGE_SCHEMA_VERSION } from './store';

export function hydrateUsageAccounts(
	initial: PersistedUsage,
	bootId: string,
): Map<string, SlotAccount> {
	const accounts = new Map<string, SlotAccount>();
	const sameBoot = initial.bootId === bootId;
	for (const slot of initial.slots) {
		const canResume =
			sameBoot &&
			slot.ifname !== undefined &&
			slot.mappingGeneration !== undefined &&
			slot.lastObserved !== undefined;
		if (canResume) {
			accounts.set(slot.logicalSlotId, {
				cycleBytes: slot.cycleBytes,
				cycleStartMs: slot.cycleStartMs,
				paused: false,
				key: {
					logicalSlotId: slot.logicalSlotId,
					mappingGeneration: slot.mappingGeneration,
					ifname: slot.ifname,
					bootId,
				},
				lastObserved: slot.lastObserved,
			});
		} else {
			accounts.set(slot.logicalSlotId, {
				cycleBytes: slot.cycleBytes,
				cycleStartMs: slot.cycleStartMs,
				paused: false,
			});
		}
	}
	return accounts;
}

export function persistedUsageState(
	bootId: string,
	savedAtMs: number,
	accounts: ReadonlyMap<string, SlotAccount>,
): PersistedUsage {
	const slots: PersistedSlot[] = [];
	for (const [logicalSlotId, account] of accounts) {
		slots.push({
			logicalSlotId,
			cycleBytes: account.cycleBytes,
			cycleStartMs: account.cycleStartMs,
			...(account.key !== undefined
				? { mappingGeneration: account.key.mappingGeneration, ifname: account.key.ifname }
				: {}),
			...(account.lastObserved !== undefined ? { lastObserved: account.lastObserved } : {}),
		});
	}
	return { schemaVersion: USAGE_SCHEMA_VERSION, bootId, savedAtMs, slots };
}
