import type { DeviceGeneration, OperationDescriptor, OperationResult } from '../../domain';
import { defineOperationDescriptor } from '../../domain';
import { parseHilinkDataCapability, parseHilinkXmlValue } from '../../hardware/router-parsers';
import type { ProviderExecutionContext } from '../contracts';
import { HILINK_PATHS, type HilinkProfile } from './provider';

export type ReadValue = Readonly<Record<string, unknown>>;
export type ReadOperation = {
	readonly descriptor: OperationDescriptor<never, ReadValue>;
	readonly read: (context: ProviderExecutionContext) => Promise<OperationResult<ReadValue>>;
};
export type WriteOperation = {
	readonly descriptor: OperationDescriptor<string | boolean, ReadValue>;
	readonly read: ReadOperation['read'];
	readonly write: (
		context: ProviderExecutionContext,
		value: string | boolean,
	) => Promise<OperationResult<ReadValue>>;
};

export function applied(
	generation: DeviceGeneration,
	value: ReadValue,
): OperationResult<ReadValue> {
	return { status: 'applied', value, generation, requiresReconciliation: false };
}

export function refused(generation: DeviceGeneration, reason: string): OperationResult<ReadValue> {
	return { status: 'refused', reason, generation, requiresReconciliation: false };
}

export function operationDescriptor<I>(
	id: string,
	write: boolean,
	profile: HilinkProfile,
): OperationDescriptor<I, ReadValue> {
	return defineOperationDescriptor<I, ReadValue>({
		id,
		support: {
			read: { supported: true },
			write: write ? { supported: true } : { supported: false, reason: 'read-only' },
		},
		authority: 'provider',
		provider: 'huawei-hilink',
		constraints: { kind: 'unconstrained' },
		livePreconditions: ['fresh-session', 'capability-evidence'],
		availability: { state: 'available' },
		mutationImpact: write ? 'write' : 'read',
		retryClass: 'never',
		readback: write
			? { required: true, reason: 'fresh-readback', matches: () => true }
			: { required: false },
		rollback: { required: false },
		journal: { required: false },
		admission: { required: true, reason: 'router-session' },
		evidence: { profiles: [profile.id], firmware: [profile.firmware] },
		confidence: 'high',
	});
}

export function requestSucceeded(status: number, body: string): boolean {
	return status >= 200 && status < 300 && /<response>\s*OK\s*<\/response>/i.test(body);
}

export function capabilityPath(kind: 'status' | 'signal' | 'mode' | 'data'): string {
	return kind === 'status'
		? HILINK_PATHS.status
		: kind === 'signal'
			? HILINK_PATHS.signal
			: kind === 'mode'
				? HILINK_PATHS.modeList
				: HILINK_PATHS.data;
}

export function writeDocument(kind: 'mode' | 'data', value: string | boolean): string {
	return kind === 'mode'
		? `<?xml version="1.0" encoding="UTF-8"?><request><NetworkMode>${String(value)}</NetworkMode></request>`
		: `<?xml version="1.0" encoding="UTF-8"?><request><dataswitch>${value ? 1 : 0}</dataswitch></request>`;
}

export function readbackMatches(
	kind: 'mode' | 'data',
	body: string,
	value: string | boolean,
): boolean {
	if (kind === 'mode') return parseHilinkXmlValue(body, 'NetworkMode') === String(value);
	const parsed = parseHilinkDataCapability(body);
	return parsed.state === 'reported' && parsed.enabled === Boolean(value);
}
