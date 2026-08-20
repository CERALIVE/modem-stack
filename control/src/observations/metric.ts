// A normalized metric: a value, or an explicit reason there is none — with the
// provenance of the exact reading that produced it.
//
// `unknown` is a FIRST-CLASS state here, and its reason is what keeps it from
// collapsing into `unsupported`. Those two answer different questions: `unsupported`
// is a positive claim about the SOURCE ("this provider cannot express this datum at
// all"), while every other reason is a claim about one READ ("the provider could have
// said, and did not / could not be asked / answered nonsense"). Folding the second
// class into the first is how a control disappears from an operator's screen because
// one poll came back empty.

import type { RouterSignalMetric, RouterSignalUnknownReason } from '../hardware/router-parsers';
import type { MetricProvenance } from './provenance';

export const METRIC_UNKNOWN_REASONS = [
	/** A positive claim about the SOURCE: it cannot express this datum at all. */
	'unsupported',
	/** The source answered and simply did not include this field. */
	'not-reported',
	/** Nobody has read this yet. Says nothing about the source or the device. */
	'not-observed',
	/** The source answered with something this layer could not decode. */
	'malformed',
	/** The source refused the read; the session needs re-authentication. */
	'auth-expired',
	/** The source answered with an explicit refusal code for this field. */
	'refused',
	/** The source could not be reached for this read. */
	'unreachable',
] as const;
export type MetricUnknownReason = (typeof METRIC_UNKNOWN_REASONS)[number];

/**
 * The two classes an unknown reason falls into.
 *
 * `capability` is a durable statement about the source; `read` is a statement about
 * one attempt and may differ on the next one. A consumer deciding whether to HIDE a
 * control (capability) or show it as pending (read) must branch on this, never on the
 * bare fact that a value is missing.
 */
export type MetricUnknownClass = 'capability' | 'read';

export function metricUnknownClass(reason: MetricUnknownReason): MetricUnknownClass {
	return reason === 'unsupported' ? 'capability' : 'read';
}

/** Whether a reason is the positive "this source cannot report it" claim. */
export function isCapabilityUnknown(reason: MetricUnknownReason): reason is 'unsupported' {
	return metricUnknownClass(reason) === 'capability';
}

export type NormalizedMetric<T> =
	| {
			readonly state: 'known';
			readonly value: T;
			readonly provenance: MetricProvenance;
	  }
	| {
			readonly state: 'unknown';
			readonly reason: MetricUnknownReason;
			readonly provenance: MetricProvenance;
	  };

export function knownMetric<T>(value: T, provenance: MetricProvenance): NormalizedMetric<T> {
	return { state: 'known', value, provenance };
}

export function unknownMetric<T>(
	reason: MetricUnknownReason,
	provenance: MetricProvenance,
): NormalizedMetric<T> {
	return { state: 'unknown', reason, provenance };
}

/**
 * Lift an optional decode result into a metric.
 *
 * `reason` is supplied by the caller precisely so this helper cannot pick one: the
 * difference between "the provider omitted the field" and "this provider has no such
 * field" is knowledge the decoder does not have and the call site does.
 */
export function metricFromOptional<T>(
	value: T | undefined,
	reason: MetricUnknownReason,
	provenance: MetricProvenance,
): NormalizedMetric<T> {
	return value === undefined
		? unknownMetric<T>(reason, provenance)
		: knownMetric(value, provenance);
}

/**
 * The migrated router parsers' own unknown vocabulary, carried across UNCHANGED.
 *
 * Every member of `RouterSignalUnknownReason` is a member of `MetricUnknownReason`
 * with the same meaning, so this is a widening and never a re-classification — in
 * particular `not-reported` stays `not-reported` and does not become `unsupported`.
 */
export function metricUnknownReasonFromRouter(
	reason: RouterSignalUnknownReason | 'refused',
): MetricUnknownReason {
	return reason;
}

/** Wrap one migrated router signal metric with its provenance. */
export function metricFromRouterSignal(
	metric: RouterSignalMetric,
	provenance: MetricProvenance,
): NormalizedMetric<number> {
	return metric.state === 'known'
		? knownMetric(metric.value, provenance)
		: unknownMetric<number>(metricUnknownReasonFromRouter(metric.reason), provenance);
}

/** Transform a known value while preserving state, reason and provenance. */
export function mapMetric<T, U>(
	metric: NormalizedMetric<T>,
	transform: (value: T) => U,
): NormalizedMetric<U> {
	return metric.state === 'known'
		? knownMetric(transform(metric.value), metric.provenance)
		: unknownMetric<U>(metric.reason, metric.provenance);
}
