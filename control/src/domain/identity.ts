// Modem identity — the four ids that pin a physical modem across its lifecycle.
//
// Design (draft §Oracle round-1): a modem is identified by FOUR distinct ids, not
// one, because each answers a different question and each has a different lifetime:
//
//   - logicalSlotId  — the stable physical-slot handle. Durable policy and routing
//                      bind to THIS. Optional: absent until the identity ladder
//                      (A3.2) resolves a slot from udev/Physdev/sysfs.
//   - equipmentId    — IMEI (or serial fallback) with provenance + confidence.
//   - subscriptionId — ICCID/EID. SENSITIVE (see marker below). Optional: no SIM.
//   - runtimePath    — the live ModemManager D-Bus object path. NEVER PERSISTED.

import type { Brand } from './brand';
import { nonEmptyString } from './brand';
import { PolicyBindingRefusedError } from './errors';

/**
 * Stable physical-slot handle (e.g. `slot-usb-1-2`). The ONLY id durable policy
 * and routing are allowed to bind to — it survives equipment swaps in the slot.
 */
export type LogicalSlotId = Brand<string, 'LogicalSlotId'>;

/**
 * SIM subscription id (ICCID or EID).
 *
 * SENSITIVE — this value identifies a subscriber. It MUST be redacted in every
 * log, telemetry, and error surface (the redaction module lands in A2.2). Treat
 * it as PII: never print it raw, never include it in a policy binding key.
 */
export type SubscriptionId = Brand<string, 'SubscriptionId'>;

/**
 * The SIM's OWN number (MSISDN), as ModemManager's `Modem.OwnNumbers` reports it.
 *
 * SENSITIVE — it is the subscriber's telephone number, so it belongs to the same
 * class as `subscriptionId`: never printed raw, never a policy binding key. It is
 * DISPLAYED to the operator on an explicit reveal; that is a rendering decision
 * and does not make it loggable.
 */
export type SubscriberNumber = Brand<string, 'SubscriberNumber'>;

/**
 * The live ModemManager D-Bus object path (e.g. `/org/freedesktop/ModemManager1/Modem/3`).
 *
 * NEVER PERSISTED — this is a per-boot runtime handle. ModemManager reassigns it
 * across daemon restarts and device replug, so it is meaningless in durable
 * storage. Durable keys derive from `logicalSlotId`/`equipmentId` only; storage
 * code in later waves must never write this field. The type name and this note
 * make that intent unambiguous at the domain layer.
 */
export type RuntimePath = Brand<string, 'RuntimePath'>;

/** How the equipment id was obtained. Discriminated union over the source. */
export type EquipmentProvenance = 'imei' | 'serial' | 'none';

/**
 * Trust in the equipment id as a durable key.
 *
 *   - high   — a well-formed, unique IMEI.
 *   - medium — a serial fallback, or an IMEI of non-standard shape.
 *   - low    — AMBIGUOUS: a zero/blank IMEI, or a value seen on more than one
 *              modem (duplicate). A low-confidence identity must NEVER bind
 *              durable policy — see `policyBindingKey` / `canBindPolicy`.
 */
export type IdentityConfidence = 'high' | 'medium' | 'low';

/**
 * The equipment id, discriminated on `provenance`.
 *
 * `imei` and `serial` carry a `value`; `none` carries none — we genuinely have no
 * equipment identifier, so `value` would be a lie. `none` is always low confidence.
 */
export type EquipmentId =
	| { readonly provenance: 'imei'; readonly value: string; readonly confidence: IdentityConfidence }
	| {
			readonly provenance: 'serial';
			readonly value: string;
			readonly confidence: IdentityConfidence;
	  }
	| { readonly provenance: 'none'; readonly confidence: 'low' };

