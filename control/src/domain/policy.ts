// Durable desired-state policy — ANTICIPATED shape (full definition lands in A2.2).
//
// This task (A2.1) does not own `DesiredCellularPolicy`; A2.2 (port contracts +
// receipts) does. We stub the minimal shape here for ONE reason: the domain layer
// must be able to express, and structurally enforce, "an ambiguous identity may
// never bind durable policy". A2.2 replaces/extends this stub — treat every field
// below as provisional and additive.

import type { EquipmentId, LogicalSlotId, ModemIdentity } from './identity';
import { assertCanBindPolicy } from './identity';

/**
 * The subset of identity a durable policy is allowed to key off.
 *
 * Deliberately excludes `runtimePath` (never persisted) and `subscriptionId`
 * (sensitive). Durable policy binds to the physical slot when known, always
 * anchored by the equipment id — never to a per-boot handle or a subscriber id.
 */
export interface PolicyBindingKey {
	readonly logicalSlotId?: LogicalSlotId;
	readonly equipmentId: EquipmentId;
}

/**
 * Operator-authored durable cellular policy. STUB — the real type (connection/apn,
 * roaming, radio preference order, simSlot, recovery budget, usage) is defined in
 * A2.2. Only `boundTo` is stable here: every durable policy names the binding key
 * it attaches to, and that key can only be produced for a high/medium-confidence
 * identity (see `policyBindingKey`).
 */
export interface DesiredCellularPolicy {
	readonly boundTo: PolicyBindingKey;
	// connection / roaming / radio / simSlot / recovery / usage: added in A2.2.
}

/**
 * Derive the durable binding key for an identity, REFUSING low-confidence
 * (ambiguous) identities. This is the structural gate that makes it impossible to
 * bind durable policy to a duplicate/zero-IMEI modem: no key can be produced, so
 * no `DesiredCellularPolicy` can name it. Throws `PolicyBindingRefusedError`.
 */
export function policyBindingKey(identity: ModemIdentity): PolicyBindingKey {
	assertCanBindPolicy(identity);
	// exactOptionalPropertyTypes: only include logicalSlotId when actually present.
	return identity.logicalSlotId !== undefined
		? { logicalSlotId: identity.logicalSlotId, equipmentId: identity.equipmentId }
		: { equipmentId: identity.equipmentId };
}
