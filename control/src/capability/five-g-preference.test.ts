import { describe, expect, test } from 'bun:test';

import type { RadioAccessTechnology } from '../domain';
import {
	FIVE_G_PREFERENCES,
	type FiveGPreference,
	fiveGPreferenceConfirmed,
	fiveGPreferenceEvidence,
	fiveGPreferenceToRadio,
	NR_MODE_UNSUPPORTED_REASON,
	nrModeSelection,
	offeredFiveGPreferences,
	type RadioModeSet,
	readFiveGPreference,
} from './five-g-preference';

const rats = (...list: readonly RadioAccessTechnology[]): ReadonlySet<RadioAccessTechnology> =>
	new Set(list);

/** The bench Quectel RM530N-GL's advertised families (todo 2, `ceralive2`). */
const QUECTEL = rats('gsm', 'umts', 'lte', '5gnr');
/** The bench SIMCom SIM7600G-H — LTE-max, no 5G. */
const SIMCOM = rats('gsm', 'umts', 'lte');

const modes = (
	allowed: ReadonlySet<RadioAccessTechnology>,
	preferred?: RadioAccessTechnology,
): RadioModeSet => ({ allowed, ...(preferred === undefined ? {} : { preferred }) });

describe('capability evidence', () => {
	test('an unobserved catalog is UNKNOWN, never absent', () => {
		expect(fiveGPreferenceEvidence(undefined)).toBe('unknown');
		expect(fiveGPreferenceEvidence(rats())).toBe('unknown');
	});

	test('an observed catalog answers on whether it names 5GNR', () => {
		expect(fiveGPreferenceEvidence(QUECTEL)).toBe('present');
		expect(fiveGPreferenceEvidence(SIMCOM)).toBe('absent');
	});
});

describe('which postures may be offered', () => {
	test('a 5G modem with fallback is offered all four', () => {
		expect(offeredFiveGPreferences(QUECTEL)).toEqual([...FIVE_G_PREFERENCES]);
	});

	test('a modem with NO 5G is offered NOTHING — not even 5g-off', () => {
		// `5g-off` on a radio with no 5G is a control that cannot change anything,
		// which is worse than an absent one: it invites an operator to act.
		expect(offeredFiveGPreferences(SIMCOM)).toEqual([]);
		expect(offeredFiveGPreferences(undefined)).toEqual([]);
	});

	test('a 5G-ONLY radio is offered only 5g-only — three labels for one posture is not a choice', () => {
		expect(offeredFiveGPreferences(rats('5gnr'))).toEqual(['5g-only']);
	});

	test('prefer-4g is withheld from a 5G modem that advertises no LTE', () => {
		expect(offeredFiveGPreferences(rats('umts', '5gnr'))).toEqual([
			'5g-only',
			'prefer-5g',
			'5g-off',
		]);
	});
});

describe('preference → (allowed, preferred)', () => {
	test('prefer-5g and prefer-4g share ONE allowed set and differ only in ranking', () => {
		const preferFive = fiveGPreferenceToRadio('prefer-5g', QUECTEL);
		const preferFour = fiveGPreferenceToRadio('prefer-4g', QUECTEL);

		expect([...(preferFive?.allowedSet ?? [])].sort()).toEqual(
			[...(preferFour?.allowedSet ?? [])].sort(),
		);
		expect(preferFive?.preferenceOrdered[0]).toBe('5gnr');
		expect(preferFour?.preferenceOrdered[0]).toBe('lte');
	});

	test('5g-only allows 5G and nothing else', () => {
		const target = fiveGPreferenceToRadio('5g-only', QUECTEL);
		expect([...(target?.allowedSet ?? [])]).toEqual(['5gnr']);
		expect(target?.preferenceOrdered).toEqual(['5gnr']);
	});

	test('5g-off keeps every sub-5G family the modem advertised', () => {
		const target = fiveGPreferenceToRadio('5g-off', QUECTEL);
		expect(target?.preferenceOrdered).toEqual(['lte', 'umts', 'gsm']);
		expect(target?.allowedSet.has('5gnr')).toBe(false);
	});

	test('a posture the modem cannot express resolves UNDEFINED, never a neighbour', () => {
		// Substituting is how "prefer 4G" on a marginal cell silently becomes 5G-first.
		for (const preference of FIVE_G_PREFERENCES) {
			expect(fiveGPreferenceToRadio(preference, SIMCOM)).toBeUndefined();
			expect(fiveGPreferenceToRadio(preference, undefined)).toBeUndefined();
		}
		expect(fiveGPreferenceToRadio('prefer-4g', rats('umts', '5gnr'))).toBeUndefined();
	});

	test('every offered posture resolves to a target — the two rules cannot disagree', () => {
		for (const catalog of [QUECTEL, rats('5gnr'), rats('lte', '5gnr')]) {
			for (const preference of offeredFiveGPreferences(catalog)) {
				expect(fiveGPreferenceToRadio(preference, catalog)).toBeDefined();
			}
		}
	});
});

