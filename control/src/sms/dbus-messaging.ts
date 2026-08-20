// The ModemManager Messaging adapter — LIST ONCE, then follow Added / Deleted.
//
// Three verbs, all reads: `Messaging.List` for the object paths,
// `Properties.GetAll` per message, and a subscription to `Added` / `Deleted`.
// There is no `Create`, no `Send`, no `Delete`, and none may be added — see
// `../ports/sms.ts` for why that is permanent rather than staged, and
// `readonly-gate.test.ts` for the lock.
//
// NEVER RE-LIST ON A TICK. MM tells us about every change, so a poll would cost
// one method call per stored message per tick and still could not report an
// arrival sooner than the tick it happened to land on. The ONLY re-list is on a
// source RECONNECT, where the events that occurred while the bus was down were
// never delivered and folding is therefore impossible; that re-list is published
// as `resynced` so the consumer replaces its rows instead of merging (see
// `inbox-store.ts`).
//
// A MESSAGE THAT VANISHES BETWEEN THE LIST AND ITS READ IS ORDINARY. The modem's
// own storage rotates, so a failed per-message read SKIPS that message rather
// than failing the whole inbox. A failed LIST is different — nothing was read at
// all — and answers a typed refusal.

import { MM_BUS_NAME, PROPERTIES_IFACE } from '../backend/constants';
import { type DecodedProps, numberProp, stringProp } from '../backend/managed-objects';
// The one definition of MM's Messaging interface name lives with the capability
// probe that also keys on it; duplicating it here is how the two drift apart.
import { MESSAGING_IFACE } from '../capability/detect';
import type { Unsubscribe } from '../ports/observation';
import type {
	SmsInboxEvent,
	SmsInboxListener,
	SmsInboxResult,
	SmsMessage,
	SmsObservationPort,
	SmsState,
} from '../ports/sms';
import type { DbusTransport, DbusValue, Subscription } from '../transport';
import { classifySmsFailure } from './mmcli-parse';
import { normalizeSmsState, SMS_INBOX_CAP, selectReadablePaths, sortAndCapSms } from './normalize';

/** `org.freedesktop.ModemManager1.Sms` — one message object. */
export const SMS_IFACE = 'org.freedesktop.ModemManager1.Sms';

/**
 * `MMSmsState` (ModemManager `mm-enums.h`) as the port's own vocabulary. The
 * index IS the enum value; an out-of-range value folds to `unknown` through
 * {@link normalizeSmsState}, so a future MM state can never surface as a raw
 * number an operator cannot act on.
 */
const SMS_STATE_BY_ORDINAL: readonly string[] = [
	'unknown',
	'stored',
	'receiving',
	'received',
	'sending',
	'sent',
];

function stateFromOrdinal(ordinal: number | undefined): SmsState {
	if (ordinal === undefined) {
		return 'unknown';
	}
	return normalizeSmsState(SMS_STATE_BY_ORDINAL[ordinal]);
}

/** Build one message from an SMS object's decoded `Sms` properties. */
export function smsFromProps(path: string, props: DecodedProps | undefined): SmsMessage {
	const from = stringProp(props, 'Number');
	const timestamp = stringProp(props, 'Timestamp');
	const index = path.slice(path.lastIndexOf('/') + 1);
	return {
		id: index,
		...(from !== undefined && from !== '' ? { from } : {}),
		...(timestamp !== undefined && timestamp !== '' ? { timestamp } : {}),
		// A data-only (WAP/PDU) message carries no text at all; `''` says so.
		text: stringProp(props, 'Text') ?? '',
		state: stateFromOrdinal(numberProp(props, 'State')),
	};
}

