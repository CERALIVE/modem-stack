import { describe, expect, test } from 'bun:test';
import { UFI_AUTH_EXPIRED_FIXTURE, UFI_FIXTURE } from '../../../test-support/observation-fixtures';
import { deviceGeneration, physicalModemId } from '../../domain';
import { createProviderMatcher } from '../matcher';
import { createProviderRegistry } from '../registry';
import { UFI_PROFILE } from './operations';
import { createUfiHimiDefinition } from './provider';
import {
	classifyUfiDiagEvidence,
	UFI_FIRMWARE_SPECIFIC_USB_ID,
	UFI_RNDIS_ADB_USB_ID,
	ufiUsbClaims,
} from './qualcomm-evidence';
import type { UfiHttpRequest, UfiHttpResponse, UfiTransport } from './transport';
import { UFI_API_PATH } from './transport';

const PASSWORD = 'fixture-ufi-password';
const ADMIN_URL = 'http://192.168.0.1';
const SESSION = 'bench-session-token';

const context = (usbId: string) => ({
	physicalModemId: physicalModemId('serial:ufi-fixture'),
	generation: deviceGeneration(1),
	transport: 'network' as const,
	passiveFacts: [{ kind: 'usb' as const, value: usbId }],
	composition: 'rndis',
	profile: UFI_PROFILE,
});

function replay(bodies: readonly string[]) {
	const calls: UfiHttpRequest[] = [];
	const pending = [...bodies];
	const transport: UfiTransport = {
		request: async (request): Promise<UfiHttpResponse> => {
			calls.push(request);
			const body = pending.shift();
			if (body === undefined) throw new Error('unexpected replay request');
			return { status: 200, body };
		},
	};
	return { calls, transport, remaining: () => pending.length };
}

function definition(transport: UfiTransport) {
	return createUfiHimiDefinition({
		interfaceName: 'usb0',
		adminUrl: ADMIN_URL,
		transport,
		credentials: { username: 'admin', password: PASSWORD },
		now: () => 1_700_000_000_000,
	});
}

const loginOk = JSON.stringify({ reply: 'ok', session: SESSION });

describe('UFI/HIMI read-only telemetry', () => {
	test('normalizes one read cycle from the migrated parsers over a single session', async () => {
		// Given
		const h = replay([
			loginOk,
			UFI_FIXTURE.sysinfo,
			UFI_FIXTURE.overview,
			UFI_FIXTURE.status,
			UFI_FIXTURE.produceInfo ?? '',
		]);

		// When
		const [envelope] = await definition(h.transport).observe(context(UFI_RNDIS_ADB_USB_ID));

		// Then
		expect(envelope?.value).toMatchObject({
			source: 'ufi-himiapi',
			signal: { dbm: { state: 'known', value: 3 } },
			hardware: { label: { state: 'known', value: 'UFI-M600' } },
		});
		expect(h.calls.map((call) => call.command)).toEqual([
			'login',
			'getsysinfo',
			'getoverview',
			'getallstatus',
			'getproduceinfo',
		]);
		expect(h.calls[0]).toEqual({
			method: 'POST',
			url: `${ADMIN_URL}${UFI_API_PATH}`,
			command: 'login',
			body: JSON.stringify({ cmdid: 'login', username: 'admin', password: PASSWORD }),
			headers: ['Content-Type: application/json;charset=UTF-8'],
			interfaceName: 'usb0',
			redirect: 'error',
		});
		expect(h.calls[1]).toEqual({
			method: 'POST',
			url: `${ADMIN_URL}${UFI_API_PATH}`,
			command: 'getsysinfo',
			body: JSON.stringify({ cmdid: 'getsysinfo', sessionId: SESSION }),
			headers: [`Authorization: ${SESSION}`, 'Content-Type: application/json;charset=UTF-8'],
			interfaceName: 'usb0',
			redirect: 'error',
		});
		expect(JSON.stringify(envelope)).not.toContain(PASSWORD);
		expect(h.remaining()).toBe(0);
	});

	test('reports a refused session honestly and never spends a second login', async () => {
		// Given
		const h = replay([
			loginOk,
			UFI_AUTH_EXPIRED_FIXTURE.sysinfo,
			UFI_AUTH_EXPIRED_FIXTURE.overview,
			UFI_AUTH_EXPIRED_FIXTURE.status,
			JSON.stringify({ reply: 'SessionOut' }),
		]);
		const provider = definition(h.transport);

		// When
		const [envelope] = await provider.observe(context(UFI_RNDIS_ADB_USB_ID));
		const afterFirstCycle = h.calls.length;
		const second = await provider.observe(context(UFI_RNDIS_ADB_USB_ID));

		// Then
		expect(envelope?.value?.signal.dbm).toMatchObject({
			state: 'unknown',
			reason: 'auth-expired',
		});
		expect(second).toEqual([]);
		expect(h.calls).toHaveLength(afterFirstCycle);
		expect(h.calls.filter((call) => call.command === 'login')).toHaveLength(1);
	});
});

