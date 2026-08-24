// USB-mode transition preconditions + the transition interlock seam.
//
// The preconditions gate a mode switch and are checked TWICE (draft §rounds 5/6
// TOCTOU): once at transaction entry (so a doomed request never enters the actor) and
// again INSIDE the actor (so a request that was valid at entry but became invalid
// while queued is caught before any disruptive call). `checkTransitionPreconditions`
// re-polls the LIVE inputs (`probeReadiness`, `interlock.canDisrupt`) each call, so
// the two checks can genuinely disagree — that disagreement is the TIER-B race.
//
// The interlock is BIDIRECTIONAL: `canDisrupt` is the streaming→transition gate (may
// I disrupt now?), inherited from A3.4's `LifecycleInterlock`; `hold` is the
// transition→streaming gate (mark "transition active" until released). The Phase-A
// stub allows both; Phase B wires CeraUI's streaming-admission check into the same
// interface without changing the transaction.

import type { EpochMillis, IdentityConfidence } from '../domain';
import type { ConnectionId, DeviceIfname } from '../ports';
import {
	buildRuntimeCompositionSetCommand,
	type CatalogEntry,
	type CertifiedCatalog,
	findCatalogEntry,
	findPermittedTransition,
	type MmUsbMode,
	type PermittedTransition,
	RUNTIME_COMPOSITION_QUERY_REGISTRY,
	type RuntimeCompositionCapability,
	type RuntimeCompositionMode,
	type RuntimeCompositionVendor,
	type SkuDiscriminator,
} from '../usb-mode';
import type { InterlockTarget, LifecycleInterlock } from './lifecycle-interlock';

/** A held "transition active" interlock — released when the transaction ends. */
export interface InterlockHold {
	release(): Promise<void>;
}

/**
 * The transition interlock. `canDisrupt` (from `LifecycleInterlock`) answers "is it
 * safe to disrupt this modem now?"; `hold` marks a transition in progress so a
 * streaming start is blocked for its duration. Both directions, one seam.
 */
export interface TransitionInterlock extends LifecycleInterlock {
	hold(target: InterlockTarget): Promise<InterlockHold>;
}

const NO_OP_HOLD: InterlockHold = {
	release(): Promise<void> {
		return Promise.resolve();
	},
};

/** The Phase-A interlock: always allows, holds nothing. */
export const ALLOW_ALL_TRANSITION_INTERLOCK: TransitionInterlock = {
	canDisrupt() {
		return Promise.resolve({ allow: true } as const);
	},
	hold(): Promise<InterlockHold> {
		return Promise.resolve(NO_OP_HOLD);
	},
};

/** Live, re-evaluable readiness inputs — re-polled at entry AND in-actor. */
export interface TransitionReadiness {
	/** The identity confidence from A3.2's ladder; `'low'` refuses the transition. */
	readonly identityConfidence: IdentityConfidence;
}

type UsbModeTransitionRequestBase = {
	readonly stableKey: string;
	readonly connectionId: ConnectionId;
	readonly deviceIfname: DeviceIfname;
	/** Physical-topology UID captured BEFORE the switch — survives re-enumeration. */
	readonly cachedPhysicalUid: string;
	/** The MM `Device` UID to inhibit by (cached — the modem disappears mid-switch). */
	readonly inhibitUid: string;
	/** Must be `true` (mirrors the CLI `--confirm` flag). */
	readonly confirm: boolean;
	/** Must be `true` (an extra maintenance-mode safety gate). */
	readonly maintenance: boolean;
	readonly now: EpochMillis;
	/** Live readiness, re-polled at entry AND in-actor (TOCTOU-safe). */
	probeReadiness(): Promise<TransitionReadiness>;
};

export type CatalogUsbModeTransitionRequest = UsbModeTransitionRequestBase & {
	readonly strategy?: 'catalog';
	readonly sku: SkuDiscriminator;
	readonly fromMode: MmUsbMode;
	readonly toMode: MmUsbMode;
};

export type RuntimeUsbModeTransitionRequest = UsbModeTransitionRequestBase & {
	readonly strategy: 'runtime';
	readonly vendor: RuntimeCompositionVendor;
	readonly sku?: SkuDiscriminator;
	readonly fromMode: RuntimeCompositionMode;
	readonly toMode: RuntimeCompositionMode;
	readonly capability: RuntimeCompositionCapability;
};

export type UsbModeTransitionRequest =
	| CatalogUsbModeTransitionRequest
	| RuntimeUsbModeTransitionRequest;

/** How a transition ended. */
export type UsbModeTransitionOutcome =
	| {
			readonly status: 'refused';
			readonly stage: 'entry' | 'in-actor';
			readonly reason: string;
			readonly steps: readonly string[];
	  }
	| {
			readonly status: 'succeeded';
			readonly newIfname: DeviceIfname;
			readonly steps: readonly string[];
	  }
	| {
			readonly status: 'failed';
			readonly degraded: boolean;
			readonly reason: string;
			readonly steps: readonly string[];
	  };

