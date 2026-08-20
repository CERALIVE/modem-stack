// The saved-vs-applied vocabulary, in NetworkManager's own terms.
//
// NM is the sole writer of bearers, APN, auth, roaming, autoconnect and activation
// (`ports/README.md` ownership matrix), and it is also the stack that draws the
// distinction this whole module is built on: a connection PROFILE is what was saved,
// an ACTIVE connection is what was actually put into force on a device, and the device
// itself reports what it is currently doing. `observations/state-separation.ts` models
// those three slots generically; this file gives them an NM-shaped payload.
//
// Radio, band, SIM and power operations are deliberately absent. Those belong to the
// ModemManager provider, and a second surface expressing them here would make two
// writers for one resource — the exact thing the ownership matrix exists to prevent.
// Nothing here carries a `PhysicalModemId` either: every slot is keyed by NM's own
// connection UUID, so this adapter can never become a second authority on which
// physical modem is which.

import type { DeviceGeneration, EpochMillis } from '../../domain';
import type {
	AppliedConfiguration,
	DesiredProfile,
	NormalizationContext,
} from '../../observations';
import type { ConnectionId, DeviceIfname, GsmProfileInput, Receipt } from '../../ports';

/**
 * NM's own device states (`NMDeviceState`), by name.
 *
 * The transitional members are kept rather than collapsed into "not activated",
 * because a device in `prepare` carrying our connection is COMING UP, and reporting
 * that as a lost bearer would turn every ordinary activation into a false alarm.
 */
export const NM_DEVICE_STATES = [
	'unknown',
	'unmanaged',
	'unavailable',
	'disconnected',
	'prepare',
	'config',
	'need-auth',
	'ip-config',
	'ip-check',
	'secondaries',
	'activated',
	'deactivating',
	'failed',
] as const;
export type NmDeviceState = (typeof NM_DEVICE_STATES)[number];

/**
 * The bearer identity all three slots compare in.
 *
 * `username` and `password` are deliberately NOT members. A state slot is read,
 * compared, and surfaced in divergence output; `gsm.password` is the one field in the
 * profile the redaction module masks everywhere else, so putting it in a comparable
 * value would re-open that hole through a side door. The credential lives in NM, is
 * written through the port, and is never mirrored here.
 */
export interface NmBearerBinding {
	readonly connectionId: ConnectionId;
	readonly deviceIfname: DeviceIfname;
	readonly apn: string;
	readonly autoConfig: boolean;
	readonly homeOnly: boolean;
}

/**
 * A bearer, or the positive absence of one.
 *
 * `unbound` exists so "NM answered, and it says nothing is in force on this device"
 * is a VALUE rather than an unavailable observation. The distinction is load-bearing:
 * an unavailable observation compares `indeterminate` against everything, which is
 * right for "the device is gone" and wrong for "the device is here and idle" — the
 * second is a definite divergence from a desired bearer, and an operator needs to see
 * it as one.
 */
export type NmBearerState =
	| { readonly kind: 'bound'; readonly binding: NmBearerBinding }
	| { readonly kind: 'unbound'; readonly deviceIfname: DeviceIfname };

export function boundBearer(binding: NmBearerBinding): NmBearerState {
	return { kind: 'bound', binding };
}

export function unboundBearer(deviceIfname: DeviceIfname): NmBearerState {
	return { kind: 'unbound', deviceIfname };
}

export function nmBearerBindingEquals(left: NmBearerBinding, right: NmBearerBinding): boolean {
	return (
		left.connectionId === right.connectionId &&
		left.deviceIfname === right.deviceIfname &&
		left.apn === right.apn &&
		left.autoConfig === right.autoConfig &&
		left.homeOnly === right.homeOnly
	);
}

/** The equality `describeStateDivergence` is driven with for NM state. */
export function nmBearerStateEquals(left: NmBearerState, right: NmBearerState): boolean {
	if (left.kind === 'bound' && right.kind === 'bound') {
		return nmBearerBindingEquals(left.binding, right.binding);
	}
	if (left.kind === 'unbound' && right.kind === 'unbound') {
		return left.deviceIfname === right.deviceIfname;
	}
	return false;
}

/** The connection NM reports active on a device, with the settings it put in force. */
export interface NmObservedActiveConnection {
	readonly connectionId: ConnectionId;
	readonly apn: string;
	readonly autoConfig: boolean;
	readonly homeOnly: boolean;
}

