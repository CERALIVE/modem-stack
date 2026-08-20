// The band-write descriptor and its certification gate.
//
// This suite proves the WIRING, not a second gate: `band/certification.ts` already
// owns the four-proof catalog and `offerableBands`, and every decision here is read
// out of it. What is asserted is that a band write can only ever reach a consumer as
// a `disruptive`, readback-required, certification-gated operation — and that the
// shipped (empty) catalog therefore refuses every device on the fleet today.

import { describe, expect, test } from 'bun:test';

import {
	BAND_CERTIFICATION_CATALOG,
	type BandCertificationEntry,
	findBandCertification,
} from '../band';
import type { ModemBands } from '../ports';
import {
	BAND_NONE_OFFERABLE_REFUSAL,
	BAND_WRITE_OPERATION_ID,
	BAND_WRITE_REFUSAL,
	bandWriteReadbackMatches,
	buildBandWriteDescriptor,
	describeBandWriteCertification,
} from './band-truth';

/** The bench Quectel's advertised bands, as the conformance fixtures spell them. */
const SUPPORTED = ['eutran-3', 'eutran-7', 'ngran-78'];

const SWEPT_ENTRY: BandCertificationEntry = {
	vidPid: '2c7c:0801',
	model: 'RM530N-GL',
	firmwarePrefix: 'RM530NGLAAR11A02',
	evidence: 'docs/BENCH.md RB-11 (fixture only)',
	proofs: { supportedRead: true, set: true, readback: true, reset: true },
	provenBands: [],
};

const NARROWED_ENTRY: BandCertificationEntry = { ...SWEPT_ENTRY, provenBands: ['eutran-3'] };

const descriptorFor = (entry: BandCertificationEntry | undefined, supported = SUPPORTED) =>
	buildBandWriteDescriptor({
		provider: 'modemmanager',
		profile: 'generic-mm',
		certification: describeBandWriteCertification({ entry, supported }),
		readSupported: true,
	});

describe('the shipped catalog is empty, so every device is refused today', () => {
	test('no fleet SKU resolves to an entry', () => {
		expect(BAND_CERTIFICATION_CATALOG.entries).toEqual([]);
		expect(
			findBandCertification(BAND_CERTIFICATION_CATALOG, {
				vidPid: '2c7c:0801',
				model: 'RM530N-GL',
				firmwarePrefix: 'RM530NGLAAR11A02M4G',
			}),
		).toBeUndefined();
	});

	test('an uncertified device refuses the write in support AND availability', () => {
		const descriptor = descriptorFor(undefined);
		expect(descriptor.support.write).toEqual({ supported: false, reason: BAND_WRITE_REFUSAL });
		expect(descriptor.availability).toEqual({ state: 'refused', reason: BAND_WRITE_REFUSAL });
	});

	test('an uncertified device offers NO bands even though the modem advertises three', () => {
		const certification = describeBandWriteCertification({
			entry: undefined,
			supported: SUPPORTED,
		});
		expect(certification.satisfied).toBe(false);
		expect(certification.offerable).toEqual([]);
	});

	test('reading bands stays available on an uncertified device', () => {
		expect(descriptorFor(undefined).support.read).toEqual({ supported: true });
	});
});

describe('certification is REQUIRED, structurally', () => {
	test('every certification decision requires certification, certified or not', () => {
		for (const entry of [undefined, SWEPT_ENTRY, NARROWED_ENTRY]) {
			expect(describeBandWriteCertification({ entry, supported: SUPPORTED }).required).toBe(true);
		}
	});

	test('a swept entry offers the whole advertised set', () => {
		expect(describeBandWriteCertification({ entry: SWEPT_ENTRY, supported: SUPPORTED })).toEqual({
			required: true,
			satisfied: true,
			reason: 'band-certification-proven',
			offerable: SUPPORTED,
		});
	});

	test('a narrowed entry offers only its proven bands', () => {
		expect(
			describeBandWriteCertification({ entry: NARROWED_ENTRY, supported: SUPPORTED }).offerable,
		).toEqual(['eutran-3']);
	});

	test('a certified band the modem no longer advertises is not offerable', () => {
		const certification = describeBandWriteCertification({
			entry: NARROWED_ENTRY,
			supported: ['eutran-7'],
		});
		expect(certification.offerable).toEqual([]);
		expect(descriptorFor(NARROWED_ENTRY, ['eutran-7']).availability).toEqual({
			state: 'refused',
			reason: BAND_NONE_OFFERABLE_REFUSAL,
		});
	});
});

describe('the descriptor carries the disruptive class and its readback', () => {
	const descriptor = descriptorFor(SWEPT_ENTRY);

	test('mutation impact is `disruptive`, never `write`', () => {
		expect(descriptor.mutationImpact).toBe('disruptive');
		expect(descriptor.mutationImpact).not.toBe('write');
		expect(descriptor.id).toBe(BAND_WRITE_OPERATION_ID);
	});

	test('the write is journalled, admitted and never auto-retried', () => {
		expect(descriptor.journal).toEqual({ required: true, reason: 'disruptive-radio-write' });
		expect(descriptor.admission).toEqual({ required: true, reason: 'provider-mutation' });
		expect(descriptor.retryClass).toBe('never');
	});

	test('the certification precondition is named in `livePreconditions`', () => {
		expect(descriptor.livePreconditions).toContain('band-certification-present');
	});

	test('the offered values are exactly what the catalog proves', () => {
		expect(descriptor.constraints).toEqual({ kind: 'allowed-values', values: [SUPPORTED] });
	});

	test('readback is required and refuses a partially-applied lock', () => {
		expect(descriptor.readback.required).toBe(true);
		if (!descriptor.readback.required) return;
		const observed: ModemBands = { supported: SUPPORTED, current: ['eutran-3'] };
		expect(descriptor.readback.matches(['eutran-3'], observed)).toBe(true);
		expect(descriptor.readback.matches(['eutran-3', 'eutran-7'], observed)).toBe(false);
	});
});

describe('readback semantics', () => {
	test('a narrowing lock must match exactly — a superset is a different lock', () => {
		expect(
			bandWriteReadbackMatches(['eutran-3'], {
				supported: SUPPORTED,
				current: ['eutran-3', 'eutran-7'],
			}),
		).toBe(false);
	});

	test('order does not matter for an exact set', () => {
		expect(
			bandWriteReadbackMatches(['eutran-7', 'eutran-3'], {
				supported: SUPPORTED,
				current: ['eutran-3', 'eutran-7'],
			}),
		).toBe(true);
	});

	test('a reset is confirmed by `any` OR by the whole supported set', () => {
		expect(bandWriteReadbackMatches(['any'], { supported: SUPPORTED, current: ['any'] })).toBe(
			true,
		);
		expect(bandWriteReadbackMatches(['any'], { supported: SUPPORTED, current: SUPPORTED })).toBe(
			true,
		);
	});

	test('a reset is NOT confirmed by a modem that stayed locked to one band', () => {
		expect(bandWriteReadbackMatches(['any'], { supported: SUPPORTED, current: ['eutran-3'] })).toBe(
			false,
		);
	});
});
