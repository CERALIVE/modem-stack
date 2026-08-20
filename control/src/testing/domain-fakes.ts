import {
	classifyOperationCompletion,
	type DeviceGeneration,
	defineOperationDescriptor,
	deviceGeneration,
	type EpochMillis,
	epochMillis,
	type MutationImpact,
	type ObservationAuthority,
	type ObservationEnvelope,
	type OperationCompletion,
	type OperationConfidence,
	type OperationDescriptor,
	type OperationResult,
	type PhysicalModemId,
	physicalModemId,
	type RetryClass,
	type SourceEpoch,
	type StableKey,
	sourceEpoch,
	stableKeyFromPhysicalModemId,
} from '../domain';

/**
 * A canonical, valid `PhysicalModemId` for contract tests.
 *
 * It is built through the real constructor, so it can never be a value the domain
 * refuses — an MM object path, an interface name, an IP address, an IMEI, or a
 * subscriber identifier.
 */
export const FAKE_PHYSICAL_MODEM_ID: PhysicalModemId = physicalModemId(
	'serial:ceralive-contract-fake',
);

/** The actor/storage key for {@link FAKE_PHYSICAL_MODEM_ID}. */
export const FAKE_STABLE_KEY: StableKey = stableKeyFromPhysicalModemId(FAKE_PHYSICAL_MODEM_ID);

/** The generation every fake defaults to, so a consumer's fences have a stable anchor. */
export const FAKE_GENERATION: DeviceGeneration = deviceGeneration(1);

export type FakeObservationOptions = {
	readonly stableKey?: StableKey;
	readonly generation?: DeviceGeneration;
	readonly source?: string;
	readonly sourceEpoch?: SourceEpoch;
	readonly observedAt?: EpochMillis;
	readonly authority?: ObservationAuthority;
};

type ObservationBaseFields = {
	readonly stableKey: StableKey;
	readonly generation: DeviceGeneration;
	readonly source: string;
	readonly sourceEpoch: SourceEpoch;
	readonly observedAt: EpochMillis;
	readonly authority: ObservationAuthority;
};

function observationBase(options: FakeObservationOptions): ObservationBaseFields {
	return {
		stableKey: options.stableKey ?? FAKE_STABLE_KEY,
		generation: options.generation ?? FAKE_GENERATION,
		source: options.source ?? 'contract-fake',
		sourceEpoch: options.sourceEpoch ?? sourceEpoch(1),
		observedAt: options.observedAt ?? epochMillis(1),
		authority: options.authority ?? 'authoritative',
	};
}

/** A fresh observation carrying `value`. */
export function fakeFreshObservation<T>(
	value: T,
	options: FakeObservationOptions = {},
): ObservationEnvelope<T> {
	return { ...observationBase(options), freshness: { state: 'fresh' }, value };
}

/** A stale observation that RETAINS `value` — staleness never discards what was read. */
export function fakeStaleObservation<T>(
	value: T,
	reason: 'source-epoch-superseded' | 'ttl-expired' | 'source-degraded' = 'ttl-expired',
	options: FakeObservationOptions = {},
): ObservationEnvelope<T> {
	const base = observationBase(options);
	return {
		...base,
		freshness: { state: 'stale', since: base.observedAt, reason },
		value,
	};
}

/**
 * An unavailable observation. It carries `value: null` by construction — there is no
 * overload that lets a consumer's fake invent a value for data nobody could read.
 */
export function fakeUnavailableObservation<T>(
	reason: 'source-unavailable' | 'device-absent' | 'provider-unavailable' = 'source-unavailable',
	options: FakeObservationOptions = {},
): ObservationEnvelope<T> {
	const base = observationBase(options);
	return {
		...base,
		freshness: { state: 'unavailable', since: base.observedAt, reason },
		value: null,
	};
}

export type FakeDescriptorOptions = {
	readonly id?: string;
	readonly provider?: string;
	readonly authority?: 'provider' | 'controller' | 'hardware';
	readonly confidence?: OperationConfidence;
};

function baseDescriptor<I, O>(
	options: FakeDescriptorOptions,
	support: { readonly read: boolean; readonly write: boolean },
	mutationImpact: MutationImpact,
	retryClass: RetryClass,
): OperationDescriptor<I, O> {
	return defineOperationDescriptor<I, O>({
		id: options.id ?? 'contract-fake-operation',
		support: {
			read: support.read ? { supported: true } : { supported: false, reason: 'contract-fake' },
			write: support.write ? { supported: true } : { supported: false, reason: 'contract-fake' },
		},
		authority: options.authority ?? 'provider',
		provider: options.provider ?? 'contract-fake-provider',
		constraints: { kind: 'unconstrained' },
		livePreconditions: [],
		availability: { state: 'available' },
		mutationImpact,
		retryClass,
		readback: { required: false },
		rollback: { required: false },
		journal: { required: false },
		admission: { required: false },
		evidence: { profiles: [], firmware: [] },
		confidence: options.confidence ?? 'medium',
	});
}

/**
 * A supported, auto-retryable idempotent READ descriptor.
 *
 * Routed through `defineOperationDescriptor`, so a fake that drifted into an
 * unsupported/retryable combination throws instead of silently modelling a
 * descriptor the domain would refuse.
 */
export function fakeReadDescriptor<O>(
	options: FakeDescriptorOptions = {},
): OperationDescriptor<never, O> {
	return baseDescriptor<never, O>(options, { read: true, write: false }, 'read', 'idempotent-read');
}

/** A supported WRITE descriptor. Writes are never auto-retryable, so `retryClass` is `never`. */
export function fakeWriteDescriptor<I, O>(
	options: FakeDescriptorOptions = {},
): OperationDescriptor<I, O> {
	return baseDescriptor<I, O>(options, { read: true, write: true }, 'write', 'never');
}

export type FakeOperationResultOptions = {
	readonly operation?: 'read' | 'write';
	readonly completionGeneration?: DeviceGeneration;
	readonly currentGeneration?: DeviceGeneration;
};

/**
 * Build an `OperationResult` by running the REAL classifier over a completion.
 *
 * A hand-written result literal is how a consumer's fake comes to disagree with the
 * package about which completions require reconciliation; this cannot.
 */
export function fakeOperationResult<O>(
	completion: OperationCompletion<O>,
	options: FakeOperationResultOptions = {},
): OperationResult<O> {
	return classifyOperationCompletion<O>({
		operation: options.operation ?? 'write',
		completionGeneration: options.completionGeneration ?? FAKE_GENERATION,
		currentGeneration: options.currentGeneration ?? FAKE_GENERATION,
		completion,
	});
}
