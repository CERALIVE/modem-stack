import {
	defineOperationDescriptor,
	type OperationDescriptor,
	type OperationResult,
} from '../../domain';
import type { ProviderReadOperations } from '../contracts';
import {
	type UfiProhibitionClass,
	type UfiProhibitionReason,
	ufiProhibition,
} from './prohibitions';

export const UFI_PROFILE = 'ufi-himi-read-only';

/** The reason every descriptor gives for its absent write half. One string, one meaning. */
export const UFI_READ_ONLY_REASON = 'ufi-himi-provider-is-read-only';

export type UfiReadValue = Readonly<Record<string, unknown>>;

/**
 * `ProviderReadOperations` is used verbatim rather than a local shape, because it has no
 * `write` member to omit — the absence is structural, not a convention this file keeps.
 */
export type UfiReadOperation = ProviderReadOperations<UfiReadValue>;

export const UFI_READ_OPERATION_IDS = ['ufi.signal.read', 'ufi.details.read'] as const;
export type UfiReadOperationId = (typeof UFI_READ_OPERATION_IDS)[number];

export function isUfiReadOperation(operationId: string): operationId is UfiReadOperationId {
	return (UFI_READ_OPERATION_IDS as readonly string[]).includes(operationId);
}

export function ufiReadDescriptor(
	operationId: UfiReadOperationId,
): OperationDescriptor<never, UfiReadValue> {
	return defineOperationDescriptor<never, UfiReadValue>({
		id: operationId,
		support: {
			read: { supported: true },
			write: { supported: false, reason: UFI_READ_ONLY_REASON },
		},
		authority: 'provider',
		provider: 'ufi-himi',
		constraints: { kind: 'unconstrained' },
		livePreconditions: ['ufi-himi-session'],
		availability: { state: 'available' },
		mutationImpact: 'read',
		retryClass: 'idempotent-read',
		readback: { required: false },
		rollback: { required: false },
		journal: { required: false },
		admission: { required: false },
		evidence: { profiles: [UFI_PROFILE], firmware: [] },
		confidence: 'medium',
	});
}

export function ufiReadResult(
	generation: OperationResult<UfiReadValue>['generation'],
	value: UfiReadValue,
): OperationResult<UfiReadValue> {
	return { status: 'applied', value, generation, requiresReconciliation: false };
}

export function ufiRefusedResult(
	generation: OperationResult<UfiReadValue>['generation'],
	reason: string,
): OperationResult<UfiReadValue> {
	return { status: 'refused', reason, generation, requiresReconciliation: false };
}

export type UfiOperationPlan =
	| { readonly status: 'read'; readonly operationId: UfiReadOperationId }
	| {
			readonly status: 'refused';
			readonly operationId: string;
			readonly reason: UfiProhibitionReason | 'unknown-operation';
			readonly prohibitionClass: UfiProhibitionClass | null;
			/**
			 * A literal, and provable: this function takes no transport, holds no session,
			 * and returns synchronously — there is nothing here that could reach the device.
			 */
			readonly transportContacted: false;
	  };

/**
 * Resolve an operation id BEFORE anything is dialled.
 *
 * Prohibited ids are answered from the frozen table first, so a forbidden operation is
 * never mistaken for a typo. An id that is neither prohibited nor a known read is
 * `unknown-operation` — also refused, because a read-only provider's operation set is
 * closed and "not in the set" is a complete answer.
 */
export function planUfiOperation(operationId: string): UfiOperationPlan {
	const prohibition = ufiProhibition(operationId);
	if (prohibition !== undefined) {
		return {
			status: 'refused',
			operationId,
			reason: prohibition.reason,
			prohibitionClass: prohibition.class,
			transportContacted: false,
		};
	}
	if (isUfiReadOperation(operationId)) return { status: 'read', operationId };
	return {
		status: 'refused',
		operationId,
		reason: 'unknown-operation',
		prohibitionClass: null,
		transportContacted: false,
	};
}
