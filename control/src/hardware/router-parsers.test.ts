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

	test('keeps the serving band and the WAN leg band as two separate readings', () => {
		// Folding them onto one key reports a band the device never claimed for that
		// leg — and the two genuinely disagree once carrier aggregation is up.
		expect(parseZteDetails('{"lte_band":"B4","wan_active_band":"LTE BAND 7"}')).toEqual({
			band: 'B4',
			network_band: 'LTE BAND 7',
		});
		expect(parseZteDetails('{"band":"B28"}')).toEqual({ band: 'B28' });
		expect(parseZteDetails('{"lte_band":"B4"}')).toEqual({ band: 'B4' });
		expect(parseZteDetails('{"wan_active_band":"LTE BAND 7"}')).toEqual({
			network_band: 'LTE BAND 7',
		});
	});

	test('carries the carrier composition and the dongle-owned counters', () => {
		expect(
			parseZteDetails(
				JSON.stringify({
					lte_ca_pcell_arfcn: '2000',
					lte_ca_pcell_band: '4',
					lte_ca_pcell_bandwidth: '20',
					lte_ca_scell_arfcn: '5230',
					lte_ca_scell_band: '7',
					lte_ca_scell_bandwidth: '15',
					monthly_tx_bytes: '12884901888',
					monthly_rx_bytes: '96636764160',
					monthly_time: '184320',
					date_month: '2026-08',
					realtime_tx_bytes: '1048576',
					realtime_rx_bytes: '8388608',
					realtime_tx_thrpt: '131072',
					realtime_rx_thrpt: '1048576',
					realtime_time: '3600',
				}),
			),
		).toEqual({
			pcell_arfcn: '2000',
			pcell_band: '4',
			pcell_bandwidth: '20',
			scell_arfcn: '5230',
			scell_band: '7',
			scell_bandwidth: '15',
			monthly_tx_bytes: '12884901888',
			monthly_rx_bytes: '96636764160',
			monthly_time: '184320',
			monthly_period: '2026-08',
			session_tx_bytes: '1048576',
			session_rx_bytes: '8388608',
			session_tx_rate: '131072',
			session_rx_rate: '1048576',
			session_time: '3600',
		});
	});

	test('drops every vendor placeholder, not only the single dash', () => {
		expect(
			parseZteDetails('{"lte_band":"--","cell_id":"n/a","network_type":"N/A","provider":"  "}'),
		).toBeUndefined();
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
