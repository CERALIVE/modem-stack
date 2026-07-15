// The identity ladder — resolving a STABLE slot handle for a live modem.
//
// A modem's D-Bus object path (`/org/freedesktop/ModemManager1/Modem/3`) is a
// per-boot, per-plug value: it changes on replug and daemon restart, so it can
// never be the durable key. The ladder derives a stable key by trying, in order:
//
//   1. slot-UID in `Modem.Device` — when OUR udev rules label the slot they set
//      `Device` to a `slot-*` UID (e.g. `slot-usb2-1`). That is stable and ours,
//      distinguishable from MM's own path-shaped default (`/sys/devices/...`).
//   2. `Modem.Physdev` (1.22+) — the physical USB topology path. Stable across
//      replug into the same port; used when no slot-UID is present.
//   3. a ports-derived sysfs walk — a deterministic key from the modem's port
//      list when neither of the above is available (MM 1.20, no udev rule yet).
//   4. equipment-id fallback — LOW confidence. Per A2.1's ambiguity rules a
//      low-confidence identity must never bind durable policy, so this rung sets
//      `confidence: 'low'` and `canBindPolicy` refuses on an ambiguous equipment id.
//
// Phase A note: no image-pipeline udev rules ship yet, so on the bench `Device`
// is usually MM's path-shaped default and the ladder lands on Physdev / sysfs.
// The `slot-*` heuristic is documented here so a bench operator can label a slot
// by hand and see rung 1 fire.

import {
	demoteToLowConfidence,
	type EquipmentId,
	type IdentityConfidence,
	imeiEquipmentId,
	type LogicalSlotId,
	logicalSlotId,
	type ModemIdentity,
	runtimePath,
} from '../domain';
import { MODEM_IFACE, MODEM3GPP_IFACE } from './constants';
import {
	type DecodedManagedObjects,
	findInterface,
	propValue,
	stringProp,
} from './managed-objects';

/** Which rung of the ladder produced the stable key. */
export type SlotSource = 'device-slot-uid' | 'physdev' | 'sysfs-walk' | 'equipment-fallback';

/** The prefix OUR udev rules use to label a slot in `Modem.Device`. */
export const SLOT_UID_PREFIX = 'slot-';

/** The raw facts the ladder resolves from — one modem's observed identity inputs. */
export interface ModemIdentityFacts {
	/** The live MM object path (becomes `runtimePath`; never a durable key). */
	readonly runtimePath: string;
	/** `Modem.Device` — a `slot-*` UID (ours) or MM's path-shaped default. */
	readonly device?: string;
	/** `Modem.Physdev` — physical topology path (1.22+; absent on 1.20). */
	readonly physdev?: string;
	/** The modem's port device names (e.g. `ttyUSB0`, `wwan0`) for the sysfs walk. */
	readonly ports?: readonly string[];
	/** IMEI/serial equipment id with its own confidence (A2.1). */
	readonly equipmentId: EquipmentId;
}

/** The ladder's output: a resolved identity plus how (and how firmly) we got it. */
export interface ResolvedIdentity {
	/** The four-part identity; `logicalSlotId` is set for rungs 1-3 only. */
	readonly identity: ModemIdentity;
	/** Which rung produced the result. */
	readonly slotSource: SlotSource;
	/** Confidence in the SLOT resolution (rung 4 is always `low`). */
	readonly confidence: IdentityConfidence;
	/** The durable row key — stable across replug for rungs 1-3 (and unique-IMEI rung 4). */
	readonly stableKey: string;
}

/**
 * Whether a `Modem.Device` value is one of OUR slot UIDs (shaped `slot-*`) rather
 * than MM's path-shaped default. This is the documented Phase-A heuristic that
 * keeps a hand-labelled slot preferred over a `/sys/devices/...` path.
 */
export function looksLikeSlotUid(device: string | undefined): boolean {
	if (device === undefined) {
		return false;
	}
	return device.startsWith(SLOT_UID_PREFIX) && device.length > SLOT_UID_PREFIX.length;
}

/** Derive a deterministic key from a modem's port list (sorted, stable across replug). */
function sysfsWalkKey(ports: readonly string[]): string | undefined {
	const named = ports.map((p) => p.trim()).filter((p) => p.length > 0);
	if (named.length === 0) {
		return undefined;
	}
	return [...named].sort().join('+');
}

function buildIdentity(facts: ModemIdentityFacts, slot: LogicalSlotId | undefined): ModemIdentity {
	return {
		equipmentId: facts.equipmentId,
		runtimePath: runtimePath(facts.runtimePath),
		...(slot !== undefined ? { logicalSlotId: slot } : {}),
	};
}

