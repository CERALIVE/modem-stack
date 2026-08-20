// Device-agnostic SMS normalization — the rules that hold whichever source the
// inbox was read through (ModemManager D-Bus or the `mmcli` client of the same
// daemon).
//
// Every rule here is a PORT of a behaviour proven on the bench board through
// CeraUI's `modules/modems/mmcli-sms.ts`, and each one exists because getting it
// wrong is silent rather than loud. They are kept in one pure module so the
// D-Bus adapter and the mmcli grammar cannot drift into two different answers
// about the same inbox.

import type { SmsMessage, SmsState } from '../ports/sms';

/**
 * The read cap. The list is reduced to the highest-indexed paths BEFORE any
 * per-message read, so a modem holding several hundred stored messages still
 * costs at most this many reads.
 */
export const SMS_INBOX_CAP = 50;

/**
 * The SMS object-path grammar.
 *
 * It is a SEPARATE regex from the modem-path one on purpose: a ModemManager
 * modem path is anchored on `/Modem/`, so reusing it here would refuse every
 * real message (`/org/freedesktop/ModemManager1/SMS/36`) on the device.
 */
export const SMS_PATH_RE: RegExp = /^(?:\/org\/freedesktop\/ModemManager1\/SMS\/\d+|\d+)$/;

const SMS_PATH_INDEX_RE = /\/org\/freedesktop\/ModemManager1\/SMS\/(\d+)/;

const KNOWN_SMS_STATES: ReadonlySet<string> = new Set<string>([
	'unknown',
	'stored',
	'receiving',
	'received',
	'sending',
	'sent',
]);

/** The trailing `/SMS/<n>` index, or `Number.NaN` when the path carries none. */
export function smsPathIndex(path: string): number {
	const match = path.match(SMS_PATH_INDEX_RE);
	return match?.[1] === undefined ? Number.NaN : Number.parseInt(match[1], 10);
}

/**
 * Fold whatever the source called the state onto the known vocabulary. An
 * unrecognised value becomes `unknown` rather than being passed through — the
 * state is rendered to an operator, and a raw token nobody can act on is worse
 * than an honest "we do not know".
 */
export function normalizeSmsState(raw: string | undefined): SmsState {
	return raw !== undefined && KNOWN_SMS_STATES.has(raw) ? (raw as SmsState) : 'unknown';
}

/**
 * ModemManager reports the service-centre timestamp with an HOURS-ONLY UTC
 * offset — `2025-08-21T17:20:16-05`, captured verbatim from the bench board.
 * That is not valid ISO 8601 and `Date.parse` answers NaN for it. Left
 * unhandled, EVERY message scores as undated and "newest first" silently
 * degrades to object-index order, which is the one ordering this module must
 * not trust. The offset is widened to `-05:00`; the anchor requires a full
 * `T??:??:??` time in front of it, so a bare `YYYY-MM-DD` is never mangled.
 */
const HOURS_ONLY_OFFSET_RE = /(T\d{2}:\d{2}:\d{2})([+-]\d{2})$/;

export function smsTimestampEpoch(timestamp: string): number {
	const parsedTime = Date.parse(timestamp.replace(HOURS_ONLY_OFFSET_RE, '$1$2:00'));
	return Number.isNaN(parsedTime) ? Number.NEGATIVE_INFINITY : parsedTime;
}

/**
 * Newest first, then capped.
 *
 * Sorted on the CARRIER timestamp because the object index is only a proxy for
 * arrival order — ModemManager reuses freed indices, so a re-enumerated inbox
 * can hand back a low index for the newest message. A message with no (or an
 * unparseable) timestamp sorts LAST rather than first: promoting an undated
 * message to the top of a "newest first" list would be a claim the device
 * cannot support. Ties fall back to the index, descending.
 */
export function sortAndCapSms(
	messages: readonly SmsMessage[],
	cap: number = SMS_INBOX_CAP,
): SmsMessage[] {
	const epoch = (message: SmsMessage): number =>
		message.timestamp === undefined
			? Number.NEGATIVE_INFINITY
			: smsTimestampEpoch(message.timestamp);

	return [...messages]
		.sort((a, b) => {
			const delta = epoch(b) - epoch(a);
			if (delta !== 0 && !Number.isNaN(delta)) {
				return delta;
			}
			return Number(b.id) - Number(a.id);
		})
		.slice(0, cap);
}

/**
 * Reduce a candidate path list to the paths worth reading: the highest-indexed
 * {@link SMS_INBOX_CAP}, each of which must match the path grammar before it can
 * reach a source as a selector.
 */
export function selectReadablePaths(
	paths: readonly string[],
	cap: number = SMS_INBOX_CAP,
): string[] {
	return [...paths]
		.sort((a, b) => smsPathIndex(b) - smsPathIndex(a))
		.slice(0, cap)
		.filter((path) => SMS_PATH_RE.test(path));
}
