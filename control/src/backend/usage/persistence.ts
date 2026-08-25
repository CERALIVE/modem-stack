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
