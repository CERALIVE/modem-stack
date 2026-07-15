import { describe, expect, test } from 'bun:test';
import {
	detectMmFeatures,
	type MmPropertyProbe,
	parseMmVersion,
	probeModemProperties,
} from './features';
import type { DecodedManagedObjects } from './managed-objects';

const BASE_MODEM_PROPS = new Set(['Manufacturer', 'Model', 'Device', 'State', 'SimType']);

function probe(overrides: Partial<MmPropertyProbe> = {}): MmPropertyProbe {
	return { properties: BASE_MODEM_PROPS, ...overrides };
}

function withPhysdev(): MmPropertyProbe {
	return { properties: new Set([...BASE_MODEM_PROPS, 'Physdev']) };
}

describe('parseMmVersion', () => {
	test('parses major.minor.patch', () => {
		expect(parseMmVersion('1.24.0')).toEqual({ major: 1, minor: 24 });
	});

	test('parses major.minor without a patch', () => {
		expect(parseMmVersion('1.20')).toEqual({ major: 1, minor: 20 });
	});

	test('tolerates a pre-release suffix', () => {
		expect(parseMmVersion('1.26.0-rc1')).toEqual({ major: 1, minor: 26 });
	});

	test('returns null for an unparseable string', () => {
		expect(parseMmVersion('not-a-version')).toBeNull();
	});
});

describe('detectMmFeatures — 3 property shapes', () => {
	test('1.20 shape: no Physdev, basic cell info, eSIM, serialization', () => {
		expect(detectMmFeatures('1.20.0', probe())).toEqual({
			physdev: false,
			cellInfo: 'basic',
			esimStatus: true,
			opSerialization: true,
		});
	});

	test('1.22 shape: Physdev present, rich cell info', () => {
		expect(detectMmFeatures('1.22.0', withPhysdev())).toEqual({
			physdev: true,
			cellInfo: 'rich',
			esimStatus: true,
			opSerialization: true,
		});
	});

	test('1.24 shape: Physdev present, rich cell info', () => {
		expect(detectMmFeatures('1.24.0', withPhysdev())).toEqual({
			physdev: true,
			cellInfo: 'rich',
			esimStatus: true,
			opSerialization: true,
		});
	});
});

describe('detectMmFeatures — property presence overrides the version', () => {
	test('physdev is property-driven: 1.24 version but no Physdev property ⇒ false', () => {
		expect(detectMmFeatures('1.24.0', probe()).physdev).toBe(false);
	});

	test('a 1.22+ modem that omits Physdev still reports rich cell info by version', () => {
		expect(detectMmFeatures('1.22.0', probe()).cellInfo).toBe('rich');
	});

	test('rich cell-info fields promote the tier even without a version signal', () => {
		const withFields = probe({ cellInfoFields: new Set(['serving-type', 'bandwidth']) });
		expect(detectMmFeatures('1.20.0', withFields).cellInfo).toBe('rich');
	});
});

describe('detectMmFeatures — degrade paths', () => {
	test('below 1.20 has no cell info, no eSIM, no serialization', () => {
		expect(detectMmFeatures('1.18.0', probe({ properties: new Set(['Device']) }))).toEqual({
			physdev: false,
			cellInfo: 'none',
			esimStatus: false,
			opSerialization: false,
		});
	});

	test('a modem advertising no cell-info capability degrades to none on a supported version', () => {
		expect(detectMmFeatures('1.24.0', withPhysdevNoCellInfo()).cellInfo).toBe('none');
	});

	test('an eSIM property forces esimStatus true even on an unparseable version', () => {
		const esimProbe = probe({ properties: new Set(['EsimStatus']) });
		expect(detectMmFeatures('garbage', esimProbe).esimStatus).toBe(true);
	});
});

describe('detectMmFeatures — unknown future version probes, never throws', () => {
	test('1.26.0 falls back to property probing, not a whitelist throw', () => {
		expect(() => detectMmFeatures('1.26.0', withPhysdev())).not.toThrow();
		expect(detectMmFeatures('1.26.0', withPhysdev())).toEqual({
			physdev: true,
			cellInfo: 'rich',
			esimStatus: true,
			opSerialization: true,
		});
	});

	test('a totally unparseable version degrades to the safe floor (property-only physdev)', () => {
		const physdevOnly = { properties: new Set(['Device', 'Physdev']) };
		expect(detectMmFeatures('???', physdevOnly)).toEqual({
			physdev: true,
			cellInfo: 'none',
			esimStatus: false,
			opSerialization: false,
		});
	});
});

function withPhysdevNoCellInfo(): MmPropertyProbe {
	return { properties: new Set([...BASE_MODEM_PROPS, 'Physdev']), cellInfoAvailable: false };
}

describe('probeModemProperties', () => {
	test('collects property names across Modem, Modem3gpp and the active SIM', () => {
		const tree: DecodedManagedObjects = [
			[
				'/org/freedesktop/ModemManager1/Modem/0',
				[
					[
						'org.freedesktop.ModemManager1.Modem',
						[
							['Device', { signature: 's', value: 'slot-usb2-1' }],
							['Physdev', { signature: 's', value: '/sys/devices/usb2' }],
							['Sim', { signature: 'o', value: '/org/freedesktop/ModemManager1/SIM/0' }],
						],
					],
					[
						'org.freedesktop.ModemManager1.Modem.Modem3gpp',
						[['Imei', { signature: 's', value: '490154203237518' }]],
					],
				],
			],
			[
				'/org/freedesktop/ModemManager1/SIM/0',
				[['org.freedesktop.ModemManager1.Sim', [['SimType', { signature: 'u', value: 2 }]]]],
			],
		];
		const result = probeModemProperties(tree, '/org/freedesktop/ModemManager1/Modem/0');
		expect(result.properties.has('Physdev')).toBe(true);
		expect(result.properties.has('Imei')).toBe(true);
		expect(result.properties.has('SimType')).toBe(true);
	});
});
