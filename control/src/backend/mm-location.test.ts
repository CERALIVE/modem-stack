// The `Modem.Location` adapter, against the REAL fleet capability masks.
//
// The four capability fixtures below are the literal `mmcli --location-status`
// readings captured on the bench (`hardware-gates.md` §(c), 2026-08-17): three
// modems advertise GNSS and the FM350-GL advertises `3gpp-lac-ci` only. They are
// used verbatim so the capability gate is proven against hardware that exists
// rather than against an invented mask.

import { describe, expect, test } from 'bun:test';
import { epochMillis } from '../domain';
import type { ModemRef } from '../ports';
import type { DbusValue, DbusVariant, MethodCall, MethodReply } from '../transport';
import { MODEM_LOCATION_IFACE } from './constants';
import { decodeLocationSources, encodeLocationSources, MmLocation } from './mm-location';
import { ModemActor } from './modem-actor';

const MODEM = '/org/freedesktop/ModemManager1/Modem/14' as ModemRef;
const STABLE_KEY = 'slot:bench-c4';

// hardware-gates.md §(c) — captured live on ceralive2, 2026-08-17.
const FLEET_CAPABILITIES = {
	'Quectel RM530N-GL': ['gps-raw', 'gps-nmea', 'gps-unmanaged', 'agps-msa', 'agps-msb'],
	'SIMCom SIM7600G-H': ['gps-raw', 'gps-nmea', 'gps-unmanaged', 'agps-msa', 'agps-msb'],
	'Qualcomm HIMI_U01': ['gps-raw', 'gps-nmea', 'agps-msa', 'agps-msb'],
	'Fibocom FM350-GL': ['3gpp-lac-ci'],
} as const;

function v(signature: string, value: DbusValue): DbusVariant {
	return { signature, value };
}

interface FakeOptions {
	readonly capabilities: readonly string[];
	readonly enabled?: readonly string[];
	/** `GetLocation` payload, or an Error to throw. `undefined` = empty dict. */
	readonly location?: DbusValue | Error;
	readonly setupError?: Error;
	readonly treeError?: Error;
	/** Omit the Location interface entirely, as a non-Location modem would. */
	readonly noLocationInterface?: boolean;
}

interface FakeTransport {
	readonly transport: {
		callMethod(call: MethodCall): Promise<MethodReply>;
	};
	readonly calls: MethodCall[];
}

function fakeTransport(options: FakeOptions): FakeTransport {
	const calls: MethodCall[] = [];
	let enabledMask = encodeLocationSources(options.enabled ?? []);

	const tree = (): DbusValue =>
		[
			[
				MODEM,
				options.noLocationInterface
					? []
					: [
							[
								MODEM_LOCATION_IFACE,
								[
									['Capabilities', v('u', encodeLocationSources(options.capabilities))],
									['Enabled', v('u', enabledMask)],
								],
							],
						],
			],
		] as unknown as DbusValue;

	return {
		calls,
		transport: {
			callMethod(call: MethodCall): Promise<MethodReply> {
				calls.push(call);
				if (call.member === 'GetManagedObjects') {
					if (options.treeError) {
						return Promise.reject(options.treeError);
					}
					return Promise.resolve({ signature: 'a{oa{sa{sv}}}', body: [tree()] });
				}
				if (call.member === 'Setup') {
					if (options.setupError) {
						return Promise.reject(options.setupError);
					}
					enabledMask = Number(call.args?.[0] ?? 0);
					return Promise.resolve({ signature: '', body: [] });
				}
				if (call.member === 'GetLocation') {
					if (options.location instanceof Error) {
						return Promise.reject(options.location);
					}
					return Promise.resolve({ signature: 'a{uv}', body: [options.location ?? []] });
				}
				return Promise.reject(new Error(`unexpected member ${call.member}`));
			},
		},
	};
}

function build(
	options: FakeOptions,
	now = () => 1_000,
): {
	readonly location: MmLocation;
	readonly calls: MethodCall[];
} {
	const fake = fakeTransport(options);
	const location = new MmLocation({
		transport: fake.transport as never,
		actor: new ModemActor(),
		resolveStableKey: () => STABLE_KEY,
		now,
	});
	return { location, calls: fake.calls };
}