export type UsbModeTransitionPlan = {
	readonly atCommand: string;
	readonly applyCommand?: string;
	readonly proof:
		| {
				readonly tier: 'catalog-descriptors';
				readonly transition: PermittedTransition;
		  }
		| {
				readonly tier: 'runtime-requery';
				readonly vendor: RuntimeCompositionVendor;
				readonly target: RuntimeCompositionMode;
				readonly currentQuery: string;
		  };
};

export type PreconditionResult =
	| {
			readonly ok: true;
			readonly entry?: CatalogEntry;
			readonly plan: UsbModeTransitionPlan;
			readonly allowlistedCommands: readonly string[];
	  }
	| { readonly ok: false; readonly reason: string };

function sameRuntimeMode(left: RuntimeCompositionMode, right: RuntimeCompositionMode): boolean {
	return Object.is(left, right);
}

function runtimePlan(
	request: RuntimeUsbModeTransitionRequest,
	catalog: CertifiedCatalog,
): PreconditionResult {
	const capability = request.capability;
	if (capability.status !== 'available') return { ok: false, reason: 'runtime capability unknown' };
	if (!sameRuntimeMode(capability.current, request.fromMode))
		return { ok: false, reason: 'runtime current mode changed' };
	if (
		!capability.returnPathProven ||
		!capability.offerable.some((mode) => sameRuntimeMode(mode, request.toMode))
	)
		return { ok: false, reason: 'no-return-path' };
	const atCommand = buildRuntimeCompositionSetCommand(request.vendor, request.toMode);
	if (atCommand === undefined) return { ok: false, reason: 'runtime target command unavailable' };

	const entry = request.sku === undefined ? undefined : findCatalogEntry(catalog, request.sku);
	if (entry !== undefined) {
		const reviewed = entry.permittedTransitions.find(
			(transition) => transition.atCommand === atCommand,
		);
		if (reviewed !== undefined) {
			return {
				ok: true,
				entry,
				plan: {
					atCommand: reviewed.atCommand,
					...(reviewed.applyCommand === undefined ? {} : { applyCommand: reviewed.applyCommand }),
					proof: { tier: 'catalog-descriptors', transition: reviewed },
				},
				allowlistedCommands: entry.permittedTransitions.flatMap((transition) =>
					transition.applyCommand === undefined
						? [transition.atCommand]
						: [transition.atCommand, transition.applyCommand],
				),
			};
		}
	}
	return {
		ok: true,
		...(entry === undefined ? {} : { entry }),
		plan: {
			atCommand,
			proof: {
				tier: 'runtime-requery',
				vendor: request.vendor,
				target: request.toMode,
				currentQuery: RUNTIME_COMPOSITION_QUERY_REGISTRY[request.vendor].current,
			},
		},
		allowlistedCommands: [atCommand],
	};
}

/**
 * Check every transition precondition against the LIVE inputs. Called at entry and
 * again in-actor; a request that passed at entry can fail here if the identity
 * confidence dropped or the interlock closed in the meantime. Order is cheap-static
 * checks first (confirm, maintenance, catalog, permitted) then the live probes
 * (identity, interlock), so a refusal touches as little as possible.
 */
export async function checkTransitionPreconditions(
	request: UsbModeTransitionRequest,
	catalog: CertifiedCatalog,
	interlock: TransitionInterlock,
): Promise<PreconditionResult> {
	if (!request.confirm) {
		return { ok: false, reason: 'confirm:true is required (missing --confirm)' };
	}
	if (!request.maintenance) {
		return { ok: false, reason: 'maintenance flag is required' };
	}
	let staticResult: PreconditionResult;
	if (request.strategy === 'runtime') {
		staticResult = runtimePlan(request, catalog);
	} else {
		const entry = findCatalogEntry(catalog, request.sku);
		if (entry === undefined) {
			return { ok: false, reason: `uncertified SKU ${request.sku.vidPid} ${request.sku.model}` };
		}
		const transition = findPermittedTransition(entry, request.fromMode, request.toMode);
		if (transition === undefined) {
			return {
				ok: false,
				reason: `transition ${request.fromMode}->${request.toMode} not permitted for ${request.sku.model}`,
			};
		}
		staticResult = {
			ok: true,
			entry,
			plan: {
				atCommand: transition.atCommand,
				...(transition.applyCommand === undefined ? {} : { applyCommand: transition.applyCommand }),
				proof: { tier: 'catalog-descriptors', transition },
			},
			allowlistedCommands: entry.permittedTransitions.flatMap((candidate) =>
				candidate.applyCommand === undefined
					? [candidate.atCommand]
					: [candidate.atCommand, candidate.applyCommand],
			),
		};
	}
	if (!staticResult.ok) return staticResult;
	const readiness = await request.probeReadiness();
	if (readiness.identityConfidence === 'low') {
		return { ok: false, reason: 'low-confidence identity — refusing to transition' };
	}
	const verdict = await interlock.canDisrupt({ stableKey: request.stableKey });
	if (!verdict.allow) {
		return { ok: false, reason: `interlock held: ${verdict.reason}` };
	}
	return staticResult;
}
