// Registration + coarse-cell context — who we are attached to, and to which cell.
//
// Two confusions are what this suite exists to catch, because both produce a
// plausible-looking value rather than a visible failure:
//
//   1. `Sim.OperatorName` (the HOME operator burned into the SIM) standing in for
//      `Modem3gpp.OperatorName` (the operator we are REGISTERED with). They agree on a
//      home network and disagree for the whole time a device is roaming.
//   2. A partially-decoded `3gpp-lac-ci` string. It carries five tokens in one value,
//      so a decoder that tolerated a short one would report a TAC read out of the cell
//      id's position — a well-formed identifier naming the wrong thing.

import { describe, expect, test } from 'bun:test';
import {
	fixtureContext,
	HILINK_FIXTURE,
	MM_FIXTURE,
	UFI_FIXTURE,
	ZTE_FIXTURE,
} from '../../test-support/observation-fixtures';
import { decode3gppLacCi, lacCiOperatorCode } from '../domain';
import { viewEnvelope } from './envelope';
import { metricUnknownClass, type NormalizedMetric } from './metric';
import type { NormalizedModemObservation } from './model';
import { normalizeHilinkObservation } from './sources/hilink';
import {
	type ModemManagerObservationInput,
	normalizeModemManagerObservation,
} from './sources/modemmanager';
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

const mm = (input: ModemManagerObservationInput) =>
	observation(normalizeModemManagerObservation(input, CONTEXT));

function known<T>(metric: NormalizedMetric<T>): T {
	if (metric.state !== 'known') {
		throw new Error(`expected a known metric, got unknown:${metric.reason}`);
	}
	return metric.value;
}

function unknownReason(metric: NormalizedMetric<unknown>): string {
	if (metric.state !== 'unknown') {
		throw new Error(`expected an unknown metric, got known:${String(metric.value)}`);
	}
	return metric.reason;
}

describe('decode3gppLacCi — MM 1.24.2 emits exactly five comma-separated tokens', () => {
	test('the five tokens decode in MM\u2019s own order, as text', () => {
		expect(decode3gppLacCi('732,101,2B1C,0A1B2C3D,4E5F')).toEqual({
			mcc: '732',
			mnc: '101',
			locationAreaCode: '2B1C',
			cellId: '0A1B2C3D',
			trackingAreaCode: '4E5F',
		});
	});

	test('hex stays hex — a cell id is never reinterpreted as decimal', () => {
		// `0A1B2C3D` parsed as a number would render 169552957, which matches nothing
		// `mmcli` or a vendor UI shows for this cell.
		expect(decode3gppLacCi('732,101,2B1C,0A1B2C3D,4E5F')?.cellId).toBe('0A1B2C3D');
	});

	test('a two-digit MNC keeps its width', () => {
		expect(decode3gppLacCi('310,01,1A,2B,3C')?.mnc).toBe('01');
		expect(
			lacCiOperatorCode({
				mcc: '310',
				mnc: '01',
				locationAreaCode: '1A',
				cellId: '2B',
				trackingAreaCode: '3C',
			}),
		).toBe('31001');
	});

	test('a token count other than five decodes to NOTHING, never a partial record', () => {
		expect(decode3gppLacCi('732,101,2B1C,0A1B2C3D')).toBeUndefined();
		expect(decode3gppLacCi('732,101,2B1C,0A1B2C3D,4E5F,extra')).toBeUndefined();
		expect(decode3gppLacCi('')).toBeUndefined();
		expect(decode3gppLacCi(undefined)).toBeUndefined();
	});

	test('an empty MCC, MNC or cell id is not a decode', () => {
		expect(decode3gppLacCi(',101,2B1C,0A1B2C3D,4E5F')).toBeUndefined();
		expect(decode3gppLacCi('732,,2B1C,0A1B2C3D,4E5F')).toBeUndefined();
		expect(decode3gppLacCi('732,101,2B1C,,4E5F')).toBeUndefined();
	});

	test('an EMPTY tracking-area code still decodes — a 2G/3G attach has none', () => {
		expect(decode3gppLacCi('732,101,2B1C,0A1B2C3D,')?.trackingAreaCode).toBe('');
	});
});

describe('ModemManager registration context', () => {
	test('the operator comes from Modem3gpp, NOT from the SIM\u2019s home operator', () => {
		const radio = mm(MM_FIXTURE).radio;
		expect(known(radio.operatorName)).toBe('Claro');
		expect(known(radio.operatorCode)).toBe('732101');
		// The fixture's SIM carries a DIFFERENT name on purpose; reading the wrong
		// interface would surface it here.
		expect(MM_FIXTURE.sim?.OperatorName).toBe('CLARO COL');
	});

	test('provenance names the exact Modem3gpp field each value came from', () => {
		const radio = mm(MM_FIXTURE).radio;
		expect(
			radio.operatorName.state === 'known' ? radio.operatorName.provenance.rawFields : [],
		).toEqual(['Modem3gpp.OperatorName']);
		expect(
			radio.operatorCode.state === 'known' ? radio.operatorCode.provenance.rawFields : [],
		).toEqual(['Modem3gpp.OperatorCode']);
	});

	test('an unregistered modem reports not-reported, never an empty string', () => {
		const radio = mm({ modem: MM_FIXTURE.modem ?? {}, modem3gpp: { OperatorName: '' } }).radio;
		expect(unknownReason(radio.operatorName)).toBe('not-reported');
		expect(unknownReason(radio.operatorCode)).toBe('not-reported');
		// A READ-class answer, so a consumer keeps showing the field as pending rather
		// than hiding it as something ModemManager cannot express.
		expect(metricUnknownClass('not-reported')).toBe('read');
	});
});

