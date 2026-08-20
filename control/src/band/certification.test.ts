import { describe, expect, it } from 'bun:test';

import {
	BAND_CERTIFICATION_CATALOG,
	type BandCertificationCatalog,
	findBandCertification,
	isBandControlCertified,
	loadBandCertificationCatalog,
	offerableBands,
} from './certification';

const QUECTEL = {
	vidPid: '2c7c:0801',
	model: 'RM530N-GL',
	firmwarePrefix: 'RM530NGLAAR05A01M4G',
};

function catalogWith(entries: unknown[]): BandCertificationCatalog {
	return loadBandCertificationCatalog({ schemaVersion: 1, entries });
}

const CERTIFIED_QUECTEL = {
	vidPid: '2c7c:0801',
	model: 'RM530N-GL',
	firmwarePrefix: 'RM530NGLAAR05',
	evidence: 'evidence/todo30.md',
	proofs: { supportedRead: true, set: true, readback: true, reset: true },
};

describe('the SHIPPED band catalog', () => {
	it('is EMPTY — nothing in the fleet has been through the drill', () => {
		expect(BAND_CERTIFICATION_CATALOG.entries).toEqual([]);
	});

	it('therefore certifies no fleet modem', () => {
		expect(isBandControlCertified(BAND_CERTIFICATION_CATALOG, QUECTEL)).toBe(false);
	});
});

describe('the schema refuses a HALF-certified entry', () => {
	it('rejects an entry missing a proof step', () => {
		expect(() =>
			catalogWith([
				{
					...CERTIFIED_QUECTEL,
					proofs: { supportedRead: true, set: true, readback: true },
				},
			]),
		).toThrow();
	});

	it('rejects an entry that states a proof step as false', () => {
		// A `false` would read as a catalog row, and a catalog row is what
		// surfaces the control. The absence of an entry is the only way to say
		// "not proven".
		expect(() =>
			catalogWith([
				{ ...CERTIFIED_QUECTEL, proofs: { ...CERTIFIED_QUECTEL.proofs, reset: false } },
			]),
		).toThrow();
	});

	it('rejects an unknown field', () => {
		expect(() => catalogWith([{ ...CERTIFIED_QUECTEL, notes: 'x' }])).toThrow();
	});
});

describe('matching a device', () => {
	it('matches a firmware FAMILY by prefix of the device revision', () => {
		const catalog = catalogWith([CERTIFIED_QUECTEL]);
		expect(findBandCertification(catalog, QUECTEL)?.evidence).toBe('evidence/todo30.md');
	});

	it('does NOT match when the device revision is one character short of the entry', () => {
		const catalog = catalogWith([CERTIFIED_QUECTEL]);
		expect(
			findBandCertification(catalog, { ...QUECTEL, firmwarePrefix: 'RM530NGLAAR0' }),
		).toBeUndefined();
	});

	it('requires all three discriminators', () => {
		const catalog = catalogWith([CERTIFIED_QUECTEL]);
		expect(findBandCertification(catalog, { ...QUECTEL, model: 'RM520N-GL' })).toBeUndefined();
		expect(findBandCertification(catalog, { ...QUECTEL, vidPid: '2c7c:0125' })).toBeUndefined();
	});

	it('fails closed for a device whose SKU could not be resolved', () => {
		expect(isBandControlCertified(catalogWith([CERTIFIED_QUECTEL]), undefined)).toBe(false);
	});
});

describe('offerableBands', () => {
	const supported = ['eutran-1', 'eutran-3', 'eutran-7', 'ngran-78'];

	it('offers NOTHING without an entry', () => {
		expect(offerableBands(undefined, supported)).toEqual([]);
	});

	it('offers the whole advertised set when the drill swept it', () => {
		const [entry] = catalogWith([CERTIFIED_QUECTEL]).entries;
		expect(offerableBands(entry, supported)).toEqual(supported);
	});

	it('NARROWS to the proven bands, intersected with what the device advertises now', () => {
		const [entry] = catalogWith([
			{ ...CERTIFIED_QUECTEL, provenBands: ['eutran-3', 'eutran-20'] },
		]).entries;
		expect(offerableBands(entry, supported)).toEqual(['eutran-3']);
	});
});
