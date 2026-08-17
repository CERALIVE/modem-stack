// `setUsagePolicy` — the WRITE half of the data-usage surface.
//
// The read half already existed (`UsageSampler.snapshot()` reports `cycleBytes`,
// `thresholdBytes` and `thresholdExceeded`), but nothing could SET the two
// numbers those readings are computed against: `DesiredUsage` was a shape the
// planner echoed into a receipt, with no persistence and no apply path. This
// module closes that, mirroring the read side's file-store idiom exactly.
//
// It is a LOCAL write, not a modem write — see `policy-store.ts`'s header for the
// ModemManager API evidence. Nothing here touches D-Bus, `mmcli`, or any bearer.
//
// TYPED RESULTS, NEVER THROWS ON BAD INPUT. Following the `PowerHook` precedent
// (`power-contract.ts`: `applied` / `unsupported` / `failed`), an out-of-range
// day is a `rejected` result carrying a named reason rather than an exception —
// this is called from an RPC boundary where a throw becomes an opaque 500.

import type { DesiredUsage } from '../../domain';
import {
	isValidCycleDay,
	isValidThresholdBytes,
	type PersistedUsagePolicySlot,
	selectUsagePolicy,
	USAGE_POLICY_SCHEMA_VERSION,
	type UsagePolicyStore,
} from './policy-store';

/**
 * The live-apply seam. `UsageSampler` implements it; a caller with no running
 * sampler simply omits it and the write is persistence-only.
 */
export interface UsagePolicyTarget {
	applyUsagePolicy(
		logicalSlotId: string,
		usage: DesiredUsage,
		atMs?: number,
	): UsagePolicyApplication;
}

/** What a live apply did to the slot's accounting window. */
export interface UsagePolicyApplication {
	/** The UTC start of the cycle the slot is now accruing into. */
	readonly cycleStartMs: number;
	/** True when the cycle ANCHOR moved, so the per-cycle total restarted at 0. */
	readonly cycleReset: boolean;
}

export interface SetUsagePolicyDeps {
	readonly store: UsagePolicyStore;
	/** Optional live sampler to apply the change to immediately. */
	readonly sampler?: UsagePolicyTarget;
	/** Injectable clock (defaults to `Date.now`). */
	readonly now?: () => number;
}

/**
 * The requested change.
 *
 * Tri-state per field, and the distinction is the whole point: `undefined`
 * leaves the persisted value ALONE (so a caller changing only the threshold
 * cannot silently drop a cycle day it never mentioned), while an explicit `null`
 * CLEARS it. A caller that cannot express `null` can never unset a policy.
 */
export interface SetUsagePolicyRequest {
	readonly logicalSlotId: string;
	readonly cycleDay?: number | null;
	readonly thresholdBytes?: number | null;
}

export type SetUsagePolicyRejection =
	| 'invalid-slot-id'
	| 'invalid-cycle-day'
	| 'invalid-threshold-bytes';

export type SetUsagePolicyResult =
	| {
			readonly status: 'applied';
			readonly logicalSlotId: string;
			/** The policy now persisted for this slot (post-merge). */
			readonly usage: DesiredUsage;
			/** Present only when a live sampler was supplied. */
			readonly applied?: UsagePolicyApplication;
	  }
	| {
			readonly status: 'rejected';
			readonly logicalSlotId: string;
			readonly reason: SetUsagePolicyRejection;
	  }
	| {
			readonly status: 'failed';
			readonly logicalSlotId: string;
			readonly reason: string;
	  };

function validateRequest(request: SetUsagePolicyRequest): SetUsagePolicyRejection | undefined {
	if (typeof request.logicalSlotId !== 'string' || request.logicalSlotId.length === 0) {
		return 'invalid-slot-id';
	}
	if (
		request.cycleDay !== undefined &&
		request.cycleDay !== null &&
		!isValidCycleDay(request.cycleDay)
	) {
		return 'invalid-cycle-day';
	}
	if (
		request.thresholdBytes !== undefined &&
		request.thresholdBytes !== null &&
		!isValidThresholdBytes(request.thresholdBytes)
	) {
		return 'invalid-threshold-bytes';
	}
	return undefined;
}

