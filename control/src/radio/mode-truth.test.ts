// The mode-write DESCRIPTOR — where the modem's own catalog becomes a contract.
//
// The acceptance property this suite exists for: a combination the modem advertised
// reaches `descriptor.constraints.values` unchanged, `preferred: 'none'` included. A
// descriptor that quietly substituted a default would be indistinguishable from a
// correct one at every other layer.

import { describe, expect, test } from 'bun:test';

import { MODE_NONE, modeCombination } from './mode-combinations';
import {
	advertisesNoPreference,
	buildModeWriteDescriptor,
	encodeModeSelection,
	MODE_WRITE_OPERATION_ID,
	type ModeSelection,
	matchAdvertisedCombination,
	readRadioModeTruth,
	sameSelection,
	selectionOf,
} from './mode-truth';

const CS = 1 << 0;
const M2G = 1 << 1;
const M3G = 1 << 2;
const M4G = 1 << 3;
const M5G = 1 << 4;
const FUTURE = 1 << 9;

const FM350_ALLOWED = CS | M2G | M3G | M4G;

/** Fibocom FM350-GL: one combination, preferred NONE (the conformance-matrix spec's own values). */
const FM350 = readRadioModeTruth({
	currentModes: [FM350_ALLOWED, 0],
	supportedModes: [[FM350_ALLOWED, 0]],
});

/** Quectel RM530N-GL as the matrix fixtures spell it: allowed CS+2G+3G, preferred NONE. */
const QUECTEL = readRadioModeTruth({
	currentModes: [CS | M2G | M3G, 0],
	supportedModes: [[CS | M2G | M3G, 0]],
});

/** SIMCom SIM7600G-H as the matrix fixtures spell it: allowed 3G, preferred NONE. */
const SIMCOM = readRadioModeTruth({
	currentModes: [M3G, 0],
	supportedModes: [[M3G, 0]],
});

/** A modem advertising a real preference plus a bit this build cannot name. */
const UNKNOWN_COMBINATION = readRadioModeTruth({
	currentModes: [M4G | M5G, M5G],
	supportedModes: [
		[M4G | M5G, M5G],
		[M4G | M5G, M4G],
		[M4G | M5G | FUTURE, FUTURE],
	],
});

const descriptorFor = (truth: Parameters<typeof buildModeWriteDescriptor>[0]['truth']) =>
	buildModeWriteDescriptor({
		provider: 'modemmanager',
		profile: 'generic-mm',
		truth,
		writeSupported: true,
	});

describe('FM350 `preferred: none` survives to the descriptor VERBATIM', () => {
	const descriptor = descriptorFor(FM350);

	test('the descriptor offers exactly the advertised combination', () => {
		expect(descriptor.constraints).toEqual({
			kind: 'allowed-values',
			values: [{ allowed: ['cs', '2g', '3g', '4g'], preferred: MODE_NONE }],
		});
	});

	test('`preferred` is `none` and was not coerced to any allowed mode', () => {
		const values =
			descriptor.constraints.kind === 'allowed-values' ? descriptor.constraints.values : [];
		expect(values[0]?.preferred).toBe(MODE_NONE);
		for (const mode of ['cs', '2g', '3g', '4g', '5g']) {
			expect(values[0]?.preferred).not.toBe(mode);
		}
	});

	test('the reading is `reported` and its combination is the same one', () => {
		expect(FM350.current).toEqual({
			state: 'reported',
			combination: modeCombination(FM350_ALLOWED, 0),
		});
		expect(advertisesNoPreference(FM350)).toBe(true);
	});

	test('the descriptor is available and write-supported', () => {
		expect(descriptor.availability).toEqual({ state: 'available' });
		expect(descriptor.support.write).toEqual({ supported: true });
		expect(descriptor.id).toBe(MODE_WRITE_OPERATION_ID);
	});
});

describe('Quectel and SIMCom fixtures', () => {
	test('Quectel advertises one no-preference combination', () => {
		expect(descriptorFor(QUECTEL).constraints).toEqual({
			kind: 'allowed-values',
			values: [{ allowed: ['cs', '2g', '3g'], preferred: MODE_NONE }],
		});
	});

	test('SIMCom advertises one 3G-only no-preference combination', () => {
		expect(descriptorFor(SIMCOM).constraints).toEqual({
			kind: 'allowed-values',
			values: [{ allowed: ['3g'], preferred: MODE_NONE }],
		});
	});

	test('two combinations sharing an allowed set differ only in the preference', () => {
		const values = UNKNOWN_COMBINATION.supported.combinations.map(selectionOf);
		expect(values[0]).toEqual({ allowed: ['4g', '5g'], preferred: '5g' });
		expect(values[1]).toEqual({ allowed: ['4g', '5g'], preferred: '4g' });
		expect(sameSelection(values[0] as ModeSelection, values[1] as ModeSelection)).toBe(false);
	});
});

