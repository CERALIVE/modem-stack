import { describe, expect, test } from 'bun:test';
import {
	FIXTURE_GENERATION,
	FIXTURE_OBSERVED_AT,
	FIXTURE_SOURCE_EPOCH,
	FIXTURE_STABLE_KEY,
	fixtureContext,
	HILINK_AUTH_EXPIRED_FIXTURE,
	HILINK_FIXTURE,
	MM_EVDO_SIGNAL_FIXTURE,
	MM_FIXTURE,
	MM_SIGNAL_SILENT_FIXTURE,
	UFI_AUTH_EXPIRED_FIXTURE,
	UFI_FIXTURE,
	ZTE_FIXTURE,
	ZTE_MALFORMED_FIXTURE,
} from '../../test-support/observation-fixtures';
import { REDACTED } from '../redact';
import { viewEnvelope } from './envelope';
import { metricUnknownClass, type NormalizedMetric } from './metric';
import type { NormalizedModemObservation } from './model';
import { redactObservationDiagnostics } from './provenance';
import { normalizeHilinkObservation } from './sources/hilink';
import { normalizeModemManagerObservation } from './sources/modemmanager';
import { normalizeUfiObservation } from './sources/ufi';
import { normalizeZteObservation } from './sources/zte';

const CONTEXT = fixtureContext();

function observation(
	envelope: ReturnType<typeof normalizeModemManagerObservation>,
): NormalizedModemObservation {
	const view = viewEnvelope(envelope);
	if (view.kind === 'unavailable') {
		throw new Error('fixture normalization must not produce an unavailable envelope');
	}
	return view.value;
}

function reason(metric: NormalizedMetric<unknown>): string {
	return metric.state === 'unknown' ? metric.reason : `known:${String(metric.value)}`;
}

const MM = observation(normalizeModemManagerObservation(MM_FIXTURE, CONTEXT));
const HILINK = observation(normalizeHilinkObservation(HILINK_FIXTURE, CONTEXT));
const ZTE = observation(normalizeZteObservation(ZTE_FIXTURE, CONTEXT));
const UFI = observation(normalizeUfiObservation(UFI_FIXTURE, CONTEXT));

describe('every source produces one envelope shape', () => {
	const cases = [
		['modemmanager', normalizeModemManagerObservation(MM_FIXTURE, CONTEXT)],
		['huawei-hilink', normalizeHilinkObservation(HILINK_FIXTURE, CONTEXT)],
		['zte-goform', normalizeZteObservation(ZTE_FIXTURE, CONTEXT)],
		['ufi-himiapi', normalizeUfiObservation(UFI_FIXTURE, CONTEXT)],
	] as const;

	test.each(cases.map(([name]) => name))(
		'Given the %s fixture, when normalized, then the envelope carries identity, epoch and time',
		(name) => {
			const envelope = cases.find(([id]) => id === name)?.[1];
			if (envelope === undefined) {
				throw new Error(`missing case ${name}`);
			}

			expect(envelope.source).toBe(name);
			expect(envelope.stableKey).toBe(FIXTURE_STABLE_KEY);
			expect(envelope.generation).toBe(FIXTURE_GENERATION);
			expect(envelope.sourceEpoch).toBe(FIXTURE_SOURCE_EPOCH);
			expect(envelope.observedAt).toBe(FIXTURE_OBSERVED_AT);
			expect(envelope.freshness.state).toBe('fresh');
		},
	);

	test.each(cases.map(([name]) => name))(
		'Given the %s fixture, when normalized, then consumed and unmapped partition the raw record',
		(name) => {
			const envelope = cases.find(([id]) => id === name)?.[1];
			if (envelope === undefined) {
				throw new Error(`missing case ${name}`);
			}
			const { diagnostics } = observation(envelope);
			const rawKeys = Object.keys(diagnostics.raw).sort();

			expect([...diagnostics.consumed, ...diagnostics.unmapped].sort()).toEqual(rawKeys);
			expect(diagnostics.consumed.filter((key) => diagnostics.unmapped.includes(key))).toEqual([]);
			expect(diagnostics.source).toBe(name);
		},
	);
});

