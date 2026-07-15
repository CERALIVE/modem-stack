// The desired-state planner — pure. Given the currently-applied state, a desired
// policy, and the modem's capabilities, it produces the port-tagged ops needed to
// converge PLUS an honest receipt per policy dimension. It performs no I/O and no
// side effects: the same inputs always yield the same ops and receipts, which is
// what makes re-applying a policy idempotent (see reconcile.test.ts).

import type { DesiredCellularPolicy, NmActivation, RadioAccessTechnology } from '../domain';
import type { ConnectionId, DeviceIfname, GsmProfileInput } from './network-manager';
import { mmOp, nmOp, type PortTaggedOp } from './ops';
import { type Receipt, receipt } from './receipts';

/** What the modem / stack can actually do — the capability set the planner honors. */
export interface ModemCapabilities {
	readonly supportedRats: ReadonlySet<RadioAccessTechnology>;
	readonly simSlotCount: number;
	readonly supportsAutoApn: boolean;
}

/**
 * The currently-applied cellular configuration, as the planner sees it — the "is"
 * state, distinct from the observational snapshot: it tracks what has actually been
 * written (profile, radio preference, primary slot) plus the live NM activation.
 */
export interface AppliedCellularState {
	readonly nmActivation: NmActivation;
	readonly hasProfile: boolean;
	readonly connectionId?: ConnectionId;
	readonly deviceIfname?: DeviceIfname;
	readonly appliedApn?: 'auto' | string;
	readonly appliedRoaming?: boolean;
	readonly appliedRadioPreference?: readonly RadioAccessTechnology[];
	readonly activePrimarySlot?: number;
	readonly activationFailureReason?: string;
}

/** A reconcile plan: the ops to run and one receipt per policy dimension. */
export interface Plan {
	readonly ops: readonly PortTaggedOp[];
	readonly receipts: readonly Receipt[];
}

interface DimensionResult {
	readonly receipt: Receipt;
	readonly op?: PortTaggedOp;
}

interface ProfilePlan {
	readonly connection: Receipt;
	readonly roaming: Receipt;
	readonly op?: PortTaggedOp;
}

/** Reconcile a desired policy against the applied state into ops + receipts. */
export function planReconcile(
	current: AppliedCellularState,
	desired: DesiredCellularPolicy,
	capabilities: ModemCapabilities,
): Plan {
	const profile = planNmProfile(current, desired, capabilities);
	const results: readonly DimensionResult[] = [
		planRadio(current, desired, capabilities),
		planSimSlot(current, desired, capabilities),
		planEnabled(current, desired),
		{ receipt: planRecovery(desired) },
		{ receipt: planUsage(desired) },
	];

	const ops: PortTaggedOp[] = [];
	const receipts: Receipt[] = [profile.connection, profile.roaming];
	if (profile.op !== undefined) {
		ops.push(profile.op);
	}
	for (const result of results) {
		receipts.push(result.receipt);
		if (result.op !== undefined) {
			ops.push(result.op);
		}
	}
	return { ops, receipts };
}

function profileFromPolicy(desired: DesiredCellularPolicy): GsmProfileInput {
	const auto = desired.connection.apn === 'auto';
	const base: GsmProfileInput = {
		connectionName: 'ceralive-cellular',
		apn: auto ? '' : desired.connection.apn,
		homeOnly: !desired.roaming,
		autoConfig: auto,
	};
	// SENSITIVE creds only when explicitly provided AND not in auto-config mode.
	if (!auto && desired.connection.auth !== undefined) {
		const { username, password } = desired.connection.auth;
		return {
			...base,
			...(username !== undefined ? { username } : {}),
			...(password !== undefined ? { password } : {}),
		};
	}
	return base;
}

// NM owns APN / auth / roaming / autoconnect: one profile write converges all of
// them, so connection + roaming share a single op and each get their own receipt.
function planNmProfile(
	current: AppliedCellularState,
	desired: DesiredCellularPolicy,
	capabilities: ModemCapabilities,
): ProfilePlan {
	const auto = desired.connection.apn === 'auto';
	if (auto && !capabilities.supportsAutoApn) {
		return {
			connection: receipt(
				'connection',
				'unsupported',
				'Auto-APN is not available on this NetworkManager / modem',
			),
			roaming: receipt(
				'roaming',
				'unsupported',
				'roaming cannot be applied without a connection profile',
			),
		};
	}
	const needsWrite =
		!current.hasProfile ||
		current.appliedApn !== desired.connection.apn ||
		current.appliedRoaming !== desired.roaming;
	if (!needsWrite) {
		return {
			connection: receipt(
				'connection',
				'applied',
				`connection APN '${desired.connection.apn}' already configured`,
			),
			roaming: receipt(
				'roaming',
				'applied',
				`roaming already ${desired.roaming ? 'enabled' : 'disabled'}`,
			),
		};
	}
	const op =
		current.hasProfile && current.connectionId !== undefined
			? nmOp({
					kind: 'updateGsmProfile',
					connectionId: current.connectionId,
					patch: profileFromPolicy(desired),
				})
			: nmOp({ kind: 'createGsmProfile', profile: profileFromPolicy(desired) });
	const verb = current.hasProfile ? 'updating' : 'creating';
	return {
		connection: receipt(
			'connection',
			'pending',
			`${verb} connection profile for APN '${desired.connection.apn}'`,
		),
		roaming: receipt(
			'roaming',
			'pending',
			`roaming ${desired.roaming ? 'enabled' : 'disabled'} via connection profile`,
		),
		op,
	};
}