const RAW_FIX = (lat: number, lon: number, alt?: number): DbusValue =>
	[
		[
			1 << 1,
			v('a{sv}', [
				['latitude', v('d', lat)],
				['longitude', v('d', lon)],
				...(alt === undefined ? [] : [['altitude', v('d', alt)] as const]),
				['utc-time', v('s', '181908.00')],
			] as unknown as DbusValue),
		],
	] as unknown as DbusValue;

describe('bitmask codec', () => {
	test('round-trips every fleet capability set', () => {
		for (const [model, sources] of Object.entries(FLEET_CAPABILITIES)) {
			const decoded = decodeLocationSources(encodeLocationSources(sources));
			expect([...decoded].sort(), model).toEqual([...sources].sort());
		}
	});

	test('an unknown source name contributes no bits rather than corrupting the mask', () => {
		expect(encodeLocationSources(['gps-raw', 'not-a-source'])).toBe(
			encodeLocationSources(['gps-raw']),
		);
	});
});

describe('capability detection against the real fleet', () => {
	test('the three GNSS-advertising fleet modems report gnssCapable', async () => {
		for (const model of ['Quectel RM530N-GL', 'SIMCom SIM7600G-H', 'Qualcomm HIMI_U01'] as const) {
			const { location } = build({ capabilities: FLEET_CAPABILITIES[model] });
			const result = await location.getLocationStatus(MODEM);
			expect(result.ok, model).toBe(true);
			if (result.ok) {
				expect(result.status.gnssCapable, model).toBe(true);
				expect(result.status.gnssEnabled, model).toBe(false);
			}
		}
	});

	test('the FM350-GL advertises 3gpp-lac-ci only and is NOT gnssCapable', async () => {
		const { location } = build({ capabilities: FLEET_CAPABILITIES['Fibocom FM350-GL'] });
		const result = await location.getLocationStatus(MODEM);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.status.capabilities.has('3gpp-lac-ci')).toBe(true);
			expect(result.status.gnssCapable).toBe(false);
		}
	});

	test('the Quectel reading with 3gpp-lac-ci already enabled reports it enabled, GNSS not', async () => {
		const { location } = build({
			capabilities: [...FLEET_CAPABILITIES['Quectel RM530N-GL'], '3gpp-lac-ci'],
			enabled: ['3gpp-lac-ci'],
		});
		const result = await location.getLocationStatus(MODEM);
		expect(result.ok && result.status.enabledSources.has('3gpp-lac-ci')).toBe(true);
		expect(result.ok && result.status.gnssEnabled).toBe(false);
	});

	test('a modem with no Location interface is reported honestly, not as absent GNSS', async () => {
		const { location } = build({ capabilities: [], noLocationInterface: true });
		const result = await location.getLocationStatus(MODEM);
		expect(result.ok).toBe(false);
	});
});