/** Fold the request onto the currently-persisted policy (tri-state merge). */
function mergePolicy(current: DesiredUsage, request: SetUsagePolicyRequest): DesiredUsage {
	const cycleDay =
		request.cycleDay === undefined ? current.cycleDay : (request.cycleDay ?? undefined);
	const thresholdBytes =
		request.thresholdBytes === undefined
			? current.thresholdBytes
			: (request.thresholdBytes ?? undefined);
	return {
		...(cycleDay !== undefined ? { cycleDay } : {}),
		...(thresholdBytes !== undefined ? { thresholdBytes } : {}),
	};
}

function toSlot(logicalSlotId: string, usage: DesiredUsage): PersistedUsagePolicySlot {
	return {
		logicalSlotId,
		...(usage.cycleDay !== undefined ? { cycleDay: usage.cycleDay } : {}),
		...(usage.thresholdBytes !== undefined ? { thresholdBytes: usage.thresholdBytes } : {}),
	};
}

/**
 * Persist a slot's usage policy and, when a live sampler is supplied, apply it
 * to that sampler in the same call.
 *
 * ORDER IS LOAD → VALIDATE → PERSIST → APPLY, and it is deliberate. The store is
 * the source of truth (the composition root rebuilds every `UsageObservation`
 * from it), so a live apply that landed while the write failed would leave the
 * running process disagreeing with what a restart would restore.
 */
export async function setUsagePolicy(
	deps: SetUsagePolicyDeps,
	request: SetUsagePolicyRequest,
): Promise<SetUsagePolicyResult> {
	const logicalSlotId = typeof request.logicalSlotId === 'string' ? request.logicalSlotId : '';
	const rejection = validateRequest(request);
	if (rejection !== undefined) {
		return { status: 'rejected', logicalSlotId, reason: rejection };
	}

	const now = deps.now ?? Date.now;
	const at = now();

	let usage: DesiredUsage;
	try {
		const state = await deps.store.load(at);
		usage = mergePolicy(selectUsagePolicy(state, logicalSlotId), request);
		const others = state.slots.filter((slot) => slot.logicalSlotId !== logicalSlotId);
		// An empty policy is REMOVED rather than stored as an empty row: "no policy"
		// and "a policy that sets nothing" are the same fact, and keeping the row
		// would grow the file by one entry per slot an operator ever cleared.
		const slots =
			usage.cycleDay === undefined && usage.thresholdBytes === undefined
				? others
				: [...others, toSlot(logicalSlotId, usage)];
		await deps.store.save({
			schemaVersion: USAGE_POLICY_SCHEMA_VERSION,
			savedAtMs: at,
			slots,
		});
	} catch (error) {
		return {
			status: 'failed',
			logicalSlotId,
			reason: error instanceof Error ? error.message : 'persist-failed',
		};
	}

	if (deps.sampler === undefined) {
		return { status: 'applied', logicalSlotId, usage };
	}
	try {
		const applied = deps.sampler.applyUsagePolicy(logicalSlotId, usage, at);
		return { status: 'applied', logicalSlotId, usage, applied };
	} catch (error) {
		return {
			status: 'failed',
			logicalSlotId,
			reason: error instanceof Error ? error.message : 'apply-failed',
		};
	}
}

/** Read one slot's persisted policy. The read counterpart of `setUsagePolicy`. */
export async function getUsagePolicy(
	deps: Pick<SetUsagePolicyDeps, 'store' | 'now'>,
	logicalSlotId: string,
): Promise<DesiredUsage> {
	const now = deps.now ?? Date.now;
	const state = await deps.store.load(now());
	return selectUsagePolicy(state, logicalSlotId);
}
