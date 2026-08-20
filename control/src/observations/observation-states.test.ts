import { describe, expect, test } from 'bun:test';
import {
	FIXTURE_GENERATION,
	FIXTURE_OBSERVED_AT,
	FIXTURE_SOURCE_EPOCH,
	fixtureContext,
} from '../../test-support/observation-fixtures';
import { deviceGeneration, epochMillis, type ObservationEnvelope, sourceEpoch } from '../domain';
import { freshObservation, metricProvenance, unavailableObservation } from './envelope';
import { evaluateFreshness, observationAgeMs } from './freshness';
import {
	isCapabilityUnknown,
	knownMetric,
	METRIC_UNKNOWN_REASONS,
	metricUnknownClass,
	metricUnknownReasonFromRouter,
	type NormalizedMetric,
	unknownMetric,
} from './metric';
import { hasReadableValue, readMetric } from './reading';

type Sample = { readonly reading: NormalizedMetric<number> };

const CONTEXT = fixtureContext();
const WINDOW = { ttlMs: 30_000 };
const PROVENANCE = metricProvenance('modemmanager', CONTEXT, ['Modem.SignalQuality']);

function sampleEnvelope(metric: NormalizedMetric<number>): ObservationEnvelope<Sample> {
	return freshObservation<Sample>('modemmanager', CONTEXT, { reading: metric });
}

const KNOWN = sampleEnvelope(knownMetric(71, PROVENANCE));

describe('freshness windows', () => {
	test('Given a fresh observation inside its window, when evaluated, then it stays fresh', () => {
		const evaluated = evaluateFreshness(KNOWN, {
			at: epochMillis(FIXTURE_OBSERVED_AT + WINDOW.ttlMs),
			window: WINDOW,
		});

		expect(evaluated.freshness.state).toBe('fresh');
		expect(evaluated.value).toEqual(KNOWN.value);
	});

	test('Given a fresh observation aged past its window, when evaluated, then it reports stale and KEEPS its value', () => {
		const evaluated = evaluateFreshness(KNOWN, {
			at: epochMillis(FIXTURE_OBSERVED_AT + WINDOW.ttlMs + 1),
			window: WINDOW,
		});

		expect(evaluated.freshness.state).toBe('stale');
		expect(evaluated.value).not.toBeNull();
		expect(readMetric(evaluated, (value) => value.reading)).toMatchObject({
			state: 'stale',
			value: 71,
			reason: 'ttl-expired',
		});
	});

	test('Given an aged observation, when it goes stale, then `since` is the moment the window closed', () => {
		const evaluated = evaluateFreshness(KNOWN, {
			at: epochMillis(FIXTURE_OBSERVED_AT + 5 * WINDOW.ttlMs),
			window: WINDOW,
		});

		expect(evaluated.freshness).toEqual({
			state: 'stale',
			since: epochMillis(FIXTURE_OBSERVED_AT + WINDOW.ttlMs),
			reason: 'ttl-expired',
		});
	});

	test('Given a superseded generation, when evaluated, then supersession outranks TTL expiry', () => {
		const evaluated = evaluateFreshness(KNOWN, {
			at: epochMillis(FIXTURE_OBSERVED_AT + 10 * WINDOW.ttlMs),
			window: WINDOW,
			currentGeneration: deviceGeneration(FIXTURE_GENERATION + 1),
		});

		expect(evaluated.freshness).toEqual({
			state: 'stale',
			since: epochMillis(FIXTURE_OBSERVED_AT + 10 * WINDOW.ttlMs),
			reason: 'source-epoch-superseded',
		});
	});

	test('Given a superseded source epoch, when evaluated inside the window, then it is stale anyway', () => {
		const evaluated = evaluateFreshness(KNOWN, {
			at: FIXTURE_OBSERVED_AT,
			window: WINDOW,
			currentSourceEpoch: sourceEpoch(FIXTURE_SOURCE_EPOCH + 1),
		});

		expect(evaluated.freshness).toMatchObject({ reason: 'source-epoch-superseded' });
	});

	test('Given a degraded source, when evaluated inside the window, then it is stale for that reason', () => {
		const evaluated = evaluateFreshness(KNOWN, {
			at: FIXTURE_OBSERVED_AT,
			window: WINDOW,
			sourceHealthy: false,
		});

		expect(evaluated.freshness).toMatchObject({ reason: 'source-degraded' });
	});

	test('Given an already stale observation, when re-evaluated, then its first cause survives', () => {
		const stale = evaluateFreshness(KNOWN, {
			at: epochMillis(FIXTURE_OBSERVED_AT + WINDOW.ttlMs + 1),
			window: WINDOW,
		});
		const again = evaluateFreshness(stale, {
			at: epochMillis(FIXTURE_OBSERVED_AT + 10 * WINDOW.ttlMs),
			window: WINDOW,
			sourceHealthy: false,
		});

		expect(again).toBe(stale);
	});

	test('Given a clock that moved backwards, when the age is taken, then it floors at zero', () => {
		expect(observationAgeMs(KNOWN, epochMillis(FIXTURE_OBSERVED_AT - 5_000))).toBe(0);
	});
});

