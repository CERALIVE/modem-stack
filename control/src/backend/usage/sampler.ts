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

import type { DesiredUsage, LogicalSlotId } from '../../domain';
import type { SlotAccount } from './accounting';
import { hydrateUsageAccounts, persistedUsageState } from './persistence';
import { applyPolicy, projectUsageSnapshot } from './policy';
import type { CounterSource } from './proc-net-dev';
import { applyUsageSamples, type SlotRate } from './sampling';
import type { PersistedUsage, UsageStore } from './store';

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
	/** The cycle day in force for this slot, when the operator set one. */
	readonly cycleDay?: number;
	readonly thresholdBytes?: number;
	/** Advisory-only: `cycleBytes > thresholdBytes`. Never gates the connection. */
	readonly thresholdExceeded: boolean;
	/**
	 * Throughput over the last measured sampling interval. ABSENT — never 0 — when
	 * this pass had no interval to measure: a first sample, a rebaseline, a paused
	 * slot, a missing interface, or a counter that went BACKWARDS. See `SlotRate`.
	 */
	readonly rateBytesPerSecond?: number;
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

export class UsageSampler {
	readonly #bootId: string;
	readonly #source: CounterSource;
	readonly #store: UsageStore;
	readonly #now: () => number;
	readonly #persistIntervalMs: number;
	readonly #defaultCycleDay: number;
	readonly #accounts: Map<string, SlotAccount>;
	readonly #policies = new Map<string, DesiredUsage>();
	// Policies written through `applyUsagePolicy` OUTRANK whatever an observation
	// carries, for the life of the process. Without this, the next `sample()` would
	// clobber a just-applied write with the policy the composition root happened to
	// build its observation from — and the operator would watch their setting
	// revert. The durable store is the source of truth for both, so an override and
	// an observation can only ever disagree inside that window.
	readonly #policyOverrides = new Map<string, DesiredUsage>();
	// Rates are IN-MEMORY ONLY and start empty on every construction — deliberately,
	// see `persistence.ts`. A throughput is a measurement over an interval this
	// process observed both ends of; a restart has observed neither.
	readonly #rates = new Map<string, SlotRate>();
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
		this.#accounts = hydrateUsageAccounts(initial, this.#bootId);
	}

	/** Load persisted state (recreating a fresh file if absent/corrupt) then build the sampler. */
	static async create(options: UsageSamplerOptions): Promise<UsageSampler> {
		const now = options.now ?? Date.now;
		const initial = await options.store.load(options.bootId, now());
		return new UsageSampler(options, initial);
	}

	/** Take one sampling pass over the current counters for the given observations. */
	async sample(observations: readonly UsageObservation[]): Promise<void> {
		const counters = await this.#source.read();
		const now = this.#now();
		applyUsageSamples(
			{
				bootId: this.#bootId,
				defaultCycleDay: this.#defaultCycleDay,
				accounts: this.#accounts,
				policies: this.#policies,
				policyOverrides: this.#policyOverrides,
				rates: this.#rates,
			},
			observations,
			counters,
			now,
		);
		this.#dirty = true;
		await this.#maybePersist(now);
	}

	/** Current per-slot usage — the queryable snapshot the CLI and platform read. */
	snapshot(): UsageSnapshot {
		return projectUsageSnapshot(
			{
				bootId: this.#bootId,
				accounts: this.#accounts,
				policies: this.#policies,
				rates: this.#rates,
			},
			this.#now(),
		);
	}

	/**
	 * Apply an operator's usage policy to this slot immediately, without waiting
	 * for the next sampling pass.
	 *
	 * A CHANGED CYCLE ANCHOR RESTARTS THE WINDOW AT ZERO, and keeps the counter
	 * BASELINE. Those two halves are the honest answer to a question with no
	 * truthful one: bytes already accrued were measured under the OLD window, so
	 * carrying them into the new one over-reports it, and there is no record of
	 * how they were distributed within it. Starting fresh states plainly that the
	 * new window began now; keeping `lastObserved` means the next sample still
	 * attributes only genuinely new bytes, never a jump. A threshold-only change
	 * moves no anchor and therefore resets nothing.
	 */
	applyUsagePolicy(
		logicalSlotId: string,
		usage: DesiredUsage,
		atMs?: number,
	): {
		cycleStartMs: number;
		cycleReset: boolean;
	} {
		const result = applyPolicy(
			{
				bootId: this.#bootId,
				defaultCycleDay: this.#defaultCycleDay,
				accounts: this.#accounts,
				policies: this.#policies,
				policyOverrides: this.#policyOverrides,
			},
			logicalSlotId,
			usage,
			atMs ?? this.#now(),
		);
		this.#dirty ||= result.dirty;
		return { cycleStartMs: result.cycleStartMs, cycleReset: result.cycleReset };
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
		const state = persistedUsageState(this.#bootId, now, this.#accounts);
		await this.#store.save(state);
		this.#lastPersistMs = now;
		this.#dirty = false;
	}
}

/** Load persisted state and build a ready sampler. See `UsageSampler.create`. */
export function createUsageSampler(options: UsageSamplerOptions): Promise<UsageSampler> {
	return UsageSampler.create(options);
}
