// The USSD session machine, one test per (state, event) cell.
//
// The table below is the CONTRACT, not a convenience: a USSD session is a scarce
// network-side resource, so "which verb is legal here" has a wrong answer that
// costs the operator a busy error they cannot explain. Every cell is enumerated
// and every cell is its own test, so adding a state or an event fails loudly
// (the exhaustiveness check at the bottom) instead of silently landing in a
// default branch.

import { describe, expect, test } from 'bun:test';
import {
	IDLE_SESSION,
	isUssdSessionOpen,
	reduceUssdSession,
	USSD_SESSION_STATES,
	type UssdSessionEvent,
	type UssdSessionSnapshot,
	type UssdSessionState,
} from './session';

const EVENTS = {
	initiate: { kind: 'initiate' },
	respond: { kind: 'respond' },
	cancel: { kind: 'cancel' },
	'replied(awaiting-reply)': { kind: 'replied', sessionState: 'awaiting-reply' },
	'replied(active)': { kind: 'replied', sessionState: 'active' },
	'replied(released)': { kind: 'replied', sessionState: 'released' },
	cancelled: { kind: 'cancelled' },
	'network-released': { kind: 'network-released' },
	timeout: { kind: 'timeout' },
	failed: { kind: 'failed', reason: 'carrier-rejected' },
} as const satisfies Record<string, UssdSessionEvent>;

type EventName = keyof typeof EVENTS;

/** `open:<state>` | `close:<outcome>` | `refuse:<reason>`. */
type Expected = string;

const TABLE: Record<UssdSessionState, Record<EventName, Expected>> = {
	idle: {
		initiate: 'open:initiating',
		respond: 'refuse:invalid-state',
		cancel: 'refuse:no-session',
		'replied(awaiting-reply)': 'refuse:invalid-state',
		'replied(active)': 'refuse:invalid-state',
		'replied(released)': 'refuse:invalid-state',
		cancelled: 'refuse:invalid-state',
		'network-released': 'refuse:no-session',
		timeout: 'refuse:no-session',
		failed: 'refuse:no-session',
	},
	initiating: {
		initiate: 'refuse:session-busy',
		respond: 'refuse:invalid-state',
		cancel: 'open:cancelling',
		'replied(awaiting-reply)': 'open:awaiting-reply',
		'replied(active)': 'open:active',
		'replied(released)': 'close:completed',
		cancelled: 'refuse:invalid-state',
		'network-released': 'close:completed',
		timeout: 'close:timed-out',
		failed: 'close:failed',
	},
	active: {
		initiate: 'refuse:session-busy',
		respond: 'refuse:invalid-state',
		cancel: 'open:cancelling',
		'replied(awaiting-reply)': 'refuse:invalid-state',
		'replied(active)': 'refuse:invalid-state',
		'replied(released)': 'refuse:invalid-state',
		cancelled: 'refuse:invalid-state',
		'network-released': 'close:completed',
		timeout: 'close:timed-out',
		failed: 'close:failed',
	},
	'awaiting-reply': {
		initiate: 'refuse:session-busy',
		respond: 'open:responding',
		cancel: 'open:cancelling',
		'replied(awaiting-reply)': 'refuse:invalid-state',
		'replied(active)': 'refuse:invalid-state',
		'replied(released)': 'refuse:invalid-state',
		cancelled: 'refuse:invalid-state',
		'network-released': 'close:completed',
		timeout: 'close:timed-out',
		failed: 'close:failed',
	},
	responding: {
		initiate: 'refuse:session-busy',
		respond: 'refuse:invalid-state',
		cancel: 'open:cancelling',
		'replied(awaiting-reply)': 'open:awaiting-reply',
		'replied(active)': 'open:active',
		'replied(released)': 'close:completed',
		cancelled: 'refuse:invalid-state',
		'network-released': 'close:completed',
		timeout: 'close:timed-out',
		failed: 'close:failed',
	},
	cancelling: {
		initiate: 'refuse:session-busy',
		respond: 'refuse:invalid-state',
		cancel: 'refuse:invalid-state',
		'replied(awaiting-reply)': 'refuse:invalid-state',
		'replied(active)': 'refuse:invalid-state',
		'replied(released)': 'refuse:invalid-state',
		cancelled: 'close:cancelled',
		'network-released': 'close:cancelled',
		timeout: 'close:timed-out',
		failed: 'close:failed',
	},
	closed: {
		initiate: 'refuse:no-session',
		respond: 'refuse:no-session',
		cancel: 'refuse:no-session',
		'replied(awaiting-reply)': 'refuse:no-session',
		'replied(active)': 'refuse:no-session',
		'replied(released)': 'refuse:no-session',
		cancelled: 'refuse:no-session',
		'network-released': 'refuse:no-session',
		timeout: 'refuse:no-session',
		failed: 'refuse:no-session',
	},
};

