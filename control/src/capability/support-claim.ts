// The support-claim taxonomy — the vocabulary this stack uses to say how much is
// actually known about a capability module on a given modem.
//
// It exists because "supported" was one word doing four jobs: the code exists,
// an operator turned it on, the modem advertises it, and somebody proved it on
// this firmware. Those are four different facts with four different consequences
// — the third gates what a UI may offer, the fourth gates what a support matrix
// may claim — and collapsing them is how a doc comes to promise a combination
// nobody ever ran.
//
// This module is PURE and mirrors the same ladder CeraUI's `@ceraui/rpc`
// `capability-modules.schema.ts` carries. It is a mirror rather than a shared
// import by Rule D: this repo builds standalone, so the two halves are kept
// honest by their tests, not by a path.

/** The seven gated capability modules. */
export const CAPABILITY_MODULES = [
	'band-lock',
	'sms',
	'five-g-pref',
	'fcc-auto-unlock',
	'gps',
	'ussd',
	'esim',
] as const;
export type CapabilityModule = (typeof CAPABILITY_MODULES)[number];

/**
 * The ladder, lowest rung first. `resolveSupportClaim` answers with the highest
 * rung reached:
 *
 *   unavailable — not shipped in this build, OR the modem positively lacks it.
 *   implemented — shipped, gate OFF. The default for every module, everywhere.
 *   enabled     — gate ON, capability UNKNOWN. "Not asked" is not "absent".
 *   capable     — gate ON, modem advertises it. The floor for offering a control.
 *   certified   — capable AND proven on this exact model+firmware. The ONLY rung
 *                 a support matrix or a doc may claim.
 */
export const SUPPORT_CLAIM_STATES = [
	'unavailable',
	'implemented',
	'enabled',
	'capable',
	'certified',
] as const;
export type SupportClaimState = (typeof SUPPORT_CLAIM_STATES)[number];

/** What a probe found. `unknown` is an answer about the READ, not the device. */
export type CapabilityEvidence = 'present' | 'absent' | 'unknown';

export interface SupportClaimInput {
	readonly implemented: boolean;
	readonly gateEnabled: boolean;
	readonly capability: CapabilityEvidence;
	readonly certified: boolean;
}

export function resolveSupportClaim(input: SupportClaimInput): SupportClaimState {
	if (!input.implemented || input.capability === 'absent') {
		return 'unavailable';
	}
	if (!input.gateEnabled) {
		return 'implemented';
	}
	if (input.capability === 'unknown') {
		return 'enabled';
	}
	return input.certified ? 'certified' : 'capable';
}

export const SURFACEABLE_SUPPORT_STATES: readonly SupportClaimState[] = ['capable', 'certified'];

export function mayRenderModule(state: SupportClaimState): boolean {
	return SURFACEABLE_SUPPORT_STATES.includes(state);
}

export function mayClaimSupport(state: SupportClaimState): boolean {
	return state === 'certified';
}

export type CapabilityModuleClaims = Readonly<Record<CapabilityModule, SupportClaimState>>;

export interface CapabilityMatrixInput {
	readonly implemented: readonly CapabilityModule[];
	readonly gates: Partial<Record<CapabilityModule, boolean>>;
	readonly capability: Partial<Record<CapabilityModule, CapabilityEvidence>>;
	readonly certified?: Partial<Record<CapabilityModule, boolean>>;
}

/** Total by construction: every module gets an explicit state. */
export function resolveCapabilityMatrix(input: CapabilityMatrixInput): CapabilityModuleClaims {
	const implemented = new Set(input.implemented);
	const claims: Record<CapabilityModule, SupportClaimState> = {} as Record<
		CapabilityModule,
		SupportClaimState
	>;
	for (const module of CAPABILITY_MODULES) {
		claims[module] = resolveSupportClaim({
			implemented: implemented.has(module),
			gateEnabled: input.gates[module] === true,
			capability: input.capability[module] ?? 'unknown',
			certified: input.certified?.[module] === true,
		});
	}
	return claims;
}

export function surfaceableModules(claims: CapabilityModuleClaims): CapabilityModule[] {
	return CAPABILITY_MODULES.filter((module) => mayRenderModule(claims[module]));
}

export function claimableModules(claims: CapabilityModuleClaims): CapabilityModule[] {
	return CAPABILITY_MODULES.filter((module) => mayClaimSupport(claims[module]));
}
