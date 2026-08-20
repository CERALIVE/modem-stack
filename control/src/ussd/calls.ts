// The four D-Bus calls the USSD adapter makes, and nothing else.
//
// Split from the adapter so the session machinery above can be read without the
// marshalling below, and so a call's shape (interface, member, signature) is
// stated once in one place.
//
// CARRIER TEXT DISCIPLINE: `Initiate` and `Respond` both take and return operator
// text, and neither the command nor the reply may ever reach a log line. Nothing
// in this file logs, and every error raised here is re-thrown untouched so the
// classifier — not a string built around the payload — decides what the caller is
// told.

import { MODEM3GPP_USSD_IFACE, PROPERTIES_IFACE } from '../backend/constants';
import type { DbusTransport } from '../transport';
import type { UssdRepliedState } from './session';

/** `MMModem3gppUssdSessionState`. */
export const USSD_STATE_UNKNOWN = 0;
export const USSD_STATE_IDLE = 1;
export const USSD_STATE_ACTIVE = 2;
export const USSD_STATE_USER_RESPONSE = 3;

/**
 * Decode MM's post-call session state. `UNKNOWN` folds onto `released` with the
 * rest: an unreadable state must close the session rather than leave the operator
 * looking at a dialogue nothing can advance.
 */
export function decodeRepliedState(state: number): UssdRepliedState {
	if (state === USSD_STATE_USER_RESPONSE) {
		return 'awaiting-reply';
	}
	return state === USSD_STATE_ACTIVE ? 'active' : 'released';
}

export interface UssdCallTarget {
	readonly transport: DbusTransport;
	readonly destination: string;
	readonly modem: string;
	readonly timeoutMs: number;
}

function firstString(body: readonly unknown[]): string {
	const value = body[0];
	return typeof value === 'string' ? value : '';
}

export async function callInitiate(target: UssdCallTarget, ussdCommand: string): Promise<string> {
	const reply = await target.transport.callMethod({
		destination: target.destination,
		path: target.modem,
		interface: MODEM3GPP_USSD_IFACE,
		member: 'Initiate',
		signature: 's',
		args: [ussdCommand],
		timeoutMs: target.timeoutMs,
	});
	return firstString(reply.body);
}

export async function callRespond(target: UssdCallTarget, ussdResponse: string): Promise<string> {
	const reply = await target.transport.callMethod({
		destination: target.destination,
		path: target.modem,
		interface: MODEM3GPP_USSD_IFACE,
		member: 'Respond',
		signature: 's',
		args: [ussdResponse],
		timeoutMs: target.timeoutMs,
	});
	return firstString(reply.body);
}

export async function callCancel(target: UssdCallTarget): Promise<void> {
	await target.transport.callMethod({
		destination: target.destination,
		path: target.modem,
		interface: MODEM3GPP_USSD_IFACE,
		member: 'Cancel',
		timeoutMs: target.timeoutMs,
	});
}

/**
 * Read the post-call session state.
 *
 * A targeted `Properties.Get` rather than a `GetManagedObjects` sweep: this runs
 * after every network round-trip, and the whole-tree read is the most expensive
 * call in the package. `unknown` on anything unreadable — the caller treats that
 * as "the network released the session", which is the conservative direction (it
 * closes a session rather than leaving one the operator cannot see).
 */
export async function readUssdState(target: UssdCallTarget): Promise<number> {
	try {
		const reply = await target.transport.callMethod({
			destination: target.destination,
			path: target.modem,
			interface: PROPERTIES_IFACE,
			member: 'Get',
			signature: 'ss',
			args: [MODEM3GPP_USSD_IFACE, 'State'],
			timeoutMs: target.timeoutMs,
		});
		const wrapped = reply.body[0];
		if (typeof wrapped === 'number') {
			return wrapped;
		}
		const inner = (wrapped as { value?: unknown } | undefined)?.value;
		return typeof inner === 'number' ? inner : USSD_STATE_UNKNOWN;
	} catch {
		return USSD_STATE_UNKNOWN;
	}
}
