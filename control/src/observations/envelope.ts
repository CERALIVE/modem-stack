// Envelope construction for normalizers.
//
// One rule shapes this module: **a payload that arrived is an OBSERVATION, however
// little of it could be read.** A refused HiLink session, an unparseable goform body
// and a UFI endpoint that answered without the field all produce a FRESH envelope
// whose metrics are `unknown` with a reason — not an `unavailable` one. That matters
// for a reason beyond taxonomy: `ObservationEnvelope` pairs `unavailable` with
// `value: null`, so emitting `unavailable` for a payload we did hold would throw the
// diagnostics block away with it, and the raw vendor fields with that.
//
// `unavailable` is therefore reserved for the case where there is no payload at all —
// the device is gone, or the provider could not be engaged.

import type {
	DeviceGeneration,
	EpochMillis,
	ObservationAuthority,
	ObservationEnvelope,
	ObservationFreshness,
	SourceEpoch,
	StableKey,
} from '../domain';
import type { MetricProvenance, ObservationSourceKind } from './provenance';

export type ObservationStaleReason = Extract<ObservationFreshness, { state: 'stale' }>['reason'];
export type ObservationUnavailableReason = Extract<
	ObservationFreshness,
	{ state: 'unavailable' }
>['reason'];

export type EnvelopeView<T> =
	| {
			readonly kind: 'valued';
			readonly value: T;
			readonly freshness: Extract<ObservationFreshness, { state: 'fresh' | 'stale' }>;
	  }
	| {
			readonly kind: 'unavailable';
			readonly freshness: Extract<ObservationFreshness, { state: 'unavailable' }>;
	  };

/**
 * Split an envelope into its two representable shapes.
 *
 * The package's only cast over an envelope lives here. `ObservationEnvelope<T>` pairs
 * `value: T` with fresh|stale and `value: null` with unavailable BY CONSTRUCTION, but
 * the discriminant sits one level down (`freshness.state`) and TypeScript narrows a
 * union only on a direct property — so the pairing the type already guarantees has to
 * be restated once, here, instead of at every call site.
 */
export function viewEnvelope<T>(envelope: ObservationEnvelope<T>): EnvelopeView<T> {
	return envelope.freshness.state === 'unavailable'
		? { kind: 'unavailable', freshness: envelope.freshness }
		: { kind: 'valued', value: envelope.value as T, freshness: envelope.freshness };
}

/**
 * Everything a normalizer needs that it cannot derive from the payload.
 *
 * There is no clock and no epoch counter in this layer: `observedAt` and
 * `sourceEpoch` are supplied by whoever performed the read, so a normalizer cannot
 * stamp a payload with a time it did not come from.
 */
export type NormalizationContext = {
	readonly stableKey: StableKey;
	readonly generation: DeviceGeneration;
	readonly sourceEpoch: SourceEpoch;
	readonly observedAt: EpochMillis;
	readonly authority?: ObservationAuthority;
};

export function contextAuthority(context: NormalizationContext): ObservationAuthority {
	return context.authority ?? 'authoritative';
}

/**
 * Provenance for one metric.
 *
 * `authority` is per-METRIC rather than inherited wholesale, because one payload can
 * mix classes: a router's RSRP is a measurement the modem reported, while its bar
 * count is a vendor rendering of that measurement, and calling both `authoritative`
 * would let a consumer treat a marketing scale as a reading.
 */
export function metricProvenance(
	source: ObservationSourceKind,
	context: NormalizationContext,
	rawFields: readonly string[],
	authority?: ObservationAuthority,
): MetricProvenance {
	return {
		source,
		sourceEpoch: context.sourceEpoch,
		observedAt: context.observedAt,
		authority: authority ?? contextAuthority(context),
		rawFields,
	};
}

/** A fresh envelope around a normalized value. */
export function freshObservation<T>(
	source: ObservationSourceKind,
	context: NormalizationContext,
	value: T,
): ObservationEnvelope<T> {
	return {
		stableKey: context.stableKey,
		generation: context.generation,
		source,
		sourceEpoch: context.sourceEpoch,
		observedAt: context.observedAt,
		authority: contextAuthority(context),
		freshness: { state: 'fresh' },
		value,
	};
}

/**
 * An envelope for a read that produced no payload at all.
 *
 * It carries `value: null` by construction — there is no overload that could invent
 * one — which is also why a normalizer holding vendor bytes must not use it.
 */
export function unavailableObservation<T>(
	source: ObservationSourceKind,
	context: NormalizationContext,
	reason: ObservationUnavailableReason,
): ObservationEnvelope<T> {
	return {
		stableKey: context.stableKey,
		generation: context.generation,
		source,
		sourceEpoch: context.sourceEpoch,
		observedAt: context.observedAt,
		authority: contextAuthority(context),
		freshness: { state: 'unavailable', since: context.observedAt, reason },
		value: null,
	};
}