export interface DbusSmsPortOptions {
	readonly transport: DbusTransport;
	/** The modem's ModemManager object path. */
	readonly modemPath: string;
	readonly destination?: string;
	readonly cap?: number;
	/** Called when a fold-time error must be surfaced without failing a read. */
	readonly onError?: (error: unknown) => void;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function createDbusSmsPort(options: DbusSmsPortOptions): SmsObservationPort {
	const { transport, modemPath } = options;
	const destination = options.destination ?? MM_BUS_NAME;
	const cap = options.cap ?? SMS_INBOX_CAP;
	const listeners = new Set<SmsInboxListener>();
	const subscriptions: Subscription[] = [];
	let wiring: Promise<void> | undefined;
	let stopped = false;

	const emit = (event: SmsInboxEvent): void => {
		for (const listener of listeners) {
			try {
				listener(event);
			} catch (error) {
				options.onError?.(error);
			}
		}
	};

	const readMessage = async (path: string): Promise<SmsMessage | undefined> => {
		try {
			const reply = await transport.callMethod({
				destination,
				path,
				interface: PROPERTIES_IFACE,
				member: 'GetAll',
				signature: 's',
				args: [SMS_IFACE],
			});
			return smsFromProps(path, reply.body[0] as unknown as DecodedProps);
		} catch {
			// Vanished between the list and this read — ordinary storage rotation.
			// Nothing is logged: the error text is the only place a body could hide.
			return undefined;
		}
	};

	const listInbox = async (): Promise<SmsInboxResult> => {
		let paths: readonly DbusValue[];
		try {
			const reply = await transport.callMethod({
				destination,
				path: modemPath,
				interface: MESSAGING_IFACE,
				member: 'List',
			});
			paths = Array.isArray(reply.body[0]) ? (reply.body[0] as DbusValue[]) : [];
		} catch (error) {
			return { ok: false, reason: classifySmsFailure(describe(error)) };
		}

		const candidates = selectReadablePaths(
			paths.filter((value): value is string => typeof value === 'string'),
			cap,
		);
		const messages: SmsMessage[] = [];
		for (const path of candidates) {
			const message = await readMessage(path);
			if (message !== undefined) {
				messages.push(message);
			}
		}
		return { ok: true, messages: sortAndCapSms(messages, cap) };
	};

	const resync = async (): Promise<void> => {
		const result = await listInbox();
		if (result.ok) {
			emit({ kind: 'resynced', messages: result.messages });
		}
	};

	const onAdded = async (body: readonly DbusValue[]): Promise<void> => {
		const path = body[0];
		if (typeof path !== 'string') {
			return;
		}
		const message = await readMessage(path);
		if (message !== undefined) {
			emit({ kind: 'added', message });
		}
	};

	const wire = async (): Promise<void> => {
		const added = await transport.subscribeSignal(
			{ interface: MESSAGING_IFACE, member: 'Added', path: modemPath },
			(event) => {
				void onAdded(event.body).catch((error) => options.onError?.(error));
			},
		);
		const deleted = await transport.subscribeSignal(
			{ interface: MESSAGING_IFACE, member: 'Deleted', path: modemPath },
			(event) => {
				const path = event.body[0];
				if (typeof path === 'string') {
					emit({ kind: 'deleted', id: path.slice(path.lastIndexOf('/') + 1) });
				}
			},
		);
		subscriptions.push(added, deleted);
		transport.on('reconnected', reconnected);
		// A subscription established AFTER the caller's own `list()` can have
		// missed an arrival in between, so the wiring ends with one resync.
		await resync();
	};

	const reconnected = (): void => {
		void resync().catch((error) => options.onError?.(error));
	};

	return {
		list: listInbox,

		observe(listener: SmsInboxListener): Unsubscribe {
			listeners.add(listener);
			if (wiring === undefined && !stopped) {
				wiring = wire().catch((error) => {
					options.onError?.(error);
				});
			}
			return () => {
				listeners.delete(listener);
			};
		},

		async stop(): Promise<void> {
			stopped = true;
			listeners.clear();
			transport.off('reconnected', reconnected);
			await wiring?.catch(() => undefined);
			wiring = undefined;
			const held = subscriptions.splice(0, subscriptions.length);
			await Promise.all(held.map((subscription) => subscription.unsubscribe()));
		},
	};
}
