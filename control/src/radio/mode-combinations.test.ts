// The verbatim mode-catalog decoder.
//
// Every case here is a LOSS this decoder exists to prevent, not a shape exercise:
// the FM350's stated no-preference, a mode bit a future ModemManager adds, and a
// catalog member that is not a `(uu)` at all.

import { describe, expect, test } from 'bun:test';

import {
	decodeModeCombination,
	decodeSupportedModeCombinations,
	encodeModeNames,
	hasUnknownCombination,
	isFullyNamedMask,
	isNamedMode,
	MODE_ANY,
	MODE_NONE,
	modeCombination,
	modeName,
	modeNames,
	modeValue,
	statesNoPreference,
} from './mode-combinations';

const CS = 1 << 0;
const M2G = 1 << 1;
const M3G = 1 << 2;
const M4G = 1 << 3;
const M5G = 1 << 4;

/** The bench FM350-GL's single advertised combination: allowed CS+2G+3G+4G, preferred NONE. */
const FM350_ALLOWED = CS | M2G | M3G | M4G;

describe('mode name vocabulary', () => {
	test('the five named MM mode bits round-trip', () => {
		for (const [bit, name] of [
			[CS, 'cs'],
			[M2G, '2g'],
			[M3G, '3g'],
			[M4G, '4g'],
			[M5G, '5g'],
		] as const) {
			expect(modeName(bit)).toBe(name);
			expect(modeValue(name)).toBe(bit);
			expect(isNamedMode(name)).toBe(true);
		}
	});

	test('an unnamed bit round-trips as a passthrough rather than being dropped', () => {
		const future = 1 << 9;
		expect(modeName(future)).toBe('mode-bit-512');
		expect(modeValue('mode-bit-512')).toBe(future);
		expect(isNamedMode('mode-bit-512')).toBe(false);
	});

	test('none is 0 and any is the full mask', () => {
		expect(modeValue(MODE_NONE)).toBe(0);
		expect(modeValue(MODE_ANY)).toBe(0xffffffff);
		expect(modeNames(0)).toEqual([]);
		expect(modeNames(0xffffffff)).toEqual([MODE_ANY]);
	});

	test('a name this build cannot place is refused, never coerced to a neighbour', () => {
		expect(modeValue('lte-advanced')).toBeUndefined();
		expect(encodeModeNames(['4g', 'lte-advanced'])).toEqual({ ok: false, unknown: 'lte-advanced' });
	});

	test('encoding a set is the OR of its bits', () => {
		expect(encodeModeNames(['2g', '3g', '4g'])).toEqual({ ok: true, mask: M2G | M3G | M4G });
		expect(encodeModeNames([])).toEqual({ ok: true, mask: 0 });
	});
});

describe('FM350 `preferred: none` — the case this module exists for', () => {
	const combination = modeCombination(FM350_ALLOWED, 0);

	test('preferred is the literal `none`, not the highest allowed mode', () => {
		expect(combination.preferred).toBe(MODE_NONE);
		expect(combination.preferred).not.toBe('4g');
		expect(combination.preferredMask).toBe(0);
	});

	test('a stated no-preference is NOT an anomaly and stays fully named', () => {
		expect(combination.anomalies).toEqual([]);
		expect(combination.classification).toBe('named');
		expect(statesNoPreference(combination)).toBe(true);
	});

	test('the allowed set is decoded in MM bit order, verbatim', () => {
		expect(combination.allowed).toEqual(['cs', '2g', '3g', '4g']);
		expect(combination.allowedMask).toBe(FM350_ALLOWED);
	});

	test('the raw masks survive alongside the names', () => {
		expect(decodeModeCombination([FM350_ALLOWED, 0])).toEqual(combination);
	});
});

