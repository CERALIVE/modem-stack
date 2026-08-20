import { describe, expect, it } from 'bun:test';

import {
	BAND_ANY,
	bandName,
	bandValue,
	decodeBandList,
	encodeBandList,
	isNamedBand,
	isResetSelection,
} from './band-names';

describe('MMModemBand ↔ name', () => {
	it('decodes the irregular GSM/UTRAN head exactly as ModemManager numbers it', () => {
		// UTRAN_2 = 12 and UTRAN_6 = 8: the ordering is NOT the band number, which
		// is the whole reason this block is a table rather than arithmetic.
		expect(bandName(1)).toBe('egsm');
		expect(bandName(4)).toBe('g850');
		expect(bandName(5)).toBe('utran-1');
		expect(bandName(8)).toBe('utran-6');
		expect(bandName(12)).toBe('utran-2');
		expect(bandName(20)).toBe('g810');
	});

	it('decodes the arithmetic blocks from their bases', () => {
		expect(bandName(31)).toBe('eutran-1');
		expect(bandName(33)).toBe('eutran-3');
		expect(bandName(101)).toBe('eutran-71');
		expect(bandName(128)).toBe('cdma-bc0');
		expect(bandName(147)).toBe('cdma-bc19');
		expect(bandName(301)).toBe('ngran-1');
		expect(bandName(378)).toBe('ngran-78');
	});

	it('names 256 as the reset value', () => {
		expect(bandName(256)).toBe(BAND_ANY);
		expect(bandValue(BAND_ANY)).toBe(256);
	});

	it('round-trips a value it does not name rather than dropping or guessing', () => {
		expect(bandName(9001)).toBe('band-9001');
		expect(bandValue('band-9001')).toBe(9001);
		expect(isNamedBand('band-9001')).toBe(false);
		expect(isNamedBand('eutran-3')).toBe(true);
	});

	it('refuses a name it cannot place', () => {
		expect(bandValue('eutran-999')).toBeUndefined();
		expect(bandValue('nonsense')).toBeUndefined();
		expect(bandValue('band-')).toBeUndefined();
	});

	it('round-trips every named band through both directions', () => {
		for (const value of [1, 12, 31, 101, 128, 147, 256, 301, 378]) {
			expect(bandValue(bandName(value))).toBe(value);
		}
	});
});

describe('decodeBandList — a property read', () => {
	it('decodes the RM530N-GL-shaped LTE + NR set a fleet modem advertises', () => {
		// eutran-1/3/7/28 + ngran-78: the shape `SupportedBands` takes on a
		// multi-mode 5G stick. Numbers, because the D-Bus property is `au`.
		expect(decodeBandList([31, 33, 37, 58, 378])).toEqual([
			'eutran-1',
			'eutran-3',
			'eutran-7',
			'eutran-28',
			'ngran-78',
		]);
	});

	it('decodes the SIM7600-shaped GSM + UTRAN + LTE set', () => {
		expect(decodeBandList([1, 2, 3, 4, 5, 12, 31, 33, 38, 50])).toEqual([
			'egsm',
			'dcs',
			'pcs',
			'g850',
			'utran-1',
			'utran-2',
			'eutran-1',
			'eutran-3',
			'eutran-8',
			'eutran-20',
		]);
	});

	it('reports a single `any` for an unlocked modem', () => {
		expect(decodeBandList([256])).toEqual(['any']);
	});

	it('drops `unknown` and non-numeric members instead of inventing bands', () => {
		expect(decodeBandList([0, 31, 'eutran-3', null, 1.5])).toEqual(['eutran-1']);
	});

	it('answers an empty list for a non-array property', () => {
		expect(decodeBandList(undefined)).toEqual([]);
		expect(decodeBandList('eutran-3')).toEqual([]);
	});
});

describe('encodeBandList — a write', () => {
	it('encodes a selection', () => {
		expect(encodeBandList(['eutran-3', 'ngran-78'])).toEqual({ ok: true, values: [33, 378] });
	});

	it('FAILS CLOSED as a whole on one unplaceable name', () => {
		// A partial band set is a different lock from the one that was asked for.
		expect(encodeBandList(['eutran-3', 'nonsense', 'eutran-7'])).toEqual({
			ok: false,
			unknown: 'nonsense',
		});
	});

	it('recognises the reset selection, and only that selection', () => {
		expect(isResetSelection(['any'])).toBe(true);
		expect(isResetSelection(['any', 'eutran-3'])).toBe(false);
		expect(isResetSelection([])).toBe(false);
		expect(isResetSelection(['eutran-3'])).toBe(false);
	});
});
