// The identity registry — ONE logical row per physical slot, across replugs.
//
// The epoch observer (A3.1) keys rows by the MM object path, which CHANGES on
// replug and daemon restart. This registry sits above it and keys rows by the
// STABLE identifier the ladder resolves (slot-UID / Physdev / sysfs / unique
// equipment id), so a modem that disconnects and reconnects to the SAME slot
// resolves to the SAME logical row instead of a duplicate.
//
// It also names the transitions the ladder can observe:
//
//   - `attached`                  — a stable key we have not seen before.
//   - `replugged`                 — same stable key, same equipment: one row, new path.
//   - `equipment-swapped-in-slot` — same slot, DIFFERENT equipment. The slot keeps
//                                   its policy (slot-inherits-policy): unplug modem A,
//                                   plug modem B into the same slot, B adopts A's
//                                   slot-bound policy.
//   - `equipment-moved`           — same equipment, DIFFERENT slot: the modem was
//                                   physically moved to another port.

import type { EquipmentId, LogicalSlotId, RuntimePath } from '../domain';
import type { ResolvedIdentity } from './identity-ladder';

/** One durable logical row, keyed by the ladder's stable identifier. */
export interface IdentityRow {
	/** The stable durable key (`slot:…` / `physdev:…` / `sysfs:…` / `equip:…`). */
	readonly stableKey: string;
	/** The resolved slot, when the row was slot-resolved (rungs 1-3). */
	readonly logicalSlotId?: LogicalSlotId;
	/** The equipment currently occupying this slot. */
	readonly equipmentId: EquipmentId;
	/** The live MM path — updated on every replug (never a durable key). */
	readonly runtimePath: RuntimePath;
}

/** A transition the registry detected while applying a resolved identity. */
export type IdentityTransition =
	| { readonly kind: 'attached'; readonly row: IdentityRow }
	| { readonly kind: 'replugged'; readonly row: IdentityRow; readonly previousPath: RuntimePath }
	| {
			readonly kind: 'equipment-swapped-in-slot';
			readonly row: IdentityRow;
			readonly previousEquipment: EquipmentId;
	  }
	| {
			readonly kind: 'equipment-moved';
			readonly row: IdentityRow;
			readonly previousKey: string;
			readonly previousSlot?: LogicalSlotId;
	  };

const equipmentValue = (equipment: EquipmentId): string | undefined =>
	equipment.provenance !== 'none' && equipment.value.trim().length > 0
		? equipment.value
		: undefined;

/**
 * Tracks logical modem rows across replug/swap/move. Stateful by design — it holds
 * the last-known row per stable key. `apply()` folds one resolved identity in and
 * reports the transition it produced.
 */
export class IdentityRegistry {
	readonly #rows = new Map<string, IdentityRow>();

	/** A snapshot of the current logical rows, in insertion order. */
	get rows(): IdentityRow[] {
		return [...this.#rows.values()];
	}

	/** The row for a stable key, or `undefined`. */
	get(stableKey: string): IdentityRow | undefined {
		return this.#rows.get(stableKey);
	}

	/** Drop a row (e.g. after a current-epoch removal). */
	remove(stableKey: string): void {
		this.#rows.delete(stableKey);
	}

	/**
	 * Fold one resolved identity into the registry and report the transition.
	 * Keeps ONE row per stable key: a replug into the same slot updates the live
	 * path in place rather than adding a duplicate.
	 */
	apply(resolved: ResolvedIdentity): IdentityTransition {
		const row = this.#rowFrom(resolved);
		const existing = this.#rows.get(row.stableKey);

		if (existing !== undefined) {
			return this.#applyToExisting(existing, resolved, row);
		}

		// A unique equipment id at a NEW stable key that already lives elsewhere
		// means the modem physically moved to a different slot/port.
		const moved = this.#findByEquipment(row.equipmentId, row.stableKey);
		if (moved !== undefined) {
			this.#rows.delete(moved.stableKey);
			this.#rows.set(row.stableKey, row);
			return {
				kind: 'equipment-moved',
				row,
				previousKey: moved.stableKey,
				...(moved.logicalSlotId !== undefined ? { previousSlot: moved.logicalSlotId } : {}),
			};
		}

		this.#rows.set(row.stableKey, row);
		return { kind: 'attached', row };
	}

	#applyToExisting(
		existing: IdentityRow,
		resolved: ResolvedIdentity,
		row: IdentityRow,
	): IdentityTransition {
		const before = equipmentValue(existing.equipmentId);
		const after = equipmentValue(resolved.identity.equipmentId);

		if (before !== undefined && after !== undefined && before !== after) {
			// Same slot, different equipment — the slot keeps its policy binding.
			this.#rows.set(row.stableKey, row);
			return { kind: 'equipment-swapped-in-slot', row, previousEquipment: existing.equipmentId };
		}

		// Same slot, same (or unchanged) equipment — a replug: one row, new path.
		this.#rows.set(row.stableKey, row);
		return { kind: 'replugged', row, previousPath: existing.runtimePath };
	}

	#rowFrom(resolved: ResolvedIdentity): IdentityRow {
		const { identity, stableKey } = resolved;
		return {
			stableKey,
			equipmentId: identity.equipmentId,
			runtimePath: identity.runtimePath,
			...(identity.logicalSlotId !== undefined ? { logicalSlotId: identity.logicalSlotId } : {}),
		};
	}

	#findByEquipment(equipment: EquipmentId, exceptKey: string): IdentityRow | undefined {
		const value = equipmentValue(equipment);
		if (value === undefined) {
			return undefined;
		}
		for (const row of this.#rows.values()) {
			if (row.stableKey !== exceptKey && equipmentValue(row.equipmentId) === value) {
				return row;
			}
		}
		return undefined;
	}
}
