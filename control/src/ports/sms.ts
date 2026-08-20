// The SMS port — LIST / READ and Added/Deleted observation. NOTHING ELSE.
//
// READ-ONLY IS PERMANENT, NOT A PHASE LIMITATION. There is no verb here that
// composes, stores, sends, or deletes a message, and none may ever be added.
// Sending or deleting an SMS is billable and irreversible, and it turns a
// diagnostic read into real modem-control capability over the subscriber's
// account. CeraUI carries the same contract on its own side, enforced by a grep
// gate (`tests/modem-sms-readonly-gate.test.ts`); `sms/readonly-gate.test.ts`
// is this package's half. Neither may be weakened to land a write path — that
// is a new spec change with its own confirmation/interlock design.
//
// THE OBSERVATION MODEL IS "LIST ONCE, THEN FOLLOW THE SIGNALS". ModemManager's
// Messaging interface emits `Added` and `Deleted` for every inbox change, so a
// consumer lists once at start and folds events from then on. Re-listing on a
// poll tick is the anti-pattern this port exists to remove: it costs one method
// call per message per tick and still cannot report an arrival any sooner than
// the tick it lands on.
//
// CONTENT NEVER RIDES A DIAGNOSTIC. A message body routinely carries a one-time
// code and its originator identifies the subscriber, so nothing on this port
// puts either into a reason string, a receipt, or a log line — see
// `../redact.ts` for the key class and `../sms/mmcli-parse.ts` for the
// content-free parse errors.

import type { Unsubscribe } from './observation';

/** A message's lifecycle state, verbatim from ModemManager's own vocabulary. */
export type SmsState = 'unknown' | 'stored' | 'receiving' | 'received' | 'sending' | 'sent';

/** One stored message, normalized. `text` is `''` for a data-only (WAP/PDU) message. */
export interface SmsMessage {
	/** The trailing `/SMS/<n>` object index, stringified. */
	readonly id: string;
	readonly from?: string;
	/** The service-centre timestamp, verbatim as the device reported it. */
	readonly timestamp?: string;
	readonly text: string;
	readonly state: SmsState;
}

/**
 * Why an inbox read produced no list. These are the four operator-actionable
 * facts, and they are deliberately distinct from one another — a modem with no
 * Messaging interface, a radio that has not come up, a selector nothing answers
 * to, and drift in whatever the source printed are four different next steps.
 */
export type SmsReadRefusal = 'unsupported' | 'not_enabled' | 'unknown_modem' | 'read_failed';

/**
 * The result of an inbox read. A REFUSAL IS NEVER AN EMPTY LIST: `{ok: true,
 * messages: []}` means this modem has an inbox and it is empty.
 */
export type SmsInboxResult =
	| { readonly ok: true; readonly messages: readonly SmsMessage[] }
	| { readonly ok: false; readonly reason: SmsReadRefusal };

/**
 * One inbox change. `resynced` carries a full authoritative list and is what a
 * source restart produces — a consumer replaces its rows with it rather than
 * merging, so a restart can never duplicate a row it already holds.
 */
export type SmsInboxEvent =
	| { readonly kind: 'added'; readonly message: SmsMessage }
	| { readonly kind: 'deleted'; readonly id: string }
	| { readonly kind: 'resynced'; readonly messages: readonly SmsMessage[] };

export type SmsInboxListener = (event: SmsInboxEvent) => void;

/**
 * The read-only SMS port. `list()` resolves the current inbox once; `observe()`
 * streams every subsequent change; `stop()` releases the source.
 *
 * It is deliberately NOT an extension of `ModemManagerPort`: a consumer that
 * only reads an inbox must not acquire radio, SIM, or inhibit verbs along the
 * way — the same narrowing argument `ModemObservationPort` makes for the
 * shadow reader.
 */
export interface SmsObservationPort {
	/** Read the modem's stored inbox, newest-first and capped. */
	list(): Promise<SmsInboxResult>;
	/** Subscribe to Added/Deleted/resync events. Returns an unsubscribe. */
	observe(listener: SmsInboxListener): Unsubscribe;
	/** Release the source. Idempotent. */
	stop(): Promise<void>;
}
