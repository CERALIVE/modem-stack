// `MMModemMode` ↔ mode NAME, and the (allowed, preferred) COMBINATION, verbatim.
//
// ModemManager advertises what a radio can do as `Modem.SupportedModes`, an `a(uu)`
// of (allowed-mask, preferred-mask) pairs, and what it is doing as `Modem.CurrentModes`,
// one `(uu)`. Everything an operator may legally ask for is in that list, and this
// module's whole job is to carry it across UNCHANGED.
//
// THREE THINGS ARE ROUTINELY LOST BY A DECODER THAT MEANS WELL, and each one is a
// documented CeraLive case rather than a hypothetical:
//
//   1. `preferred: 0` (`MM_MODEM_MODE_NONE`). The bench Fibocom FM350-GL advertises
//      exactly one combination, and its preferred mask is 0 — the modem allows a set
//      of modes and states NO preference within it. That is a real, legal answer, and
//      it is NOT the same as "prefer the highest allowed mode". Substituting a default
//      shows an operator a preference the modem never expressed and cannot be returned
//      to. `preferred` is therefore the name `none`, carried through to the operation
//      descriptor's own allowed-value list.
//   2. A bit this build does not name. MM's mode enum grows; a mask carrying an
//      unfamiliar bit is still a combination the modem advertised and will accept. It
//      round-trips as `mode-bit-<n>` (the `band-<n>` discipline from `band-names.ts`),
//      the combination is CLASSIFIED `unknown-combination`, and it stays offerable.
//      `unknown` is never coerced to `unsupported` — that is the support-claim
//      taxonomy's first rule, and it applies to a mode catalog exactly as it does to a
//      capability probe.
//   3. A member that is not a `(uu)` at all. Dropping it silently shortens the catalog,
//      so `decodeSupportedModeCombinations` RETAINS it in a separate `undecodable`
//      list. Decoded + undecodable always equals what the provider sent.
//
// This module is pure and total: no transport, no clock, no I/O. The `SetCurrentModes`
// call itself stays where every other radio mutation lives (`backend/mm-mutations.ts`).

/** A mode as every operator-facing surface spells it. Opaque; compare by equality. */
export type ModeName = string;

/**
 * `MM_MODEM_MODE_NONE` (0) — the modem expresses no preference within its allowed set.
 * A legal, load-bearing value; never a stand-in for "not reported".
 */
export const MODE_NONE = 'none';

/** `MM_MODEM_MODE_ANY` (0xFFFFFFFF) — every mode the modem has. */
export const MODE_ANY = 'any';
const MODE_ANY_VALUE = 0xffffffff;

/** The named `MMModemMode` bits, in MM's own bit order. */
const NAMED_BITS: readonly (readonly [number, ModeName])[] = [
	[1 << 0, 'cs'],
	[1 << 1, '2g'],
	[1 << 2, '3g'],
	[1 << 3, '4g'],
	[1 << 4, '5g'],
];

const BIT_TO_NAME = new Map<number, ModeName>(NAMED_BITS);
const NAME_TO_BIT = new Map<ModeName, number>(NAMED_BITS.map(([bit, name]) => [name, bit]));

/** The passthrough spelling for a mode bit this build does not name. */
const PASSTHROUGH_RE = /^mode-bit-(\d+)$/;

const NAMED_MASK = NAMED_BITS.reduce((mask, [bit]) => mask | bit, 0);

/** Decode one `MMModemMode` bit. Total: an unnamed bit round-trips. */
export function modeName(bit: number): ModeName {
	return BIT_TO_NAME.get(bit) ?? `mode-bit-${bit}`;
}

