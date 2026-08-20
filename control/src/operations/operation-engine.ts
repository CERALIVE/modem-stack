import {
	canAutoRetry,
	classifyOperationCompletion,
	type DeviceGeneration,
	type OperationDescriptor,
	type OperationResult,
	type PhysicalModemId,
} from '../domain';
import { acquireMutationAdmission, type MutationAdmissionResult } from '../ports';
import type { ModemControlCompositionRoot } from '../safety';
import type {
	OperationAttemptContext,
	OperationExecution,
	OperationPreconditionPort,
	ReconciliationExecution,
	ReconciliationResult,
} from './contracts';

export * from './contracts';

export type OperationEngineOptions = {
	readonly root: ModemControlCompositionRoot;
	readonly currentGeneration: (physicalModemId: PhysicalModemId) => DeviceGeneration;
	readonly preconditions: OperationPreconditionPort;
};

const MAX_IDEMPOTENT_READ_ATTEMPTS = 2;

export class OperationEngine {
	readonly #root: ModemControlCompositionRoot;
	readonly #currentGeneration: OperationEngineOptions['currentGeneration'];
	readonly #preconditions: OperationPreconditionPort;
	readonly #reconciliationRequired = new Set<PhysicalModemId>();

	constructor(options: OperationEngineOptions) {
		this.#root = options.root;
		this.#currentGeneration = options.currentGeneration;
		this.#preconditions = options.preconditions;
	}

	invoke<I, O>(execution: OperationExecution<I, O>): Promise<OperationResult<O>> {
		if (execution.descriptor.mutationImpact === 'read') {
			return this.#invokeNow(execution);
		}
		return this.#root
			.actorFor(execution.physicalModemId)
			.run(execution.physicalModemId, () => this.#invokeNow(execution));
	}

	reconcile(execution: ReconciliationExecution): Promise<ReconciliationResult> {
		return this.#root
			.actorFor(execution.physicalModemId)
			.run(execution.physicalModemId, async () => {
				const current = this.#currentGeneration(execution.physicalModemId);
				if (!this.#reconciliationRequired.has(execution.physicalModemId)) {
					return { status: 'not-required', generation: current };
				}
				if (current !== execution.generation) {
					return { status: 'failed', reason: 'stale-generation', generation: current };
				}
				const result = await execution.run();
				const completedGeneration = this.#currentGeneration(execution.physicalModemId);
				if (completedGeneration !== execution.generation) {
					return {
						status: 'failed',
						reason: 'stale-generation',
						generation: completedGeneration,
					};
				}
				if (result.status === 'failed') {
					return { ...result, generation: completedGeneration };
				}
				this.#reconciliationRequired.delete(execution.physicalModemId);
				return { status: 'reconciled', generation: completedGeneration };
			});
	}

	async #invokeNow<I, O>(execution: OperationExecution<I, O>): Promise<OperationResult<O>> {
		const generation = this.#currentGeneration(execution.physicalModemId);
		const kind = execution.descriptor.mutationImpact === 'read' ? 'read' : 'write';
		if (kind === 'write' && this.#reconciliationRequired.has(execution.physicalModemId)) {
			return refused('reconciliation-required', generation);
		}

		const descriptorRefusal = descriptorRefusalReason(execution);
		if (descriptorRefusal !== undefined) return refused(descriptorRefusal, generation);

		const precondition = await this.#preconditions.check({
			operationId: execution.operationId,
			physicalModemId: execution.physicalModemId,
			generation,
			descriptorId: execution.descriptor.id,
			preconditions: execution.descriptor.livePreconditions,
		});
		if (precondition.status === 'refused') return refused(precondition.reason, generation);

		const admission = await acquireMutationAdmission(
			{
				operationId: execution.operationId,
				physicalModemId: execution.physicalModemId,
				impact: execution.descriptor.mutationImpact,
				requirement: execution.descriptor.admission,
			},
			kind === 'write' ? this.#root.admission : undefined,
		);
		if (admission.status === 'refused') return refused(admission.reason, generation);

		try {
			await execution.journal?.record({
				phase: 'started',
				operationId: execution.operationId,
				physicalModemId: execution.physicalModemId,
				generation,
				descriptor: execution.descriptor,
				input: execution.input,
			});
			const result = await this.#executeWithRetry(execution, generation, kind);
			const withHooks = await this.#runCompletionHooks(execution, result, generation);
			if (withHooks.status === 'unknown-outcome') {
				this.#reconciliationRequired.add(execution.physicalModemId);
			}
			await execution.journal?.record({
				phase: 'completed',
				operationId: execution.operationId,
				physicalModemId: execution.physicalModemId,
				generation,
				descriptor: execution.descriptor,
				result: withHooks,
			});
			return withHooks;
		} finally {
			await releaseAdmission(admission);
		}
	}

	async #executeWithRetry<I, O>(
		execution: OperationExecution<I, O>,
		generation: DeviceGeneration,
		kind: 'read' | 'write',
	): Promise<OperationResult<O>> {
		for (let attempt = 1; attempt <= MAX_IDEMPOTENT_READ_ATTEMPTS; attempt += 1) {
			const completion = await execution.execute({
				operationId: execution.operationId,
				generation,
				attempt,
			});
			const result = classifyOperationCompletion({
				operation: kind,
				completionGeneration: generation,
				currentGeneration: this.#currentGeneration(execution.physicalModemId),
				completion,
			});
			if (!canAutoRetry(execution.descriptor, result) || attempt === MAX_IDEMPOTENT_READ_ATTEMPTS) {
				return result;
			}
		}
		return refused('retry-budget-exhausted', generation);
	}

	async #runCompletionHooks<I, O>(
		execution: OperationExecution<I, O>,
		result: OperationResult<O>,
		generation: DeviceGeneration,
	): Promise<OperationResult<O>> {
		const context: OperationAttemptContext = {
			operationId: execution.operationId,
			generation,
			attempt: 1,
		};
		if (result.status === 'applied' && execution.descriptor.readback.required) {
			const completion = await execution.readback?.(context);
			if (completion === undefined) return refused('readback-hook-missing', generation);
			const readback = classifyOperationCompletion({
				operation: 'read',
				completionGeneration: generation,
				currentGeneration: this.#currentGeneration(execution.physicalModemId),
				completion,
			});
			if (
				readback.status === 'applied' &&
				execution.descriptor.readback.matches(execution.input, readback.value)
			) {
				return result;
			}
			if (readback.status === 'unknown-outcome') return readback;
			await execution.rollback?.(context);
			return refused(
				readback.status === 'applied' ? 'readback-mismatch' : `readback-${readback.reason}`,
				generation,
				'failed',
			);
		}
		if (result.status === 'failed' && execution.descriptor.rollback.required) {
			await execution.rollback?.(context);
		}
		return result;
	}
}

