import { describe, expect, test } from 'bun:test';

import { MODEM_OPERATION_IDS } from '../operation-ids';
import {
	RUNTIME_COMPOSITION_QUERY_REGISTRY,
	resolveRuntimeCompositionCapability,
} from './runtime-capability';

describe('runtime composition capability', () => {
	test.each([
		{
			name: 'Fibocom FM350 real capture',
			vendor: 'fibocom',
			currentResponse: '+GTUSBMODE: 41\r\n\r\nOK',
			enumerationResponse: '+GTUSBMODE: (40,41)\r\n\r\nOK',
			expectedCurrent: 41,
			expectedEnumerated: [40, 41],
		},
		{
			name: 'Quectel usbnet range',
			vendor: 'quectel',
			currentResponse: '+QCFG: "usbnet",0\r\n\r\nOK',
			enumerationResponse: '+QCFG: "usbnet",(0-3)\r\n\r\nOK',
			expectedCurrent: 0,
			expectedEnumerated: [0, 1, 2, 3],
		},
		{
			name: 'SIMCom PID domain',
			vendor: 'simcom',
			currentResponse: '+CUSBPIDSWITCH: 9001\r\n\r\nOK',
			enumerationResponse:
				'+CUSBPIDSWITCH: (9000,9001,9002,9003,9004,9005,9006,9007,9011,9016,9018,9019,901A,901B,9020,9021,9022,9023,9024,9025,9026,9027,9028,9029,902A,902B),(0-1),(0-1)\r\n\r\nOK',
			expectedCurrent: '9001',
			expectedEnumerated: [
				'9000',
				'9001',
				'9002',
				'9003',
				'9004',
				'9005',
				'9006',
				'9007',
				'9011',
				'9016',
				'9018',
				'9019',
				'901A',
				'901B',
				'9020',
				'9021',
				'9022',
				'9023',
				'9024',
				'9025',
				'9026',
				'9027',
				'9028',
				'9029',
				'902A',
				'902B',
			],
		},
	])('derives $name from the device response', (fixture) => {
		const capability = resolveRuntimeCompositionCapability(fixture);

		expect(capability).toEqual({
			status: 'available',
			current: fixture.expectedCurrent,
			enumerated: fixture.expectedEnumerated,
			returnPathProven: true,
			offerable: fixture.expectedEnumerated,
		});
	});

	test('withholds every target when the current mode is not enumerated', () => {
		const capability = resolveRuntimeCompositionCapability({
			vendor: 'fibocom',
			currentResponse: '+GTUSBMODE: 42\r\nOK',
			enumerationResponse: '+GTUSBMODE: (40,41)\r\nOK',
		});

		expect(capability).toEqual({
			status: 'available',
			current: 42,
			enumerated: [40, 41],
			returnPathProven: false,
			offerable: [],
		});
	});

	test.each([
		{
			name: 'unknown vendor',
			input: {
				vendor: 'unlisted-vendor',
				currentResponse: '+MODE: 1\r\nOK',
				enumerationResponse: '+MODE: (1,2)\r\nOK',
			},
			reason: 'vendor-unsupported',
		},
		{
			name: 'truncated response',
			input: {
				vendor: 'fibocom',
				currentResponse: '+GTUSBMODE: 41\r\nOK',
				enumerationResponse: '+GTUSBMODE: (40,',
			},
			reason: 'malformed-response',
		},
	])('fails closed for $name', ({ input, reason }) => {
		const capability = resolveRuntimeCompositionCapability(input);

		expect(capability).toEqual({
			status: 'unknown',
			current: null,
			enumerated: [],
			returnPathProven: false,
			offerable: [],
			reason,
		});
		expect(JSON.stringify(capability)).not.toContain('uncertified');
	});

	test('registry records only the commands needed to ask each vendor', () => {
		expect(RUNTIME_COMPOSITION_QUERY_REGISTRY).toEqual({
			fibocom: { current: 'AT+GTUSBMODE?', enumerate: 'AT+GTUSBMODE=?' },
			quectel: { current: 'AT+QCFG="usbnet"', enumerate: 'AT+QCFG=?' },
			simcom: { current: 'AT+CUSBPIDSWITCH?', enumerate: 'AT+CUSBPIDSWITCH=?' },
			sierra: { current: 'AT!USBCOMP?', enumerate: 'AT!USBCOMP=?' },
		});
	});
});

describe('MODEM_OPERATION_IDS', () => {
	test('equals the non-vacuous union of concrete IDs declared by all four providers', async () => {
		const sourceFiles = [
			'../providers/modem-manager/generic-operations.ts',
			'../radio/mode-truth.ts',
			'../radio/band-truth.ts',
			'../providers/huawei-hilink/runtime.ts',
			'../providers/ufi-himi/operations.ts',
			'../providers/ufi-himi/prohibitions.ts',
			'../providers/zte-goform/provider.ts',
		];
		const source = (
			await Promise.all(sourceFiles.map((path) => Bun.file(new URL(path, import.meta.url)).text()))
		).join('\n');
		const declared = new Set(
			Array.from(
				source.matchAll(
					/['"](modemmanager\.[a-z-]+|ufi\.[a-z.-]+|nv\.write|efs\.write|identity\.write|calibration\.write|firmware\.flash|edl\.automation|driver\.blind-retry|interface\.blind-retry|diag\.write|diag\.info-probe|shell\.transport-fallback|status|signal|mode|data)['"]/g,
				),
				(match) => match[1],
			).filter((id) => id !== undefined),
		);

		expect(declared.size).toBe(23);
		expect(new Set<string>(MODEM_OPERATION_IDS)).toEqual(declared);
		expect(MODEM_OPERATION_IDS).toHaveLength(23);
		expect(Object.isFrozen(MODEM_OPERATION_IDS)).toBe(true);
	});
});
