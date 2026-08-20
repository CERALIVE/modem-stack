// The `five-g-pref` capability module's MODEL — which 5G postures a modem can be
// asked for, how each maps onto ModemManager's `SetCurrentModes`, and which one
// the radio is on right now.
//
// It is pure and total. Nothing here talks to a bus: `MmMutations.setRadioModes`
// already owns the D-Bus call, the per-modem serialization and the quiesce, so
// this module's whole job is to decide WHICH `DesiredRadio` a stated preference
// means and to refuse to name one the modem never advertised.
//
// WHY THE MODULE EXISTS AT ALL, given the 3G/4G/5G selector already writes
// `SetCurrentModes`: that selector's vocabulary is the ALLOWED SET. Two genuinely
// different postures — "allow 4G and 5G, prefer 5G" and "allow 4G and 5G, prefer
// 4G" — share one allowed set and are distinguishable only by the PREFERRED mode,
// which the coarse selector folds away. An operator on a marginal 5G cell wants
// exactly that distinction, and it is the one thing they could not previously ask
// for.

import type { RadioAccessTechnology } from '../domain';
import type { CapabilityEvidence } from './support-claim';

/**
 * The postures this module offers. Deliberately four NAMED intents rather than a
 * free (allowed, preferred) pair: an arbitrary pair is expressible on the wire but
 * not answerable by an operator, and most pairs are postures nobody wants.
 *
 *   5g-only   — allow ONLY 5G. No fallback: out of 5G coverage the modem stops
 *               registering, which is why it is offered but never a default.
 *   prefer-5g — allow 5G and everything below it, rank 5G first.
 *   prefer-4g — the SAME allowed set, ranked LTE first. This is the posture a
 *               marginal 5G cell calls for, and the one the coarse allowed-set
 *               selector structurally cannot express.
 *   5g-off    — allow everything the modem supports EXCEPT 5G.
 */
export const FIVE_G_PREFERENCES = ['5g-only', 'prefer-5g', 'prefer-4g', '5g-off'] as const;
export type FiveGPreference = (typeof FIVE_G_PREFERENCES)[number];

/** One `(allowed, preferred)` pair, the shape MM's `CurrentModes` really carries. */
export interface RadioModeSet {
	readonly allowed: ReadonlySet<RadioAccessTechnology>;
	/** MM's `preferred` is a SINGLE mode, and `none` is a legal answer. */
	readonly preferred?: RadioAccessTechnology | undefined;
}

/** What a stated preference resolves to, in `MmMutations.setRadioModes`'s shape. */
export interface FiveGRadioTarget {
	readonly preferenceOrdered: readonly RadioAccessTechnology[];
	readonly allowedSet: ReadonlySet<RadioAccessTechnology>;
}

/**
 * SA vs NSA — and the honest answer, which is that ModemManager does not expose
 * the choice at all.
 *
 * Checked against MM 1.24.2's own D-Bus surface rather than recalled: the only
 * NR-specific member on a modem object is
 * `Modem.Modem3gpp.SetNr5gRegistrationSettings`, whose keys are `mico-mode` and
 * `drx-cycle` — power-saving registration parameters, not a standalone-vs
 * non-standalone selector. Vendors expose the selector through their own AT
 * commands (Quectel `AT+QNWPREFCFG="mode_pref"`, and one per vendor after that),
 * which is a per-SKU control surface this module deliberately does not open: an
 * uncertified AT write that can cost registration is exactly what the evidence
 * gate exists to keep out.
 *
 * So the axis is REPORTED as unsupported rather than omitted. A missing field
 * reads as "nobody asked"; a stated `not-exposed-by-modemmanager` tells an
 * operator looking for an SA toggle why there is none.
 */
export const NR_MODE_UNSUPPORTED_REASON = 'not-exposed-by-modemmanager' as const;

export interface NrModeSelection {
	readonly supported: false;
	readonly reason: typeof NR_MODE_UNSUPPORTED_REASON;
}

/** The SA/NSA verdict. Constant today, and a function so a future SKU-certified
 *  path replaces one call site rather than every consumer. */
export function nrModeSelection(): NrModeSelection {
	return { supported: false, reason: NR_MODE_UNSUPPORTED_REASON };
}

/** RAT ranking, highest generation first. The ONE ordering this module uses. */
const RAT_ORDER: readonly RadioAccessTechnology[] = ['5gnr', 'lte', 'umts', 'gsm'];

function ranked(rats: ReadonlySet<RadioAccessTechnology>): readonly RadioAccessTechnology[] {
	return RAT_ORDER.filter((rat) => rats.has(rat));
}

/**
 * Does this modem's advertised mode catalog contain 5G?
 *
 * An EMPTY catalog is `unknown`, never `absent` — an unobserved read says nothing
 * about the device, and reporting `absent` there would hide the module on a modem
 * that supports it. This is the same first-class-`unknown` rule `detect.ts`
 * follows, applied one level deeper: `detect.ts` can only see that a
 * `SupportedModes` property EXISTS, which is equally true of a 4G-only modem.
 */