/** The four-part modem identity. */
export interface ModemIdentity {
	/** Absent until the identity ladder resolves a physical slot. */
	readonly logicalSlotId?: LogicalSlotId;
	readonly equipmentId: EquipmentId;
	/** Absent with no SIM. SENSITIVE — redact everywhere (A2.2 redaction module). */
	readonly subscriptionId?: SubscriptionId;
	/**
	 * The SIM's own number(s). ABSENT when the carrier/SIM published none — most
	 * SIMs do not, so absence is the common case and never an error. SENSITIVE.
	 */
	readonly ownNumbers?: readonly SubscriberNumber[];
	/** NEVER PERSISTED — per-boot runtime handle only. */
	readonly runtimePath: RuntimePath;
}

// --- constructors ----------------------------------------------------------

/** Construct a `LogicalSlotId` from a non-empty string. */
export function logicalSlotId(value: string): LogicalSlotId {
	return nonEmptyString(value, 'logicalSlotId') as LogicalSlotId;
}

/** Construct a `SubscriptionId` from a non-empty string. */
export function subscriptionId(value: string): SubscriptionId {
	return nonEmptyString(value, 'subscriptionId') as SubscriptionId;
}

/** Construct a `SubscriberNumber` from a non-empty string. */
export function subscriberNumber(value: string): SubscriberNumber {
	return nonEmptyString(value, 'subscriberNumber') as SubscriberNumber;
}

/** Construct a `RuntimePath` from a non-empty string. */
export function runtimePath(value: string): RuntimePath {
	return nonEmptyString(value, 'runtimePath') as RuntimePath;
}

const ALL_ZEROS = /^0+$/;

/**
 * Grade an IMEI's confidence from its own shape alone.
 *
 * A blank or all-zeros IMEI is a well-known ambiguous placeholder → `low`. A
 * canonical 15/16-digit IMEI → `high`. Anything else → `medium`. DUPLICATE
 * detection is cross-modem and cannot be done from a single value here; A3.2
 * demotes duplicates to `low` via `demoteToLowConfidence`.
 */
function gradeImei(value: string): IdentityConfidence {
	const trimmed = value.trim();
	if (trimmed.length === 0 || ALL_ZEROS.test(trimmed)) {
		return 'low';
	}
	return /^\d{15,16}$/.test(trimmed) ? 'high' : 'medium';
}

/** The absence of any equipment id — always low confidence. */
export const NO_EQUIPMENT_ID: EquipmentId = { provenance: 'none', confidence: 'low' };

/** Build an IMEI-provenance equipment id, grading confidence from the value. */
export function imeiEquipmentId(value: string): EquipmentId {
	return { provenance: 'imei', value, confidence: gradeImei(value) };
}

/**
 * Build a serial-fallback equipment id. A serial is never as trustworthy as a
 * clean IMEI, so it caps at `medium` (blank → `low`).
 */
export function serialEquipmentId(value: string): EquipmentId {
	const confidence: IdentityConfidence = value.trim().length === 0 ? 'low' : 'medium';
	return { provenance: 'serial', value, confidence };
}

/**
 * Demote an equipment id to `low` confidence — used by the identity ladder when a
 * value turns out to be shared across modems (duplicate IMEI). Idempotent; `none`
 * is already low.
 */
export function demoteToLowConfidence(id: EquipmentId): EquipmentId {
	if (id.provenance === 'none') {
		return id;
	}
	return { provenance: id.provenance, value: id.value, confidence: 'low' };
}

// --- policy-binding gate ----------------------------------------------------

/**
 * Whether this identity may bind DURABLE policy. False for ambiguous
 * (low-confidence) equipment identities — a duplicate or zero IMEI must never
 * become the durable key that a saved policy attaches to.
 */
export function canBindPolicy(identity: ModemIdentity): boolean {
	return identity.equipmentId.confidence !== 'low';
}

/** Throw `PolicyBindingRefusedError` if the identity may not bind durable policy. */
export function assertCanBindPolicy(identity: ModemIdentity): void {
	if (!canBindPolicy(identity)) {
		throw new PolicyBindingRefusedError(
			`equipment id (provenance=${identity.equipmentId.provenance}) is low-confidence`,
		);
	}
}
