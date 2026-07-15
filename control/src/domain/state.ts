// Orthogonal state dimensions.
//
// Draft §Oracle round-1: modem state is NOT one enum. It is a set of independent
// dimensions that vary separately — presence, SIM, radio, registration,
// NM-activation, data interface, reconcile, recovery. Collapsing them into a
// single enum loses real, simultaneously-true facts (e.g. "present + radio on +
// searching + no NM connection"). Each dimension below mirrors a real
// ModemManager / NetworkManager concept; values track those enums.

import type { Brand } from './brand';
import { nonNegativeInteger } from './brand';

/** Milliseconds since the Unix epoch. */
export type EpochMillis = Brand<number, 'EpochMillis'>;

/** Construct an `EpochMillis` from a non-negative integer timestamp. */
export function epochMillis(value: number): EpochMillis {
	return nonNegativeInteger(value, 'epochMillis') as EpochMillis;
}

// --- 1. presence + source health -------------------------------------------

/** Whether the modem is in the current authoritative observation snapshot. */
export type Presence = 'present' | 'absent';

/**
 * Health of the observation SOURCE (the ModemManager daemon / bus), independent
 * of presence. When the source drops (owner loss, bus disconnect) the last data
 * goes `stale` and then `sourceUnavailable` — it is NEVER silently turned into
 * `absent`. Only an authoritative snapshot confirms real removal (A3.1 epochs).
 */
export type SourceHealth = 'live' | 'stale' | 'sourceUnavailable';

// --- 2. SIM slots + lock ----------------------------------------------------

/** SIM lock state — subset of `MMModemLock` plus `unknown`. */
export type SimLock =
	| 'unknown'
	| 'none'
	| 'sim-pin'
	| 'sim-puk'
	| 'sim-pin2'
	| 'sim-puk2'
	| 'net-pers'
	| 'permanently-blocked';

/** A single physical SIM slot. */
export interface SimSlot {
	/** 1-based slot index (ModemManager numbers slots from 1). */
	readonly index: number;
	/** A SIM card is physically inserted in this slot. */
	readonly occupied: boolean;
	/** This is the primary/active slot the modem is currently using. */
	readonly active: boolean;
	readonly lock: SimLock;
}

/** Lock states that require a SIM to actually be present in the slot. */
export const SIM_LOCK_REQUIRES_CARD: ReadonlySet<SimLock> = new Set<SimLock>([
	'sim-pin',
	'sim-puk',
	'sim-pin2',
	'sim-puk2',
	'net-pers',
	'permanently-blocked',
]);

// --- 3. radio power + MM state ---------------------------------------------

/** Radio power state — `MMModemPowerState`. */
export type RadioPower = 'unknown' | 'off' | 'low' | 'on';

/** Modem lifecycle state — `MMModemState`. */
export type MmState =
	| 'failed'
	| 'unknown'
	| 'initializing'
	| 'locked'
	| 'disabled'
	| 'disabling'
	| 'enabling'
	| 'enabled'
	| 'searching'
	| 'registered'
	| 'disconnecting'
	| 'connecting'
	| 'connected';

/**
 * MM states that imply the radio is powered and actively on the air — none of
 * these can coexist with `radioPower: 'off'`, and all imply the modem is present.
 */
export const MM_STATES_REQUIRING_RADIO: ReadonlySet<MmState> = new Set<MmState>([
	'enabled',
	'searching',
	'registered',
	'connecting',
	'connected',
	'disconnecting',
]);

// --- 4. registration + RAT set ---------------------------------------------

/** 3GPP registration state — `MMModem3gppRegistrationState`. */
export type RegistrationStatus = 'idle' | 'home' | 'searching' | 'denied' | 'unknown' | 'roaming';

/** Radio access technology family — subset of `MMModemAccessTechnology` groups. */
export type RadioAccessTechnology = 'gsm' | 'umts' | 'lte' | '5gnr';

/**
 * Registration dimension: a status plus the SET of currently-active access
 * technologies. MM's access-technology field is a bitmask (carrier aggregation
 * can light more than one), so a set — not a single value — is the faithful model.
 */
export interface Registration {
	readonly status: RegistrationStatus;
	readonly activeRats: ReadonlySet<RadioAccessTechnology>;
}

/** Registration statuses that mean the modem is attached to a network. */
export function isRegistered(status: RegistrationStatus): boolean {
	return status === 'home' || status === 'roaming';
}

// --- 5. NM activation -------------------------------------------------------

/**
 * NetworkManager connection/activation state for this modem's device — `NMDeviceState`
 * collapsed to the states that matter. NM is the SOLE owner of activation; this
 * dimension reflects, never drives, that ownership.
 */
export type NmActivation =
	| 'unmanaged'
	| 'unavailable'
	| 'disconnected'
	| 'activating'
	| 'activated'
	| 'deactivating'
	| 'failed';

// --- 6. data interface ------------------------------------------------------

/**
 * The net device the modem exposes for data (e.g. `wwan0`). `name` may be absent
 * even when `present` (MM can report a bearer whose ip-interface is not yet
 * named); a `name` without `present` is impossible and guarded.
 */
export interface DataInterface {
	readonly present: boolean;
	readonly name?: string;
}

// --- 7. reconcile status ----------------------------------------------------

/**
 * Aggregate desired-state reconciliation status. Mirrors the A2.2 receipt
 * taxonomy at snapshot granularity: `unsupported` means the desired state cannot
 * be applied on this hardware (e.g. "prefer 5G" on a 4G-only modem) — surfaced,
 * never silently dropped.
 */
export type ReconcileStatus = 'converged' | 'reconciling' | 'pending' | 'divergent' | 'unsupported';

// --- 8. recovery state ------------------------------------------------------

/**
 * Recovery-ladder stage. Ordered rungs mirror A3.4:
 *   nm-cycle → mm-cycle → reset → power-cycle, gated by attribution and budgets.
 * `idle` = nothing in flight; `exhausted` = budget spent, gave up.
 */
export type RecoveryStage =
	| 'idle'
	| 'attributing'
	| 'nm-cycle'
	| 'mm-cycle'
	| 'reset'
	| 'power-cycle'
	| 'cooldown'
	| 'exhausted';

/**
 * Recovery dimension. `cooldownUntil` is present ONLY while `stage` is `cooldown`
 * (guarded); `attempts` counts disruptive rungs fired in the current budget window
 * and resets to 0 at `idle`.
 */
export interface RecoveryState {
	readonly stage: RecoveryStage;
	readonly attempts: number;
	readonly cooldownUntil?: EpochMillis;
}
