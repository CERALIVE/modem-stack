// The usage sampler — orchestrates the counter source, pure accounting reducer,
// billing-cycle math, and fail-soft persistence into one internal service.
//
// SESSION = the kernel boot id. Interface byte counters reset to zero on reboot, so
// the boot id both scopes every baseline key AND lets a reload detect a reboot: a
// persisted document from a different boot keeps its per-cycle totals but drops its
// baselines, so the first post-reboot sample re-baselines zero-delta.
//
// PERSISTENCE: state is written at most once per minute (rate-limited) plus a
// `flush()` shutdown hook. A crash therefore loses AT MOST ~1 minute of unpersisted
// deltas (the window since the last rate-limited write); a clean shutdown calls
// `flush()` and loses effectively nothing.

import { type DesiredUsage, epochMillis, type LogicalSlotId } from '../../domain';
import { applySample, type BaselineKey, initialAccount, type SlotAccount } from './accounting';
import { cycleStart } from './billing-cycle';
import type { CounterSource } from './proc-net-dev';
import type { PersistedSlot, PersistedUsage, UsageStore } from './store';
import { USAGE_SCHEMA_VERSION } from './store';

/** One slot's observation for a sampling pass — identity + mapping + local policy. */
export interface UsageObservation {
	readonly logicalSlotId: LogicalSlotId;
	/** Bumped by A4.2 whenever the ifname-to-slot mapping changes (→ zero-delta rebase). */
	readonly mappingGeneration: number;
	readonly ifname: string;
	/** A3.2 identity-ladder confidence; `low` pauses sampling for this slot. */
	readonly confidence: 'high' | 'medium' | 'low';
	/** Local-controller-owned usage policy (cycle day + advisory threshold). */
	readonly usage: DesiredUsage;
}

/** A queryable per-slot usage figure — consumed by the A6.1 bench CLI `usage` command. */
export interface SlotUsageSnapshot {
	readonly logicalSlotId: string;
	readonly cycleBytes: number;
	readonly cycleStartMs: number;
	readonly paused: boolean;
	readonly thresholdBytes?: number;
	/** Advisory-only: `cycleBytes > thresholdBytes`. Never gates the connection. */
	readonly thresholdExceeded: boolean;
}

/** The sampler's current state, per slot, at a point in time. */
export interface UsageSnapshot {
	readonly bootId: string;
	readonly generatedAtMs: number;
	readonly slots: readonly SlotUsageSnapshot[];
}

export interface UsageSamplerOptions {
	/** The kernel boot id (see `readBootId`) — the session identity. */
	readonly bootId: string;
	readonly source: CounterSource;
	readonly store: UsageStore;
	/** Injectable clock (defaults to `Date.now`). */
	readonly now?: () => number;
	/** Minimum spacing between persists (default 60_000 ms = the ≤1-min loss bound). */
	readonly persistIntervalMs?: number;
	/** Cycle day used when a slot's policy omits `cycleDay` (default 1 = 1st of month). */
	readonly defaultCycleDay?: number;
}

const DEFAULT_PERSIST_INTERVAL_MS = 60_000;
const DEFAULT_CYCLE_DAY = 1;

function toPersistedSlot(logicalSlotId: string, account: SlotAccount): PersistedSlot {
	return {
		logicalSlotId,
		cycleBytes: account.cycleBytes,
		cycleStartMs: account.cycleStartMs,
		...(account.key !== undefined
			? { mappingGeneration: account.key.mappingGeneration, ifname: account.key.ifname }
			: {}),
		...(account.lastObserved !== undefined ? { lastObserved: account.lastObserved } : {}),
	};
}

export class UsageSampler {
	readonly #bootId: string;
	readonly #source: CounterSource;
	readonly #store: UsageStore;
	readonly #now: () => number;
	readonly #persistIntervalMs: number;
	readonly #defaultCycleDay: number;
	readonly #accounts = new Map<string, SlotAccount>();
	readonly #policies = new Map<string, DesiredUsage>();
	#lastPersistMs: number;
	#dirty = false;

	private constructor(options: UsageSamplerOptions, initial: PersistedUsage) {
		this.#bootId = options.bootId;
		this.#source = options.source;
		this.#store = options.store;
		this.#now = options.now ?? Date.now;
		this.#persistIntervalMs = options.persistIntervalMs ?? DEFAULT_PERSIST_INTERVAL_MS;
		this.#defaultCycleDay = options.defaultCycleDay ?? DEFAULT_CYCLE_DAY;
		this.#lastPersistMs = this.#now();
		this.#hydrate(initial);
	}

