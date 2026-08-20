// Why a USSD verb did not succeed — one typed vocabulary, and the classifier that
// maps ModemManager's own failure surface onto it.
//
// The point of typing these is that every member names a DIFFERENT thing the
// operator can do, and the one this module exists for is the honest reporting of
// a carrier that will not carry USSD at all on the registration the modem has.
//
// THE LTE-ONLY CASE, stated plainly. USSD is a circuit-switched supplementary
// service. A modem registered PS-only — LTE or 5G-SA with no CS domain and no
// CSFB — can only carry it if the operator deploys USSI (USSD over IMS, 3GPP TS
// 24.390); many do not, and the modem/network then answers a generic
// unsupported/failed error that is indistinguishable, on its face, from "this
// modem has no USSD interface". Reporting that as a device limitation would send
// an operator hunting for a firmware fix for a network policy, so the classifier
// takes the modem's REGISTRATION alongside the error and separates the two.
//
// Nothing here guesses: `lte-only-unsupported` is claimed ONLY when the
// registration is positively known to be PS-only. An unknown registration keeps
// the generic reason, because "we did not look" is not evidence.

/**
 * Every way a USSD verb can fail to do what the operator asked.
 *
 *   unsupported          — this modem exposes no USSD interface at all.
 *   lte-only-unsupported — the modem is registered PS-only (LTE/5G with no CS
 *                          domain) and the network refused. NOT a device fault.
 *   carrier-rejected     — the network refused for some other reason.
 *   not-registered       — there is no network to carry the session.
 *   session-busy         — a session is already open (locally or network-side).
 *   no-session           — respond/cancel with nothing open.
 *   invalid-state        — the verb is wrong for the state the session is in.
 *   timeout              — the bounded wait elapsed with no answer.
 *   transport-failed     — the bus call itself failed; the modem never answered.
 */
export const USSD_REFUSAL_REASONS = [
	'unsupported',
	'lte-only-unsupported',
	'carrier-rejected',
	'not-registered',
	'session-busy',
	'no-session',
	'invalid-state',
	'timeout',
	'transport-failed',
] as const;
export type UssdRefusalReason = (typeof USSD_REFUSAL_REASONS)[number];

/**
 * What the modem is registered on, as far as anyone has looked.
 *
 * `csDomain` is the load-bearing field: `false` means the modem is attached with
 * NO circuit-switched domain available (LTE/5G-SA without CSFB), which is the
 * registration on which a plain USSD refusal is a carrier-policy statement rather
 * than a device one. `undefined` means nobody read it, and is never treated as
 * `false`.
 */
export interface UssdRegistrationFacts {
	readonly registered: boolean;
	/** Is a circuit-switched domain available on this registration? */
	readonly csDomain?: boolean;
	/** MM access technologies currently in use, lowercased (`lte`, `5gnr`, …). */
	readonly accessTechnologies?: readonly string[];
}

/** Access technologies that carry no circuit-switched domain of their own. */
const PACKET_ONLY_RATS: ReadonlySet<string> = new Set<string>([
	'lte',
	'5gnr',
	'lte-cat-m',
	'lte-nb-iot',
]);

/**
 * True when the modem's registration positively cannot carry a circuit-switched
 * service. Requires evidence in BOTH directions: something must say the CS domain
 * is absent, and every technology in use must be a packet-only one. A modem that
 * reported no technologies at all answers `false` — an empty list is a statement
 * about the read.
 */
export function isPacketSwitchedOnly(facts: UssdRegistrationFacts): boolean {
	if (!facts.registered) {
		return false;
	}
	if (facts.csDomain !== false) {
		return false;
	}
	const rats = facts.accessTechnologies;
	if (rats === undefined || rats.length === 0) {
		return false;
	}
	return rats.every((rat) => PACKET_ONLY_RATS.has(rat.toLowerCase()));
}

/**
 * ModemManager D-Bus error names this classifier recognises, matched on the
 * SUFFIX after the last dot so a future `...Error.Core.Unsupported` regrouping
 * does not silently fall through to `transport-failed`.
 */
const ERROR_SUFFIX_REASONS: ReadonlyMap<string, UssdRefusalReason> = new Map<
	string,
	UssdRefusalReason
>([
	['Unsupported', 'unsupported'],
	['NotSupported', 'unsupported'],
	['InProgress', 'session-busy'],
	['NoNetwork', 'not-registered'],
	['NotRegistered', 'not-registered'],
	['Timeout', 'timeout'],
	['Aborted', 'carrier-rejected'],
	['Failed', 'carrier-rejected'],
]);

/**
 * Message fragments that identify a refusal no error NAME distinguishes. MM
 * folds several modem answers into `Core.Failed`, so the text is the only signal
 * separating "the network said no" from "the bus call broke".
 */
const MESSAGE_REASONS: readonly (readonly [RegExp, UssdRefusalReason])[] = [
	[/ussd.*(?:not supported|unsupported)/i, 'unsupported'],
	[/(?:session|operation) (?:already )?(?:active|in progress)/i, 'session-busy'],
	[/no (?:active )?ussd session/i, 'no-session'],
	[/not registered|no network/i, 'not-registered'],
	[/timed? ?out/i, 'timeout'],
	[/rejected|refused|denied|network error/i, 'carrier-rejected'],
];

function errorName(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) {
		return undefined;
	}
	const name = (error as { dbusName?: unknown; name?: unknown }).dbusName;
	if (typeof name === 'string' && name.includes('.')) {
		return name;
	}
	const fallback = (error as { name?: unknown }).name;
	return typeof fallback === 'string' && fallback.includes('.') ? fallback : undefined;
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'object' && error !== null) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === 'string') {
			return message;
		}
	}
	return String(error);
}

/**
 * Classify a failed USSD call. Pure, total, never throws.
 *
 * Order is deliberate: the D-Bus error NAME is the strongest signal and is read
 * first; the message text is consulted only for the names MM overloads; anything
 * unrecognised stays `transport-failed`, which is the honest answer for a failure
 * whose origin cannot be attributed to the network.
 *
 * The PS-only promotion runs LAST and applies to exactly the two reasons that are
 * ambiguous between a device limit and a carrier policy — a `not-registered` or a
 * bus failure is neither, and is left alone.
 */
export function classifyUssdFailure(
	error: unknown,
	registration: UssdRegistrationFacts = { registered: false },
): UssdRefusalReason {
	const name = errorName(error);
	const suffix = name?.slice(name.lastIndexOf('.') + 1);
	const message = errorMessage(error);

	let reason: UssdRefusalReason | undefined =
		suffix === undefined ? undefined : ERROR_SUFFIX_REASONS.get(suffix);

	// `Core.Failed` is MM's catch-all, so its message is worth more than its name.
	if (reason === undefined || reason === 'carrier-rejected') {
		for (const [pattern, mapped] of MESSAGE_REASONS) {
			if (pattern.test(message)) {
				reason = mapped;
				break;
			}
		}
	}

	if (reason === undefined) {
		return 'transport-failed';
	}

	const ambiguous = reason === 'unsupported' || reason === 'carrier-rejected';
	return ambiguous && isPacketSwitchedOnly(registration) ? 'lte-only-unsupported' : reason;
}
