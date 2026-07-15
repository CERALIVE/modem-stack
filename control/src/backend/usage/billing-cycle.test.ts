// UTC billing-cycle math — month-length clamping (cycleDay 31 → Feb 28/29) and the
// before/after-boundary cycle-start selection.

import { describe, expect, test } from 'bun:test';
import { type EpochMillis, epochMillis } from '../../domain';
import { clampCycleDay, cycleStart, daysInMonth } from './billing-cycle';

const utc = (y: number, m: number, d: number, h = 0): EpochMillis =>
	epochMillis(Date.UTC(y, m, d, h));

describe('daysInMonth', () => {
	test('February is 28 days in a common year, 29 in a leap year', () => {
		expect(daysInMonth(2023, 1)).toBe(28);
		expect(daysInMonth(2024, 1)).toBe(29); // 2024 is a leap year
		expect(daysInMonth(2100, 1)).toBe(28); // century non-leap
		expect(daysInMonth(2000, 1)).toBe(29); // 400-divisible leap
	});

	test('30- and 31-day months', () => {
		expect(daysInMonth(2024, 3)).toBe(30); // April
		expect(daysInMonth(2024, 0)).toBe(31); // January
	});
});

describe('clampCycleDay', () => {
	test('cycleDay 31 clamps to the last day of a short month', () => {
		expect(clampCycleDay(31, 2023, 1)).toBe(28); // Feb non-leap
		expect(clampCycleDay(31, 2024, 1)).toBe(29); // Feb leap
		expect(clampCycleDay(31, 2024, 3)).toBe(30); // April
		expect(clampCycleDay(31, 2024, 0)).toBe(31); // January — no clamp
	});

	test('a valid in-range day is unchanged; a floor of 1 is enforced', () => {
		expect(clampCycleDay(15, 2024, 5)).toBe(15);
		expect(clampCycleDay(0, 2024, 5)).toBe(1);
	});
});

describe('cycleStart — month-length clamp with before/after selection', () => {
	test('cycleDay 31 in February resolves to the clamped Feb boundary', () => {
		// 2023-02-15 with cycleDay 31 → cycle started 2023-01-31 (Feb boundary Feb 28
		// is still ahead of the 15th).
		expect(cycleStart(epochMillis(utc(2023, 1, 15)), 31)).toBe(utc(2023, 0, 31));
		// 2023-03-01 with cycleDay 31 → the active cycle began at clamped Feb 28.
		expect(cycleStart(epochMillis(utc(2023, 2, 1)), 31)).toBe(utc(2023, 1, 28));
		// Leap year: 2024-03-01 → Feb 29.
		expect(cycleStart(epochMillis(utc(2024, 2, 1)), 31)).toBe(utc(2024, 1, 29));
	});

	test('now exactly on the boundary starts a new cycle', () => {
		expect(cycleStart(epochMillis(utc(2024, 5, 10)), 10)).toBe(utc(2024, 5, 10));
	});

	test('now before this month boundary rolls back to the previous month', () => {
		// cycleDay 20, now is the 5th → cycle began on the 20th of the prior month.
		expect(cycleStart(epochMillis(utc(2024, 6, 5)), 20)).toBe(utc(2024, 5, 20));
	});

	test('January rollback wraps to December of the prior year', () => {
		expect(cycleStart(epochMillis(utc(2024, 0, 5)), 20)).toBe(utc(2023, 11, 20));
	});
});
