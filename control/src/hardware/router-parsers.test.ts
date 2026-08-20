import { describe, expect, test } from 'bun:test';

import {
	deriveSimPresence,
	parseHilinkCapabilities,
	parseHilinkDataCapability,
	parseHilinkSession,
	parseHilinkSignal,
	parseHilinkUserState,
	parseUfiDetails,
	parseUfiSignal,
	parseZteDetails,
	parseZteSignal,
} from './router-parsers';

describe('migrated modem facts', () => {
	test('derives SIM presence from ModemManager slot facts', () => {
		expect(deriveSimPresence({ sim: '/org/freedesktop/ModemManager1/SIM/0' })).toBe('present');
		expect(deriveSimPresence({ sim: '', simSlots: ['/', '/'], failedReason: 'sim-missing' })).toBe(
			'absent',
		);
		expect(deriveSimPresence({ sim: '' })).toBe('unknown');
	});
});

describe('transport-free router response parsers', () => {
	test('normalizes Huawei signal values without fabricating empty metrics', () => {
		const signal = parseHilinkSignal({
			status: '<response><SignalIcon>4</SignalIcon><maxsignal>5</maxsignal></response>',
			signal:
				'<response><rssi>-71dBm</rssi><rsrp>-93dBm</rsrp><rsrq></rsrq><sinr>12dB</sinr></response>',
		});
		expect(signal.bars).toEqual({ state: 'known', value: 4 });
		expect(signal.rsrp).toEqual({ state: 'known', value: -93 });
		expect(signal.rsrq).toEqual({ state: 'unknown', reason: 'not-reported' });
	});

	test('normalizes ZTE and UFI signal dialects', () => {
		expect(parseZteSignal('{"signalbar":"4","rssi":"-67","lte_snr":"8"}')).toMatchObject({
			bars: { state: 'known', value: 4 },
			dbm: { state: 'known', value: -67 },
			snr: { state: 'known', value: 8 },
		});
		expect(
			parseUfiSignal({
				sysinfo: '{"reply":"ok","params":{"SIGNAL":-96}}',
				overview: '',
				status: '',
			}).dbm,
		).toEqual({ state: 'known', value: -96 });
	});

	test('extracts ZTE and UFI details while dropping vendor placeholders', () => {
		expect(
			parseZteDetails(
				'{"network_type":"LTE","network_provider":"732103","network_provider_fullname":"Movistar","cell_id":"2c20f34"}',
			),
		).toEqual({ network_type: 'LTE', provider: 'Movistar', cell_id: '2c20f34' });
		expect(
			parseUfiDetails({
				overview:
					'{"reply":"ok","params":{"SSID":"4G-UFI","WANIP":"-","IMSI":"732123","ICCID":"8957","WEBVER":"WEB1.1"}}',
				sysinfo: '{"reply":"ok","params":{"cellid":"42","bsid":"25002"}}',
			}),
		).toEqual({
			ssid: '4G-UFI',
			imsi: '732123',
			iccid: '8957',
			web_version: 'WEB1.1',
			cell_id: '42',
			station_id: '25002',
		});
	});

	test('reports Huawei network-mode capability and refusal distinctly', () => {
		expect(
			parseHilinkCapabilities({
				netModeList:
					'<response><NetworkModeList><NetworkMode><Index>00</Index><Name>AUTO</Name></NetworkMode></NetworkModeList></response>',
				netMode: '<response><NetworkMode>00</NetworkMode></response>',
			}),
		).toEqual({
			net_mode: { state: 'reported', modes: [{ id: '00', name: 'AUTO' }], current: '00' },
		});
		expect(parseHilinkCapabilities({ netModeList: '<error><code>112008</code></error>' })).toEqual({
			net_mode: { state: 'unavailable', reason: 'refused', code: '112008' },
		});
	});

	test('parses Huawei session, login-profile, and data capability documents centrally', () => {
		expect(
			parseHilinkSession(
				'<response><SesInfo>SessionID=fixture</SesInfo><TokInfo>fixture-token</TokInfo></response>',
			),
		).toEqual({ cookie: 'SessionID=fixture', token: 'fixture-token' });
		expect(
			parseHilinkUserState(
				'<response><State>-1</State><Username>admin</Username><password_type>4</password_type></response>',
			),
		).toEqual({ state: '-1', passwordType: 4 });
		expect(parseHilinkDataCapability('<response><dataswitch>1</dataswitch></response>')).toEqual({
			state: 'reported',
			enabled: true,
		});
		expect(parseHilinkDataCapability('<response><code>125002</code></response>')).toEqual({
			state: 'unavailable',
			reason: 'auth-expired',
		});
	});
});
