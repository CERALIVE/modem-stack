// Cell-info normalization — pure fixtures, no bus.
//
// Locks the review-corrected mappings (draft round 10/11): the real NR key is `sinr`
// (a `snr`-carrying dict is IGNORED), `physical-ci` → `pci`, `rsrp`/`rsrq` pass
// through, `band` only when directly supplied, provenance is always carried, and the
// serving-cell TOTAL order is permutation-invariant.

import { describe, expect, test } from 'bun:test';
import { epochMillis } from '../domain';
import type { DbusVariant } from '../transport';
import { type CellReading, normalizeCellReading, selectServingCell } from './cell-info';
import type { DecodedProps } from './managed-objects';

type Scalar = number | string | boolean;

function v(value: Scalar): DbusVariant {
	const signature = typeof value === 'number' ? 'i' : typeof value === 'boolean' ? 'b' : 's';
	return { signature, value };
}

function cell(record: Record<string, Scalar>): DecodedProps {
	return Object.entries(record).map(([key, value]) => [key, v(value)] as const);
}

const PROVENANCE = {
	source: '/org/freedesktop/ModemManager1/Modem/0',
	observedAt: epochMillis(1000),
};

const read = (record: Record<string, Scalar>): CellReading =>
	normalizeCellReading(cell(record), PROVENANCE);

/** Every fixed permutation of a small array — exhaustive, deterministic shuffle. */
function permutations<T>(items: readonly T[]): T[][] {
	if (items.length <= 1) {
		return [[...items]];
	}
	const result: T[][] = [];
	items.forEach((item, index) => {
		const rest = [...items.slice(0, index), ...items.slice(index + 1)];
		for (const tail of permutations(rest)) {
			result.push([item, ...tail]);
		}
	});
	return result;
}

describe('normalizeCellReading — pinned key mappings', () => {
	test('the real NR key is `sinr`', () => {
		expect(read({ sinr: 12 }).sinr).toBe(12);
	});

	test('a `snr`-carrying dict is IGNORED — sinr stays undefined', () => {
		const reading = read({ snr: 9, rsrp: -95 });
		expect(reading.sinr).toBeUndefined();
		expect(reading.rsrp).toBe(-95);
	});

	test('`sinr` wins even when `snr` is also present (wrong key never leaks in)', () => {
		expect(read({ snr: 9, sinr: 12 }).sinr).toBe(12);
	});

	test('`physical-ci` maps to `pci`; rsrp/rsrq pass through', () => {
		const reading = read({ 'physical-ci': 42, rsrp: -95, rsrq: -10 });
		expect(reading.pci).toBe(42);
		expect(reading.rsrp).toBe(-95);
		expect(reading.rsrq).toBe(-10);
	});

	test('`band` is surfaced ONLY when directly supplied', () => {
		expect(read({ rsrp: -90 }).band).toBeUndefined();
		expect(read({ rsrp: -90, band: 'n78' }).band).toBe('n78');
	});

	test('every reading carries `source` + `observedAt` provenance', () => {
		const reading = read({ 'cell-id': 'A', rsrp: -80 });
		expect(reading.source).toBe(PROVENANCE.source);
		expect(reading.observedAt).toBe(PROVENANCE.observedAt);
	});

	test('serving flag reads a `serving` bool OR a serving `cell-type`', () => {
		expect(read({ serving: true }).serving).toBe(true);
		expect(read({ 'cell-type': 'lte-serving' }).serving).toBe(true);
		expect(read({ 'cell-type': 'lte-neighbor' }).serving).toBe(false);
	});
});

describe('selectServingCell — TOTAL order', () => {
	test('a serving-marked cell wins even with a LOWER rsrp', () => {
		const marked = read({ 'cell-id': 'A', serving: true, rsrp: -110 });
		const strong = read({ 'cell-id': 'B', rsrp: -70 });
		expect(selectServingCell([strong, marked])?.cellId).toBe('A');
	});

	test('with no serving mark, the HIGHEST rsrp wins', () => {
		const cells = [
			read({ 'cell-id': 'A', rsrp: -95 }),
			read({ 'cell-id': 'B', rsrp: -70 }),
			read({ 'cell-id': 'C', rsrp: -110 }),
		];
		expect(selectServingCell(cells)?.cellId).toBe('B');
	});

	test('cells lacking rsrp sort LAST', () => {
		const withRsrp = read({ 'cell-id': 'A', rsrp: -120 });
		const noRsrp = read({ 'cell-id': 'B' });
		expect(selectServingCell([noRsrp, withRsrp])?.cellId).toBe('A');
	});

	test('an rsrp tie breaks lexicographically by cell-id', () => {
		const cells = [
			read({ 'cell-id': 'zeta', rsrp: -80 }),
			read({ 'cell-id': 'alpha', rsrp: -80 }),
			read({ 'cell-id': 'mike', rsrp: -80 }),
		];
		expect(selectServingCell(cells)?.cellId).toBe('alpha');
	});

	test('empty input has no serving cell', () => {
		expect(selectServingCell([])).toBeUndefined();
	});
});

describe('selectServingCell — permutation invariance (MANDATORY)', () => {
	test('every permutation of a mixed cell set picks the SAME serving cell', () => {
		const cells = [
			read({ 'cell-id': 'A', rsrp: -95, 'physical-ci': 1 }),
			read({ 'cell-id': 'B', serving: true, rsrp: -108, 'physical-ci': 2 }),
			read({ 'cell-id': 'C', rsrp: -70, 'physical-ci': 3 }),
			read({ 'cell-id': 'D', 'physical-ci': 4 }),
			read({ 'cell-id': 'E', rsrp: -88, 'physical-ci': 5 }),
		];
		const perms = permutations(cells);
		expect(perms.length).toBe(120);
		// The serving-marked cell B wins regardless of order.
		for (const perm of perms) {
			expect(selectServingCell(perm)?.cellId).toBe('B');
		}
	});

	test('without a serving mark, the highest-rsrp winner is permutation-invariant', () => {
		const cells = [
			read({ 'cell-id': 'A', rsrp: -95 }),
			read({ 'cell-id': 'B', rsrp: -70 }),
			read({ 'cell-id': 'C', rsrp: -110 }),
			read({ 'cell-id': 'D', rsrp: -70 }),
			read({ 'cell-id': 'E' }),
		];
		// Tie at -70 between B and D → lexicographic → B.
		for (const perm of permutations(cells)) {
			expect(selectServingCell(perm)?.cellId).toBe('B');
		}
	});
});