describe('ModemManager normalization', () => {
	test('Given a registered modem, when normalized, then the migrated decoders supply the values', () => {
		expect(MM.radio.modemState).toMatchObject({ state: 'known', value: 'registered' });
		expect(MM.radio.registration).toMatchObject({ state: 'known', value: 'home' });
		expect(MM.radio.accessTechnologies).toMatchObject({ state: 'known', value: ['5gnr'] });
		expect(MM.radio.modeLabel).toMatchObject({ state: 'known', value: '5g4g' });
		expect(MM.hardware.label).toMatchObject({ state: 'known', value: 'RM530N-GL' });
		expect(MM.sim.presence).toMatchObject({ state: 'known', value: 'present' });
		expect(MM.sim.lockRequired).toMatchObject({ state: 'known', value: 'none' });
		expect(MM.sim.kind).toMatchObject({ state: 'known', value: 'physical' });
	});

	test('Given the Signal interface, when normalized, then each metric names the field it came from', () => {
		expect(MM.signal.quality).toMatchObject({ state: 'known', value: 71 });
		expect(MM.signal.dbm).toMatchObject({ state: 'known', value: -71 });
		expect(MM.signal.rsrp).toMatchObject({ state: 'known', value: -98.5 });
		expect(MM.signal.rsrp.provenance).toEqual({
			source: 'modemmanager',
			sourceEpoch: FIXTURE_SOURCE_EPOCH,
			observedAt: FIXTURE_OBSERVED_AT,
			authority: 'authoritative',
			rawFields: ['Signal.Nr5g.rsrp'],
		});
	});

	const EVDO = observation(normalizeModemManagerObservation(MM_EVDO_SIGNAL_FIXTURE, CONTEXT));
	const extended = [
		['rsrp', MM.signal.rsrp, -98.5, 'Signal.Nr5g.rsrp'],
		['rsrq', MM.signal.rsrq, -11, 'Signal.Nr5g.rsrq'],
		['snr', MM.signal.snr, 6.5, 'Signal.Nr5g.snr'],
		['sinr', EVDO.signal.sinr, 9.5, 'Signal.Evdo.sinr'],
	] as const;

	test.each(extended.map(([name]) => name))(
		'Given a Signal RAT dict carrying %s, when normalized, then it is fresh, authoritative and field-attributed',
		(name) => {
			const entry = extended.find(([id]) => id === name);
			if (entry === undefined) {
				throw new Error(`missing extended metric ${name}`);
			}
			const [, metric, value, rawField] = entry;

			expect(metric).toMatchObject({ state: 'known', value });
			expect(metric.provenance.authority).toBe('authoritative');
			expect(metric.provenance.rawFields).toEqual([rawField]);
			expect(metric.provenance.observedAt).toBe(FIXTURE_OBSERVED_AT);
		},
	);

	test('Given an NSA attach, when normalized, then the LTE anchor is retained rather than merged', () => {
		expect(MM.diagnostics.raw['Signal.Lte']).toContainEqual(['rsrp', -104]);
		expect(MM.diagnostics.consumed).toContain('Signal.Nr5g');
	});

	test('Given every RAT dict empty, when normalized, then each metric is a READ-class unknown and never a zero', () => {
		const silent = observation(normalizeModemManagerObservation(MM_SIGNAL_SILENT_FIXTURE, CONTEXT));

		for (const metric of [
			silent.signal.dbm,
			silent.signal.rsrp,
			silent.signal.rsrq,
			silent.signal.snr,
			silent.signal.sinr,
		]) {
			expect(metric).toMatchObject({ state: 'unknown', reason: 'not-reported' });
			expect(metric).not.toHaveProperty('value');
		}
	});

	test('Given an LTE/NR modem reporting no SINR, when normalized, then it is not-reported and NOT unsupported', () => {
		expect(reason(MM.signal.sinr)).toBe('not-reported');
		expect(metricUnknownClass('not-reported')).toBe('read');
	});

	test('Given a metric ModemManager cannot express, when normalized, then it is a capability claim', () => {
		expect(reason(MM.signal.bars)).toBe('unsupported');
		expect(reason(MM.signal.maxBars)).toBe('unsupported');
	});

	test('Given a field present but undecodable, when normalized, then it is malformed and noted', () => {
		expect(reason(MM.sim.esimStatus)).toBe('malformed');
		expect(MM.diagnostics.notes).toContainEqual({
			code: 'field-shape-unrecognized',
			field: 'Sim.EsimStatus',
		});
	});

	test('Given an interface nobody read, when normalized, then it is not-observed rather than not-reported', () => {
		const withoutSim = observation(
			normalizeModemManagerObservation({ modem: MM_FIXTURE.modem ?? {} }, CONTEXT),
		);

		expect(reason(withoutSim.sim.kind)).toBe('not-observed');
		expect(reason(withoutSim.sim.esimStatus)).toBe('not-observed');
		expect(reason(withoutSim.signal.rsrp)).toBe('not-observed');
		expect(reason(withoutSim.radio.registration)).toBe('not-reported');
	});

	test('Given an absent modem state, when normalized, then it is not-reported and never unsupported', () => {
		const empty = observation(normalizeModemManagerObservation({ modem: {} }, CONTEXT));

		expect(reason(empty.radio.modemState)).toBe('not-reported');
		expect(reason(empty.sim.presence)).toBe('not-reported');
		expect(reason(empty.hardware.label)).toBe('not-reported');
	});
});

