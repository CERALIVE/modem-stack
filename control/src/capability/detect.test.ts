import { describe, expect, test } from 'bun:test';

import {
	detectCapabilityModules,
	LOCATION_IFACE,
	MESSAGING_IFACE,
	type ModuleCapabilityProbe,
	USSD_IFACE,
} from './detect';

type ProbeOverrides = {
	readonly [K in keyof ModuleCapabilityProbe]?: ModuleCapabilityProbe[K] | undefined;
};

function probe(overrides: ProbeOverrides = {}): ModuleCapabilityProbe {
	const interfaces = 'interfaces' in overrides ? overrides.interfaces : DEFAULT_INTERFACES;
	const locationSources =
		'locationSources' in overrides ? overrides.locationSources : DEFAULT_LOCATION_SOURCES;
	const supportedRats = overrides.supportedRats;
	return {
		properties: overrides.properties ?? DEFAULT_PROPERTIES,
		...(interfaces === undefined ? {} : { interfaces }),
		...(locationSources === undefined ? {} : { locationSources }),
		...(supportedRats === undefined ? {} : { supportedRats }),
	};
}

const DEFAULT_PROPERTIES = new Set(['SupportedBands', 'SupportedModes', 'SimType']);
const DEFAULT_INTERFACES = new Set([MESSAGING_IFACE, USSD_IFACE, LOCATION_IFACE]);
const DEFAULT_LOCATION_SOURCES = new Set(['gps-raw', 'gps-nmea']);

describe('per-module capability detection', () => {
	test('a fully-featured modem advertises every probeable module', () => {
		const detected = detectCapabilityModules(probe());
		expect(detected['band-lock']).toBe('present');
		expect(detected['five-g-pref']).toBe('present');
		expect(detected.esim).toBe('present');
		expect(detected.sms).toBe('present');
		expect(detected.ussd).toBe('present');
		expect(detected.gps).toBe('present');
	});

	test('an OBSERVED modem missing a property reports absent, not unknown', () => {
		const detected = detectCapabilityModules(probe({ properties: new Set(['SupportedModes']) }));
		expect(detected['band-lock']).toBe('absent');
		expect(detected.esim).toBe('absent');
		expect(detected['five-g-pref']).toBe('present');
	});

	test('a read that never landed reports unknown for every property-backed module', () => {
		const detected = detectCapabilityModules(probe({ properties: new Set() }));
		expect(detected['band-lock']).toBe('unknown');
		expect(detected['five-g-pref']).toBe('unknown');
		expect(detected.esim).toBe('unknown');
	});

	test('`EsimStatus` alone is enough for eSIM — the two spellings coexist', () => {
		expect(detectCapabilityModules(probe({ properties: new Set(['EsimStatus']) })).esim).toBe(
			'present',
		);
	});

	test('an unobserved interface set reports unknown, never absent', () => {
		const detected = detectCapabilityModules(probe({ interfaces: undefined }));
		expect(detected.sms).toBe('unknown');
		expect(detected.ussd).toBe('unknown');
		expect(detected.gps).toBe('unknown');
	});

	test('an observed modem without the Messaging/USSD interfaces reports absent', () => {
		const detected = detectCapabilityModules(probe({ interfaces: new Set() }));
		expect(detected.sms).toBe('absent');
		expect(detected.ussd).toBe('absent');
	});

	test('the Location interface alone is NOT a GNSS claim', () => {
		expect(detectCapabilityModules(probe({ locationSources: new Set(['3gpp-lac-ci']) })).gps).toBe(
			'absent',
		);
		expect(detectCapabilityModules(probe({ locationSources: undefined })).gps).toBe('unknown');
	});

	test('FCC auto-unlock is never inferred from the modem surface', () => {
		expect(detectCapabilityModules(probe())['fcc-auto-unlock']).toBe('unknown');
		expect(detectCapabilityModules(probe({ properties: new Set() }))['fcc-auto-unlock']).toBe(
			'unknown',
		);
	});

	test('detection never throws on a hostile probe', () => {
		expect(() =>
			detectCapabilityModules({
				properties: new Set(),
				interfaces: new Set(),
				locationSources: new Set(),
			}),
		).not.toThrow();
	});
});

describe('`five-g-pref` narrows on the decoded mode catalog', () => {
	// The property NAME is not the question: every MM modem exports
	// `SupportedModes`, so the name alone resolves `present` on a 4G-only radio.
	test('a decoded catalog naming 5GNR is present', () => {
		expect(
			detectCapabilityModules(probe({ supportedRats: new Set(['lte', '5gnr']) }))['five-g-pref'],
		).toBe('present');
	});

	test('a decoded catalog WITHOUT 5GNR is absent, even though the property exists', () => {
		const detected = detectCapabilityModules(probe({ supportedRats: new Set(['umts', 'lte']) }));
		expect(detected['five-g-pref']).toBe('absent');
		// The property-name answer for the same probe is `present` — proving the
		// decoded catalog is what narrowed it, not a changed property set.
		expect(detectCapabilityModules(probe())['five-g-pref']).toBe('present');
	});

	test('an EMPTY decoded catalog is unknown, never absent', () => {
		expect(detectCapabilityModules(probe({ supportedRats: new Set() }))['five-g-pref']).toBe(
			'unknown',
		);
	});

	test('a caller that decoded no catalog keeps the byte-identical property-name answer', () => {
		expect(detectCapabilityModules(probe({ supportedRats: undefined }))['five-g-pref']).toBe(
			'present',
		);
		expect(
			detectCapabilityModules(probe({ properties: new Set(), supportedRats: undefined }))[
				'five-g-pref'
			],
		).toBe('unknown');
	});

	test('narrowing touches ONLY this module', () => {
		const narrowed = detectCapabilityModules(probe({ supportedRats: new Set(['lte']) }));
		const base = detectCapabilityModules(probe());
		for (const module of ['band-lock', 'sms', 'ussd', 'gps', 'esim', 'fcc-auto-unlock'] as const) {
			expect(narrowed[module]).toBe(base[module]);
		}
	});
});
