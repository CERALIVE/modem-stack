// The pure usage-accounting reducer — the heart of the sampler.
//
// For each logical slot we keep a per-cycle byte total plus a BASELINE: the last
// observed cumulative counter value under a specific key. The key is the composite
// `{logicalSlotId, mappingGeneration, ifname, bootId}`. The rules, all encoded here
// with zero I/O so they can be exhaustively unit-tested:
//
//   - REMAP (any key field changes — e.g. the ifname-to-slot mapping bumped
//     `mappingGeneration`, or a reboot changed `bootId`): rebaseline with a
//     ZERO-DELTA sample. We start counting fresh from the current cumulative value
//     and attribute nothing for that first sample — never a spurious jump.
//   - SAME-KEY DECREASE (the cumulative counter went DOWN — interface re-created /
//     counter reset without a reported remap): CLAMP the negative delta to zero and
//     REBASE the baseline to the new lower value. Never report negative usage.
//   - LOW CONFIDENCE (ambiguous identity, A3.2 ladder): sampling is PAUSED. We drop
//     the baseline and attribute nothing; on resume the next sample is zero-delta so
//     bytes moved during the ambiguous window are never mis-attributed.
//   - CYCLE ROLLOVER (`now` crossed into a new billing cycle): the per-cycle total
//     resets to zero. The baseline is kept — the kernel counter is continuous across
//     a billing boundary; only OUR accounting window resets.

import type { IdentityConfidence, LogicalSlotId } from '../../domain';

/** The composite baseline key. A change in ANY field is a remap (zero-delta rebase). */
export interface BaselineKey {
	readonly logicalSlotId: string;
	readonly mappingGeneration: number;
	readonly ifname: string;
	readonly bootId: string;
}

/** Per-slot accounting state. `key`/`lastObserved` are unset before the first sample. */
export interface SlotAccount {
	/** Bytes attributed to this slot within the current cycle. */
	readonly cycleBytes: number;
	/** UTC start of the cycle `cycleBytes` is accruing into. */
	readonly cycleStartMs: number;
	/** True when the last observation was low-confidence and sampling is paused. */
	readonly paused: boolean;
	/** The key the baseline was captured under (undefined = no baseline yet). */
	readonly key?: BaselineKey;
	/** The cumulative counter value at the last accepted sample. */
	readonly lastObserved?: number;
}

/** One observation fed to the reducer for a single slot in one sampling pass. */
export interface SampleInput {
	readonly key: BaselineKey;
	/** The current cumulative rx+tx counter for the slot's interface. */
	readonly current: number;
	readonly confidence: IdentityConfidence;
	/** The UTC start of the slot's active cycle (from `cycleStart`). */
	readonly cycleStartMs: number;
}

/** A fresh account for a slot first seen in `cycleStartMs`. */
export function initialAccount(cycleStartMs: number): SlotAccount {
	return { cycleBytes: 0, cycleStartMs, paused: false };
}

function sameKey(a: BaselineKey, b: BaselineKey): boolean {
	return (
		a.logicalSlotId === b.logicalSlotId &&
		a.mappingGeneration === b.mappingGeneration &&
		a.ifname === b.ifname &&
		a.bootId === b.bootId
	);
}

/** Apply a cycle rollover: if we crossed into a newer cycle, zero the per-cycle total. */
function rollCycle(account: SlotAccount, cycleStartMs: number): SlotAccount {
	if (cycleStartMs > account.cycleStartMs) {
		return { ...account, cycleBytes: 0, cycleStartMs };
	}
	return account;
}

/**
 * Fold one observation into a slot's account, returning the NEXT account. Pure —
 * no clock, no I/O; the caller supplies `current`, `confidence` and `cycleStartMs`.
 */
export function applySample(prior: SlotAccount | undefined, input: SampleInput): SlotAccount {
	const base = rollCycle(prior ?? initialAccount(input.cycleStartMs), input.cycleStartMs);

	// Ambiguous identity → pause: attribute nothing and drop the baseline so the
	// next confident sample re-baselines zero-delta (no back-attribution).
	if (input.confidence === 'low') {
		return { cycleBytes: base.cycleBytes, cycleStartMs: base.cycleStartMs, paused: true };
	}

	// Remap, first-ever sample, or resuming from a pause → zero-delta rebaseline.
	if (base.paused || base.key === undefined || base.lastObserved === undefined) {
		return { ...base, paused: false, key: input.key, lastObserved: input.current };
	}
	if (!sameKey(base.key, input.key)) {
		return { ...base, paused: false, key: input.key, lastObserved: input.current };
	}

	// Same key: a decrease is a counter reset → clamp the negative delta and rebase.
	if (input.current < base.lastObserved) {
		return { ...base, paused: false, key: input.key, lastObserved: input.current };
	}

	// Normal case: attribute the non-negative delta and advance the baseline.
	const delta = input.current - base.lastObserved;
	return {
		...base,
		paused: false,
		key: input.key,
		lastObserved: input.current,
		cycleBytes: base.cycleBytes + delta,
	};
}

/** Convenience constructor for a `BaselineKey` from its parts. */
export function baselineKey(
	logicalSlotId: LogicalSlotId,
	mappingGeneration: number,
	ifname: string,
	bootId: string,
): BaselineKey {
	return { logicalSlotId, mappingGeneration, ifname, bootId };
}
