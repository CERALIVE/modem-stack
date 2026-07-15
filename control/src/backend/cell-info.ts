// Cell-info normalization — a decoded ModemManager cell dict → a stable reading.
//
// `Modem.GetCellInfo` returns `aa{sv}`: one `a{sv}` dict per visible cell. The keys
// vary by RAT and MM version, so this module pins EXACTLY the mappings the rest of
// the stack depends on and ignores everything else:
//
//   - `physical-ci` → `pci`      (the real MM key; never guessed from anything else)
//   - `rsrp`, `rsrq`             pass through as numbers
//   - `sinr`                     the REAL NR SINR key. A dict carrying `snr` (the
//                                WRONG name) is IGNORED — `sinr` stays undefined.
//   - `cell-id`                  the cell identifier (serving-cell tiebreak)
//   - `band`                     surfaced ONLY when the source supplies it directly;
//                                never inferred from earfcn / frequency / anything.
//   - `serving` / `cell-type`    whether this is the serving cell.
//
// Every reading also carries `source` + `observedAt` provenance, so a consumer can
// tell a fresh reading from a cached one and know where it came from. Pure — no I/O.

import type { EpochMillis } from '../domain';
import type { DecodedProps } from './managed-objects';
import { numberProp, stringProp } from './managed-objects';

/** Where a batch of cell readings came from, and when it was observed. */
export interface CellInfoProvenance {
	/** A human/source tag, e.g. the modem path or `'Modem.GetCellInfo'`. */
	readonly source: string;
	readonly observedAt: EpochMillis;
}

/** One normalized cell reading — only the pinned fields, plus provenance. */
export interface CellReading {
	/** `true` when this dict is marked as the serving cell. */
	readonly serving: boolean;
	/** The cell identifier, when supplied (serving-cell tiebreak key). */
	readonly cellId?: string;
	/** Physical cell id — from the `physical-ci` key ONLY. */
	readonly pci?: number;
	readonly rsrp?: number;
	readonly rsrq?: number;
	/** NR SINR — from the `sinr` key ONLY (a `snr`-keyed dict is ignored). */
	readonly sinr?: number;
	/** Radio band — present ONLY when the source supplied it directly. */
	readonly band?: string;
	readonly source: string;
	readonly observedAt: EpochMillis;
}

/** Read a `serving` flag: an explicit `serving` bool, else a `cell-type` naming it. */
function readServing(cell: DecodedProps): boolean {
	const flag = cell.find(([key]) => key === 'serving')?.[1]?.value;
	if (typeof flag === 'boolean') {
		return flag;
	}
	const cellType = stringProp(cell, 'cell-type');
	return cellType?.toLowerCase().includes('serving') ?? false;
}

/** Normalize ONE cell's `a{sv}` dict into a `CellReading`, pinning the known keys. */
export function normalizeCellReading(
	cell: DecodedProps,
	provenance: CellInfoProvenance,
): CellReading {
	const cellId = stringProp(cell, 'cell-id');
	const pci = numberProp(cell, 'physical-ci');
	const rsrp = numberProp(cell, 'rsrp');
	const rsrq = numberProp(cell, 'rsrq');
	// `sinr` ONLY — a dict carrying `snr` must never populate this field.
	const sinr = numberProp(cell, 'sinr');
	// `band` ONLY when directly supplied; never inferred.
	const band = stringProp(cell, 'band');
	return {
		serving: readServing(cell),
		...(cellId !== undefined ? { cellId } : {}),
		...(pci !== undefined ? { pci } : {}),
		...(rsrp !== undefined ? { rsrp } : {}),
		...(rsrq !== undefined ? { rsrq } : {}),
		...(sinr !== undefined ? { sinr } : {}),
		...(band !== undefined ? { band } : {}),
		source: provenance.source,
		observedAt: provenance.observedAt,
	};
}

/** Normalize a whole `GetCellInfo` reply (`aa{sv}` → cell dicts) into readings. */
export function normalizeCellInfo(
	cells: readonly DecodedProps[],
	provenance: CellInfoProvenance,
): readonly CellReading[] {
	return cells.map((cell) => normalizeCellReading(cell, provenance));
}

/**
 * Serving-cell TOTAL order — a strict, permutation-invariant ranking of readings.
 * Returns < 0 when `a` outranks `b` (should sort first / is the better serving cell):
 *
 *   1. a `serving`-marked cell outranks a non-serving one;
 *   2. then the HIGHER `rsrp` outranks the lower — a cell with NO `rsrp` sorts LAST;
 *   3. ties break lexicographically by `cell-id` (a cell with none sorts last);
 *   4. final deterministic tiebreaks (`pci`, then a stable serialization) guarantee
 *      the order is total even for otherwise-identical distinct cells, so the winner
 *      never depends on input order.
 */
export function compareServing(a: CellReading, b: CellReading): number {
	if (a.serving !== b.serving) {
		return a.serving ? -1 : 1;
	}
	const rsrpRank = compareOptionalDesc(a.rsrp, b.rsrp);
	if (rsrpRank !== 0) {
		return rsrpRank;
	}
	const cellRank = compareOptionalAsc(a.cellId, b.cellId);
	if (cellRank !== 0) {
		return cellRank;
	}
	const pciRank = compareOptionalAsc(a.pci, b.pci);
	if (pciRank !== 0) {
		return pciRank;
	}
	return stableTag(a) < stableTag(b) ? -1 : stableTag(a) > stableTag(b) ? 1 : 0;
}

/** Higher value first; `undefined` last. */
function compareOptionalDesc(a: number | undefined, b: number | undefined): number {
	if (a === b) return 0;
	if (a === undefined) return 1;
	if (b === undefined) return -1;
	return b - a;
}

/** Lower value first; `undefined` last. Works for numbers and strings. */
function compareOptionalAsc<T extends number | string>(a: T | undefined, b: T | undefined): number {
	if (a === b) return 0;
	if (a === undefined) return 1;
	if (b === undefined) return -1;
	return a < b ? -1 : 1;
}

/** A stable, order-independent fingerprint used only as the final total-order tiebreak. */
function stableTag(reading: CellReading): string {
	return JSON.stringify([
		reading.serving,
		reading.cellId ?? null,
		reading.pci ?? null,
		reading.rsrp ?? null,
		reading.rsrq ?? null,
		reading.sinr ?? null,
		reading.band ?? null,
	]);
}

/**
 * Select the serving cell under the total order above. Permutation-invariant: the
 * same set of readings always yields the same winner regardless of their order.
 */
export function selectServingCell(cells: readonly CellReading[]): CellReading | undefined {
	if (cells.length === 0) {
		return undefined;
	}
	return cells.reduce((best, cell) => (compareServing(cell, best) < 0 ? cell : best));
}