describe('stale, unavailable and unknown are three distinct states', () => {
	const stale = evaluateFreshness(KNOWN, {
		at: epochMillis(FIXTURE_OBSERVED_AT + WINDOW.ttlMs + 1),
		window: WINDOW,
	});
	const unavailable = unavailableObservation<Sample>('modemmanager', CONTEXT, 'device-absent');
	const unknown = sampleEnvelope(unknownMetric<number>('not-reported', PROVENANCE));

	const staleReading = readMetric(stale, (value) => value.reading);
	const unavailableReading = readMetric(unavailable, (value) => value.reading);
	const unknownReading = readMetric(unknown, (value) => value.reading);

	test('Given the three cases, when read, then their discriminants differ', () => {
		expect([staleReading.state, unavailableReading.state, unknownReading.state]).toEqual([
			'stale',
			'unavailable',
			'unknown',
		]);
	});

	test('Given the three cases, when read, then only stale carries a value', () => {
		expect(hasReadableValue(staleReading)).toBe(true);
		expect(hasReadableValue(unavailableReading)).toBe(false);
		expect(hasReadableValue(unknownReading)).toBe(false);
		expect('value' in unavailableReading).toBe(false);
		expect('value' in unknownReading).toBe(false);
	});

	test('Given an unavailable observation, when read, then no metric provenance is invented', () => {
		expect('provenance' in unavailableReading).toBe(false);
		expect(unavailable.value).toBeNull();
		expect(unavailableReading.envelope.observedAt).toBe(FIXTURE_OBSERVED_AT);
	});

	test('Given an unavailable observation, when aged past the window, then it never becomes stale', () => {
		const aged = evaluateFreshness(unavailable, {
			at: epochMillis(FIXTURE_OBSERVED_AT + 100 * WINDOW.ttlMs),
			window: WINDOW,
			sourceHealthy: false,
		});

		expect(aged.freshness).toEqual({
			state: 'unavailable',
			since: FIXTURE_OBSERVED_AT,
			reason: 'device-absent',
		});
		expect(aged.value).toBeNull();
	});

	test('Given an unknown metric in a stale envelope, when read, then it reads unknown rather than stale', () => {
		const staleUnknown = evaluateFreshness(
			sampleEnvelope(unknownMetric<number>('auth-expired', PROVENANCE)),
			{ at: epochMillis(FIXTURE_OBSERVED_AT + WINDOW.ttlMs + 1), window: WINDOW },
		);
		const reading = readMetric(staleUnknown, (value) => value.reading);

		expect(reading.state).toBe('unknown');
		expect(reading.envelope.observedAt).toBe(FIXTURE_OBSERVED_AT);
	});
});

describe('unknown is never coerced to unsupported', () => {
	test('Given every unknown reason, when classified, then only `unsupported` is a capability claim', () => {
		const capability = METRIC_UNKNOWN_REASONS.filter(isCapabilityUnknown);

		expect(capability).toEqual(['unsupported']);
		expect(METRIC_UNKNOWN_REASONS.map(metricUnknownClass)).toEqual(
			METRIC_UNKNOWN_REASONS.map((reason) => (reason === 'unsupported' ? 'capability' : 'read')),
		);
	});

	test('Given a migrated router reason, when carried across, then it is preserved verbatim', () => {
		const routerReasons = [
			'unsupported',
			'not-reported',
			'malformed',
			'auth-expired',
			'unreachable',
			'refused',
		] as const;

		for (const reason of routerReasons) {
			expect(metricUnknownReasonFromRouter(reason)).toBe(reason);
		}
	});

	test('Given a read-class unknown, when compared to a capability claim, then they are different values', () => {
		const notReported = unknownMetric<number>('not-reported', PROVENANCE);
		const unsupported = unknownMetric<number>('unsupported', PROVENANCE);

		expect(notReported).not.toEqual(unsupported);
		expect(metricUnknownClass('not-reported')).not.toBe(metricUnknownClass('unsupported'));
	});
});
