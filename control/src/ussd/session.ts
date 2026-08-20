// The USSD session state machine — pure, total, and the only place a session's
// legality is decided.
//
// USSD is a SESSION protocol, not a request/response one: `Initiate` opens a
// dialogue the network may keep open pending a `Respond`, and a session that is
// neither responded to nor cancelled stays open on the NETWORK side, consuming a
// scarce per-subscriber slot and blocking the next `Initiate` with a busy error.
// So "which verb is legal right now" is a real question with a real wrong answer,
// and answering it inside the D-Bus adapter would make it untestable without a
// bus. It lives here instead, as data.
//
// Everything the machine can be told is an EVENT and every answer is a
// TRANSITION — an illegal verb is REFUSED with a typed reason, never thrown and
// never silently ignored. A refusal at an RPC boundary must name what the caller
// can do about it; a throw becomes an opaque failure and a silent no-op becomes a
// UI that spins forever.
//
// The machine carries NO carrier text. The reply an operator sees is threaded by
// the adapter and redacted at every log boundary (`../redact`); keeping it out of
// the state entirely means a state snapshot can never leak one.

import type { UssdRefusalReason } from './refusal';

/**
 * Session states.
 *
 * Three of them (`idle`, `active`, `awaiting-reply`) mirror MM's own
 * `MMModem3gppUssdSessionState`; the rest are LOCAL in-flight states, because MM
 * has no state for "we dispatched a call and the reply has not landed". Without
 * them a second `initiate` racing the first would be judged against `idle` and
 * allowed through, which is exactly the double-open the network answers busy.
 */
export const USSD_SESSION_STATES = [
	/** No session. MM `IDLE`. */
	'idle',
	/** `Initiate` dispatched, reply outstanding. Local. */
	'initiating',
	/** Network answered and the session is open with nothing pending. MM `ACTIVE`. */
	'active',
	/** Network asked a question; a `Respond` is required. MM `USER_RESPONSE`. */
	'awaiting-reply',
	/** `Respond` dispatched, reply outstanding. Local. */
	'responding',
	/** `Cancel` dispatched, confirmation outstanding. Local. */
	'cancelling',
	/** Terminal for this session object. A new session starts from a new machine. */
	'closed',
] as const;
export type UssdSessionState = (typeof USSD_SESSION_STATES)[number];

/** How a session that reached `closed` got there. */
export const USSD_SESSION_OUTCOMES = [
	/** The network completed the dialogue and released the session. */
	'completed',
	/** The operator cancelled it. */
	'cancelled',
	/** No answer within the bound; the machine closed it locally. */
	'timed-out',
	/** The network or the modem refused. `refusal` names which. */
	'failed',
] as const;
export type UssdSessionOutcome = (typeof USSD_SESSION_OUTCOMES)[number];

/** MM's post-call session state, decoded. */
export type UssdRepliedState = 'awaiting-reply' | 'active' | 'released';

export type UssdSessionEvent =
	/** The operator asked to open a session. */
	| { readonly kind: 'initiate' }
	/** The operator answered a network prompt. */
	| { readonly kind: 'respond' }
	/** The operator asked to close the session. */
	| { readonly kind: 'cancel' }
	/**
	 * The network answered an `Initiate`/`Respond`. `sessionState` is MM's own
	 * post-call `Modem3gpp.Ussd.State`, decoded: the network either wants an
	 * answer, is holding the session open with nothing pending, or released it.
	 */
	| { readonly kind: 'replied'; readonly sessionState: UssdRepliedState }
	/** A `Cancel` was confirmed by the modem. */
	| { readonly kind: 'cancelled' }
	/** The network released the session without our asking (notification path). */
	| { readonly kind: 'network-released' }
	/** The bounded wait elapsed with no answer. */
	| { readonly kind: 'timeout' }
	/** The call failed. The reason is carried onto the terminal state verbatim. */
	| { readonly kind: 'failed'; readonly reason: UssdRefusalReason };

export interface UssdSessionSnapshot {
	readonly state: UssdSessionState;
	/** Present only at `closed`. */
	readonly outcome?: UssdSessionOutcome;
	/** Present only at `closed` with outcome `failed`. */
	readonly refusal?: UssdRefusalReason;
}

export type UssdTransition =
	| { readonly ok: true; readonly snapshot: UssdSessionSnapshot }
	/** The verb is not legal in this state, and the machine did NOT move. */
	| { readonly ok: false; readonly refusal: UssdRefusalReason };

export const IDLE_SESSION: UssdSessionSnapshot = { state: 'idle' };

