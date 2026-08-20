// What the modem says it can do with its modes, and the operation descriptor built
// from exactly that — nothing added, nothing narrowed.
//
// `capability/five-g-preference.ts` maps four named POSTURES onto an (allowed,
// preferred) pair and refuses to name one the modem never advertised. This module is
// the layer underneath it: the modem's own catalog, unedited, so a posture selector
// and a raw combination selector are reading the same truth. It deliberately does not
// know what a posture is.
//
// THE OFFERED SET IS THE ADVERTISED SET. A combination classified
// `unknown-combination` — an unfamiliar mode bit, a preferred mode outside its own
// allowed set — is STILL offered, because the modem advertised it and will accept it.
// Hiding it would be coercing `unknown` into `unsupported`, which is the one thing
// `support-claim.ts` exists to stop.

import { defineOperationDescriptor, type OperationDescriptor } from '../domain';
import {
	decodeModeCombination,
	decodeSupportedModeCombinations,
	encodeModeNames,
	MODE_NONE,
	type ModeCombination,
	type ModeCombinationSet,
	type ModeName,
	statesNoPreference,
} from './mode-combinations';

/**
 * A mode selection as a caller expresses it: the set to allow, and the one to prefer
 * within it. `preferred: 'none'` is a first-class selection, not a missing field.
 */
export type ModeSelection = {
	readonly allowed: readonly ModeName[];
	readonly preferred: ModeName;
};

/** `CurrentModes` as a reading — "the modem did not report it" is an answer, not a null. */
export type ModeCombinationReading =
	| { readonly state: 'reported'; readonly combination: ModeCombination }
	| { readonly state: 'not-reported' };

export type RadioModeTruth = {
	readonly current: ModeCombinationReading;
	readonly supported: ModeCombinationSet;
};

export function readRadioModeTruth(input: {
	readonly currentModes: unknown;
	readonly supportedModes: unknown;
}): RadioModeTruth {
	const current = decodeModeCombination(input.currentModes);
	return {
		current:
			current === undefined
				? { state: 'not-reported' }
				: { state: 'reported', combination: current },
		supported: decodeSupportedModeCombinations(input.supportedModes),
	};
}

/** The selection a combination represents, with `preferred` carried across verbatim. */
export function selectionOf(combination: ModeCombination): ModeSelection {
	return { allowed: combination.allowed, preferred: combination.preferred };
}

function sameNameSet(left: readonly ModeName[], right: readonly ModeName[]): boolean {
	if (left.length !== right.length) return false;
	const sorted = [...right].sort();
	return [...left].sort().every((name, index) => name === sorted[index]);
}

/** Two selections are the same when both the allowed set AND the preference agree. */
export function sameSelection(left: ModeSelection, right: ModeSelection): boolean {
	return left.preferred === right.preferred && sameNameSet(left.allowed, right.allowed);
}

/**
 * The advertised combination a selection names, or `undefined`.
 *
 * `undefined` is the whole answer — never the nearest neighbour. `prefer-4g` silently
 * becoming `prefer-5g` on a marginal cell is the exact substitution
 * `five-g-preference.ts` refuses, and it is refused here for the same reason.
 */
export function matchAdvertisedCombination(
	supported: ModeCombinationSet,
	selection: ModeSelection,
): ModeCombination | undefined {
	return supported.combinations.find((each) => sameSelection(selectionOf(each), selection));
}

/** The masks `SetCurrentModes` needs, or the name that could not be placed. */
export function encodeModeSelection(
	selection: ModeSelection,
):
	| { readonly ok: true; readonly allowedMask: number; readonly preferredMask: number }
	| { readonly ok: false; readonly unknown: ModeName } {
	const allowed = encodeModeNames(selection.allowed);
	if (!allowed.ok) return allowed;
	const preferred = encodeModeNames(selection.preferred === MODE_NONE ? [] : [selection.preferred]);
	if (!preferred.ok) return preferred;
	return { ok: true, allowedMask: allowed.mask, preferredMask: preferred.mask };
}

export const MODE_WRITE_OPERATION_ID = 'modemmanager.mode-combination';

/** Why a mode write is not on offer right now. */
export type ModeWriteRefusal = 'mode-write-unsupported' | 'no-advertised-mode-combinations';

export type ModeWriteDescriptorInput = {
	readonly provider: string;
	readonly profile: string;
	readonly truth: RadioModeTruth;
	readonly writeSupported: boolean;
};

/**
 * The live mode-write descriptor.
 *
 * `constraints` is an `allowed-values` list built from the modem's OWN catalog, so a
 * combination carrying `preferred: 'none'` reaches a consumer through the descriptor
 * exactly as the modem stated it. Readback is REQUIRED: `SetCurrentModes` returning
 * without an error only proves the daemon accepted the call, and an
 * accepted-but-ignored mode write is indistinguishable from success at the call site.
 */
export function buildModeWriteDescriptor(
	input: ModeWriteDescriptorInput,
): OperationDescriptor<ModeSelection, RadioModeTruth> {
	const values = input.truth.supported.combinations.map(selectionOf);
	const refusal: ModeWriteRefusal | undefined = !input.writeSupported
		? 'mode-write-unsupported'
		: values.length === 0
			? 'no-advertised-mode-combinations'
			: undefined;
	return defineOperationDescriptor<ModeSelection, RadioModeTruth>({
		id: MODE_WRITE_OPERATION_ID,
		support: {
			read: { supported: true },
			write: input.writeSupported
				? { supported: true }
				: { supported: false, reason: 'mode-write-unsupported' },
		},
		authority: 'provider',
		provider: input.provider,
		constraints: { kind: 'allowed-values', values },
		livePreconditions: [
			'modem-present',
			'runtime-interface-present',
			'mode-combination-advertised',
		],
		availability:
			refusal === undefined ? { state: 'available' } : { state: 'refused', reason: refusal },
		mutationImpact: 'disruptive',
		retryClass: 'never',
		readback: {
			required: true,
			reason: 'mode-write-readback',
			matches: (selection, observed) =>
				observed.current.state === 'reported' &&
				sameSelection(selectionOf(observed.current.combination), selection),
		},
		rollback: { required: false },
		journal: { required: true, reason: 'disruptive-radio-write' },
		admission: { required: true, reason: 'provider-mutation' },
		evidence: { profiles: [input.profile], firmware: [] },
		confidence: 'high',
	});
}

/** True when the modem advertises at least one combination stating no preference. */
export function advertisesNoPreference(truth: RadioModeTruth): boolean {
	return truth.supported.combinations.some(statesNoPreference);
}