describe('reading the posture back off the radio', () => {
	const cases: readonly (readonly [string, RadioModeSet, FiveGPreference | undefined])[] = [
		['5G alone', modes(rats('5gnr')), '5g-only'],
		['5G first', modes(QUECTEL, '5gnr'), 'prefer-5g'],
		['LTE first', modes(QUECTEL, 'lte'), 'prefer-4g'],
		['no 5G at all', modes(SIMCOM, 'lte'), '5g-off'],
		['no 5G, UMTS-ranked', modes(SIMCOM, 'umts'), '5g-off'],
		['5G allowed, UMTS preferred', modes(QUECTEL, 'umts'), undefined],
		['5G allowed, nothing preferred', modes(QUECTEL), undefined],
	];

	for (const [name, current, expected] of cases) {
		test(`${name} → ${expected ?? 'undefined'}`, () => {
			expect(readFiveGPreference(current)).toBe(expected);
		});
	}

	test('an unread radio is UNDEFINED and is never rounded to a posture', () => {
		expect(readFiveGPreference(undefined)).toBeUndefined();
		expect(readFiveGPreference(modes(rats()))).toBeUndefined();
	});

	test('every posture round-trips through its own target', () => {
		for (const preference of offeredFiveGPreferences(QUECTEL)) {
			const target = fiveGPreferenceToRadio(preference, QUECTEL);
			expect(
				readFiveGPreference(modes(target?.allowedSet ?? rats(), target?.preferenceOrdered[0])),
			).toBe(preference);
		}
	});
});

describe('the readback IS the confirmation', () => {
	test('a radio that landed on the request confirms', () => {
		expect(fiveGPreferenceConfirmed('prefer-4g', modes(QUECTEL, 'lte'))).toBe(true);
	});

	test('a radio that CLAMPED the request does NOT confirm', () => {
		// MM accepting the method call is not the radio taking the mode set.
		expect(fiveGPreferenceConfirmed('prefer-4g', modes(QUECTEL, '5gnr'))).toBe(false);
		expect(fiveGPreferenceConfirmed('5g-only', modes(QUECTEL, '5gnr'))).toBe(false);
	});

	test('an unreadable radio does NOT confirm', () => {
		expect(fiveGPreferenceConfirmed('prefer-5g', undefined)).toBe(false);
	});
});

describe('SA / NSA', () => {
	test('is reported unsupported with a reason, never omitted', () => {
		// A missing field reads as "nobody asked"; a stated reason tells an operator
		// hunting for an SA toggle why there is none.
		expect(nrModeSelection()).toEqual({
			supported: false,
			reason: NR_MODE_UNSUPPORTED_REASON,
		});
	});

	test('this module opens NO vendor AT surface for it', async () => {
		const source = await Bun.file(new URL('./five-g-preference.ts', import.meta.url)).text();
		const executable = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
		for (const token of ['QNWPREFCFG', 'AT+', 'callMethod', 'transport']) {
			expect(executable).not.toContain(token);
		}
	});
});
