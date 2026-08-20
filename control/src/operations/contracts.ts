import type {
	DeviceGeneration,
	OperationCompletion,
	OperationDescriptor,
	OperationResult,
	PhysicalModemId,
} from '../domain';

export type OperationPreconditionRequest = {
	readonly operationId: string;
	readonly physicalModemId: PhysicalModemId;
	readonly generation: DeviceGeneration;
	readonly descriptorId: string;
	readonly preconditions: readonly string[];
};

export type OperationPreconditionResult =
	| { readonly status: 'satisfied' }
	| { readonly status: 'refused'; readonly reason: string };

/** Live operation facts. Implementations must inspect them for every invocation. */
export interface OperationPreconditionPort {
	check(request: OperationPreconditionRequest): Promise<OperationPreconditionResult>;
}

export type OperationAttemptContext = {
	readonly operationId: string;
	readonly generation: DeviceGeneration;
	readonly attempt: number;
};

export type OperationJournalEvent<I, O> =
	| {
			readonly phase: 'started';
			readonly operationId: string;
			readonly physicalModemId: PhysicalModemId;
			readonly generation: DeviceGeneration;
			readonly descriptor: OperationDescriptor<I, O>;
			readonly input: I;
	  }
	| {
			readonly phase: 'completed';
			readonly operationId: string;
			readonly physicalModemId: PhysicalModemId;
			readonly generation: DeviceGeneration;
			readonly descriptor: OperationDescriptor<I, O>;
			readonly result: OperationResult<O>;
	  };

export interface OperationJournalHook<I, O> {
	record(event: OperationJournalEvent<I, O>): Promise<void>;
}

export type OperationExecution<I, O> = {
	readonly operationId: string;
	readonly physicalModemId: PhysicalModemId;
	readonly descriptor: OperationDescriptor<I, O>;
	readonly input: I;
	readonly execute: (context: OperationAttemptContext) => Promise<OperationCompletion<O>>;
	readonly readback?: (context: OperationAttemptContext) => Promise<OperationCompletion<O>>;
	readonly rollback?: (context: OperationAttemptContext) => Promise<OperationCompletion<void>>;
	readonly journal?: OperationJournalHook<I, O>;
};

export type ReconciliationExecution = {
	readonly physicalModemId: PhysicalModemId;
	readonly generation: DeviceGeneration;
	readonly run: () => Promise<
		{ readonly status: 'reconciled' } | { readonly status: 'failed'; readonly reason: string }
	>;
};

export type ReconciliationResult =
	| { readonly status: 'reconciled'; readonly generation: DeviceGeneration }
	| { readonly status: 'not-required'; readonly generation: DeviceGeneration }
	| {
			readonly status: 'failed';
			readonly reason: 'stale-generation' | string;
			readonly generation: DeviceGeneration;
	  };
