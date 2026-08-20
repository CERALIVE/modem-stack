import type { MutationImpact, OperationRequirement, PhysicalModemId } from '../domain';

export type MutationAdmissionRequest = {
	readonly operationId: string;
	readonly physicalModemId: PhysicalModemId;
	readonly impact: MutationImpact;
	readonly requirement: OperationRequirement;
};

export interface MutationAdmissionLease {
	release(): Promise<void>;
}

export type MutationAdmissionRefusalReason = 'admission-port-missing' | 'admission-refused';

export type MutationAdmissionDecision =
	| { readonly status: 'admitted'; readonly lease: MutationAdmissionLease }
	| {
			readonly status: 'refused';
			readonly reason: MutationAdmissionRefusalReason;
			readonly detail?: string;
	  };

export type MutationAdmissionResult =
	| { readonly status: 'not-required' }
	| MutationAdmissionDecision;

/** Consumer-owned admission authority. The package neither derives nor interprets its policy. */
export interface MutationAdmissionPort {
	acquire(request: MutationAdmissionRequest): Promise<MutationAdmissionDecision>;
}

export function acquireMutationAdmission(
	request: MutationAdmissionRequest,
	port: MutationAdmissionPort | undefined,
): Promise<MutationAdmissionResult> {
	if (!request.requirement.required) {
		return Promise.resolve({ status: 'not-required' });
	}
	if (port === undefined) {
		return Promise.resolve({ status: 'refused', reason: 'admission-port-missing' });
	}
	return port.acquire(request);
}
