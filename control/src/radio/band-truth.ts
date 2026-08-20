// The band-write descriptor — the certification gate, expressed as an operation contract.
//
// It ADDS NOTHING to `band/certification.ts`. That module already owns the four-proof
// per-SKU catalog, the fail-closed lookup, and the `offerableBands` narrowing, and it
// is the only place a SKU may be declared certified. What was missing was the other
// end of the wire: a band write's OPERATION DESCRIPTOR did not say that it is
// disruptive-with-a-certification-requirement, so the gate lived only inside the
// provider's capability flag and a consumer reading the descriptor could not see it.
//
// TWO INDEPENDENT FENCES, deliberately. `availability: refused` is what a consumer
// reads to decide whether to offer the control at all; the provider's own
// `bandWrite` capability check is what refuses the call if one is made anyway. A gate
// that exists only in the descriptor is advisory, and a gate that exists only in the
// provider is invisible — a band lock can take a working uplink off the air, so it
// gets both.

import { type BandCertificationEntry, type BandName, offerableBands } from '../band';
import { defineOperationDescriptor, type OperationDescriptor } from '../domain';
import type { ModemBands } from '../ports';

export const BAND_WRITE_OPERATION_ID = 'modemmanager.bands';

/** The refusal reasons a band write may carry. Certification is the first gate. */
export const BAND_WRITE_REFUSAL = 'band-certification-required';
export const BAND_READ_REFUSAL = 'band-read-unsupported';
export const BAND_NONE_OFFERABLE_REFUSAL = 'no-offerable-certified-bands';

/**
 * The band-lock certification decision for one device, as a descriptor consumer sees it.
 *
 * `required` is `true` unconditionally and is typed as the literal, so no code path can
 * produce a band-write decision that does not require certification. This is the one
 * capability module documented as STRICTER than `support-claim.ts`'s `capable` floor.
 */
export type BandWriteCertification = {
	readonly required: true;
	readonly satisfied: boolean;
	readonly reason: 'band-certification-proven' | typeof BAND_WRITE_REFUSAL;
	/** What the catalog proves is settable, intersected with what the modem advertises. */
	readonly offerable: readonly BandName[];
};

export function describeBandWriteCertification(input: {
	readonly entry: BandCertificationEntry | undefined;
	readonly supported: readonly BandName[];
}): BandWriteCertification {
	const offerable = offerableBands(input.entry, input.supported);
	return input.entry === undefined
		? { required: true, satisfied: false, reason: BAND_WRITE_REFUSAL, offerable }
		: { required: true, satisfied: true, reason: 'band-certification-proven', offerable };
}

export type BandWriteDescriptorInput = {
	readonly provider: string;
	readonly profile: string;
	readonly certification: BandWriteCertification;
	readonly readSupported: boolean;
};

function sameBandSet(left: readonly BandName[], right: readonly BandName[]): boolean {
	if (left.length !== right.length) return false;
	const sorted = [...right].sort();
	return [...left].sort().every((band, index) => band === sorted[index]);
}

/**
 * Whether a band readback confirms the write.
 *
 * A NARROWING lock must match exactly — a superset is a different lock from the one
 * that was asked for. The reset (`['any']`) is the exception ModemManager forces:
 * releasing a lock is `SetCurrentBands([ANY])`, and a modem afterwards reports either
 * `any` or its whole supported set, both of which mean "no lock is in force".
 */
export function bandWriteReadbackMatches(
	requested: readonly BandName[],
	observed: ModemBands,
): boolean {
	if (requested.length === 1 && requested[0] === 'any') {
		return (
			(observed.current.length === 1 && observed.current[0] === 'any') ||
			sameBandSet(observed.current, observed.supported)
		);
	}
	return sameBandSet(requested, observed.current);
}

/**
 * The live band-write descriptor.
 *
 * `mutationImpact: 'disruptive'` because `SetCurrentBands` re-registers the radio and
 * drops the bearer underneath NetworkManager; `readback` is REQUIRED because an
 * accepted-but-ignored band write is the failure mode the catalog's own `readback`
 * proof exists to catch, and it looks like success from the call site alone.
 */
export function buildBandWriteDescriptor(
	input: BandWriteDescriptorInput,
): OperationDescriptor<readonly BandName[], ModemBands> {
	const refusal = !input.certification.satisfied
		? BAND_WRITE_REFUSAL
		: input.certification.offerable.length === 0
			? BAND_NONE_OFFERABLE_REFUSAL
			: undefined;
	return defineOperationDescriptor<readonly BandName[], ModemBands>({
		id: BAND_WRITE_OPERATION_ID,
		support: {
			read: input.readSupported
				? { supported: true }
				: { supported: false, reason: BAND_READ_REFUSAL },
			write: input.certification.satisfied
				? { supported: true }
				: { supported: false, reason: BAND_WRITE_REFUSAL },
		},
		authority: 'provider',
		provider: input.provider,
		constraints: { kind: 'allowed-values', values: [input.certification.offerable] },
		livePreconditions: ['modem-present', 'runtime-interface-present', 'band-certification-present'],
		availability:
			refusal === undefined ? { state: 'available' } : { state: 'refused', reason: refusal },
		mutationImpact: 'disruptive',
		retryClass: 'never',
		readback: {
			required: true,
			reason: 'band-write-readback',
			matches: bandWriteReadbackMatches,
		},
		rollback: { required: false },
		journal: { required: true, reason: 'disruptive-radio-write' },
		admission: { required: true, reason: 'provider-mutation' },
		evidence: { profiles: [input.profile], firmware: [] },
		confidence: 'high',
	});
}
