import { describe, expect, test } from 'bun:test';
import {
	providerFixture,
	providerMatchRequest,
} from '../../test-support/provider-conformance-fixture';
import { deviceGeneration } from '../domain';
import { createProviderMatcher, createProviderRegistry } from './index';

describe('provider matcher conformance', () => {
	test('Given no matching evidence, when matching, then the device is unsupported', async () => {
		const registry = createProviderRegistry();
		registry.register(providerFixture('fixture-a'));

		const result = await createProviderMatcher(registry).match(
			providerMatchRequest(deviceGeneration(1), 'different-model'),
		);

		expect(result.status).toBe('unsupported');
		expect(result.score).toBe('unsupported');
		expect(result.provider).toBeNull();
		expect(result.writable).toBe(false);
	});

	test('Given one strong match, when matching, then that provider and profile are selected', async () => {
		const registry = createProviderRegistry();
		registry.register(providerFixture('fixture-a'));

		const result = await createProviderMatcher(registry).match(
			providerMatchRequest(deviceGeneration(1)),
		);

		expect(result.status).toBe('selected');
		expect(result.provider).toBe('fixture-a');
		expect(result.profile).toBe('fixture-profile');
		expect(result.score).toBe('supported');
	});

	test('Given one weak match, when matching, then it remains ambiguous and read-only', async () => {
		const registry = createProviderRegistry();
		const weak = providerFixture('fixture-a');
		registry.register({
			...weak,
			passiveMatchers: weak.passiveMatchers.map((matcher) => ({
				...matcher,
				strength: 'weak' as const,
			})),
		});

		const result = await createProviderMatcher(registry).match(
			providerMatchRequest(deviceGeneration(1)),
		);

		expect(result.status).toBe('ambiguous');
		expect(result.score).toBe('maybe');
		expect(result.operations).toBeNull();
		expect(result.writable).toBe(false);
	});

	test('Given tied providers, when matching, then the result is ambiguous read-only with evidence', async () => {
		const registry = createProviderRegistry();
		registry.register(providerFixture('fixture-a'));
		registry.register(providerFixture('fixture-b'));

		const result = await createProviderMatcher(registry).match(
			providerMatchRequest(deviceGeneration(1)),
		);

		expect(result.status).toBe('ambiguous');
		expect(result.provider).toBeNull();
		expect(result.writable).toBe(false);
		expect(
			result.evidence
				.filter((item) => item.stage === 'passive-facts' && item.signal === 'match')
				.map((item) => item.provider),
		).toEqual(['fixture-a', 'fixture-b']);
	});

	test('Given colliding passive facts, when providers expose writes, then neither writable provider is selected', async () => {
		let authAttempts = 0;
		const registry = createProviderRegistry();
		const first = providerFixture('fixture-a');
		const second = providerFixture('fixture-b');
		registry.register({
			...first,
			authenticatedProfile: {
				algorithm: 'fixture-a-owner-selected',
				attemptLimit: 1,
				authenticate: async () => {
					authAttempts += 1;
					return { status: 'matched', profile: 'fixture-profile', detail: 'profile-confirmed' };
				},
			},
			operations: () => ({ ...first.operations('fixture-profile'), access: 'read-write' }),
		});
		registry.register({
			...second,
			authenticatedProfile: {
				algorithm: 'fixture-b-owner-selected',
				attemptLimit: 1,
				authenticate: async () => {
					authAttempts += 1;
					return { status: 'matched', profile: 'fixture-profile', detail: 'profile-confirmed' };
				},
			},
			operations: () => ({ ...second.operations('fixture-profile'), access: 'read-write' }),
		});

		const result = await createProviderMatcher(registry).match(
			providerMatchRequest(deviceGeneration(1)),
		);

		expect(result.status).toBe('ambiguous');
		expect(result.provider).toBeNull();
		expect(result.operations).toBeNull();
		expect(result.writable).toBe(false);
		expect(authAttempts).toBe(0);
	});

	test('Given a cached generation, when generation advances, then provider evidence is re-evaluated', async () => {
		let probeRuns = 0;
		const registry = createProviderRegistry();
		registry.register(
			providerFixture('fixture-a', {
				probe: {
					id: 'fixture-a.status',
					run: async () => {
						probeRuns += 1;
						return {
							signal: 'match',
							strength: 'weak',
							profiles: ['fixture-profile'],
							detail: 'status-endpoint-shape',
						};
					},
				},
			}),
		);
		const matcher = createProviderMatcher(registry);

		await matcher.match(providerMatchRequest(deviceGeneration(1)));
		await matcher.match(providerMatchRequest(deviceGeneration(1)));
		await matcher.match(providerMatchRequest(deviceGeneration(2)));

		expect(probeRuns).toBe(2);
	});

	test('Given one authenticated profile, when matching twice in a generation, then one auth attempt precedes capability reads', async () => {
		const stages: string[] = [];
		const registry = createProviderRegistry();
		const definition = providerFixture('fixture-a', {
			probe: {
				id: 'fixture-a.status',
				run: async () => {
					stages.push('fingerprint');
					return {
						signal: 'match',
						strength: 'weak',
						profiles: ['fixture-profile'],
						detail: 'status-endpoint-shape',
					};
				},
			},
		});
		registry.register({
			...definition,
			authenticatedProfile: {
				algorithm: 'fixture-owner-selected',
				attemptLimit: 1,
				authenticate: async () => {
					stages.push('auth');
					return { status: 'matched', profile: 'fixture-profile', detail: 'profile-confirmed' };
				},
			},
			capabilityReaders: [
				{
					id: 'fixture-a.signal',
					read: async () => {
						stages.push('capability');
						return { signal: 'match', strength: 'weak', detail: 'signal-readable' };
					},
				},
			],
		});
		const matcher = createProviderMatcher(registry);

		await matcher.match(providerMatchRequest(deviceGeneration(1)));
		await matcher.match(providerMatchRequest(deviceGeneration(1)));

		expect(stages).toEqual(['fingerprint', 'auth', 'capability']);
	});
});