	/** Load persisted state (recreating a fresh file if absent/corrupt) then build the sampler. */
	static async create(options: UsageSamplerOptions): Promise<UsageSampler> {
		const now = options.now ?? Date.now;
		const initial = await options.store.load(options.bootId, now());
		return new UsageSampler(options, initial);
	}

	/** Rebuild in-memory accounts. A reboot (differing boot id) drops the baselines. */
	#hydrate(initial: PersistedUsage): void {
		const sameBoot = initial.bootId === this.#bootId;
		for (const slot of initial.slots) {
			const canResume =
				sameBoot &&
				slot.ifname !== undefined &&
				slot.mappingGeneration !== undefined &&
				slot.lastObserved !== undefined;
			if (canResume) {
				const key: BaselineKey = {
					logicalSlotId: slot.logicalSlotId,
					mappingGeneration: slot.mappingGeneration as number,
					ifname: slot.ifname as string,
					bootId: this.#bootId,
				};
				this.#accounts.set(slot.logicalSlotId, {
					cycleBytes: slot.cycleBytes,
					cycleStartMs: slot.cycleStartMs,
					paused: false,
					key,
					lastObserved: slot.lastObserved as number,
				});
			} else {
				this.#accounts.set(slot.logicalSlotId, {
					cycleBytes: slot.cycleBytes,
					cycleStartMs: slot.cycleStartMs,
					paused: false,
				});
			}
		}
	}

	/** Take one sampling pass over the current counters for the given observations. */
	async sample(observations: readonly UsageObservation[]): Promise<void> {
		const counters = await this.#source.read();
		const now = this.#now();
		for (const obs of observations) {
			const slotId = obs.logicalSlotId as string;
			this.#policies.set(slotId, obs.usage);
			const cycleDay = obs.usage.cycleDay ?? this.#defaultCycleDay;
			const cycleStartMs = cycleStart(epochMillis(now), cycleDay);
			const current = counters.get(obs.ifname);
			if (current === undefined) {
				// No reading for this interface — ensure the slot exists, attribute nothing.
				if (!this.#accounts.has(slotId)) {
					this.#accounts.set(slotId, initialAccount(cycleStartMs));
				}
				continue;
			}
			const key: BaselineKey = {
				logicalSlotId: slotId,
				mappingGeneration: obs.mappingGeneration,
				ifname: obs.ifname,
				bootId: this.#bootId,
			};
			const next = applySample(this.#accounts.get(slotId), {
				key,
				current,
				confidence: obs.confidence,
				cycleStartMs,
			});
			this.#accounts.set(slotId, next);
		}
		this.#dirty = true;
		await this.#maybePersist(now);
	}

	/** Current per-slot usage — the queryable snapshot the CLI and platform read. */
	snapshot(): UsageSnapshot {
		const generatedAtMs = this.#now();
		const slots: SlotUsageSnapshot[] = [];
		for (const [slotId, account] of this.#accounts) {
			const thresholdBytes = this.#policies.get(slotId)?.thresholdBytes;
			slots.push({
				logicalSlotId: slotId,
				cycleBytes: account.cycleBytes,
				cycleStartMs: account.cycleStartMs,
				paused: account.paused,
				...(thresholdBytes !== undefined ? { thresholdBytes } : {}),
				thresholdExceeded: thresholdBytes !== undefined && account.cycleBytes > thresholdBytes,
			});
		}
		return { bootId: this.#bootId, generatedAtMs, slots };
	}

	/** Flush unpersisted state immediately — the shutdown hook (bounds loss to ≤1 min). */
	async flush(): Promise<void> {
		if (this.#dirty) {
			await this.#persist(this.#now());
		}
	}

	async #maybePersist(now: number): Promise<void> {
		if (now - this.#lastPersistMs >= this.#persistIntervalMs) {
			await this.#persist(now);
		}
	}

	async #persist(now: number): Promise<void> {
		const slots: PersistedSlot[] = [];
		for (const [slotId, account] of this.#accounts) {
			slots.push(toPersistedSlot(slotId, account));
		}
		const state: PersistedUsage = {
			schemaVersion: USAGE_SCHEMA_VERSION,
			bootId: this.#bootId,
			savedAtMs: now,
			slots,
		};
		await this.#store.save(state);
		this.#lastPersistMs = now;
		this.#dirty = false;
	}
}

/** Load persisted state and build a ready sampler. See `UsageSampler.create`. */
export function createUsageSampler(options: UsageSamplerOptions): Promise<UsageSampler> {
	return UsageSampler.create(options);
}
