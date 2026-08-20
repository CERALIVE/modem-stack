import { describe, expect, test } from 'bun:test';
import {
	canAutoRetry,
	deviceGeneration,
	nextDeviceGeneration,
	physicalModemId,
	stableKeyFromPhysicalModemId,
} from '../domain';
import { createProviderMatcher, createProviderRegistry } from '../providers';
import {
	FAKE_GENERATION,
	FAKE_PHYSICAL_MODEM_ID,
	FAKE_PROVIDER_MODEL,
	FAKE_STABLE_KEY,
	fakeFreshObservation,
	fakeOperationResult,
	fakeProviderDefinition,
	fakeProviderMatchRequest,
	fakeReadDescriptor,
	fakeStaleObservation,
	fakeUnauthenticatedProbe,
	fakeUnavailableObservation,
	fakeWriteDescriptor,
} from './index';

describe('public identity fakes', () => {
	test('the canonical id round-trips through the real constructor', () => {
		expect(physicalModemId(FAKE_PHYSICAL_MODEM_ID)).toBe(FAKE_PHYSICAL_MODEM_ID);
		expect(stableKeyFromPhysicalModemId(FAKE_PHYSICAL_MODEM_ID)).toBe(FAKE_STABLE_KEY);
	});

	test('the default generation is the first real lifetime', () => {
		expect(FAKE_GENERATION).toBe(deviceGeneration(1));
	});
});

describe('observation fakes', () => {
	test('a fresh envelope carries the value', () => {
		const envelope = fakeFreshObservation({ registered: true });
		expect(envelope.freshness.state).toBe('fresh');
		expect(envelope.value).toEqual({ registered: true });
		expect(envelope.stableKey).toBe(FAKE_STABLE_KEY);
	});

	test('a stale envelope RETAINS the value it was built with', () => {
		const envelope = fakeStaleObservation({ registered: false }, 'source-degraded');
		expect(envelope.freshness).toEqual({
			state: 'stale',
			since: envelope.observedAt,
			reason: 'source-degraded',
		});
		expect(envelope.value).toEqual({ registered: false });
	});

	test('an unavailable envelope can only be null — no value can be invented', () => {
		const envelope = fakeUnavailableObservation<{ registered: boolean }>('device-absent');
		expect(envelope.freshness.state).toBe('unavailable');
		expect(envelope.value).toBeNull();
	});
});

describe('operation fakes', () => {
	test('the read descriptor is the only one that may auto-retry', () => {
		const read = fakeReadDescriptor<number>();
		const write = fakeWriteDescriptor<string, number>();
		const failed = fakeOperationResult<number>({ status: 'failed', reason: 'contract-fake' });

		expect(canAutoRetry(read, failed)).toBe(true);
		expect(canAutoRetry(write, failed)).toBe(false);
	});

	test('a stale-generation completion is classified by the REAL classifier', () => {
		const result = fakeOperationResult<number>(
			{ status: 'applied', value: 7 },
			{ currentGeneration: nextDeviceGeneration(FAKE_GENERATION) },
		);
		expect(result).toEqual({
			status: 'unknown-outcome',
			reason: 'stale-generation',
			requiresReconciliation: true,
			generation: FAKE_GENERATION,
		});
	});

	test('a timed-out WRITE demands reconciliation while a timed-out read does not', () => {
		expect(fakeOperationResult<number>({ status: 'timed-out' }).requiresReconciliation).toBe(true);
		expect(
			fakeOperationResult<number>({ status: 'timed-out' }, { operation: 'read' })
				.requiresReconciliation,
		).toBe(false);
	});
});

describe('provider fakes', () => {
	test('a fake definition is selectable by the real registry + matcher', async () => {
		const registry = createProviderRegistry();
		registry.register(fakeProviderDefinition({ observation: { registered: true } }));

		const matcher = createProviderMatcher(registry);
		const result = await matcher.match(fakeProviderMatchRequest());

		expect(result.status).toBe('selected');
		expect(result.provider).toBe('contract-fake-provider');
		expect(result.profile).toBe('contract-fake-profile');
	});

	test('a request naming another model is not selected', async () => {
		const registry = createProviderRegistry();
		registry.register(fakeProviderDefinition({ observation: { registered: true } }));

		const matcher = createProviderMatcher(registry);
		const result = await matcher.match(fakeProviderMatchRequest({ model: 'some-other-model' }));

		expect(result.status).toBe('unsupported');
		expect(result.operations).toBeNull();
	});

	test('the fake probe answers its configured fingerprint', async () => {
		const probe = fakeUnauthenticatedProbe({ signal: 'mismatch', strength: 'weak' });
		await expect(probe.run(fakeProviderMatchRequest())).resolves.toMatchObject({
			signal: 'mismatch',
			strength: 'weak',
		});
	});

	test('the default match request names the fake model', () => {
		expect(fakeProviderMatchRequest().passiveFacts).toEqual([
			{ kind: 'model', value: FAKE_PROVIDER_MODEL },
		]);
	});
});