describe('enable / disable', () => {
	test('enable turns on the requested sources and reports them back', async () => {
		const { location, calls } = build({ capabilities: FLEET_CAPABILITIES['Quectel RM530N-GL'] });
		const result = await location.enableGnss(MODEM, ['gps-raw', 'gps-nmea']);

		expect(result.outcome).toBe('applied');
		expect([...result.enabledSources].sort()).toEqual(['gps-nmea', 'gps-raw']);
		const setup = calls.find((call) => call.member === 'Setup');
		expect(setup?.interface).toBe(MODEM_LOCATION_IFACE);
		expect(setup?.signature).toBe('ub');
	});

	test('signal_location is ALWAYS false — coordinates never go onto the bus', async () => {
		const { location, calls } = build({ capabilities: FLEET_CAPABILITIES['Quectel RM530N-GL'] });
		await location.enableGnss(MODEM, ['gps-raw']);
		await location.disableGnss(MODEM);

		const setups = calls.filter((call) => call.member === 'Setup');
		expect(setups.length).toBe(2);
		for (const setup of setups) {
			expect(setup.args?.[1]).toBe(false);
		}
	});

	test('a source the modem does not advertise is dropped, not sent', async () => {
		const { location } = build({ capabilities: FLEET_CAPABILITIES['Qualcomm HIMI_U01'] });
		const result = await location.enableGnss(MODEM, ['gps-raw', 'gps-unmanaged']);
		expect(result.outcome).toBe('applied');
		expect(result.enabledSources.has('gps-unmanaged')).toBe(false);
		expect(result.enabledSources.has('gps-raw')).toBe(true);
	});

	test('enabling on a non-GNSS modem is refused honestly, never silently applied', async () => {
		const { location, calls } = build({ capabilities: FLEET_CAPABILITIES['Fibocom FM350-GL'] });
		const result = await location.enableGnss(MODEM, ['gps-raw']);

		expect(result.outcome).toBe('unsupported');
		expect(result.reason).toContain('GNSS');
		expect(calls.some((call) => call.member === 'Setup')).toBe(false);
	});

	test('disable clears ONLY the GNSS bits — cell location survives', async () => {
		const { location, calls } = build({
			capabilities: [...FLEET_CAPABILITIES['Quectel RM530N-GL'], '3gpp-lac-ci'],
			enabled: ['3gpp-lac-ci', 'gps-raw', 'gps-nmea'],
		});
		const result = await location.disableGnss(MODEM);

		expect(result.outcome).toBe('applied');
		expect([...result.enabledSources]).toEqual(['3gpp-lac-ci']);
		const setup = calls.find((call) => call.member === 'Setup');
		expect(Number(setup?.args?.[0])).toBe(encodeLocationSources(['3gpp-lac-ci']));
	});

	test('a Setup failure is surfaced as failed, never as applied', async () => {
		const { location } = build({
			capabilities: FLEET_CAPABILITIES['Quectel RM530N-GL'],
			setupError: new Error('org.freedesktop.DBus.Error.AccessDenied'),
		});
		const result = await location.enableGnss(MODEM, ['gps-raw']);
		expect(result.outcome).toBe('failed');
		expect(result.reason).toContain('AccessDenied');
	});
});

describe('reading the fix — the no-antenna paths', () => {
	test('GNSS switched off answers `disabled`, not `no-fix`', async () => {
		const { location } = build({ capabilities: FLEET_CAPABILITIES['Quectel RM530N-GL'] });
		const read = await location.readFix(MODEM);
		expect(read.outcome).toBe('disabled');
	});

	test('a non-GNSS modem answers `unsupported`, never `no-fix`', async () => {
		const { location } = build({ capabilities: FLEET_CAPABILITIES['Fibocom FM350-GL'] });
		expect((await location.readFix(MODEM)).outcome).toBe('unsupported');
	});

	test('enabled with an empty GetLocation is an honest `no-fix` — the antenna-less case', async () => {
		const { location } = build({
			capabilities: FLEET_CAPABILITIES['Quectel RM530N-GL'],
			enabled: ['gps-raw', 'gps-nmea'],
			location: [],
		});
		const read = await location.readFix(MODEM);
		expect(read.outcome).toBe('no-fix');
	});

	test('a gps-raw entry present but carrying no coordinates is still `no-fix`', async () => {
		const { location } = build({
			capabilities: FLEET_CAPABILITIES['Quectel RM530N-GL'],
			enabled: ['gps-raw'],
			location: [
				[1 << 1, v('a{sv}', [['utc-time', v('s', '181908.00')]] as unknown as DbusValue)],
			] as unknown as DbusValue,
		});
		expect((await location.readFix(MODEM)).outcome).toBe('no-fix');
	});

	test('a quality-0 NMEA block is `no-fix`, not a decoded position', async () => {
		const { location } = build({
			capabilities: FLEET_CAPABILITIES['Quectel RM530N-GL'],
			enabled: ['gps-nmea'],
			location: [[1 << 2, v('s', '$GPGGA,000000,,,,,0,00,99.99,,,,,,*48')]] as unknown as DbusValue,
		});
		expect((await location.readFix(MODEM)).outcome).toBe('no-fix');
	});

	test('a GetLocation error is `error`, never a silent `no-fix`', async () => {
		const { location } = build({
			capabilities: FLEET_CAPABILITIES['Quectel RM530N-GL'],
			enabled: ['gps-raw'],
			location: new Error('org.freedesktop.ModemManager1.Error.Core.Retry'),
		});
		const read = await location.readFix(MODEM);
		expect(read.outcome).toBe('error');
		expect(read.outcome === 'error' && read.reason).toContain('Retry');
	});
});

