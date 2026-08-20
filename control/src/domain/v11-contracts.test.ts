import { describe, expect, test } from 'bun:test';
import {
	canAutoRetry,
	classifyOperationCompletion,
	defineOperationDescriptor,
	deviceGeneration,
	epochMillis,
	isCurrentGeneration,
	nextDeviceGeneration,
	type ObservationEnvelope,
	PhysicalModemIdentityError,
	physicalModemId,
	resolvePhysicalModemIdentity,
	sourceEpoch,
	stableKey,
} from './index';

describe('PhysicalModemId and StableKey', () => {
	test('Given an MM object path, when PhysicalModemId is constructed, then construction is refused', () => {
		expect(() => physicalModemId('/org/freedesktop/ModemManager1/Modem/7')).toThrow(
			PhysicalModemIdentityError,
		);
	});

	test.each([
		['ifname', 'wwan0'],
		['IPv4 address', '192.168.8.1'],
		['IPv6 address', '2001:db8::1'],
		['uncompressed IPv6 address', '2001:db8:0:0:0:0:0:1'],
		['IMEI', '490154203237518'],
		['ICCID', '8944500101234567890'],
		['EID', '89049032000000000000000000000001'],
	])(
		'Given a %s shape, when PhysicalModemId is constructed, then it is refused',
		(_shape, value) => {
			expect(() => physicalModemId(`serial:${value}`)).toThrow(PhysicalModemIdentityError);
		},
	);

	test('Given every identity fact, when resolving, then serial outranks ID_PATH and fallback', () => {
		const resolved = resolvePhysicalModemIdentity({
			serial: 'SERIAL-A1',
			idPath: 'pci-0000:01:00.0-usb-0:2:1.0',
			fallback: 'vid-2c7c-pid-0800-port-2',
		});

		expect(resolved.source).toBe('serial');
		expect(resolved.physicalModemId).toBe(physicalModemId('serial:SERIAL-A1'));
		expect(resolved.stableKey).toBe(stableKey('modem:serial:SERIAL-A1'));
	});

	test('Given no serial, when resolving, then ID_PATH outranks fallback', () => {
		const resolved = resolvePhysicalModemIdentity({
			idPath: 'pci-0000:01:00.0-usb-0:2:1.0',
			fallback: 'vid-2c7c-pid-0800-port-2',
		});

		expect(resolved.source).toBe('id-path');
	});

	test('Given an oversized fallback, when resolving, then construction is refused', () => {
		expect(() => resolvePhysicalModemIdentity({ fallback: 'x'.repeat(129) })).toThrow(
			PhysicalModemIdentityError,
		);
	});
});

describe('DeviceGeneration', () => {
	test('Given a current generation, when the device re-enumerates, then generation increments', () => {
		const current = deviceGeneration(4);
		const replacement = nextDeviceGeneration(current);

		expect(replacement).toBe(deviceGeneration(5));
		expect(isCurrentGeneration(current, replacement)).toBe(false);
		expect(isCurrentGeneration(replacement, replacement)).toBe(true);
	});
});

describe('ObservationEnvelope', () => {
	test('Given an unavailable source, when represented, then unavailable is distinct from stale', () => {
		const unavailable: ObservationEnvelope<string> = {
			stableKey: resolvePhysicalModemIdentity({ serial: 'SERIAL-A1' }).stableKey,
			generation: deviceGeneration(1),
			source: 'modemmanager',
			sourceEpoch: sourceEpoch(3),
			observedAt: epochMillis(100),
			freshness: {
				state: 'unavailable',
				since: epochMillis(90),
				reason: 'source-unavailable',
			},
			authority: 'authoritative',
			value: null,
		};

		expect(unavailable.freshness.state).toBe('unavailable');
		expect(unavailable.value).toBeNull();
	});
});

const READ_DESCRIPTOR = defineOperationDescriptor<string, string>({
	id: 'radio-power',
	support: {
		read: { supported: true },
		write: { supported: false, reason: 'provider-read-only' },
	},
	authority: 'provider',
	provider: 'modemmanager',
	constraints: { kind: 'allowed-values', values: ['on', 'off'] },
	livePreconditions: ['device-present'],
	availability: { state: 'available' },
	mutationImpact: 'read',
	retryClass: 'idempotent-read',
	readback: { required: false },
	rollback: { required: false },
	journal: { required: false },
	admission: { required: false },
	evidence: { profiles: ['generic-mm'], firmware: [] },
	confidence: 'high',
});

describe('OperationDescriptor', () => {
	test('Given asymmetric provider support, when described, then read and write remain independent', () => {
		expect(READ_DESCRIPTOR.support.read.supported).toBe(true);
		expect(READ_DESCRIPTOR.support.write).toEqual({
			supported: false,
			reason: 'provider-read-only',
		});
	});

	test('Given a write operation marked retryable, when defined, then the invalid contract is refused', () => {
		expect(() =>
			defineOperationDescriptor<string, string>({
				...READ_DESCRIPTOR,
				mutationImpact: 'write',
				retryClass: 'idempotent-read',
			}),
		).toThrow();
	});
});

describe('OperationResult', () => {
	test('Given a completion under a stale generation, when classified, then it is unknown-outcome and never failed', () => {
		const result = classifyOperationCompletion<string>({
			operation: 'write',
			completionGeneration: deviceGeneration(2),
			currentGeneration: deviceGeneration(3),
			completion: { status: 'failed', reason: 'provider-error' },
		});

		expect(result.status).toBe('unknown-outcome');
		expect(result).toEqual({
			status: 'unknown-outcome',
			reason: 'stale-generation',
			requiresReconciliation: true,
			generation: deviceGeneration(2),
		});
	});

	test.each(['timed-out', 'dropped'] as const)(
		'Given a %s write reply, when classified, then reconciliation is required',
		(status) => {
			const generation = deviceGeneration(5);
			const result = classifyOperationCompletion({
				operation: 'write',
				completionGeneration: generation,
				currentGeneration: generation,
				completion: { status },
			});

			expect(result.status).toBe('unknown-outcome');
			expect(result.requiresReconciliation).toBe(true);
		},
	);

	test('Given an idempotent read failure, when retry eligibility is checked, then it may auto-retry', () => {
		const generation = deviceGeneration(5);
		const result = classifyOperationCompletion<string>({
			operation: 'read',
			completionGeneration: generation,
			currentGeneration: generation,
			completion: { status: 'timed-out' },
		});

		expect(canAutoRetry(READ_DESCRIPTOR, result)).toBe(true);
	});
});
