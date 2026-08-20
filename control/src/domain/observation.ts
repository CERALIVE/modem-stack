import type { Brand } from './brand';
import { nonNegativeInteger } from './brand';
import type { DeviceGeneration } from './generation';
import type { StableKey } from './physical-identity';
import type { EpochMillis } from './state';

export type SourceEpoch = Brand<number, 'SourceEpoch'>;

export function sourceEpoch(value: number): SourceEpoch {
	return nonNegativeInteger(value, 'sourceEpoch') as SourceEpoch;
}

export type ObservationAuthority = 'authoritative' | 'derived' | 'advisory';

export type ObservationFreshness =
	| { readonly state: 'fresh' }
	| {
			readonly state: 'stale';
			readonly since: EpochMillis;
			readonly reason: 'source-epoch-superseded' | 'ttl-expired' | 'source-degraded';
	  }
	| {
			readonly state: 'unavailable';
			readonly since: EpochMillis;
			readonly reason: 'source-unavailable' | 'device-absent' | 'provider-unavailable';
	  };

type ObservationBase = {
	readonly stableKey: StableKey;
	readonly generation: DeviceGeneration;
	readonly source: string;
	readonly sourceEpoch: SourceEpoch;
	readonly observedAt: EpochMillis;
	readonly authority: ObservationAuthority;
};

/** A value is retained while stale, but unavailable is explicit and carries no invented value. */
export type ObservationEnvelope<T> =
	| (ObservationBase & {
			readonly freshness: Extract<ObservationFreshness, { readonly state: 'fresh' | 'stale' }>;
			readonly value: T;
	  })
	| (ObservationBase & {
			readonly freshness: Extract<ObservationFreshness, { readonly state: 'unavailable' }>;
			readonly value: null;
	  });