export function fiveGPreferenceEvidence(
	supportedRats: ReadonlySet<RadioAccessTechnology> | undefined,
): CapabilityEvidence {
	if (supportedRats === undefined || supportedRats.size === 0) {
		return 'unknown';
	}
	return supportedRats.has('5gnr') ? 'present' : 'absent';
}

/**
 * Which postures this modem can actually be asked for.
 *
 * A modem with no 5G is offered NOTHING — not `5g-off` either, because "turn 5G
 * off" is a control that would change nothing on a radio that has no 5G, and a
 * control that cannot change anything is the defect this repo's evidence gate
 * exists to keep off an operator's screen.
 *
 * `prefer-5g` / `prefer-4g` / `5g-off` each additionally require a SUB-5G mode to
 * fall back to: on a 5G-only radio they would all collapse onto the same allowed
 * set as `5g-only`, i.e. three labels for one posture.
 */
export function offeredFiveGPreferences(
	supportedRats: ReadonlySet<RadioAccessTechnology> | undefined,
): readonly FiveGPreference[] {
	if (supportedRats === undefined || !supportedRats.has('5gnr')) {
		return [];
	}
	const lower = ranked(supportedRats).filter((rat) => rat !== '5gnr');
	if (lower.length === 0) {
		return ['5g-only'];
	}
	// `prefer-4g` names LTE specifically, so it is offered only on a modem that
	// has LTE. A 5G+UMTS-only radio is not a real fleet device, but naming a mode
	// the modem never advertised is the one thing this module must not do.
	return FIVE_G_PREFERENCES.filter(
		(preference) => preference !== 'prefer-4g' || supportedRats.has('lte'),
	);
}

/**
 * Resolve a stated preference into the `(allowed, preferred)` pair to write.
 *
 * `undefined` means this modem cannot express the posture — the caller must
 * REFUSE rather than substitute a neighbouring one. Substituting is how an
 * operator asks for "prefer 4G" on a marginal cell and silently gets 5G-first.
 */
export function fiveGPreferenceToRadio(
	preference: FiveGPreference,
	supportedRats: ReadonlySet<RadioAccessTechnology> | undefined,
): FiveGRadioTarget | undefined {
	if (supportedRats === undefined || !offeredFiveGPreferences(supportedRats).includes(preference)) {
		return undefined;
	}
	const all = ranked(supportedRats);
	const withoutNr = all.filter((rat) => rat !== '5gnr');

	switch (preference) {
		case '5g-only':
			return { allowedSet: new Set<RadioAccessTechnology>(['5gnr']), preferenceOrdered: ['5gnr'] };
		case 'prefer-5g':
			return { allowedSet: new Set(all), preferenceOrdered: all };
		case 'prefer-4g':
			// The allowed set is IDENTICAL to `prefer-5g`'s — only the ranking moves.
			// That is the whole point of the posture, and it is why a consumer must
			// never diff allowed sets to decide whether a write is needed.
			return {
				allowedSet: new Set(all),
				preferenceOrdered: ['lte', ...all.filter((rat) => rat !== 'lte')],
			};
		case '5g-off':
			return { allowedSet: new Set(withoutNr), preferenceOrdered: withoutNr };
	}
}

/**
 * Which posture a modem's CURRENT modes name — or `undefined` for a pair this
 * model does not name.
 *
 * `undefined` is a first-class answer and must not be rounded to the nearest
 * posture: a radio parked on `allowed: 3g,4g; preferred: 3g` is in a state no 5G
 * preference describes, and reporting one would show an operator a selection they
 * never made and cannot get back to.
 */
export function readFiveGPreference(
	current: RadioModeSet | undefined,
): FiveGPreference | undefined {
	if (current === undefined || current.allowed.size === 0) {
		return undefined;
	}
	const has5g = current.allowed.has('5gnr');
	const others = ranked(current.allowed).filter((rat) => rat !== '5gnr');

	if (!has5g) {
		// A sub-5G allowed set is `5g-off` whatever it ranks first: the posture is
		// about 5G, and this model has no opinion on how 4G and 3G are ordered.
		return '5g-off';
	}
	if (others.length === 0) {
		return '5g-only';
	}
	if (current.preferred === '5gnr') {
		return 'prefer-5g';
	}
	if (current.preferred === 'lte') {
		return 'prefer-4g';
	}
	return undefined;
}

/**
 * Did a readback land on the requested posture?
 *
 * The RESULT of the write is not the write's own acknowledgement — MM answering
 * the method call says the request was accepted, not that the radio took it, and
 * a modem is entitled to clamp a mode set it cannot honour. So a confirmation is
 * a re-read compared against the request, and this is that comparison.
 */
export function fiveGPreferenceConfirmed(
	requested: FiveGPreference,
	readback: RadioModeSet | undefined,
): boolean {
	return readFiveGPreference(readback) === requested;
}
