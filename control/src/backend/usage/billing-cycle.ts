// UTC billing-cycle computation with month-length clamping.
//
// A usage cycle resets on a configured day of the month (`cycleDay`, 1–31) in UTC.
// Months are not all the same length, so a `cycleDay` past the end of a short month
// must clamp to that month's LAST day rather than rolling into the next month or
// throwing: `cycleDay: 31` resolves to Feb 28 (or Feb 29 in a leap year), Apr 30,
// etc. All arithmetic is UTC — the device clock's local zone never shifts a cycle.

import type { EpochMillis } from '../../domain';

/** Days in a given UTC month. `month` is 0-based (0 = January). Handles leap Feb. */
export function daysInMonth(year: number, month: number): number {
	// Day 0 of the next month is the last day of this month; UTC avoids DST drift.
	return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Clamp a requested cycle day to the last valid day of the given month. */
export function clampCycleDay(cycleDay: number, year: number, month: number): number {
	const floor = Math.max(1, Math.trunc(cycleDay));
	return Math.min(floor, daysInMonth(year, month));
}

/** The UTC epoch-ms of the cycle boundary in a specific month (clamped). */
function boundaryFor(cycleDay: number, year: number, month: number): number {
	return Date.UTC(year, month, clampCycleDay(cycleDay, year, month));
}

/**
 * The UTC start (`EpochMillis`) of the cycle that `now` falls in for a given
 * `cycleDay`. If `now` is before this month's (clamped) boundary the active cycle
 * began on the previous month's boundary; otherwise it began on this month's.
 */
export function cycleStart(now: EpochMillis, cycleDay: number): EpochMillis {
	const at = new Date(now);
	const year = at.getUTCFullYear();
	const month = at.getUTCMonth();
	const thisBoundary = boundaryFor(cycleDay, year, month);
	if (now >= thisBoundary) {
		return thisBoundary as EpochMillis;
	}
	// Roll back one month (December wraps to the prior year), re-clamping there.
	const prevMonth = month === 0 ? 11 : month - 1;
	const prevYear = month === 0 ? year - 1 : year;
	return boundaryFor(cycleDay, prevYear, prevMonth) as EpochMillis;
}