/** Encode one mode name. `undefined` for a name this build cannot place. */
export function modeValue(name: ModeName): number | undefined {
	if (name === MODE_NONE) return 0;
	if (name === MODE_ANY) return MODE_ANY_VALUE;
	const known = NAME_TO_BIT.get(name);
	if (known !== undefined) return known;
	const passthrough = PASSTHROUGH_RE.exec(name);
	if (passthrough?.[1] === undefined) return undefined;
	const parsed = Number(passthrough[1]);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** True when this build recognises the name (a `mode-bit-<n>` passthrough does not). */
export function isNamedMode(name: ModeName): boolean {
	return name === MODE_NONE || name === MODE_ANY || NAME_TO_BIT.has(name);
}

/**
 * Split a mask into its set bits, named where this build can and passed through where
 * it cannot. A zero mask is the EMPTY set — the caller decides whether that reads as
 * `none` (a preference) or as an anomaly (an allowed set nothing can be chosen from).
 */
export function modeNames(mask: number): readonly ModeName[] {
	if (!Number.isSafeInteger(mask) || mask <= 0) return [];
	if (mask === MODE_ANY_VALUE) return [MODE_ANY];
	const names: ModeName[] = [];
	for (let bit = 1; bit <= mask && bit > 0; bit *= 2) {
		if ((mask & bit) !== 0) names.push(modeName(bit));
	}
	return names;
}

/** Encode a set of mode names into one mask. Fails closed on an unplaceable name. */
export function encodeModeNames(
	names: readonly ModeName[],
):
	| { readonly ok: true; readonly mask: number }
	| { readonly ok: false; readonly unknown: ModeName } {
	let mask = 0;
	for (const name of names) {
		const value = modeValue(name);
		if (value === undefined) return { ok: false, unknown: name };
		mask |= value;
	}
	return { ok: true, mask: mask >>> 0 };
}

/** Why a combination could not be fully placed. Never a reason to hide it. */
export const MODE_COMBINATION_ANOMALIES = [
	/** The allowed mask carries a bit this build does not name. */
	'unnamed-allowed-bit',
	/** The preferred mask carries a bit this build does not name. */
	'unnamed-preferred-bit',
	/** The preferred mode is not a member of the allowed set. */
	'preferred-not-in-allowed',
	/** The preferred mask names more than one mode; MM's contract is at most one. */
	'preferred-not-singular',
	/** The allowed mask is zero — nothing can be selected from this combination. */
	'empty-allowed',
] as const;
export type ModeCombinationAnomaly = (typeof MODE_COMBINATION_ANOMALIES)[number];

export type ModeCombinationClassification = 'named' | 'unknown-combination';

/**
 * One `(allowed, preferred)` pair, decoded without loss.
 *
 * The masks are retained ALONGSIDE the names so a consumer can always reproduce the
 * exact bytes the modem reported, whatever this build managed to name.
 */
export type ModeCombination = {
	readonly allowedMask: number;
	readonly allowed: readonly ModeName[];
	readonly preferredMask: number;
	/** `none` when the modem stated no preference — verbatim, never a substitute. */
	readonly preferred: ModeName;
	readonly classification: ModeCombinationClassification;
	readonly anomalies: readonly ModeCombinationAnomaly[];
};

/**
 * A `SupportedModes` catalog: everything decoded, plus everything that could not be.
 *
 * `undecodable` exists so the no-drop property is structural rather than a promise —
 * `combinations.length + undecodable.length` is the member count the provider sent.
 */
export type ModeCombinationSet = {
	readonly combinations: readonly ModeCombination[];
	/** Members that were not a `(uu)` pair, retained exactly as the provider sent them. */
	readonly undecodable: readonly unknown[];
};

function isUnnamed(names: readonly ModeName[]): boolean {
	return names.some((name) => !isNamedMode(name));
}

/** Build a combination from two raw masks, recording every anomaly it carries. */
export function modeCombination(allowedMask: number, preferredMask: number): ModeCombination {
	const allowed = modeNames(allowedMask);
	const preferredNames = modeNames(preferredMask);
	const anomalies: ModeCombinationAnomaly[] = [];
	if (allowed.length === 0) anomalies.push('empty-allowed');
	if (isUnnamed(allowed)) anomalies.push('unnamed-allowed-bit');
	if (isUnnamed(preferredNames)) anomalies.push('unnamed-preferred-bit');
	if (preferredNames.length > 1) anomalies.push('preferred-not-singular');
	// A zero preferred mask is `none` and is NOT an anomaly: it is MM's own way of
	// saying "no preference within the allowed set", which the FM350 actually reports.
	if (
		preferredNames.length > 0 &&
		preferredMask !== MODE_ANY_VALUE &&
		(preferredMask & allowedMask) !== preferredMask
	) {
		anomalies.push('preferred-not-in-allowed');
	}
	return {
		allowedMask,
		allowed,
		preferredMask,
		preferred: preferredNames.length === 0 ? MODE_NONE : (preferredNames.join('+') as ModeName),
		classification: anomalies.length === 0 ? 'named' : 'unknown-combination',
		anomalies,
	};
}

/** True when the modem stated no preference within this combination's allowed set. */
export function statesNoPreference(combination: ModeCombination): boolean {
	return combination.preferredMask === 0;
}

function decodePair(value: unknown): readonly [number, number] | undefined {
	if (!Array.isArray(value) || value.length !== 2) return undefined;
	const [allowed, preferred] = value;
	if (typeof allowed !== 'number' || !Number.isSafeInteger(allowed) || allowed < 0)
		return undefined;
	if (typeof preferred !== 'number' || !Number.isSafeInteger(preferred) || preferred < 0) {
		return undefined;
	}
	return [allowed, preferred];
}

/** Decode one `CurrentModes` `(uu)`. `undefined` only when the value is not a pair. */
export function decodeModeCombination(value: unknown): ModeCombination | undefined {
	const pair = decodePair(value);
	return pair === undefined ? undefined : modeCombination(pair[0], pair[1]);
}

/**
 * Decode a `SupportedModes` `a(uu)`.
 *
 * Nothing is dropped: a member that is not a pair lands in `undecodable`, and a pair
 * this build cannot fully name lands in `combinations` classified
 * `unknown-combination`. A non-array value is an empty catalog, not an error — a modem
 * that advertises no mode control is a real reading.
 */
export function decodeSupportedModeCombinations(value: unknown): ModeCombinationSet {
	if (!Array.isArray(value)) return { combinations: [], undecodable: [] };
	const combinations: ModeCombination[] = [];
	const undecodable: unknown[] = [];
	for (const member of value) {
		const pair = decodePair(member);
		if (pair === undefined) undecodable.push(member);
		else combinations.push(modeCombination(pair[0], pair[1]));
	}
	return { combinations, undecodable };
}

/** True when any advertised combination carries an anomaly this build could not place. */
export function hasUnknownCombination(set: ModeCombinationSet): boolean {
	return (
		set.undecodable.length > 0 ||
		set.combinations.some((each) => each.classification === 'unknown-combination')
	);
}

/** Whether a mask names a mode this build recognises across every set bit. */
export function isFullyNamedMask(mask: number): boolean {
	return mask === MODE_ANY_VALUE || mask === 0 || (mask & ~NAMED_MASK) === 0;
}
