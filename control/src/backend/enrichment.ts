// Read-only status enrichment — firmware revision, eSIM facts, signal cadence,
// and normalized cell info, assembled for one modem's status surface.
//
// These are additive, read-only details layered on top of the lifecycle snapshot
// (A3.1) — they never gate anything and never fail a backend start. `Modem.Revision`
// and the eSIM `SimType` / `EsimStatus` (MM 1.20+) are read straight from the decoded
// `GetManagedObjects` tree; `signalCadence` comes from the Signal.Setup manager; cell
// info is normalized from a `GetCellInfo` reply by `./cell-info`.

import type { CellReading } from './cell-info';
import { selectServingCell } from './cell-info';
import { MODEM_IFACE, SIM_IFACE } from './constants';
import type { DecodedManagedObjects } from './managed-objects';
import { findInterface, followObjectPath, numberProp, stringProp } from './managed-objects';
import type { SignalCadence } from './signal-setup';

/** eSIM provisioning type — `Sim.SimType` (MMSimType), 1.20+. */
export type SimType = 'physical' | 'esim' | 'unknown';

/** eSIM profile status — `Sim.EsimStatus` (MMSimEsimStatus), 1.20+. */
export type EsimStatus = 'no-profiles' | 'with-profiles' | 'unknown';

/** The eSIM facts of a modem's active SIM. */
export interface EsimInfo {
	readonly simType: SimType;
	readonly esimStatus: EsimStatus;
}

/** The full read-only enrichment surfaced beside a modem's lifecycle snapshot. */
export interface ModemEnrichment {
	/** `Modem.Revision` — firmware/hardware revision string, when present. */
	readonly revision?: string;
	readonly esim: EsimInfo;
	readonly signalCadence: SignalCadence;
	readonly cellInfo: readonly CellReading[];
	/** The selected serving cell (total-order winner), when any cell is present. */
	readonly servingCell?: CellReading;
}

/** MMSimType (`Sim.SimType`) → the domain `SimType`. */
function mapSimType(value: number | undefined): SimType {
	switch (value) {
		case 1:
			return 'physical';
		case 2:
			return 'esim';
		default:
			return 'unknown';
	}
}

/** MMSimEsimStatus (`Sim.EsimStatus`) → the domain `EsimStatus`. */
function mapEsimStatus(value: number | undefined): EsimStatus {
	switch (value) {
		case 1:
			return 'no-profiles';
		case 2:
			return 'with-profiles';
		default:
			return 'unknown';
	}
}

/** Read `Modem.Revision`, when present. */
export function readRevision(tree: DecodedManagedObjects, modemPath: string): string | undefined {
	const revision = stringProp(findInterface(tree, modemPath, MODEM_IFACE), 'Revision');
	return revision !== undefined && revision.length > 0 ? revision : undefined;
}

/** Read the eSIM `SimType` / `EsimStatus` off the modem's active SIM object. */
export function readEsimInfo(tree: DecodedManagedObjects, modemPath: string): EsimInfo {
	const modem = findInterface(tree, modemPath, MODEM_IFACE);
	const sim = followObjectPath(tree, modem, 'Sim', SIM_IFACE);
	return {
		simType: mapSimType(numberProp(sim, 'SimType')),
		esimStatus: mapEsimStatus(numberProp(sim, 'EsimStatus')),
	};
}

/** Assemble the full enrichment for one modem from its tree, cadence, and cell info. */
export function buildEnrichment(
	tree: DecodedManagedObjects,
	modemPath: string,
	signalCadence: SignalCadence,
	cellInfo: readonly CellReading[],
): ModemEnrichment {
	const revision = readRevision(tree, modemPath);
	const serving = selectServingCell(cellInfo);
	return {
		...(revision !== undefined ? { revision } : {}),
		esim: readEsimInfo(tree, modemPath),
		signalCadence,
		cellInfo,
		...(serving !== undefined ? { servingCell: serving } : {}),
	};
}