/**
 * Reach a state by DRIVING the machine from idle rather than casting a literal,
 * so every state in the table is proven reachable through legal events. A cast
 * would let an unreachable state sit in the table looking covered.
 */
function drive(events: readonly UssdSessionEvent[]): UssdSessionSnapshot {
	let snapshot = IDLE_SESSION;
	for (const event of events) {
		const transition = reduceUssdSession(snapshot, event);
		if (!transition.ok) {
			throw new Error(`could not reach the state: ${event.kind} was refused`);
		}
		snapshot = transition.snapshot;
	}
	return snapshot;
}

const PATHS: Record<UssdSessionState, readonly UssdSessionEvent[]> = {
	idle: [],
	initiating: [EVENTS.initiate],
	active: [EVENTS.initiate, EVENTS['replied(active)']],
	'awaiting-reply': [EVENTS.initiate, EVENTS['replied(awaiting-reply)']],
	responding: [EVENTS.initiate, EVENTS['replied(awaiting-reply)'], EVENTS.respond],
	cancelling: [EVENTS.initiate, EVENTS.cancel],
	closed: [EVENTS.initiate, EVENTS.timeout],
};

function describeTransition(transition: ReturnType<typeof reduceUssdSession>): Expected {
	if (!transition.ok) {
		return `refuse:${transition.refusal}`;
	}
	const { state, outcome } = transition.snapshot;
	return state === 'closed' ? `close:${outcome}` : `open:${state}`;
}

describe('the USSD session transition table', () => {
	for (const state of USSD_SESSION_STATES) {
		const start = drive(PATHS[state]);
		expect(start.state).toBe(state);

		for (const eventName of Object.keys(EVENTS) as EventName[]) {
			const expected = TABLE[state][eventName];
			test(`${state} + ${eventName} -> ${expected}`, () => {
				const transition = reduceUssdSession(start, EVENTS[eventName]);
				expect(describeTransition(transition)).toBe(expected);
			});
		}
	}
});

test('the table covers every state and every event, and nothing more', () => {
	expect(Object.keys(TABLE).sort()).toEqual([...USSD_SESSION_STATES].sort());
	const eventNames = Object.keys(EVENTS).sort();
	for (const state of USSD_SESSION_STATES) {
		expect(Object.keys(TABLE[state]).sort()).toEqual(eventNames);
	}
});

test('a refused verb leaves the machine untouched', () => {
	const awaiting = drive(PATHS['awaiting-reply']);
	const transition = reduceUssdSession(awaiting, EVENTS.initiate);
	expect(transition.ok).toBe(false);
	// The caller still holds the snapshot it passed in; nothing here mutates it.
	expect(awaiting.state).toBe('awaiting-reply');
});

test('a failed session carries its refusal onto the terminal state', () => {
	const transition = reduceUssdSession(drive(PATHS.initiating), {
		kind: 'failed',
		reason: 'lte-only-unsupported',
	});
	expect(transition.ok).toBe(true);
	if (!transition.ok) return;
	expect(transition.snapshot).toEqual({
		state: 'closed',
		outcome: 'failed',
		refusal: 'lte-only-unsupported',
	});
});

test('a completed session carries no refusal', () => {
	const transition = reduceUssdSession(drive(PATHS.responding), EVENTS['replied(released)']);
	expect(transition.ok).toBe(true);
	if (!transition.ok) return;
	expect(transition.snapshot.refusal).toBeUndefined();
	expect(transition.snapshot.outcome).toBe('completed');
});

test('a session is open in every state but idle and closed', () => {
	for (const state of USSD_SESSION_STATES) {
		const expected = state !== 'idle' && state !== 'closed';
		expect(isUssdSessionOpen(drive(PATHS[state]))).toBe(expected);
	}
});
