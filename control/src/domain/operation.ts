import { DomainError } from './errors';
import type { DeviceGeneration } from './generation';

export type OperationSupport =
	| { readonly supported: true }
	| { readonly supported: false; readonly reason: string };

export type OperationConstraints<I> =
	| { readonly kind: 'unconstrained' }
	| { readonly kind: 'allowed-values'; readonly values: readonly I[] }
	| {
			readonly kind: 'numeric-range';
			readonly min: number;
			readonly max: number;
			readonly step?: number;
	  };

export type OperationAvailability =
	| { readonly state: 'available' }
	| { readonly state: 'unavailable'; readonly reason: string }
	| { readonly state: 'refused'; readonly reason: string };

export type MutationImpact = 'read' | 'write' | 'session' | 'disruptive' | 'recovery';
export type RetryClass = 'never' | 'idempotent-read';
export type OperationConfidence = 'high' | 'medium' | 'low' | 'unknown';

export type OperationRequirement =
	| { readonly required: false }
	| { readonly required: true; readonly reason: string };

export type OperationReadback<I, O> =
	| { readonly required: false }
	| {
			readonly required: true;
			readonly reason: string;
			readonly matches: (input: I, observed: O) => boolean;
	  };

export type OperationDescriptor<I, O> = {
	readonly id: string;
	readonly support: {
		readonly read: OperationSupport;
		readonly write: OperationSupport;
	};
	readonly authority: 'provider' | 'controller' | 'hardware';
	readonly provider: string;
	readonly constraints: OperationConstraints<I>;
	readonly livePreconditions: readonly string[];
	readonly availability: OperationAvailability;
	readonly mutationImpact: MutationImpact;
	readonly retryClass: RetryClass;
	readonly readback: OperationReadback<I, O>;
	readonly rollback: OperationRequirement;
	readonly journal: OperationRequirement;
	readonly admission: OperationRequirement;
	readonly evidence: {
		readonly profiles: readonly string[];
		readonly firmware: readonly string[];
	};
	readonly confidence: OperationConfidence;
};

export class OperationDescriptorError extends DomainError {
	override readonly name = 'OperationDescriptorError';
	readonly reason = 'retry-requires-idempotent-read';

	constructor() {
		super('operation descriptor refused: automatic retry requires a supported idempotent read');
	}
}

export function defineOperationDescriptor<I, O>(
	descriptor: OperationDescriptor<I, O>,
): OperationDescriptor<I, O> {
	if (
		descriptor.retryClass === 'idempotent-read' &&
		(descriptor.mutationImpact !== 'read' || !descriptor.support.read.supported)
	) {
		throw new OperationDescriptorError();
	}
	return descriptor;
}

export type OperationCompletion<O> =
	| { readonly status: 'applied'; readonly value: O }
	| { readonly status: 'refused'; readonly reason: string }
	| { readonly status: 'failed'; readonly reason: string }
	| { readonly status: 'timed-out' }
	| { readonly status: 'dropped' };

export type OperationResult<O> =
	| {
			readonly status: 'applied';
			readonly value: O;
			readonly generation: DeviceGeneration;
			readonly requiresReconciliation: false;
	  }
	| {
			readonly status: 'refused';
			readonly reason: string;
			readonly generation: DeviceGeneration;
			readonly requiresReconciliation: false;
	  }
	| {
			readonly status: 'unknown-outcome';
			readonly reason: 'stale-generation' | 'write-reply-timed-out' | 'write-reply-dropped';
			readonly generation: DeviceGeneration;
			readonly requiresReconciliation: true;
	  }
	| {
			readonly status: 'failed';
			readonly reason: string;
			readonly generation: DeviceGeneration;
			readonly requiresReconciliation: false;
	  };

export type OperationCompletionContext<O> = {
	readonly operation: 'read' | 'write';
	readonly completionGeneration: DeviceGeneration;
	readonly currentGeneration: DeviceGeneration;
	readonly completion: OperationCompletion<O>;
};

/** Apply generation and write-reply uncertainty before exposing a completion to callers. */
export function classifyOperationCompletion<O>(
	context: OperationCompletionContext<O>,
): OperationResult<O> {
	const generation = context.completionGeneration;
	if (generation !== context.currentGeneration) {
		return {
			status: 'unknown-outcome',
			reason: 'stale-generation',
			requiresReconciliation: true,
			generation,
		};
	}

	switch (context.completion.status) {
		case 'applied':
			return {
				status: 'applied',
				value: context.completion.value,
				generation,
				requiresReconciliation: false,
			};
		case 'refused':
			return {
				status: 'refused',
				reason: context.completion.reason,
				generation,
				requiresReconciliation: false,
			};
		case 'failed':
			return {
				status: 'failed',
				reason: context.completion.reason,
				generation,
				requiresReconciliation: false,
			};
		case 'timed-out':
			return context.operation === 'write'
				? {
						status: 'unknown-outcome',
						reason: 'write-reply-timed-out',
						requiresReconciliation: true,
						generation,
					}
				: {
						status: 'failed',
						reason: 'read-reply-timed-out',
						requiresReconciliation: false,
						generation,
					};
		case 'dropped':
			return context.operation === 'write'
				? {
						status: 'unknown-outcome',
						reason: 'write-reply-dropped',
						requiresReconciliation: true,
						generation,
					}
				: {
						status: 'failed',
						reason: 'read-reply-dropped',
						requiresReconciliation: false,
						generation,
					};
	}
}

/** Automatic retries are restricted to explicitly classified idempotent reads. */
export function canAutoRetry<I, O>(
	descriptor: OperationDescriptor<I, O>,
	result: OperationResult<O>,
): boolean {
	return (
		descriptor.mutationImpact === 'read' &&
		descriptor.support.read.supported &&
		descriptor.retryClass === 'idempotent-read' &&
		result.status === 'failed'
	);
}
