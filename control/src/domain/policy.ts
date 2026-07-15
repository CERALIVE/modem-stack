// Durable desired-state policy — the operator's intent for one modem.
//
// A2.1 stubbed this shape so the domain could enforce "an ambiguous identity may
// never bind durable policy" (see `policyBindingKey`). A2.2 owns the REAL
// definition below: the full connection / roaming / radio / simSlot / recovery /
// usage intent the desired-state planner reconciles (see `../ports/reconcile`).

import type { EquipmentId, LogicalSlotId, ModemIdentity } from './identity';
import { assertCanBindPolicy } from './identity';
import type { RadioAccessTechnology } from './state';

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

/** IP address family a connection requests. */
export type IpFamily = 'ipv4' | 'ipv6' | 'ipv4v6';

/**
 * Connection credentials. TODAY'S SEMANTICS (draft §round-5 auth): these are
 * persisted ONLY in the NetworkManager profile; the controller keeps them
 * transient in memory and NEVER writes them to its own store. `password` is
 * SENSITIVE and is ALWAYS redacted in logs / output / receipts (see `../redact`).
 */
export interface DesiredAuth {
	readonly username?: string;
	/** SENSITIVE — always redacted; NM-profile-persisted only, transient in memory. */
	readonly password?: string;
}

/** The data-connection intent. `apn: "auto"` selects NM Auto-APN (A4.1). */
export interface DesiredConnection {
	readonly apn: 'auto' | string;
	readonly ipFamily: IpFamily;
	readonly auth?: DesiredAuth;
	/**
	 * Manual operator selection (`gsm.network-id`) — pin registration to a specific
	 * PLMN. Honored only while roaming (A4.1 amendment): the NM profile writes
	 * `gsm.network-id = roaming ? networkId : ""`, so it is cleared when roaming is off.
	 */
	readonly networkId?: string;
}

/**
 * Radio access-technology intent. `preferenceOrdered` is ranked most-preferred
 * first ("prefer 5G" ⇒ `['5gnr', 'lte', …]`); it must be honored as a PREFERENCE,
 * never silently narrowed to an exclusive set — the planner reports `unsupported`
 * when the top preference is unavailable (never a silent downgrade). `allowedSet`,
 * when present, hard-limits the technologies the modem may use at all.
 */
export interface DesiredRadio {
	readonly preferenceOrdered: readonly RadioAccessTechnology[];
	readonly allowedSet?: ReadonlySet<RadioAccessTechnology>;
}

/**
 * Recovery intent. DISABLED BY DEFAULT — the evidence-gated recovery ladder (A3.4)
 * adds the per-step budgets / cooldowns; in Phase A `enabled` defaults to `false`
 * and no recovery action is ever taken unless it is explicitly turned on.
 */
export interface DesiredRecovery {
	readonly enabled: boolean;
}

/** Data-usage policy — local-controller owned (see ports README ownership table). */
export interface DesiredUsage {
	/** Day of month (1–31) the usage cycle resets; UTC, month-length clamped (A4.3). */
	readonly cycleDay?: number;
	/** Advisory threshold in bytes; crossing it raises an advisory, never gates. */
	readonly thresholdBytes?: number;
}

/**
 * Operator-authored durable cellular policy, bound to a high/medium-confidence
 * identity via `boundTo` (a low-confidence identity cannot produce a binding key,
 * so it can never be named here).
 *
 *   - enabled    — desired NM activation state (`enabled ≙ NM-activation`).
 *   - connection — APN (or `"auto"`), IP family, optional (redacted) credentials.
 *   - roaming    — allow the modem to register while roaming.
 *   - radio      — ranked RAT preference (+ optional hard-allowed set).
 *   - simSlot    — preferred primary SIM slot (1-based; multi-slot modems).
 *   - recovery   — recovery-ladder intent (disabled by default).
 *   - usage      — data-usage cycle + advisory threshold.
 */
export interface DesiredCellularPolicy {
	readonly boundTo: PolicyBindingKey;
	readonly enabled: boolean;
	readonly connection: DesiredConnection;
	readonly roaming: boolean;
	readonly radio: DesiredRadio;
	readonly simSlot?: number;
	readonly recovery: DesiredRecovery;
	readonly usage: DesiredUsage;
}

/** Recovery disabled — the Phase-A default (A3.4 adds budgets / cooldowns). */
export const RECOVERY_DISABLED: DesiredRecovery = { enabled: false };

/**
 * Build a sensible default policy for a bindable identity: NM activation on,
 * Auto-APN, dual-stack IP, roaming off, prefer newest RAT down to GSM, recovery
 * disabled, no usage limits. Concrete adapters and the planner refine from here.
 */
export function defaultCellularPolicy(boundTo: PolicyBindingKey): DesiredCellularPolicy {
	return {
		boundTo,
		enabled: true,
		connection: { apn: 'auto', ipFamily: 'ipv4v6' },
		roaming: false,
		radio: { preferenceOrdered: ['5gnr', 'lte', 'umts', 'gsm'] },
		recovery: RECOVERY_DISABLED,
		usage: {},
	};
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
