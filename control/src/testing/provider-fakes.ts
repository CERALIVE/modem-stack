import type { DeviceGeneration, ObservationEnvelope } from '../domain';
import type {
	FingerprintResult,
	PassiveFact,
	ProviderDefinition,
	ProviderExecutionContext,
	ProviderMatchRequest,
	ProviderOperationsSurface,
	ProviderTransport,
	UnauthenticatedProbe,
} from '../providers';
import { FAKE_GENERATION, FAKE_PHYSICAL_MODEM_ID, fakeFreshObservation } from './domain-fakes';

/** The model string every provider fake matches on unless one is named. */
export const FAKE_PROVIDER_MODEL = 'contract-fake-model';

export type FakeMatchRequestOptions = {
	readonly generation?: DeviceGeneration;
	readonly transport?: ProviderTransport;
	readonly model?: string;
	readonly composition?: string;
	readonly firmware?: string;
	readonly passiveFacts?: readonly PassiveFact[];
};

/** A well-formed `ProviderMatchRequest` whose passive facts name exactly one model. */
export function fakeProviderMatchRequest(
	options: FakeMatchRequestOptions = {},
): ProviderMatchRequest {
	const model = options.model ?? FAKE_PROVIDER_MODEL;
	return {
		physicalModemId: FAKE_PHYSICAL_MODEM_ID,
		generation: options.generation ?? FAKE_GENERATION,
		transport: options.transport ?? 'network',
		passiveFacts: options.passiveFacts ?? [{ kind: 'model', value: model }],
		composition: options.composition ?? 'ethernet-router',
		firmware: options.firmware ?? '1.0.0',
	};
}

export type FakeProviderOptions<TObservation> = {
	readonly id?: string;
	readonly profile?: string;
	readonly profileVersion?: string;
	readonly model?: string;
	readonly eligibleTransports?: readonly ProviderTransport[];
	readonly access?: ProviderOperationsSurface['access'];
	readonly observation?: TObservation;
	readonly probes?: readonly UnauthenticatedProbe[];
};

/**
 * A minimal but COMPLETE `ProviderDefinition` — one strong required passive matcher on
 * the model fact, no authenticated profile, no capability readers.
 *
 * It registers nothing and reaches no device: `observe` answers a fresh envelope built
 * from the supplied observation, and `operations` returns the access surface asked for.
 * This is the shape a consumer writes its own registry/matcher tests against without
 * inventing a parallel provider contract.
 */
export function fakeProviderDefinition<TObservation>(
	options: FakeProviderOptions<TObservation> & { readonly observation: TObservation },
): ProviderDefinition<TObservation, ProviderOperationsSurface> {
	const id = options.id ?? 'contract-fake-provider';
	const profile = options.profile ?? 'contract-fake-profile';
	const model = options.model ?? FAKE_PROVIDER_MODEL;
	const access: ProviderOperationsSurface['access'] = options.access ?? 'read-only';
	const observation = options.observation;

	return {
		id,
		profileVersion: options.profileVersion ?? '1.0.0',
		eligibleTransports: options.eligibleTransports ?? ['network'],
		passiveMatchers: [
			{
				id: `${id}-model`,
				fact: 'model',
				expected: [model],
				profiles: [profile],
				strength: 'strong',
				required: true,
			},
		],
		unauthenticatedProbes: options.probes ?? [],
		capabilityReaders: [],
		observe: (
			_context: ProviderExecutionContext,
		): Promise<readonly ObservationEnvelope<TObservation>[]> =>
			Promise.resolve([fakeFreshObservation(observation, { source: id })]),
		operations: (_profile: string): ProviderOperationsSurface => ({ access }),
		contractFixtures: [],
	};
}

export type FakeProbeOptions = {
	readonly id?: string;
	readonly signal?: FingerprintResult['signal'];
	readonly strength?: FingerprintResult['strength'];
	readonly profiles?: readonly string[];
	readonly detail?: string;
};

/** A harmless unauthenticated probe that answers a fixed fingerprint. */
export function fakeUnauthenticatedProbe(options: FakeProbeOptions = {}): UnauthenticatedProbe {
	const result: FingerprintResult = {
		signal: options.signal ?? 'match',
		strength: options.strength ?? 'moderate',
		profiles: options.profiles ?? ['contract-fake-profile'],
		detail: options.detail ?? 'contract-fake probe',
	};
	return {
		id: options.id ?? 'contract-fake-probe',
		run: (_context: ProviderMatchRequest): Promise<FingerprintResult> => Promise.resolve(result),
	};
}
