// Pure mapping: a decoded ModemManager object tree → a `CellularSnapshot`.
//
// A3.1 is lifecycle-only. This mapper is DELIBERATELY conservative: it captures
// identity, presence, source health, radio power, and MM state — the facts the
// observer needs to order and reconcile modems — but leaves the richer 3GPP
// registration + access-technology set as `unknown`/empty. Faithful registration and
// cell-info normalisation are A3.2 (identity ladder) and A3.3 (Signal.Setup / cell
// info); mapping them here would either be a guess or trip the domain guards. The
// snapshot this produces is always guard-valid by construction.

import {
	type CellularSnapshot,
	imeiEquipmentId,
	type MmState,
	subscriptionId as makeSubscriptionId,
	type RadioPower,
	runtimePath,
	type SubscriptionId,
} from '../domain';
import { MODEM_IFACE, MODEM3GPP_IFACE, SIM_IFACE } from './constants';
import {
	type DecodedManagedObjects,
	findInterface,
	followObjectPath,
	numberProp,
	pathsWithInterface,
	stringProp,
} from './managed-objects';

/** The dimensions of a mapped modem, WITHOUT a revision (the observer stamps that). */
export type MappedModem = Omit<CellularSnapshot, 'revision'>;

/** MMModemState (`Modem.State`, signed) → the domain `MmState`. */
function mapMmState(state: number | undefined): MmState {
	switch (state) {
		case -1:
			return 'failed';
		case 1:
			return 'initializing';
		case 2:
			return 'locked';
		case 3:
			return 'disabled';
		case 4:
			return 'disabling';
		case 5:
			return 'enabling';
		case 6:
			return 'enabled';
		case 7:
			return 'searching';
		case 8:
			return 'registered';
		case 9:
			return 'disconnecting';
		case 10:
			return 'connecting';
		case 11:
			return 'connected';
		default:
			return 'unknown';
	}
}

/** MMModemPowerState (`Modem.PowerState`) → the domain `RadioPower`. */
function mapRadioPower(power: number | undefined): RadioPower {
	switch (power) {
		case 1:
			return 'off';
		case 2:
			return 'low';
		case 3:
			return 'on';
		default:
			return 'unknown';
	}
}

/** Locked / failed modems keep the radio off; every other state we cannot see as
 *  off (the guards forbid an active MM state with the radio off), so an unknown
 *  power reading is treated as `on` when the modem is clearly on the air. */
function reconcilePower(power: RadioPower, state: MmState): RadioPower {
	const onTheAir =
		state === 'enabled' ||
		state === 'searching' ||
		state === 'registered' ||
		state === 'connecting' ||
		state === 'connected' ||
		state === 'disconnecting';
	if (onTheAir && (power === 'unknown' || power === 'off')) {
		return 'on';
	}
	return power;
}

/** Read a modem's subscription id (ICCID) from its active SIM object, if any. */
function readSubscriptionId(
	tree: DecodedManagedObjects,
	modemPath: string,
): SubscriptionId | undefined {
	const modem = findInterface(tree, modemPath, MODEM_IFACE);
	const sim = followObjectPath(tree, modem, 'Sim', SIM_IFACE);
	const iccid = stringProp(sim, 'SimIdentifier');
	return iccid !== undefined && iccid.length > 0 ? makeSubscriptionId(iccid) : undefined;
}

/** Map ONE modem object to its dimensions. The modem must expose `Modem`. */
export function mapModem(tree: DecodedManagedObjects, modemPath: string): MappedModem {
	const modem = findInterface(tree, modemPath, MODEM_IFACE);
	const modem3gpp = findInterface(tree, modemPath, MODEM3GPP_IFACE);

	const equipment = stringProp(modem, 'EquipmentIdentifier') ?? stringProp(modem3gpp, 'Imei') ?? '';
	const mmState = mapMmState(numberProp(modem, 'State'));
	const radioPower = reconcilePower(mapRadioPower(numberProp(modem, 'PowerState')), mmState);
	const sub = readSubscriptionId(tree, modemPath);

	return {
		identity: {
			equipmentId: imeiEquipmentId(equipment),
			runtimePath: runtimePath(modemPath),
			...(sub !== undefined ? { subscriptionId: sub } : {}),
		},
		presence: 'present',
		sourceHealth: 'live',
		simSlots: [],
		radioPower,
		mmState,
		// Conservative: 3GPP registration + RAT set are A3.3's job (see file header).
		registration: { status: 'unknown', activeRats: new Set() },
		nmActivation: 'unavailable',
		dataInterface: { present: false },
		reconcileStatus: 'pending',
		recoveryState: { stage: 'idle', attempts: 0 },
	};
}

/** Every modem path in the tree (objects exposing the `Modem` interface), in order. */
export function modemPaths(tree: DecodedManagedObjects): string[] {
	return pathsWithInterface(tree, MODEM_IFACE);
}

/** A stable fingerprint of a mapped modem's meaningful dimensions (ignores revision
 *  and source health), used to suppress redundant revision bumps on identical reads. */
export function fingerprint(mapped: MappedModem): string {
	return JSON.stringify({
		id: mapped.identity.equipmentId,
		sub: mapped.identity.subscriptionId ?? null,
		path: mapped.identity.runtimePath,
		presence: mapped.presence,
		radioPower: mapped.radioPower,
		mmState: mapped.mmState,
		registration: {
			status: mapped.registration.status,
			rats: [...mapped.registration.activeRats].sort(),
		},
		nmActivation: mapped.nmActivation,
		dataInterface: mapped.dataInterface,
		reconcileStatus: mapped.reconcileStatus,
	});
}
