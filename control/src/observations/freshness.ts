// Freshness evaluation — how a retained observation ages, and what it never becomes.
//
// Three rules carry the weight here:
//
//  1. **Staleness keeps the value.** An aged reading is the last thing the device
//     actually said; discarding it leaves an operator with a blank field and no way
//     to tell "we lost contact" from "the modem reports nothing".
//  2. **Unavailable is terminal on re-evaluation.** An envelope that carries no value
//     cannot become stale, because there is nothing to age. Re-classifying it would
//     have to invent a value to be stale about.
//  3. **Staleness is monotonic.** A stale envelope is returned UNCHANGED, so its
//     `since` and `reason` record the FIRST cause. Freshness comes from a new read,
//     never from re-evaluating an old one.
//
// This module has no clock: the caller supplies `at` on every evaluation, which is
// what makes the whole window testable without waiting. Same discipline as
// `location/fix-state.ts`.

import {
	type DeviceGeneration,
	type EpochMillis,
	epochMillis,
	isCurrentGeneration,
	type ObservationEnvelope,
	type SourceEpoch,
} from '../domain';
import { type ObservationStaleReason, viewEnvelope } from './envelope';

/** How long a retained value is reported fresh before it ages into `stale`. */
export type FreshnessWindow = {
	readonly ttlMs: number;
};

export type FreshnessEvaluation = {
	/** The caller's current time. This module never reads a clock of its own. */
	readonly at: EpochMillis;
	readonly window: FreshnessWindow;
	/** The source's current epoch; an older envelope epoch is superseded. */
	readonly currentSourceEpoch?: SourceEpoch;
	/** The device's current generation; an envelope from an older one is fenced out. */
	readonly currentGeneration?: DeviceGeneration;
	/** `false` marks a source that is answering but degraded (e.g. a reconnecting bus). */
	readonly sourceHealthy?: boolean;
};

/** How long ago an envelope was observed, floored at zero for a clock that moved back. */
export function observationAgeMs<T>(envelope: ObservationEnvelope<T>, at: EpochMillis): number {
	return Math.max(0, at - envelope.observedAt);
}

/**
 * Re-classify an envelope against the current time, epoch, generation and source
 * health.
 *
 * Trigger precedence, when several apply at once: superseded generation → superseded
 * source epoch → degraded source → TTL expiry. The first three are positive statements
 * that the reading has been overtaken by a newer reality; TTL expiry only says nobody
 * has looked recently, and reporting it over a supersession would understate why.
 */
export function evaluateFreshness<T>(
	envelope: ObservationEnvelope<T>,
	evaluation: FreshnessEvaluation,
): ObservationEnvelope<T> {
	const view = viewEnvelope(envelope);
	if (view.kind === 'unavailable' || view.freshness.state !== 'fresh') {
		return envelope;
	}

	const reason = staleReason(envelope, evaluation);
	if (reason === undefined) {
		return envelope;
	}

	return {
		...envelope,
		freshness: { state: 'stale', since: staleSince(envelope, evaluation, reason), reason },
		value: view.value,
	};
}

function staleReason<T>(
	envelope: ObservationEnvelope<T>,
	evaluation: FreshnessEvaluation,
): ObservationStaleReason | undefined {
	if (
		evaluation.currentGeneration !== undefined &&
		!isCurrentGeneration(envelope.generation, evaluation.currentGeneration)
	) {
		return 'source-epoch-superseded';
	}
	if (
		evaluation.currentSourceEpoch !== undefined &&
		envelope.sourceEpoch !== evaluation.currentSourceEpoch
	) {
		return 'source-epoch-superseded';
	}
	if (evaluation.sourceHealthy === false) {
		return 'source-degraded';
	}
	return observationAgeMs(envelope, evaluation.at) > evaluation.window.ttlMs
		? 'ttl-expired'
		: undefined;
}

/**
 * When the reading became stale.
 *
 * A TTL expiry has an exact moment — one window after it was observed — and reporting
 * the evaluation time instead would make a reading that expired an hour ago look like
 * it just went stale. A supersession or a degradation is only known at the moment it
 * is evaluated, so those honestly report `at`.
 */
function staleSince<T>(
	envelope: ObservationEnvelope<T>,
	evaluation: FreshnessEvaluation,
	reason: ObservationStaleReason,
): EpochMillis {
	return reason === 'ttl-expired'
		? epochMillis(envelope.observedAt + evaluation.window.ttlMs)
		: evaluation.at;
}
