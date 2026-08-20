// The Qualcomm/HIMI prohibition table.
//
// These operations have NO IMPLEMENTATION ANYWHERE in this provider — not a refused
// stub, not a disabled branch, not a private helper. The table below is inert DATA: it
// exists so a caller asking for one of these ids gets a NAMED refusal instead of an
// "unknown operation" shrug, and so the fence can be enumerated by a test rather than
// argued for in prose. Nothing here can perform anything.
//
// Why each is prohibited rather than merely gated:
//
//   NV / EFS / identity / calibration writes — they rewrite the modem's own persistent
//     storage. A bad write bricks the radio, forges an IMEI, or destroys the factory RF
//     calibration, and none of the three is recoverable from this device's userspace.
//     Identity writes are additionally illegal in most jurisdictions.
//   Firmware flashing and EDL automation — an interrupted flash leaves a device that
//     enumerates only in emergency-download mode, which needs physical access this
//     controller by definition does not have on a deployed board.
//   Blind driver / interface retries — re-binding a driver or cycling an interface
//     "until it works" is how a transient enumeration fault becomes a reboot loop, and
//     it destroys the evidence the next diagnosis needs.
//   DIAG writes — the Qualcomm DIAG channel can reach every one of the above.
//   The DIAG info probe — READ-only and legitimate, but bench-only and human-supervised
//     (docs/UFI-DIAG-PROBE.md). It is not a production operation and never becomes one.
//   Shell transport fallback — production never reaches this device over ADB, SSH,
//     telnet or DIAG under any circumstance. The HIMI HTTP API is the only transport.

import { defineOperationDescriptor, type OperationDescriptor } from '../../domain';

export type UfiProhibitionClass =
	| 'device-integrity'
	| 'firmware'
	| 'recovery-automation'
	| 'diagnostic-channel'
	| 'transport-fallback';

export const UFI_PROHIBITED_OPERATIONS = {
	'nv.write': { reason: 'nv-write-prohibited', class: 'device-integrity' },
	'efs.write': { reason: 'efs-write-prohibited', class: 'device-integrity' },
	'identity.write': { reason: 'identity-write-prohibited', class: 'device-integrity' },
	'calibration.write': { reason: 'calibration-write-prohibited', class: 'device-integrity' },
	'firmware.flash': { reason: 'firmware-flash-prohibited', class: 'firmware' },
	'edl.automation': { reason: 'edl-automation-prohibited', class: 'recovery-automation' },
	'driver.blind-retry': { reason: 'blind-driver-retry-prohibited', class: 'recovery-automation' },
	'interface.blind-retry': {
		reason: 'blind-interface-retry-prohibited',
		class: 'recovery-automation',
	},
	'diag.write': { reason: 'diag-write-prohibited', class: 'diagnostic-channel' },
	'diag.info-probe': {
		reason: 'diag-probe-is-bench-supervised-only',
		class: 'diagnostic-channel',
	},
	'shell.transport-fallback': {
		reason: 'shell-transport-fallback-prohibited',
		class: 'transport-fallback',
	},
} as const satisfies Record<
	string,
	{ readonly reason: string; readonly class: UfiProhibitionClass }
>;

export type UfiProhibitedOperationId = keyof typeof UFI_PROHIBITED_OPERATIONS;
export type UfiProhibition = (typeof UFI_PROHIBITED_OPERATIONS)[UfiProhibitedOperationId];
export type UfiProhibitionReason = UfiProhibition['reason'];

export const UFI_PROHIBITED_OPERATION_IDS = Object.keys(
	UFI_PROHIBITED_OPERATIONS,
) as readonly UfiProhibitedOperationId[];

export function isUfiProhibitedOperation(
	operationId: string,
): operationId is UfiProhibitedOperationId {
	return Object.hasOwn(UFI_PROHIBITED_OPERATIONS, operationId);
}

export function ufiProhibition(operationId: string): UfiProhibition | undefined {
	return isUfiProhibitedOperation(operationId) ? UFI_PROHIBITED_OPERATIONS[operationId] : undefined;
}

/**
 * An INERT descriptor, so the same refusal survives a trip through the operation engine.
 *
 * It declares read AND write unsupported and availability refused, and it constrains
 * inputs to the empty set — three independent fences, each sufficient on its own. It
 * carries no execute/readback/rollback function because none exists to carry.
 */
export function ufiProhibitionDescriptor(
	operationId: UfiProhibitedOperationId,
): OperationDescriptor<unknown, never> {
	const { reason } = UFI_PROHIBITED_OPERATIONS[operationId];
	return defineOperationDescriptor<unknown, never>({
		id: operationId,
		support: {
			read: { supported: false, reason },
			write: { supported: false, reason },
		},
		authority: 'provider',
		provider: 'ufi-himi',
		constraints: { kind: 'allowed-values', values: [] },
		livePreconditions: [],
		availability: { state: 'refused', reason },
		// `disruptive`, not `write`: every one of these rewrites persistent device state
		// or drives a recovery mode. The engine treats any non-read impact as a write
		// (queued behind the modem's actor), so the refusal path is identical.
		mutationImpact: 'disruptive',
		retryClass: 'never',
		readback: { required: false },
		rollback: { required: false },
		journal: { required: false },
		admission: { required: false },
		evidence: { profiles: [], firmware: [] },
		confidence: 'high',
	});
}
