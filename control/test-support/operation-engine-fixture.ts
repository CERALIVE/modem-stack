import {
	defineOperationDescriptor,
	deviceGeneration,
	nextDeviceGeneration,
	type OperationCompletion,
	type OperationDescriptor,
	physicalModemId,
} from '../src/domain';
import {
	createOperationEngine,
	type OperationExecution,
	type OperationPreconditionPort,
} from '../src/operations/operation-engine';
import type { MutationAdmissionPort, ResourceOwnershipPort } from '../src/ports';
import { createModemControlCompositionRoot } from '../src/safety';

export const OPERATION_MODEM = physicalModemId('serial:operation-engine');

const ownership: ResourceOwnershipPort = {
	acquire: () => Promise.resolve({ status: 'refused', reason: 'already-owned' }),
};
const admission: MutationAdmissionPort = {
	acquire: () =>
		Promise.resolve({
			status: 'admitted',
			lease: { release: () => Promise.resolve() },
		}),
};

export function operationDescriptor(
	overrides: Partial<OperationDescriptor<string, string>> = {},
): OperationDescriptor<string, string> {
	return defineOperationDescriptor({
		id: 'set-mode',
		support: { read: { supported: true }, write: { supported: true } },
		authority: 'provider',
		provider: 'fixture',
		constraints: { kind: 'allowed-values', values: ['auto', 'lte'] },
		livePreconditions: ['device-present'],
		availability: { state: 'available' },
		mutationImpact: 'write',
		retryClass: 'never',
		readback: { required: false },
		rollback: { required: false },
		journal: { required: false },
		admission: { required: true, reason: 'controller approval' },
		evidence: { profiles: ['fixture'], firmware: [] },
		confidence: 'high',
		...overrides,
	});
}

export function deferred<T>(): {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
} {
	let resolvePromise: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(value: T): void {
			if (resolvePromise === undefined) throw new Error('deferred resolver was not initialized');
			resolvePromise(value);
		},
	};
}

export function operationExecution(
	completion: () => Promise<OperationCompletion<string>>,
	overrides: Partial<OperationExecution<string, string>> = {},
): OperationExecution<string, string> {
	return {
		operationId: 'operation-1',
		physicalModemId: OPERATION_MODEM,
		descriptor: operationDescriptor(),
		input: 'lte',
		execute: completion,
		...overrides,
	};
}

export function createOperationEngineHarness(preconditions?: OperationPreconditionPort) {
	const root = createModemControlCompositionRoot({ admission, ownership });
	let generation = deviceGeneration(1);
	const engine = createOperationEngine({
		root,
		currentGeneration: () => generation,
		preconditions: preconditions ?? {
			check: () => Promise.resolve({ status: 'satisfied' }),
		},
	});
	return {
		engine,
		generation: () => generation,
		replace(): void {
			generation = nextDeviceGeneration(generation);
		},
		dispose: () => root.dispose(),
	};
}