describe('HiLink normalization', () => {
	test('Given both bodies, when normalized, then the migrated parser supplies the signal', () => {
		expect(HILINK.signal.bars).toMatchObject({ state: 'known', value: 4 });
		expect(HILINK.signal.maxBars).toMatchObject({ state: 'known', value: 5 });
		expect(HILINK.signal.dbm).toMatchObject({ state: 'known', value: -65 });
		expect(HILINK.signal.rsrp).toMatchObject({ state: 'known', value: -101 });
		expect(HILINK.signal.sinr).toMatchObject({ state: 'known', value: 12 });
		expect(HILINK.radio.modeLabel).toMatchObject({ state: 'known', value: '03' });
	});

	test('Given a vendor bar scale, when normalized, then it is marked derived rather than authoritative', () => {
		expect(HILINK.signal.bars.provenance.authority).toBe('derived');
		expect(HILINK.signal.dbm.provenance.authority).toBe('authoritative');
	});

	test('Given a router admin API, when normalized, then absent modem concepts are capability claims', () => {
		expect(reason(HILINK.radio.modemState)).toBe('unsupported');
		expect(reason(HILINK.radio.registration)).toBe('unsupported');
		expect(reason(HILINK.signal.quality)).toBe('unsupported');
	});

	test('Given a refused session, when normalized, then metrics report auth-expired and NOT unsupported', () => {
		const refused = observation(normalizeHilinkObservation(HILINK_AUTH_EXPIRED_FIXTURE, CONTEXT));

		expect(reason(refused.signal.dbm)).toBe('auth-expired');
		expect(reason(refused.signal.bars)).toBe('auth-expired');
		expect(reason(refused.radio.modeLabel)).toBe('auth-expired');
		expect(refused.diagnostics.notes).toContainEqual({
			code: 'auth-expired',
			field: 'monitoring-status.code',
		});
	});

	test('Given a refused session, when normalized, then the envelope is still an observation', () => {
		const envelope = normalizeHilinkObservation(HILINK_AUTH_EXPIRED_FIXTURE, CONTEXT);

		expect(envelope.freshness.state).toBe('fresh');
		expect(envelope.value).not.toBeNull();
	});
});

describe('ZTE normalization', () => {
	test('Given a goform body, when normalized, then signal and mode come from the migrated parsers', () => {
		expect(ZTE.signal.bars).toMatchObject({ state: 'known', value: 4 });
		expect(ZTE.signal.dbm).toMatchObject({ state: 'known', value: -67 });
		expect(ZTE.signal.rsrp).toMatchObject({ state: 'known', value: -99 });
		expect(ZTE.signal.rsrq).toMatchObject({ state: 'known', value: -10 });
		expect(ZTE.signal.snr).toMatchObject({ state: 'known', value: 7 });
		expect(ZTE.radio.modeLabel).toMatchObject({ state: 'known', value: 'LTE' });
	});

	test('Given the vendor fixed bar scale, when normalized, then it is derived', () => {
		expect(ZTE.signal.maxBars).toMatchObject({ state: 'known', value: 5 });
		expect(ZTE.signal.maxBars.provenance.authority).toBe('derived');
	});

	test('Given an unparseable body, when normalized, then it is a malformed observation, not an unavailable one', () => {
		const envelope = normalizeZteObservation(ZTE_MALFORMED_FIXTURE, CONTEXT);
		const malformed = observation(envelope);

		expect(envelope.freshness.state).toBe('fresh');
		expect(reason(malformed.signal.dbm)).toBe('malformed');
		expect(reason(malformed.radio.modeLabel)).toBe('malformed');
		expect(malformed.diagnostics.notes).toContainEqual({
			code: 'unparseable-body',
			field: 'goform',
		});
	});
});

