// Reading — the projection a consumer renders from.
//
// It is the one place the envelope's freshness and the metric's knownness are folded
// together, and it keeps FOUR genuinely distinct outcomes rather than a value plus a
// flag:
//
//   `fresh`       — a current value.
//   `stale`       — a RETAINED value that has aged out, with when and why.
//   `unavailable` — there is no observation at all; no value exists to report.
//   `unknown`     — there IS an observation and this field is not in it, with a reason
//                   that says whether the source CANNOT report it or merely DID NOT.
//
// They differ in shape, not only in label: `unavailable` and `unknown` carry no
// `value` field at all, so no consumer can read one off a state that has none, and
// `unavailable` carries no metric provenance because no metric was produced.

import type {
	DeviceGeneration,
	EpochMillis,
	ObservationAuthority,
	ObservationEnvelope,
	SourceEpoch,
	StableKey,
} from '../domain';
import {
	type ObservationStaleReason,
	type ObservationUnavailableReason,
	viewEnvelope,
} from './envelope';
import type { MetricUnknownReason, NormalizedMetric } from './metric';
import type { MetricProvenance } from './provenance';

/** The envelope-level provenance every reading carries, whatever its state. */
export type EnvelopeProvenance = {
	readonly stableKey: StableKey;
	readonly generation: DeviceGeneration;
	readonly source: string;
	readonly sourceEpoch: SourceEpoch;
	readonly observedAt: EpochMillis;
	readonly authority: ObservationAuthority;
};

export function envelopeProvenance<T>(envelope: ObservationEnvelope<T>): EnvelopeProvenance {
	return {
		stableKey: envelope.stableKey,
		generation: envelope.generation,
		source: envelope.source,
		sourceEpoch: envelope.sourceEpoch,
		observedAt: envelope.observedAt,
		authority: envelope.authority,
	};
}

type ReadingBase = { readonly envelope: EnvelopeProvenance };

export type ObservationReading<T> =
	| (ReadingBase & {
			readonly state: 'fresh';
			readonly value: T;
			readonly provenance: MetricProvenance;
	  })
	| (ReadingBase & {
			readonly state: 'stale';
			readonly value: T;
			readonly since: EpochMillis;
			readonly reason: ObservationStaleReason;
			readonly provenance: MetricProvenance;
	  })
	| (ReadingBase & {
			readonly state: 'unavailable';
			readonly since: EpochMillis;
			readonly reason: ObservationUnavailableReason;
	  })
	| (ReadingBase & {
			readonly state: 'unknown';
			readonly reason: MetricUnknownReason;
			readonly provenance: MetricProvenance;
	  });

export const OBSERVATION_READING_STATES = ['fresh', 'stale', 'unavailable', 'unknown'] as const;
export type ObservationReadingState = (typeof OBSERVATION_READING_STATES)[number];

/**
 * Project one metric out of an envelope.
 *
 * An unknown metric inside a STALE envelope reads `unknown`, not `stale`: staleness is
 * a statement about a value's age, and there is no value here to have aged. The
 * envelope's own age remains readable through `reading.envelope.observedAt`.
 */
export function readMetric<T, V>(
	envelope: ObservationEnvelope<T>,
	select: (value: T) => NormalizedMetric<V>,
): ObservationReading<V> {
	const base: ReadingBase = { envelope: envelopeProvenance(envelope) };
	const view = viewEnvelope(envelope);

	if (view.kind === 'unavailable') {
		return {
			...base,
			state: 'unavailable',
			since: view.freshness.since,
			reason: view.freshness.reason,
		};
	}

	const metric = select(view.value);
	if (metric.state === 'unknown') {
		return { ...base, state: 'unknown', reason: metric.reason, provenance: metric.provenance };
	}
	if (view.freshness.state === 'stale') {
		return {
			...base,
			state: 'stale',
			value: metric.value,
			since: view.freshness.since,
			reason: view.freshness.reason,
			provenance: metric.provenance,
		};
	}
	return { ...base, state: 'fresh', value: metric.value, provenance: metric.provenance };
}

/** Whether a reading carries a value a consumer may render. */
export function hasReadableValue<T>(
	reading: ObservationReading<T>,
): reading is Extract<ObservationReading<T>, { readonly state: 'fresh' | 'stale' }> {
	return reading.state === 'fresh' || reading.state === 'stale';
}