/** One device exactly as NM reports it in a readout. */
export interface NmObservedDevice {
	readonly ifname: DeviceIfname;
	readonly state: NmDeviceState;
	readonly activeConnection?: NmObservedActiveConnection;
}

/**
 * ONE COMPLETE NM readout — an enumeration, never a delta.
 *
 * That is what makes re-enumeration detectable at all: a device missing from `devices`
 * means the device is GONE, and a delta stream has no way to say that without a
 * removal event nobody guarantees will arrive.
 *
 * `context` supplies the clock, the generation and the source epoch, exactly as the
 * observation layer requires — this adapter has no clock of its own for observations
 * and therefore cannot stamp a readout with a time it did not come from.
 */
export interface NmObservationInput {
	readonly context: NormalizationContext;
	readonly devices: readonly NmObservedDevice[];
}

/** What an operator asked for: a saved profile, targeted at an exact device. */
export interface NmDesiredRequest {
	readonly profile: GsmProfileInput;
	readonly deviceIfname: DeviceIfname;
	/** Opaque origin label (an RPC caller, a policy engine). Never a credential. */
	readonly requestedBy: string;
	/** Update this existing profile instead of creating a new one. */
	readonly connectionId?: ConnectionId;
}

export const NM_ADAPTER_REFUSAL_REASONS = [
	'no-desired-profile',
	'profile-absent',
	'activation-failed',
	'deactivation-failed',
	'write-failed',
] as const;
export type NmAdapterRefusalReason = (typeof NM_ADAPTER_REFUSAL_REASONS)[number];

export type NmSaveResult =
	| {
			readonly ok: true;
			readonly connectionId: ConnectionId;
			readonly desired: DesiredProfile<NmBearerState>;
	  }
	| { readonly ok: false; readonly reason: NmAdapterRefusalReason; readonly receipt: Receipt };

/** Applying a desired profile: the write either took, or it did not and says why. */
export type NmApplyResult =
	| {
			readonly ok: true;
			readonly applied: AppliedConfiguration<NmBearerState>;
			readonly receipt: Receipt;
	  }
	| { readonly ok: false; readonly reason: NmAdapterRefusalReason; readonly receipt: Receipt };

export const NM_APPLIED_LOSS_REASONS = [
	/** The readout has no such device at all — a re-enumeration, or an unplug. */
	'interface-absent',
	/** The device is present and carries no active connection. */
	'interface-detached',
	/** A DIFFERENT connection is active on our device. */
	'connection-replaced',
	/** NM reports the device itself failed. */
	'activation-failed',
] as const;
export type NmAppliedLossReason = (typeof NM_APPLIED_LOSS_REASONS)[number];

/**
 * The applied bearer stopped being in force.
 *
 * `previous` is retained rather than discarded: a caller deciding whether to re-apply
 * or to roll back needs to know what WAS in force, and the applied slot has just been
 * cleared precisely because it no longer describes reality.
 */
export interface NmAppliedLoss {
	readonly connectionId: ConnectionId;
	readonly deviceIfname: DeviceIfname;
	readonly reason: NmAppliedLossReason;
	readonly lostAt: EpochMillis;
	readonly generation: DeviceGeneration;
	readonly previous: AppliedConfiguration<NmBearerState>;
}

export type NmAppliedOutcome =
	/** A desired profile is tracked, and nothing has been put into force for it yet. */
	| { readonly status: 'unapplied' }
	| { readonly status: 'retained'; readonly applied: AppliedConfiguration<NmBearerState> }
	| {
			readonly status: 'pending';
			readonly applied: AppliedConfiguration<NmBearerState>;
			readonly deviceState: NmDeviceState;
	  }
	| { readonly status: 'lost'; readonly loss: NmAppliedLoss };

export interface NmConnectionOutcome {
	readonly connectionId: ConnectionId;
	readonly outcome: NmAppliedOutcome;
}

/**
 * The result of folding one readout.
 *
 * A readout from a superseded generation is REFUSED rather than applied late: the
 * generation fence exists so a reply about a previous enumeration cannot clear applied
 * state that belongs to the current one.
 */
export type NmObservationResult =
	| {
			readonly kind: 'refused';
			readonly reason: 'superseded-generation';
			readonly currentGeneration: DeviceGeneration;
	  }
	| {
			readonly kind: 'accepted';
			readonly generation: DeviceGeneration;
			readonly observedAt: EpochMillis;
			readonly outcomes: readonly NmConnectionOutcome[];
			/** Just the losses, so the case that matters is not behind a filter. */
			readonly losses: readonly NmAppliedLoss[];
	  };