function radioMatches(
	applied: readonly RadioAccessTechnology[] | undefined,
	desired: readonly RadioAccessTechnology[],
): boolean {
	if (applied === undefined || applied.length !== desired.length) {
		return false;
	}
	return applied.every((rat, index) => rat === desired[index]);
}

function planRadio(
	current: AppliedCellularState,
	desired: DesiredCellularPolicy,
	capabilities: ModemCapabilities,
): DimensionResult {
	const preference = desired.radio.preferenceOrdered;
	const top = preference[0];
	if (top === undefined) {
		return {
			receipt: receipt(
				'radio',
				'failed',
				'radio preference must list at least one access technology',
			),
		};
	}
	if (!capabilities.supportedRats.has(top)) {
		const supported = [...capabilities.supportedRats].join(', ') || 'none';
		return {
			receipt: receipt(
				'radio',
				'unsupported',
				`preferred radio access technology '${top}' is not supported by this modem (supports ${supported})`,
			),
		};
	}
	if (radioMatches(current.appliedRadioPreference, preference)) {
		return {
			receipt: receipt('radio', 'applied', `radio preference already ${preference.join(' > ')}`),
		};
	}
	return {
		receipt: receipt('radio', 'pending', `setting radio preference to ${preference.join(' > ')}`),
		op: mmOp({ kind: 'setRadioModes', preference: desired.radio }),
	};
}

function planSimSlot(
	current: AppliedCellularState,
	desired: DesiredCellularPolicy,
	capabilities: ModemCapabilities,
): DimensionResult {
	if (desired.simSlot === undefined) {
		return { receipt: receipt('simSlot', 'applied', 'no primary SIM slot preference set') };
	}
	if (capabilities.simSlotCount <= 1) {
		return {
			receipt: receipt(
				'simSlot',
				'unsupported',
				`primary SIM slot selection requires a multi-slot modem (this modem has ${capabilities.simSlotCount})`,
			),
		};
	}
	if (desired.simSlot < 1 || desired.simSlot > capabilities.simSlotCount) {
		return {
			receipt: receipt(
				'simSlot',
				'failed',
				`SIM slot ${desired.simSlot} is out of range (1..${capabilities.simSlotCount})`,
			),
		};
	}
	if (current.activePrimarySlot === desired.simSlot) {
		return {
			receipt: receipt('simSlot', 'applied', `SIM slot ${desired.simSlot} already primary`),
		};
	}
	return {
		receipt: receipt('simSlot', 'pending', `switching primary SIM slot to ${desired.simSlot}`),
		op: mmOp({ kind: 'setPrimarySimSlot', slotIndex: desired.simSlot }),
	};
}

function planEnabled(
	current: AppliedCellularState,
	desired: DesiredCellularPolicy,
): DimensionResult {
	const nm = current.nmActivation;
	const addressable = current.connectionId !== undefined && current.deviceIfname !== undefined;
	if (desired.enabled) {
		switch (nm) {
			case 'activated':
				return { receipt: receipt('enabled', 'applied', 'connection is active') };
			case 'activating':
				return { receipt: receipt('enabled', 'pending', 'connection activation in progress') };
			case 'failed':
				return {
					receipt: receipt(
						'enabled',
						'failed',
						`connection activation failed${current.activationFailureReason ? `: ${current.activationFailureReason}` : ''}`,
					),
				};
			case 'unmanaged':
				return {
					receipt: receipt('enabled', 'unsupported', 'device is not managed by NetworkManager'),
				};
			default:
				if (
					!addressable ||
					current.connectionId === undefined ||
					current.deviceIfname === undefined
				) {
					return {
						receipt: receipt(
							'enabled',
							'pending',
							'awaiting connection profile and data interface before activation',
						),
					};
				}
				return {
					receipt: receipt('enabled', 'pending', 'activating connection'),
					op: nmOp({
						kind: 'activate',
						connectionId: current.connectionId,
						deviceIfname: current.deviceIfname,
					}),
				};
		}
	}
	if (
		(nm === 'activated' || nm === 'activating') &&
		current.connectionId !== undefined &&
		current.deviceIfname !== undefined
	) {
		return {
			receipt: receipt('enabled', 'pending', 'deactivating connection'),
			op: nmOp({
				kind: 'deactivate',
				connectionId: current.connectionId,
				deviceIfname: current.deviceIfname,
			}),
		};
	}
	return { receipt: receipt('enabled', 'applied', 'connection is inactive') };
}

// Recovery + usage are LOCAL-CONTROLLER owned (README ownership table): they emit no
// MM / NM op, only a receipt recording that the local policy was accepted.
function planRecovery(desired: DesiredCellularPolicy): Receipt {
	return receipt(
		'recovery',
		'applied',
		desired.recovery.enabled ? 'recovery policy recorded (enabled)' : 'recovery disabled (default)',
	);
}

function planUsage(desired: DesiredCellularPolicy): Receipt {
	const parts: string[] = [];
	if (desired.usage.cycleDay !== undefined) {
		parts.push(`cycle day ${desired.usage.cycleDay}`);
	}
	if (desired.usage.thresholdBytes !== undefined) {
		parts.push(`threshold ${desired.usage.thresholdBytes} bytes`);
	}
	return receipt(
		'usage',
		'applied',
		parts.length > 0 ? `usage policy recorded (${parts.join(', ')})` : 'no usage policy set',
	);
}
