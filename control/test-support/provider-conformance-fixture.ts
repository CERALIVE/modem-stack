import {
	type DeviceGeneration,
	deviceGeneration,
	epochMillis,
	type ObservationEnvelope,
	type OperationDescriptor,
	type OperationResult,
	type PhysicalModemId,
	physicalModemId,
	sourceEpoch,
	stableKeyFromPhysicalModemId,
} from '../src/domain';
import type {
	ProviderDefinition,
	ProviderMatchRequest,
	ProviderOperationsSurface,
	ProviderReadOperations,
} from '../src/providers';

type TestObservation = { readonly registered: boolean };

type TestOperations = ProviderOperationsSurface & {
	readonly signal: ProviderReadOperations<number>;
};

const PHYSICAL_ID: PhysicalModemId = physicalModemId('serial:provider-conformance');

export function providerMatchRequest(
	generation: DeviceGeneration,
	model = 'fixture-model',
): ProviderMatchRequest {
	return {
		physicalModemId: PHYSICAL_ID,
		generation,
		transport: 'network',
		passiveFacts: [{ kind: 'model', value: model }],
		composition: 'ethernet-router',
		firmware: '1.0.0',
	};
}

export function providerFixture(
	id: string,
	options: {
		readonly model?: string;
		readonly probe?: ProviderDefinition<
			TestObservation,
			TestOperations
		>['unauthenticatedProbes'][number];
	} = {},
): ProviderDefinition<TestObservation, TestOperations> {
	const model = options.model ?? 'fixture-model';
	const generation = deviceGeneration(1);
	const observation: ObservationEnvelope<TestObservation> = {
		stableKey: stableKeyFromPhysicalModemId(PHYSICAL_ID),
		generation,
		source: id,
		sourceEpoch: sourceEpoch(1),
		observedAt: epochMillis(1),
		freshness: { state: 'fresh' },
		authority: 'authoritative',
		value: { registered: true },
	};
	const descriptor: OperationDescriptor<never, number> = {
		id: 'signal.read',
		support: { read: { supported: true }, write: { supported: false, reason: 'read-only' } },
		authority: 'provider',
		provider: id,
		constraints: { kind: 'unconstrained' },
		livePreconditions: ['device-present'],
		availability: { state: 'available' },
		mutationImpact: 'read',
		retryClass: 'idempotent-read',
		readback: { required: false },
		rollback: { required: false },
		journal: { required: false },
		admission: { required: false },
		evidence: { profiles: ['fixture-profile'], firmware: ['1.0.0'] },
		confidence: 'high',
	};

	return {
		id,
		profileVersion: '1',
		eligibleTransports: ['network'],
		passiveMatchers: [
			{
				id: `${id}.model`,
				fact: 'model',
				expected: [model],
				profiles: ['fixture-profile'],
				strength: 'strong',
				required: true,
			},
		],
		unauthenticatedProbes: options.probe === undefined ? [] : [options.probe],
		capabilityReaders: [],
		observe: async () => [observation],
		operations: () => ({
			access: 'read-only',
			signal: {
				descriptor,
				read: async () => {
					const result: OperationResult<number> = {
						status: 'applied',
						value: -70,
						generation,
						requiresReconciliation: false,
					};
					return result;
				},
			},
		}),
		contractFixtures: [
			{
				profile: 'fixture-profile',
				request: { method: 'GET', path: '/status' },
				response: { registered: true },
			},
		],
	};
}
