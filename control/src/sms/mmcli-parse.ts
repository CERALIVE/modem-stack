// The `mmcli -K` SMS grammar.
//
// WHY A CLI GRAMMAR LIVES BESIDE A D-BUS PORT: `mmcli` is a client of the SAME
// ModemManager daemon the D-Bus adapter talks to, and CeraUI has been reading
// its inbox through it on real hardware since Phase A. Owning the grammar here
// is what makes the port's output provable byte-for-byte against that reader on
// the same captured output (`mmcli-parse.parity.test.ts`) — a claim no amount of
// D-Bus-only code could support — and it is what lets a consumer move its
// parsing onto this package without also having to move its transport in the
// same change.
//
// CONTENT-FREE BY CONSTRUCTION. Unlike an ordinary parser, nothing here ever
// puts a parsed LINE into an error, a log, or a receipt. A message body is
// routinely a one-time code and a sender identifies the subscriber, so a
// malformed record reports the KEY NAMES it found and nothing else — enough to
// diagnose CLI drift, and carrying no message content. This module also never
// logs at all, which is why it does not reuse a generic key/value splitter: the
// generic one prints the offending line verbatim on any line it cannot split,
// which would put message text into a log the first time mmcli reframed a body.

import type { SmsMessage, SmsReadRefusal } from '../ports/sms';
import { normalizeSmsState, smsPathIndex } from './normalize';

/** A parse outcome. `detail` NEVER carries message content — key names only. */
export type SmsParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string; readonly detail: string };

const fail = <T>(reason: string, detail: string): SmsParseResult<T> => ({
	ok: false,
	reason,
	detail,
});

const SMS_LIST_KEY = 'modem.messaging.sms';
const LIST_LENGTH_SUFFIX = /\.length$/;
const LIST_VALUE_SUFFIX = /\.value\[\d+]$/;
const SMS_PATH_ANYWHERE_RE = /\/org\/freedesktop\/ModemManager1\/SMS\/(\d+)/;

/**
 * The escapes `g_strescape()` emits, minus the octal form. mmcli's `-K` writer
 * runs EVERY value it prints through `g_strescape (value, NULL)`
 * (`cli/mmcli-output.c`), so this table plus the 3-digit octal form is the
 * complete grammar — anything else can be left untouched instead of guessed at.
 */
const SIMPLE_ESCAPES: Readonly<Record<string, number>> = {
	b: 0x08,
	f: 0x0c,
	n: 0x0a,
	r: 0x0d,
	t: 0x09,
	v: 0x0b,
	'"': 0x22,
	'\\': 0x5c,
};