describe('an unknown combination stays OFFERED, never coerced to unsupported', () => {
	const descriptor = descriptorFor(UNKNOWN_COMBINATION);

	test('the unnameable combination is in the descriptor`s allowed values', () => {
		const values =
			descriptor.constraints.kind === 'allowed-values' ? descriptor.constraints.values : [];
		expect(values).toHaveLength(3);
		expect(values[2]).toEqual({
			allowed: ['4g', '5g', 'mode-bit-512'],
			preferred: 'mode-bit-512',
		});
	});

	test('the descriptor stays available despite carrying an unknown combination', () => {
		expect(descriptor.availability).toEqual({ state: 'available' });
		expect(descriptor.support.write).toEqual({ supported: true });
	});

	test('it can be matched and encoded back to the exact masks the modem sent', () => {
		const selection: ModeSelection = {
			allowed: ['4g', '5g', 'mode-bit-512'],
			preferred: 'mode-bit-512',
		};
		expect(matchAdvertisedCombination(UNKNOWN_COMBINATION.supported, selection)).toBeDefined();
		expect(encodeModeSelection(selection)).toEqual({
			ok: true,
			allowedMask: M4G | M5G | FUTURE,
			preferredMask: FUTURE,
		});
	});
});

describe('refusals are refusals, never substitutions', () => {
	test('a selection the modem never advertised matches nothing', () => {
		expect(
			matchAdvertisedCombination(FM350.supported, {
				allowed: ['cs', '2g', '3g', '4g'],
				preferred: '4g',
			}),
		).toBeUndefined();
	});

	test('a nearest-neighbour is NOT returned for an unadvertised preference', () => {
		const nearest = matchAdvertisedCombination(UNKNOWN_COMBINATION.supported, {
			allowed: ['4g', '5g'],
			preferred: '3g',
		});
		expect(nearest).toBeUndefined();
	});

	test('an empty catalog refuses the descriptor rather than offering an open write', () => {
		const descriptor = descriptorFor(readRadioModeTruth({ currentModes: 7, supportedModes: [] }));
		expect(descriptor.availability).toEqual({
			state: 'refused',
			reason: 'no-advertised-mode-combinations',
		});
	});

	test('a modem with no mode write says so in support AND availability', () => {
		const descriptor = buildModeWriteDescriptor({
			provider: 'modemmanager',
			profile: 'generic-mm',
			truth: FM350,
			writeSupported: false,
		});
		expect(descriptor.support.write).toEqual({
			supported: false,
			reason: 'mode-write-unsupported',
		});
		expect(descriptor.availability).toEqual({
			state: 'refused',
			reason: 'mode-write-unsupported',
		});
	});

	test('an unplaceable mode name fails the encode closed', () => {
		expect(encodeModeSelection({ allowed: ['4g', 'lte-advanced'], preferred: '4g' })).toEqual({
			ok: false,
			unknown: 'lte-advanced',
		});
	});
});

describe('the write is disruptive and readback-gated', () => {
	const descriptor = descriptorFor(FM350);

	test('mutation impact is disruptive and the write is journalled and admitted', () => {
		expect(descriptor.mutationImpact).toBe('disruptive');
		expect(descriptor.journal).toEqual({ required: true, reason: 'disruptive-radio-write' });
		expect(descriptor.admission).toEqual({ required: true, reason: 'provider-mutation' });
		expect(descriptor.retryClass).toBe('never');
	});

	test('readback confirms only when BOTH the allowed set and the preference match', () => {
		expect(descriptor.readback.required).toBe(true);
		if (!descriptor.readback.required) return;
		const selection: ModeSelection = { allowed: ['cs', '2g', '3g', '4g'], preferred: MODE_NONE };
		expect(descriptor.readback.matches(selection, FM350)).toBe(true);
		expect(
			descriptor.readback.matches({ allowed: ['cs', '2g', '3g', '4g'], preferred: '4g' }, FM350),
		).toBe(false);
	});

	test('a modem that reported no current modes cannot satisfy a readback', () => {
		expect(descriptor.readback.required).toBe(true);
		if (!descriptor.readback.required) return;
		const unreported = readRadioModeTruth({ currentModes: undefined, supportedModes: [] });
		expect(unreported.current).toEqual({ state: 'not-reported' });
		expect(descriptor.readback.matches({ allowed: ['cs'], preferred: MODE_NONE }, unreported)).toBe(
			false,
		);
	});
});
