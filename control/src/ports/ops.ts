// Port-tagged reconcile ops — a planned mutation TAGGED with the port that owns it.
//
// The op kinds are DISJOINT by construction: a radio / SIM op (`MmOp`) shares no
// `kind` with a connection / APN op (`NmOp`). Tagging is therefore type-checked —
// `{ port: 'nm', op: { kind: 'setRadioModes', … } }` does NOT compile, because a
// radio op is not assignable to the NM arm. That mis-tag is a COMPILE-TIME error
// (see `ops.type-test.ts` for the `@ts-expect-error` proofs). This is the ownership
// matrix (README) enforced by the type system, not merely by convention.

import type { DesiredRadio } from '../domain';
import type {
	ConnectionId,
	DeviceIfname,
	GsmProfileInput,
	GsmProfilePatch,
} from './network-manager';

/** Radio + SIM ops — owned SOLELY by the ModemManager port. */
export type MmOp =
	| { readonly kind: 'setRadioModes'; readonly preference: DesiredRadio }
	| { readonly kind: 'setPrimarySimSlot'; readonly slotIndex: number };

/** Connection / APN / activation ops — owned SOLELY by the NetworkManager port. */
export type NmOp =
	| { readonly kind: 'createGsmProfile'; readonly profile: GsmProfileInput }
	| {
			readonly kind: 'updateGsmProfile';
			readonly connectionId: ConnectionId;
			readonly patch: GsmProfilePatch;
	  }
	| {
			readonly kind: 'activate';
			readonly connectionId: ConnectionId;
			readonly deviceIfname: DeviceIfname;
	  }
	| {
			readonly kind: 'deactivate';
			readonly connectionId: ConnectionId;
			readonly deviceIfname: DeviceIfname;
	  };

/**
 * A planned op tagged with its owning port. The two arms are disjoint on BOTH the
 * `port` discriminant AND the op `kind` space, so the planner cannot emit — and a
 * reviewer cannot write — a radio op under the NM port, or a connection op under
 * the MM port.
 */
export type PortTaggedOp =
	| { readonly port: 'mm'; readonly op: MmOp }
	| { readonly port: 'nm'; readonly op: NmOp };

/** Tag an MM op for the ModemManager port. Only an `MmOp` is accepted. */
export function mmOp(op: MmOp): PortTaggedOp {
	return { port: 'mm', op };
}

/** Tag an NM op for the NetworkManager port. Only an `NmOp` is accepted. */
export function nmOp(op: NmOp): PortTaggedOp {
	return { port: 'nm', op };
}