describe('reading the fix — a real position', () => {
	test('a gps-raw dict decodes with the READ timestamp, not the modem clock', async () => {
		const { location } = build(
			{
				capabilities: FLEET_CAPABILITIES['Quectel RM530N-GL'],
				enabled: ['gps-raw'],
				location: RAW_FIX(4.60971, -74.08175, 2640),
			},
			() => 555_000,
		);
		const read = await location.readFix(MODEM);
		expect(read.outcome).toBe('fix');
		if (read.outcome === 'fix') {
			expect(read.fix.latitude).toBe(4.60971);
			expect(read.fix.longitude).toBe(-74.08175);
			expect(read.fix.altitude).toBe(2640);
			expect(read.fix.observedAt).toBe(epochMillis(555_000));
			expect(read.fix.utcTime).toBe('181908.00');
		}
	});

	test('NMEA is the fallback when gps-raw carries nothing usable', async () => {
		const { location } = build({
			capabilities: FLEET_CAPABILITIES['Qualcomm HIMI_U01'],
			enabled: ['gps-nmea'],
			location: [
				[1 << 2, v('s', '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47')],
			] as unknown as DbusValue,
		});
		const read = await location.readFix(MODEM);
		expect(read.outcome).toBe('fix');
		if (read.outcome === 'fix') {
			expect(read.fix.latitude).toBeCloseTo(48.1173, 4);
		}
	});
});

describe('the bearer is never touched', () => {
	test('no GNSS call quiesces NetworkManager — a GPS toggle must not drop a link', async () => {
		let quiesced = 0;
		const fake = fakeTransport({ capabilities: FLEET_CAPABILITIES['Quectel RM530N-GL'] });
		const location = new MmLocation({
			transport: fake.transport as never,
			actor: new ModemActor({
				acquire: () => {
					quiesced += 1;
					return Promise.resolve({ release: () => Promise.resolve() });
				},
			}),
			resolveStableKey: () => STABLE_KEY,
		});

		await location.enableGnss(MODEM, ['gps-raw']);
		await location.disableGnss(MODEM);
		await location.readFix(MODEM);

		expect(quiesced).toBe(0);
	});

	test('every GNSS D-Bus call targets the Location interface and nothing else', async () => {
		const { location, calls } = build({
			capabilities: FLEET_CAPABILITIES['Quectel RM530N-GL'],
			enabled: ['gps-raw'],
			location: RAW_FIX(4.6, -74.08),
		});
		await location.enableGnss(MODEM, ['gps-raw']);
		await location.readFix(MODEM);

		const members = new Set(calls.map((call) => call.member));
		expect(members.has('Setup')).toBe(true);
		expect(members.has('GetLocation')).toBe(true);
		for (const call of calls) {
			if (call.member !== 'GetManagedObjects') {
				expect(call.interface).toBe(MODEM_LOCATION_IFACE);
			}
		}
	});
});

describe('a hostile bus never throws out of the adapter', () => {
	test('a failing GetManagedObjects degrades to a typed refusal', async () => {
		const { location } = build({ capabilities: [], treeError: new Error('bus gone') });
		expect((await location.getLocationStatus(MODEM)).ok).toBe(false);
		expect((await location.enableGnss(MODEM, ['gps-raw'])).outcome).toBe('unsupported');
		expect((await location.readFix(MODEM)).outcome).toBe('unsupported');
	});
});