/**
 * Resolve ONE modem's stable identity by walking the ladder. Pure — no I/O.
 *
 * Rungs 1-3 yield a `logicalSlotId` and a stable key that survives replug into the
 * same slot. Rung 4 (equipment fallback) yields NO slot and `confidence: 'low'`,
 * so a durable policy bound via `policyBindingKey` is refused for an ambiguous
 * (duplicate/zero) equipment id.
 */
export function resolveModemIdentity(facts: ModemIdentityFacts): ResolvedIdentity {
	// Rung 1 — our slot-UID in `Device`.
	if (looksLikeSlotUid(facts.device)) {
		const device = facts.device as string;
		const slot = logicalSlotId(device);
		return {
			identity: buildIdentity(facts, slot),
			slotSource: 'device-slot-uid',
			confidence: 'high',
			stableKey: `slot:${device}`,
		};
	}

	// Rung 2 — `Physdev` physical topology path (1.22+).
	const physdev = facts.physdev?.trim();
	if (physdev !== undefined && physdev.length > 0) {
		const slot = logicalSlotId(`physdev:${physdev}`);
		return {
			identity: buildIdentity(facts, slot),
			slotSource: 'physdev',
			confidence: 'high',
			stableKey: `physdev:${physdev}`,
		};
	}

	// Rung 3 — ports-derived sysfs walk.
	const walk = facts.ports !== undefined ? sysfsWalkKey(facts.ports) : undefined;
	if (walk !== undefined) {
		const slot = logicalSlotId(`sysfs:${walk}`);
		return {
			identity: buildIdentity(facts, slot),
			slotSource: 'sysfs-walk',
			confidence: 'medium',
			stableKey: `sysfs:${walk}`,
		};
	}

	// Rung 4 — equipment fallback, LOW confidence, no durable slot.
	const equip = facts.equipmentId;
	const stableKey =
		equip.provenance !== 'none' && equip.value.trim().length > 0
			? `equip:${equip.value}`
			: `path:${facts.runtimePath}`;
	return {
		identity: buildIdentity(facts, undefined),
		slotSource: 'equipment-fallback',
		confidence: 'low',
		stableKey,
	};
}

/**
 * Resolve a batch of modems, demoting any equipment id that appears on more than
 * one modem to LOW confidence FIRST (cross-modem duplicate detection A2.1 cannot do
 * from a single value). A duplicate IMEI thus reaches rung 4 with a low-confidence
 * equipment id, and `canBindPolicy` refuses durable binding on it.
 */
export function resolveModemIdentities(
	factsList: readonly ModemIdentityFacts[],
): ResolvedIdentity[] {
	const counts = new Map<string, number>();
	for (const facts of factsList) {
		const { equipmentId } = facts;
		if (equipmentId.provenance !== 'none' && equipmentId.value.trim().length > 0) {
			counts.set(equipmentId.value, (counts.get(equipmentId.value) ?? 0) + 1);
		}
	}
	return factsList.map((facts) => {
		const { equipmentId } = facts;
		const duplicated =
			equipmentId.provenance !== 'none' && (counts.get(equipmentId.value) ?? 0) > 1;
		const resolvedFacts: ModemIdentityFacts = duplicated
			? { ...facts, equipmentId: demoteToLowConfidence(equipmentId) }
			: facts;
		return resolveModemIdentity(resolvedFacts);
	});
}

/** MM `Modem.Ports` is `a(su)`: entries of `[portName, portType]`. */
function portNames(value: ReturnType<typeof propValue>): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const names = value
		.map((entry) => (Array.isArray(entry) ? entry[0] : undefined))
		.filter((name): name is string => typeof name === 'string');
	return names.length > 0 ? names : undefined;
}

/**
 * Extract one modem's `ModemIdentityFacts` from a decoded `GetManagedObjects` tree —
 * the bridge real backends use to feed the ladder from an observed snapshot.
 */
export function modemIdentityFactsFromTree(
	tree: DecodedManagedObjects,
	modemPath: string,
): ModemIdentityFacts {
	const modem = findInterface(tree, modemPath, MODEM_IFACE);
	const modem3gpp = findInterface(tree, modemPath, MODEM3GPP_IFACE);
	const equipment = stringProp(modem, 'EquipmentIdentifier') ?? stringProp(modem3gpp, 'Imei') ?? '';
	const device = stringProp(modem, 'Device');
	const physdev = stringProp(modem, 'Physdev');
	const ports = portNames(propValue(modem, 'Ports'));

	return {
		runtimePath: modemPath,
		equipmentId: imeiEquipmentId(equipment),
		...(device !== undefined ? { device } : {}),
		...(physdev !== undefined ? { physdev } : {}),
		...(ports !== undefined ? { ports } : {}),
	};
}
