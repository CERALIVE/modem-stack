import { afterEach, describe, expect, test } from 'bun:test';
import { createOperationEngineHarness } from '../../../test-support/operation-engine-fixture';
import { physicalModemId } from '../../domain';
import type { OperationExecution } from '../../operations';
import { UFI_PROFILE } from './operations';
import {
	UFI_PROHIBITED_OPERATION_IDS,
	UFI_PROHIBITED_OPERATIONS,
	type UfiProhibitedOperationId,
	ufiProhibitionDescriptor,
} from './prohibitions';
import { createUfiHimiDefinition } from './provider';
import type { UfiHttpRequest, UfiTransport } from './transport';

const FENCE_MODEM = physicalModemId('serial:ufi-fence');

const disposals: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});

/** A transport that records every call and answers nothing. Any use is a failure. */
function spyTransport() {
	const calls: UfiHttpRequest[] = [];
	const transport: UfiTransport = {
		request: async (request) => {
			calls.push(request);
			return { status: 200, body: '{"reply":"ok"}' };
		},
	};
	return { calls, transport };
}

function operationsFor(transport: UfiTransport) {
	return createUfiHimiDefinition({
		interfaceName: 'usb0',
		adminUrl: 'http://192.168.0.1',
		transport,
		credentials: { username: 'admin', password: 'unused-in-this-suite' },
	}).operations(UFI_PROFILE);
}

/** Every callable reachable from a value, by path — the structural half of "no write". */
function functionPaths(value: unknown, path = ''): readonly string[] {
	if (typeof value === 'function') return [path];
	if (Array.isArray(value)) {
		return value.flatMap((item, index) => functionPaths(item, `${path}[${index}]`));
	}
	if (typeof value === 'object' && value !== null) {
		return Object.entries(value).flatMap(([key, item]) =>
			functionPaths(item, path === '' ? key : `${path}.${key}`),
		);
	}
	return [];
}

describe('UFI operations expose zero write descriptors', () => {
	test('the only callables on the surface are the two reads and the pure planner', () => {
		// Given
		const spy = spyTransport();

		// When
		const operations = operationsFor(spy.transport);

		// Then
		expect(operations.access).toBe('read-only');
		expect(functionPaths(operations)).toEqual(['reads[0].read', 'reads[1].read', 'plan']);
		expect(spy.calls).toEqual([]);
	});

	test('no read entry carries a write member and no descriptor supports a write', () => {
		// Given
		const spy = spyTransport();

		// When
		const operations = operationsFor(spy.transport);

		// Then
		expect(operations.reads.length).toBeGreaterThan(0);
		for (const entry of operations.reads) {
			expect(Object.keys(entry).sort()).toEqual(['descriptor', 'read']);
			expect('write' in entry).toBe(false);
			expect(entry.descriptor.mutationImpact).toBe('read');
			expect(entry.descriptor.support.write).toEqual({
				supported: false,
				reason: 'ufi-himi-provider-is-read-only',
			});
		}
		expect(spy.calls).toEqual([]);
	});
});

describe('prohibited operations', () => {
	test('the fence enumerates every forbidden class the safety model names', () => {
		// Given / When
		const ids = [...UFI_PROHIBITED_OPERATION_IDS].sort();

		// Then
		expect(ids).toEqual([
			'calibration.write',
			'diag.info-probe',
			'diag.write',
			'driver.blind-retry',
			'edl.automation',
			'efs.write',
			'firmware.flash',
			'identity.write',
			'interface.blind-retry',
			'nv.write',
			'shell.transport-fallback',
		]);
	});

	test.each([...UFI_PROHIBITED_OPERATION_IDS])(
		'%s is refused with its typed reason and never reaches the transport',
		(operationId) => {
			// Given
			const spy = spyTransport();
			const operations = operationsFor(spy.transport);

			// When
			const plan = operations.plan(operationId);

			// Then
			expect(plan).toEqual({
				status: 'refused',
				operationId,
				reason: UFI_PROHIBITED_OPERATIONS[operationId].reason,
				prohibitionClass: UFI_PROHIBITED_OPERATIONS[operationId].class,
				transportContacted: false,
			});
			expect(operations.reads.some((entry) => entry.descriptor.id === operationId)).toBe(false);
			expect(spy.calls).toEqual([]);
		},
	);

	test('an unknown operation id is refused too — the read set is closed', () => {
		// Given
		const spy = spyTransport();

		// When
		const plan = operationsFor(spy.transport).plan('ufi.wifi.enable');

		// Then
		expect(plan).toMatchObject({ status: 'refused', reason: 'unknown-operation' });
		expect(spy.calls).toEqual([]);
	});

	test('a supported read id still plans as a read', () => {
		// Given
		const spy = spyTransport();

		// When
		const plan = operationsFor(spy.transport).plan('ufi.signal.read');

		// Then
		expect(plan).toEqual({ status: 'read', operationId: 'ufi.signal.read' });
		expect(spy.calls).toEqual([]);
	});
});

describe('prohibited operations driven through the operation engine', () => {
	test('every forbidden id is refused before any transport activity', async () => {
		// Given — an ADVERSARIAL execution: its execute() would dial the device, so a
		// single recorded call proves the engine ran it. The descriptor is the shipped,
		// inert one; nothing in the package can supply a matching execute.
		const spy = spyTransport();
		const harness = createOperationEngineHarness();
		disposals.push(harness.dispose);
		const attempt = (
			operationId: UfiProhibitedOperationId,
		): OperationExecution<unknown, never> => ({
			operationId,
			physicalModemId: FENCE_MODEM,
			descriptor: ufiProhibitionDescriptor(operationId),
			input: undefined,
			execute: async () => {
				await spy.transport.request({
					method: 'POST',
					url: 'http://192.168.0.1/himiapi/json',
					command: 'getsysinfo',
					body: '{"cmdid":"getsysinfo"}',
					headers: [],
					interfaceName: 'usb0',
					redirect: 'error',
				});
				return { status: 'failed', reason: 'prohibited-operation-must-never-execute' };
			},
		});

		// When
		const results = await Promise.all(
			UFI_PROHIBITED_OPERATION_IDS.map((operationId) =>
				harness.engine.invoke(attempt(operationId)),
			),
		);

		// Then
		expect(
			results.map((result) => ({
				status: result.status,
				reason: 'reason' in result ? result.reason : null,
			})),
		).toEqual(
			UFI_PROHIBITED_OPERATION_IDS.map((operationId) => ({
				status: 'refused',
				reason: UFI_PROHIBITED_OPERATIONS[operationId].reason,
			})),
		);
		expect(spy.calls).toEqual([]);
	});

	test('the inert descriptor refuses on three independent fences', () => {
		// Given / When
		const descriptor = ufiProhibitionDescriptor('firmware.flash');

		// Then
		expect(descriptor.support.read).toEqual({
			supported: false,
			reason: 'firmware-flash-prohibited',
		});
		expect(descriptor.support.write).toEqual({
			supported: false,
			reason: 'firmware-flash-prohibited',
		});
		expect(descriptor.availability).toEqual({
			state: 'refused',
			reason: 'firmware-flash-prohibited',
		});
		expect(descriptor.constraints).toEqual({ kind: 'allowed-values', values: [] });
	});
});