/** States in which an operator verb may be dispatched at all. */
const ACCEPTS_INITIATE: ReadonlySet<UssdSessionState> = new Set<UssdSessionState>(['idle']);
const ACCEPTS_RESPOND: ReadonlySet<UssdSessionState> = new Set<UssdSessionState>([
	'awaiting-reply',
]);
const ACCEPTS_CANCEL: ReadonlySet<UssdSessionState> = new Set<UssdSessionState>([
	'initiating',
	'active',
	'awaiting-reply',
	'responding',
]);

/** States with a call in flight — the only ones a network answer may land on. */
const IN_FLIGHT: ReadonlySet<UssdSessionState> = new Set<UssdSessionState>([
	'initiating',
	'responding',
]);

function open(state: UssdSessionState): UssdTransition {
	return { ok: true, snapshot: { state } };
}

function close(outcome: UssdSessionOutcome, refusal?: UssdRefusalReason): UssdTransition {
	return {
		ok: true,
		snapshot: { state: 'closed', outcome, ...(refusal === undefined ? {} : { refusal }) },
	};
}

function refuse(refusal: UssdRefusalReason): UssdTransition {
	return { ok: false, refusal };
}

/**
 * Apply one event. TOTAL: every (state, event) pair has an answer, and an answer
 * is either a new snapshot or a typed refusal that leaves the machine untouched.
 *
 * A `closed` machine accepts NOTHING — not even another `cancel`. Re-opening a
 * terminal session would hide the fact that the previous one ended, and the
 * cost of a fresh machine is one object.
 */
export function reduceUssdSession(
	snapshot: UssdSessionSnapshot,
	event: UssdSessionEvent,
): UssdTransition {
	const state = snapshot.state;
	if (state === 'closed') {
		return refuse('no-session');
	}

	// Every event except `initiate` describes something happening TO a session,
	// and an idle machine has none for them to happen to.
	const sessionOpen = state !== 'idle';

	switch (event.kind) {
		case 'initiate':
			// A session already in flight or open is the busy case the network
			// itself would answer — refused locally so no second dialogue is opened.
			return ACCEPTS_INITIATE.has(state) ? open('initiating') : refuse('session-busy');

		case 'respond':
			// Responding to a session that never asked a question is not a busy
			// device; it is the wrong verb, and `invalid-state` says so.
			return ACCEPTS_RESPOND.has(state) ? open('responding') : refuse('invalid-state');

		case 'cancel':
			// The two refusals are different operator facts: nothing to close, vs a
			// cancel that is already in flight.
			if (ACCEPTS_CANCEL.has(state)) {
				return open('cancelling');
			}
			return refuse(sessionOpen ? 'invalid-state' : 'no-session');

		case 'replied':
			// A network answer that lands on a state with no call in flight is
			// evidence of a lost reply or a duplicate; it is refused rather than
			// used to resurrect a session the machine already moved past.
			if (!IN_FLIGHT.has(state)) {
				return refuse('invalid-state');
			}
			// The three-way answer is the dialogue-vs-one-shot distinction, and
			// collapsing `active` into `released` is what would leave a session MM
			// still considers open dangling on the network side.
			if (event.sessionState === 'released') {
				return close('completed');
			}
			return open(event.sessionState);

		case 'cancelled':
			// Only a machine that asked to cancel may be closed by one, so a stray
			// confirmation cannot tear down a live dialogue.
			return state === 'cancelling' ? close('cancelled') : refuse('invalid-state');

		case 'network-released':
			// The network is authoritative about its own session, so this lands
			// from anywhere the session is still open — including mid-call, where
			// it is the honest end of a dialogue whose reply will not come. During
			// a cancel it is reported as `cancelled`: the operator asked for the
			// session to end and it ended.
			if (!sessionOpen) {
				return refuse('no-session');
			}
			return close(state === 'cancelling' ? 'cancelled' : 'completed');

		case 'timeout':
			// The bound closes rather than reverting: after an unanswered call the
			// network's own view is unknown, and pretending we are back at `idle`
			// would let the next `initiate` walk into a busy error with no
			// explanation.
			return sessionOpen ? close('timed-out') : refuse('no-session');

		case 'failed':
			return sessionOpen ? close('failed', event.reason) : refuse('no-session');

		default: {
			const unreachable: never = event;
			return unreachable;
		}
	}
}

/** True while the session still holds a network dialogue open. */
export function isUssdSessionOpen(snapshot: UssdSessionSnapshot): boolean {
	return snapshot.state !== 'idle' && snapshot.state !== 'closed';
}