describe('UFI normalization', () => {
	test('Given three endpoints, when normalized, then the single reported reading survives', () => {
		expect(UFI.signal.dbm).toMatchObject({ state: 'known', value: 3 });
		expect(UFI.hardware.label).toMatchObject({ state: 'known', value: 'UFI-M600' });
		expect(UFI.signal.dbm.provenance.rawFields).toEqual([
			'sysinfo.SIGNAL',
			'overview.SIGNAL',
			'status.signalStrength',
		]);
	});

	test('Given a SessionOut reply, when normalized, then the reading is auth-expired and noted', () => {
		const refused = observation(normalizeUfiObservation(UFI_AUTH_EXPIRED_FIXTURE, CONTEXT));

		expect(reason(refused.signal.dbm)).toBe('auth-expired');
		expect(refused.diagnostics.notes).toContainEqual({
			code: 'auth-expired',
			field: 'overview.reply',
		});
	});

	test('Given subscriber identifiers in the payload, when redacted, then only those are masked', () => {
		const redacted = redactObservationDiagnostics(UFI.diagnostics);

		expect(UFI.diagnostics.raw['overview.IMSI']).toBe('732123456789012');
		expect(redacted.raw['overview.IMSI']).toBe(REDACTED);
		expect(redacted.raw['overview.ICCID']).toBe(REDACTED);
		expect(redacted.raw['sysinfo.cputemp']).toBe('46');
		expect(redacted.unmapped).toEqual(UFI.diagnostics.unmapped);
	});
});

describe('no raw vendor field is dropped during normalization', () => {
	const roundTrips = [
		['modemmanager', MM, 'Modem.Ports', ['ttyUSB0', 'wwan0']],
		['modemmanager', MM, 'Modem3gpp.Pco', 'dns-primary=10.0.0.1'],
		['modemmanager', MM, 'Sim.OperatorName', 'CLARO COL'],
		['modemmanager', MM, 'Signal.Rate', 5],
		['huawei-hilink', HILINK, 'monitoring-status.CurrentNetworkTypeEx', '101'],
		['huawei-hilink', HILINK, 'device-signal.TotalDownload', '987654321'],
		['huawei-hilink', HILINK, 'monitoring-status.ConnectionStatus', '901'],
		['zte-goform', ZTE, 'goform.wan_lte_ca', 'ca_deactivated'],
		['zte-goform', ZTE, 'goform.lte_pci', '188'],
		['zte-goform', ZTE, 'goform.rmcc', '732'],
		['ufi-himiapi', UFI, 'sysinfo.cputemp', '46'],
		['ufi-himiapi', UFI, 'overview.WEBVER', 'V1.0.7'],
		['ufi-himiapi', UFI, 'status.battery', '88'],
	] as const;

	test.each(roundTrips.map(([source, , key]) => `${source} ${key}`))(
		'Given %s, when normalized, then the vendor field survives verbatim in diagnostics',
		(label) => {
			const entry = roundTrips.find(([source, , key]) => `${source} ${key}` === label);
			if (entry === undefined) {
				throw new Error(`missing round trip ${label}`);
			}
			const [, normalized, key, value] = entry;

			expect(normalized.diagnostics.raw[key]).toEqual(value);
			expect(normalized.diagnostics.unmapped).toContain(key);
		},
	);

	test('Given a repeated XML tag, when flattened, then later occurrences are kept under a suffix', () => {
		expect(HILINK.diagnostics.raw['net-mode-list.Index']).toBe('00');
		expect(HILINK.diagnostics.raw['net-mode-list.Index#2']).toBe('03');
		expect(HILINK.diagnostics.raw['net-mode-list.Name']).toBe('AUTO');
		expect(HILINK.diagnostics.raw['net-mode-list.Name#2']).toBe('LTE');
	});

	test('Given a consumed field, when normalized, then it is still present in the raw record', () => {
		for (const normalized of [MM, HILINK, ZTE, UFI]) {
			for (const key of normalized.diagnostics.consumed) {
				expect(Object.hasOwn(normalized.diagnostics.raw, key)).toBe(true);
			}
		}
	});
});