/** Octal triplet first: `\302` is a byte, `\\302` is a backslash then "302". */
const ESCAPE_RE = /\\(?:([0-7]{3})|([bfnrtv"\\]))/g;

/**
 * Undo `g_strescape()` on one `-K` value.
 *
 * mmcli does not print non-ASCII text — it prints the LITERAL ASCII characters
 * of the octal escape. A Spanish message arrives on stdout as the eight
 * characters `\`,`3`,`0`,`2`,`\`,`2`,`4`,`1` where the wire carried the two
 * UTF-8 bytes `0xC2 0xA1` (confirmed on the bench board with `od -c`). The
 * escapes are therefore per-BYTE, not per-character, and the only correct
 * decode is to rebuild the byte sequence and read it back as UTF-8 — decoding
 * each escape with `String.fromCharCode` instead turns `¡` into `Â¡`.
 *
 * Total and silent: it never throws and never logs, because the value it holds
 * is message content. An escape outside the grammar is copied VERBATIM rather
 * than dropped — mmcli cannot emit one, so meeting one means the value was
 * never escaped and copying it is the only lossless answer.
 */
export function unescapeMmcliValue(value: string): string {
	if (!value.includes('\\')) {
		return value;
	}

	const encoder = new TextEncoder();
	const bytes: number[] = [];
	const pushText = (text: string): void => {
		for (const byte of encoder.encode(text)) {
			bytes.push(byte);
		}
	};

	let cursor = 0;
	ESCAPE_RE.lastIndex = 0;
	let match = ESCAPE_RE.exec(value);
	while (match !== null) {
		if (match.index > cursor) {
			pushText(value.slice(cursor, match.index));
		}
		const octal = match[1];
		const simple = match[2];
		if (octal !== undefined) {
			bytes.push(Number.parseInt(octal, 8));
		} else if (simple !== undefined) {
			const byte = SIMPLE_ESCAPES[simple];
			if (byte !== undefined) {
				bytes.push(byte);
			}
		}
		cursor = match.index + match[0].length;
		match = ESCAPE_RE.exec(value);
	}
	if (cursor < value.length) {
		pushText(value.slice(cursor));
	}

	// A byte run that is not valid UTF-8 becomes U+FFFD — an honest
	// "undecodable here" mark. Failing the whole read would lose every other
	// field over one bad byte.
	return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Collect the `modem.messaging.sms` entries, honouring mmcli's array form. */
function collectListEntries(raw: string): string[] | undefined {
	let scalar: string | undefined;
	const array: string[] = [];
	let sawArray = false;

	for (const line of raw.split('\n')) {
		const separator = line.indexOf(':');
		if (separator <= 0) {
			continue;
		}
		const key = line.slice(0, separator).trim();
		// Unescaped AFTER the split, never before: a decoded byte must never be
		// able to forge the `:` the line was split on.
		const value = unescapeMmcliValue(line.slice(separator + 1).trim());
		// mmcli renders an absent value as `--`; it carries no entry.
		if (value === '--') {
			continue;
		}
		if (key.replace(LIST_LENGTH_SUFFIX, '') === SMS_LIST_KEY && LIST_LENGTH_SUFFIX.test(key)) {
			sawArray = true;
		} else if (key.replace(LIST_VALUE_SUFFIX, '') === SMS_LIST_KEY && LIST_VALUE_SUFFIX.test(key)) {
			sawArray = true;
			array.push(value);
		} else if (key === SMS_LIST_KEY) {
			scalar = value;
		}
	}

	if (sawArray) {
		return array;
	}
	return scalar === undefined ? undefined : [scalar];
}

/**
 * Extract SMS object paths from `mmcli -K -m <id> --messaging-list-sms`.
 *
 * An inbox with no messages prints as `modem.messaging.sms: --`, whose `--`
 * carries no entry — so an ABSENT key is a legitimate EMPTY INBOX, exactly as it
 * is for `--3gpp-scan`, not drift. What IS drift, and what fails loud here, is
 * output that never mentions the key at all (a renamed field, an error body
 * reaching this parser): answering "no messages" to a read that never ran would
 * be the worst possible lie about an inbox.
 */
export function parseSmsListOutput(raw: string): SmsParseResult<string[]> {
	const entries = collectListEntries(raw);

	if (entries === undefined) {
		if (!raw.includes(SMS_LIST_KEY)) {
			return fail('no modem.messaging.sms key in the mmcli output', 'no-key');
		}
		return { ok: true, value: [] };
	}

	const paths = entries.filter((entry) => SMS_PATH_ANYWHERE_RE.test(entry));
	if (entries.length > 0 && paths.length === 0) {
		return fail('no SMS paths matched the ModemManager path grammar', 'no-path-match');
	}
	return { ok: true, value: paths };
}

/**
 * Parse one `mmcli -K -s <path>` record.
 *
 * A malformed record reports the KEY NAMES it found and nothing else — see the
 * content-free note at the top of this file.
 */
export function parseSmsRecordOutput(raw: string): SmsParseResult<SmsMessage> {
	const fields = new Map<string, string>();
	for (const line of raw.split('\n')) {
		const separator = line.indexOf(':');
		if (separator <= 0) {
			continue;
		}
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();
		if (!key.startsWith('sms.') || value === '' || value === '--') {
			continue;
		}
		fields.set(key, unescapeMmcliValue(value));
	}

	const keyNames = [...fields.keys()].join(', ');
	const dbusPath = fields.get('sms.dbus-path');
	if (dbusPath === undefined) {
		return fail('no sms.dbus-path key in the mmcli output', keyNames);
	}

	const index = smsPathIndex(dbusPath);
	if (Number.isNaN(index)) {
		return fail('sms.dbus-path did not match the ModemManager path grammar', keyNames);
	}

	const from = fields.get('sms.content.number');
	const timestamp = fields.get('sms.properties.timestamp');

	return {
		ok: true,
		value: {
			id: String(index),
			...(from !== undefined ? { from } : {}),
			...(timestamp !== undefined ? { timestamp } : {}),
			// A data-only (WAP/PDU) message has no text at all; `''` says so honestly.
			text: fields.get('sms.content.text') ?? '',
			state: normalizeSmsState(fields.get('sms.properties.state')),
		},
	};
}

/**
 * Classify a source failure into a refusal the operator can act on.
 *
 * The three recognised strings are ModemManager 1.24's own, confirmed on the
 * bench board: a modem with no Messaging interface, a radio that has not come up
 * yet, and a selector nothing answers to. Anything else stays `read_failed`
 * rather than being guessed at.
 */
export function classifySmsFailure(description: string): SmsReadRefusal {
	if (/no messaging capabilities/i.test(description)) {
		return 'unsupported';
	}
	if (/not enabled yet/i.test(description)) {
		return 'not_enabled';
	}
	if (/couldn't find modem|cannot find modem/i.test(description)) {
		return 'unknown_modem';
	}
	return 'read_failed';
}