describe('UFI/HIMI provider matching', () => {
	test.each([UFI_RNDIS_ADB_USB_ID, UFI_FIRMWARE_SPECIFIC_USB_ID])(
		'%s selects the read-only profile with no writable surface',
		async (usbId) => {
			// Given
			const h = replay([loginOk, UFI_FIXTURE.status, UFI_FIXTURE.sysinfo]);
			const registry = createProviderRegistry();
			registry.register(definition(h.transport));

			// When
			const result = await createProviderMatcher(registry).match(context(usbId));

			// Then
			expect(result).toMatchObject({
				status: 'selected',
				provider: 'ufi-himi',
				profile: UFI_PROFILE,
				writable: false,
				operations: { access: 'read-only', diagAccess: 'prohibited' },
			});
			expect(h.calls.filter((call) => call.command === 'login')).toHaveLength(1);
		},
	);
});

describe('Qualcomm composition evidence', () => {
	test('05c6:9024 claims RNDIS and an ADB interface, and nothing more', () => {
		// Given / When
		const claims = ufiUsbClaims(UFI_RNDIS_ADB_USB_ID);

		// Then
		expect(claims).toEqual(['rndis-network', 'adb-interface']);
	});

	test('05c6:9091 is firmware-specific and is not evidence of a DIAG channel', () => {
		// Given / When
		const evidence = classifyUfiDiagEvidence({
			usbId: UFI_FIRMWARE_SPECIFIC_USB_ID,
			interfaces: [],
		});

		// Then
		expect(ufiUsbClaims(UFI_FIRMWARE_SPECIFIC_USB_ID)).toEqual([]);
		expect(evidence).toEqual({ state: 'not-proven', reason: 'product-id-is-not-evidence' });
	});

	test('an enumerated composition without a DIAG descriptor stays not-proven', () => {
		// Given / When
		const evidence = classifyUfiDiagEvidence({
			usbId: UFI_RNDIS_ADB_USB_ID,
			interfaces: [
				{ number: 0, interfaceClass: 0xe0, interfaceSubClass: 0x01, interfaceProtocol: 0x03 },
				{ number: 2, interfaceClass: 0xff, interfaceSubClass: 0x42, interfaceProtocol: 0x01 },
			],
		});

		// Then
		expect(evidence).toEqual({ state: 'not-proven', reason: 'no-diag-interface-descriptor' });
	});

	test('a confirmed DIAG descriptor still leaves production access prohibited', async () => {
		// Given
		const h = replay([]);
		const evidence = classifyUfiDiagEvidence({
			usbId: UFI_RNDIS_ADB_USB_ID,
			interfaces: [
				{ number: 3, interfaceClass: 0xff, interfaceSubClass: 0xff, interfaceProtocol: 0x30 },
			],
		});

		// When
		const operations = definition(h.transport).operations(UFI_PROFILE);

		// Then
		expect(evidence).toEqual({ state: 'descriptor-confirmed', interfaceNumber: 3 });
		expect(operations.diagAccess).toBe('prohibited');
		expect(operations.reads.map((entry) => entry.descriptor.id)).toEqual([
			'ufi.signal.read',
			'ufi.details.read',
		]);
		expect(h.calls).toEqual([]);
	});
});
