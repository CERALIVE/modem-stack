import type {
	DeviceGeneration,
	ObservationEnvelope,
	OperationDescriptor,
	OperationResult,
	PhysicalModemId,
} from '../domain';

export const PROVIDER_TRANSPORTS = ['usb', 'pci', 'network', 'modemmanager'] as const;
export type ProviderTransport = (typeof PROVIDER_TRANSPORTS)[number];

export const PASSIVE_FACT_KINDS = [
	'usb',
	'pci',
	'interface',
	'driver',
	'gateway',
	'model',
	'firmware',
] as const;
export type PassiveFactKind = (typeof PASSIVE_FACT_KINDS)[number];
export type EvidenceStrength = 'none' | 'weak' | 'moderate' | 'strong';
export type MatcherScore = 'unsupported' | 'maybe' | 'likely' | 'supported';

export type PassiveFact = {
	readonly kind: PassiveFactKind;
	readonly value: string;
};

export type ProviderMatchRequest = {
	readonly physicalModemId: PhysicalModemId;
	readonly generation: DeviceGeneration;
	readonly transport: ProviderTransport;
	readonly passiveFacts: readonly PassiveFact[];
	readonly composition: string;
	readonly firmware?: string;
};

export type ProviderExecutionContext = ProviderMatchRequest & {
	readonly profile: string;
};

export type PassiveMatcher = {
	readonly id: string;
	readonly fact: PassiveFactKind;
	readonly expected: readonly string[];
	readonly profiles: readonly string[];
	readonly strength: Exclude<EvidenceStrength, 'none'>;
	readonly required: boolean;
};

export type FingerprintResult = {
	readonly signal: 'match' | 'mismatch' | 'unknown';
	readonly strength: Exclude<EvidenceStrength, 'none'>;
	readonly profiles: readonly string[];
	readonly detail: string;
};

export type UnauthenticatedProbe = {
	readonly id: string;
	readonly run: (context: ProviderMatchRequest) => Promise<FingerprintResult>;
};

export type CapabilityReader = {
	readonly id: string;
	readonly read: (
		context: ProviderExecutionContext,
	) => Promise<Omit<FingerprintResult, 'profiles'>>;
};

export type AuthenticatedProfileResult =
	| { readonly status: 'matched'; readonly profile: string; readonly detail: string }
	| { readonly status: 'refused'; readonly detail: string }
	| { readonly status: 'unavailable'; readonly detail: string };

/** One algorithm and one call per generation-scoped evaluation; cycling is unrepresentable. */
export type AuthenticatedProfile = {
	readonly algorithm: string;
	readonly attemptLimit: 1;
	readonly authenticate: (
		context: ProviderMatchRequest,
		profileCandidates: readonly string[],
	) => Promise<AuthenticatedProfileResult>;
};

export type ProviderOperationsSurface = {
	readonly access: 'read-only' | 'read-write';
};

export interface ProviderReadOperations<O> {
	readonly descriptor: OperationDescriptor<never, O>;
	readonly read: (context: ProviderExecutionContext) => Promise<OperationResult<O>>;
}

export interface ProviderWriteOperations<I, O> {
	readonly descriptor: OperationDescriptor<I, O>;
	readonly read: (context: ProviderExecutionContext) => Promise<OperationResult<O>>;
	readonly write: (context: ProviderExecutionContext, input: I) => Promise<OperationResult<O>>;
}

export type ProviderContractFixture = {
	readonly profile: string;
	readonly request: Readonly<Record<string, unknown>>;
	readonly response: Readonly<Record<string, unknown>>;
};

export interface ProviderDefinition<
	TObservation = unknown,
	TOperations extends ProviderOperationsSurface = ProviderOperationsSurface,
> {
	readonly id: string;
	readonly profileVersion: string;
	readonly eligibleTransports: readonly ProviderTransport[];
	readonly passiveMatchers: readonly PassiveMatcher[];
	readonly unauthenticatedProbes: readonly UnauthenticatedProbe[];
	readonly authenticatedProfile?: AuthenticatedProfile;
	readonly capabilityReaders: readonly CapabilityReader[];
	readonly observe: (
		context: ProviderExecutionContext,
	) => Promise<readonly ObservationEnvelope<TObservation>[]>;
	readonly operations: (profile: string) => TOperations;
	readonly contractFixtures: readonly ProviderContractFixture[];
}

export type MatcherEvidence = {
	readonly provider: string;
	readonly profile: string | null;
	readonly stage:
		| 'transport-eligibility'
		| 'passive-facts'
		| 'unauthenticated-fingerprint'
		| 'authenticated-profile'
		| 'capability-read';
	readonly source: string;
	readonly signal: 'match' | 'mismatch' | 'unknown';
	readonly strength: EvidenceStrength;
	readonly detail: string;
};

type MatchResultBase = {
	readonly score: MatcherScore;
	readonly confidence: number;
	readonly evidence: readonly MatcherEvidence[];
	readonly conflicts: readonly MatcherEvidence[];
	readonly generation: DeviceGeneration;
	readonly physicalModemId: PhysicalModemId;
};

export type ProviderMatchResult =
	| (MatchResultBase & {
			readonly status: 'unsupported' | 'ambiguous';
			readonly provider: null;
			readonly profile: null;
			readonly operations: null;
			readonly writable: false;
	  })
	| (MatchResultBase & {
			readonly status: 'selected';
			readonly provider: string;
			readonly profile: string;
			readonly operations: ProviderOperationsSurface;
			readonly writable: boolean;
	  });

export interface ProviderMatcher {
	match(request: ProviderMatchRequest): Promise<ProviderMatchResult>;
}