export function createOperationEngine(options: OperationEngineOptions): OperationEngine {
	return new OperationEngine(options);
}

function descriptorRefusalReason<I, O>(execution: OperationExecution<I, O>): string | undefined {
	const { descriptor } = execution;
	const support =
		descriptor.mutationImpact === 'read' ? descriptor.support.read : descriptor.support.write;
	if (!support.supported) return support.reason;
	if (descriptor.availability.state !== 'available') return descriptor.availability.reason;
	if (!inputAllowed(descriptor, execution.input)) return 'constraint-refused';
	if (descriptor.readback.required && execution.readback === undefined)
		return 'readback-hook-missing';
	if (descriptor.rollback.required && execution.rollback === undefined)
		return 'rollback-hook-missing';
	if (descriptor.journal.required && execution.journal === undefined) return 'journal-hook-missing';
	return undefined;
}

function inputAllowed<I, O>(descriptor: OperationDescriptor<I, O>, input: I): boolean {
	switch (descriptor.constraints.kind) {
		case 'unconstrained':
			return true;
		case 'allowed-values':
			return descriptor.constraints.values.some((value) => Object.is(value, input));
		case 'numeric-range':
			return (
				typeof input === 'number' &&
				input >= descriptor.constraints.min &&
				input <= descriptor.constraints.max &&
				(descriptor.constraints.step === undefined ||
					(input - descriptor.constraints.min) % descriptor.constraints.step === 0)
			);
	}
}

function refused<O>(
	reason: string,
	generation: DeviceGeneration,
	status: 'refused' | 'failed' = 'refused',
): OperationResult<O> {
	return { status, reason, generation, requiresReconciliation: false };
}

async function releaseAdmission(admission: MutationAdmissionResult): Promise<void> {
	if (admission.status === 'admitted') await admission.lease.release();
}
