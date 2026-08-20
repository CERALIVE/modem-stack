// The inbox row store — folds `Added` / `Deleted` / resync events into one
// newest-first, capped list.
//
// TWO PROPERTIES ARE THE WHOLE POINT OF THIS FILE, and both are failures a
// signal-driven inbox produces on its own unless something stops them.
//
// DUPLICATE SUPPRESSION. ModemManager emits `Added` for a message it is
// receiving AND again once it is stored, a re-subscribe after a bus hiccup can
// replay one, and a consumer that also re-listed would hold the same message
// twice. Rows are therefore keyed by object index and an `Added` carrying
// nothing new is a NO-OP — `apply` answers `false` and no consumer is woken.
//
// RESTART RECOVERY. A source restart cannot be folded, because the events that
// happened while it was down were never delivered. `resynced` therefore REPLACES
// the whole row set rather than merging into it: merging would keep a message
// deleted during the outage forever, and re-adding each row of a fresh list one
// `added` at a time is exactly how a restart comes to duplicate the inbox it
// already had.

import type { SmsInboxEvent, SmsMessage } from '../ports/sms';
import { SMS_INBOX_CAP, sortAndCapSms } from './normalize';

export interface SmsInboxStore {
	/** Apply one event. Answers whether the visible inbox actually changed. */
	apply(event: SmsInboxEvent): boolean;
	/** The current inbox, newest-first and capped. */
	snapshot(): SmsMessage[];
	/** Number of retained rows, before the cap is applied. */
	size(): number;
}

/** Two rows are the same message when every rendered field matches. */
function sameMessage(a: SmsMessage, b: SmsMessage): boolean {
	return (
		a.id === b.id &&
		a.text === b.text &&
		a.state === b.state &&
		a.from === b.from &&
		a.timestamp === b.timestamp
	);
}

export function createSmsInboxStore(cap: number = SMS_INBOX_CAP): SmsInboxStore {
	const rows = new Map<string, SmsMessage>();

	const applyAdded = (message: SmsMessage): boolean => {
		const held = rows.get(message.id);
		// A repeated Added for a row we already hold VERBATIM is the duplicate
		// this store exists to swallow. An Added that genuinely differs is a
		// state transition (receiving -> received) and does update the row.
		if (held !== undefined && sameMessage(held, message)) {
			return false;
		}
		rows.set(message.id, message);
		return true;
	};

	const applyResynced = (messages: readonly SmsMessage[]): boolean => {
		const next = new Map<string, SmsMessage>();
		for (const message of messages) {
			next.set(message.id, message);
		}
		// Report "unchanged" when the authoritative list matches what is already
		// held, so a reconnect that found nothing new broadcasts nothing.
		let changed = next.size !== rows.size;
		if (!changed) {
			for (const [id, message] of next) {
				const held = rows.get(id);
				if (held === undefined || !sameMessage(held, message)) {
					changed = true;
					break;
				}
			}
		}
		rows.clear();
		for (const [id, message] of next) {
			rows.set(id, message);
		}
		return changed;
	};

	return {
		apply(event: SmsInboxEvent): boolean {
			switch (event.kind) {
				case 'added':
					return applyAdded(event.message);
				case 'deleted':
					return rows.delete(event.id);
				case 'resynced':
					return applyResynced(event.messages);
			}
		},
		snapshot(): SmsMessage[] {
			return sortAndCapSms([...rows.values()], cap);
		},
		size(): number {
			return rows.size;
		},
	};
}