describe('unknown combinations are passed through TYPED, never dropped', () => {
	test('an unfamiliar allowed bit keeps the combination and classifies it', () => {
		const combination = modeCombination(M4G | (1 << 9), M4G);
		expect(combination.allowed).toEqual(['4g', 'mode-bit-512']);
		expect(combination.classification).toBe('unknown-combination');
		expect(combination.anomalies).toEqual(['unnamed-allowed-bit']);
	});

	test('a preferred mode outside its own allowed set is reported, not corrected', () => {
		const combination = modeCombination(M4G, M5G);
		expect(combination.preferred).toBe('5g');
		expect(combination.anomalies).toEqual(['preferred-not-in-allowed']);
		expect(combination.classification).toBe('unknown-combination');
	});

	test('a zero allowed mask is retained as an anomaly rather than filtered away', () => {
		const combination = modeCombination(0, 0);
		expect(combination.allowed).toEqual([]);
		expect(combination.anomalies).toEqual(['empty-allowed']);
	});

	test('a multi-bit preferred mask is reported as non-singular and kept whole', () => {
		const combination = modeCombination(M4G | M5G, M4G | M5G);
		expect(combination.preferred).toBe('4g+5g');
		expect(combination.preferredMask).toBe(M4G | M5G);
		expect(combination.anomalies).toContain('preferred-not-singular');
	});

	test('`unknown` is never `unsupported` — the classification carries no support claim', () => {
		const combination = modeCombination(M4G | (1 << 9), 0);
		expect(combination.classification).toBe('unknown-combination');
		expect(combination.allowedMask).toBe(M4G | (1 << 9));
		expect(combination.allowed.length).toBeGreaterThan(0);
	});
});

describe('decoding a whole SupportedModes catalog', () => {
	test('nothing is dropped: decoded + undecodable equals what the provider sent', () => {
		const members = [
			[M4G, 0],
			[M4G | M5G, M5G],
			'not-a-pair',
			[M4G, M5G, M2G],
			[M4G],
			[M2G | M3G, M3G],
		];
		const set = decodeSupportedModeCombinations(members);
		expect(set.combinations.length + set.undecodable.length).toBe(members.length);
		expect(set.undecodable).toEqual(['not-a-pair', [M4G, M5G, M2G], [M4G]]);
	});

	test('an undecodable member is retained EXACTLY as it arrived', () => {
		const set = decodeSupportedModeCombinations([{ allowed: 8 }]);
		expect(set.combinations).toEqual([]);
		expect(set.undecodable).toEqual([{ allowed: 8 }]);
	});

	test('a non-array property is an empty catalog, not a throw', () => {
		expect(decodeSupportedModeCombinations(undefined)).toEqual({
			combinations: [],
			undecodable: [],
		});
		expect(decodeSupportedModeCombinations(7)).toEqual({ combinations: [], undecodable: [] });
	});

	test('the FM350 catalog decodes to exactly one no-preference combination', () => {
		const set = decodeSupportedModeCombinations([[FM350_ALLOWED, 0]]);
		expect(set.combinations).toHaveLength(1);
		expect(set.combinations[0]?.preferred).toBe(MODE_NONE);
		expect(hasUnknownCombination(set)).toBe(false);
	});

	test('a catalog carrying one unknown member reports so without hiding the rest', () => {
		const set = decodeSupportedModeCombinations([
			[M4G, 0],
			[M4G | (1 << 9), 0],
		]);
		expect(set.combinations).toHaveLength(2);
		expect(hasUnknownCombination(set)).toBe(true);
	});

	test('a negative or non-integer mask is not a pair', () => {
		const set = decodeSupportedModeCombinations([
			[-1, 0],
			[8, 1.5],
		]);
		expect(set.combinations).toEqual([]);
		expect(set.undecodable).toHaveLength(2);
	});
});

describe('mask naming', () => {
	test('isFullyNamedMask accepts none, any and every named combination', () => {
		expect(isFullyNamedMask(0)).toBe(true);
		expect(isFullyNamedMask(0xffffffff)).toBe(true);
		expect(isFullyNamedMask(FM350_ALLOWED)).toBe(true);
		expect(isFullyNamedMask(M4G | (1 << 9))).toBe(false);
	});
});