describe('ModemManager coarse-cell context (3gpp-lac-ci)', () => {
	test('TAC and CID are claimed from the one location string', () => {
		const cell = mm(MM_FIXTURE).cell;
		expect(known(cell.cellId)).toBe('0A1B2C3D');
		expect(known(cell.tac)).toBe('4E5F');
		expect(cell.cellId.state === 'known' ? cell.cellId.provenance.rawFields : []).toEqual([
			'Location.3gpp-lac-ci',
		]);
	});

	test('NO location body read is `not-observed` — nobody looked', () => {
		const { location: _location, ...withoutLocation } = MM_FIXTURE;
		const cell = mm(withoutLocation).cell;
		expect(unknownReason(cell.cellId)).toBe('not-observed');
		expect(unknownReason(cell.tac)).toBe('not-observed');
	});

	test('a location body carrying no 3gpp-lac-ci entry is `not-reported`', () => {
		const cell = mm({ ...MM_FIXTURE, location: {} }).cell;
		expect(unknownReason(cell.cellId)).toBe('not-reported');
		expect(unknownReason(cell.tac)).toBe('not-reported');
	});

	test('a malformed value fails BOTH fields together, never one of them', () => {
		const cell = mm({ ...MM_FIXTURE, location: { '3gpp-lac-ci': '732,101,2B1C' } }).cell;
		expect(unknownReason(cell.cellId)).toBe('malformed');
		expect(unknownReason(cell.tac)).toBe('malformed');
	});

	test('an empty TAC on an attach that has none is not-reported, and the CID still reads', () => {
		const cell = mm({ ...MM_FIXTURE, location: { '3gpp-lac-ci': '732,101,2B1C,00A1B2,' } }).cell;
		expect(known(cell.cellId)).toBe('00A1B2');
		expect(unknownReason(cell.tac)).toBe('not-reported');
	});

	test('the whole Location property stays in the diagnostics block', () => {
		const diagnostics = mm(MM_FIXTURE).diagnostics;
		expect(diagnostics.raw['Location.3gpp-lac-ci']).toBe('732,101,2B1C,0A1B2C3D,4E5F');
	});
});

describe('router sources claim only what a migrated parser decoded', () => {
	test('ZTE claims the operator NAME and the cell id it already parses', () => {
		const zte = observation(normalizeZteObservation(ZTE_FIXTURE, CONTEXT));
		expect(known(zte.radio.operatorName)).toBe('Movistar');
		expect(known(zte.cell.cellId)).toBe('0A1B2C');
		// `rmcc` + `rmnc` are in the payload, but joining an unpadded MNC would name a
		// different network — so no code is derived.
		expect(unknownReason(zte.radio.operatorCode)).toBe('not-reported');
		expect(zte.diagnostics.raw['goform.rmcc']).toBe('732');
		expect(zte.diagnostics.raw['goform.rmnc']).toBe('123');
	});

	test('UFI claims its cell id and no operator', () => {
		const ufi = observation(normalizeUfiObservation(UFI_FIXTURE, CONTEXT));
		expect(known(ufi.cell.cellId)).toBe('3344');
		expect(unknownReason(ufi.radio.operatorName)).toBe('not-reported');
	});

	test('HiLink ships a raw <cell_id> that is retained but NOT claimed', () => {
		const hilink = observation(normalizeHilinkObservation(HILINK_FIXTURE, CONTEXT));
		expect(unknownReason(hilink.cell.cellId)).toBe('not-reported');
		expect(hilink.diagnostics.raw['device-signal.cell_id']).toBe('12345678');
		expect(hilink.diagnostics.unmapped).toContain('device-signal.cell_id');
	});

	test('no router source claims `unsupported` for TAC — that would be a source claim', () => {
		for (const observed of [
			observation(normalizeZteObservation(ZTE_FIXTURE, CONTEXT)),
			observation(normalizeUfiObservation(UFI_FIXTURE, CONTEXT)),
			observation(normalizeHilinkObservation(HILINK_FIXTURE, CONTEXT)),
		]) {
			expect(unknownReason(observed.cell.tac)).toBe('not-reported');
			expect(metricUnknownClass(unknownReason(observed.cell.tac) as 'not-reported')).toBe('read');
		}
	});
});
