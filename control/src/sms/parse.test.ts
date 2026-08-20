// Parity fixtures for the read-only SMS port.
//
// Every fixture below is VERBATIM `mmcli 1.24.2 -K` output captured from the
// bench board (Quectel RM530N-GL, 37 stored messages) with the bodies replaced
// by neutral copy, and every expected value is the answer CeraUI's shipped
// `modules/modems/mmcli-sms.ts` reader produces for it. This suite is therefore
// the port's half of the migrate-then-remove gate: it pins the behaviour, and
// CeraUI's `modem-sms-port-parity.test.ts` runs BOTH implementations over the
// same fixtures and asserts they agree. Rule D forbids importing that reader
// here, so the differential lives on the side that can see both.

import { describe, expect, test } from 'bun:test';
import type { SmsMessage } from '../ports/sms';
import {
	classifySmsFailure,
	parseSmsListOutput,
	parseSmsRecordOutput,
	unescapeMmcliValue,
} from './mmcli-parse';
import {
	normalizeSmsState,
	SMS_INBOX_CAP,
	SMS_PATH_RE,
	selectReadablePaths,
	smsPathIndex,
	smsTimestampEpoch,
	sortAndCapSms,
} from './normalize';

const POPULATED_LIST = [
	'modem.messaging.sms.length    : 3',
	'modem.messaging.sms.value[1]  : /org/freedesktop/ModemManager1/SMS/36',
	'modem.messaging.sms.value[2]  : /org/freedesktop/ModemManager1/SMS/35',
	'modem.messaging.sms.value[3]  : /org/freedesktop/ModemManager1/SMS/0',
].join('\n');

const EMPTY_LIST = 'modem.messaging.sms           : --';

const RECORD = [
	'sms.dbus-path                      : /org/freedesktop/ModemManager1/SMS/36',
	'sms.content.number                 : 85573',
	'sms.content.text                   : Neutral fixture body with a colon: and more',
	'sms.content.data                   : --',
	'sms.properties.pdu-type            : deliver',
	'sms.properties.state               : received',
	'sms.properties.validity            : --',
	'sms.properties.storage             : me',
	'sms.properties.smsc                : +573103154363',
	'sms.properties.class               : --',
	'sms.properties.timestamp           : 2025-08-21T17:20:16-05',
	'sms.properties.delivery-state      : --',
].join('\n');

const message = (id: string, timestamp?: string): SmsMessage => ({
	id,
	text: `body ${id}`,
	state: 'received',
	...(timestamp !== undefined ? { timestamp } : {}),
});

describe('parseSmsListOutput', () => {
	test('extracts every path from a populated inbox listing', () => {
		const result = parseSmsListOutput(POPULATED_LIST);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual([
				'/org/freedesktop/ModemManager1/SMS/36',
				'/org/freedesktop/ModemManager1/SMS/35',
				'/org/freedesktop/ModemManager1/SMS/0',
			]);
		}
	});

	test('a `--` list is a genuinely EMPTY inbox, not drift', () => {
		const result = parseSmsListOutput(EMPTY_LIST);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual([]);
		}
	});

	test('output that never mentions the key fails LOUD', () => {
		const result = parseSmsListOutput('modem.generic.state : connected');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('modem.messaging.sms');
		}
	});

	test('entries matching no path grammar fail LOUD', () => {
		const result = parseSmsListOutput(
			['modem.messaging.sms.length    : 1', 'modem.messaging.sms.value[1]  : nope'].join('\n'),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('path grammar');
		}
	});
});

describe('SMS_PATH_RE — a retargeted grammar, not the modem one', () => {
	test('accepts a real SMS object path and a bare index', () => {
		expect(SMS_PATH_RE.test('/org/freedesktop/ModemManager1/SMS/36')).toBe(true);
		expect(SMS_PATH_RE.test('36')).toBe(true);
	});

	test('rejects anything that could escape an argv boundary', () => {
		for (const hostile of [
			'--send',
			'36; rm -rf /',
			'/org/freedesktop/ModemManager1/Modem/0',
			'',
			'/org/freedesktop/ModemManager1/SMS/',
		]) {
			expect(SMS_PATH_RE.test(hostile)).toBe(false);
		}
	});
});

describe('parseSmsRecordOutput', () => {
	test('reads the board record, keeping a colon inside the body', () => {
		const result = parseSmsRecordOutput(RECORD);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value).toEqual({
				id: '36',
				from: '85573',
				text: 'Neutral fixture body with a colon: and more',
				timestamp: '2025-08-21T17:20:16-05',
				state: 'received',
			});
		}
	});

	test('a data-only message reports an empty body rather than guessing', () => {
		const result = parseSmsRecordOutput(
			[
				'sms.dbus-path            : /org/freedesktop/ModemManager1/SMS/7',
				'sms.content.text         : --',
				'sms.properties.state     : received',
			].join('\n'),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.text).toBe('');
		}
	});

	test('an unknown state folds to `unknown`, never a raw token', () => {
		const result = parseSmsRecordOutput(
			[
				'sms.dbus-path            : /org/freedesktop/ModemManager1/SMS/7',
				'sms.properties.state     : some-future-state',
			].join('\n'),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.state).toBe('unknown');
		}
	});

	test('a malformed record reports KEY NAMES and no content', () => {
		const body = 'Tu pin es 4821';
		const result = parseSmsRecordOutput(
			[`sms.content.text : ${body}`, 'sms.properties.state : received'].join('\n'),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toContain('sms.dbus-path');
			expect(result.detail).toContain('sms.content.text');
			expect(result.detail).not.toContain(body);
			expect(JSON.stringify(result)).not.toContain(body);
		}
	});
});

describe('unescapeMmcliValue — per-BYTE, then UTF-8', () => {
	test('rebuilds a multi-byte character from its octal escapes', () => {
		expect(unescapeMmcliValue('\\302\\241Disfruta!')).toBe('\u00a1Disfruta!');
	});

	test('a doubled backslash is a literal backslash, not a byte', () => {
		expect(unescapeMmcliValue('\\\\302')).toBe('\\302');
	});

	test('leaves an unescaped value untouched', () => {
		expect(unescapeMmcliValue('plain body')).toBe('plain body');
	});
});

describe('smsTimestampEpoch — the hours-only offset', () => {
	test('widens `-05` to `-05:00` so the board timestamp parses at all', () => {
		expect(smsTimestampEpoch('2025-08-21T17:20:16-05')).toBe(
			Date.parse('2025-08-21T17:20:16-05:00'),
		);
	});

	test('an already-valid offset is unchanged', () => {
		expect(smsTimestampEpoch('2025-08-21T17:20:16+02:00')).toBe(
			Date.parse('2025-08-21T17:20:16+02:00'),
		);
	});

	test('a bare date is never mangled by the widening anchor', () => {
		expect(smsTimestampEpoch('2025-08-21')).toBe(Date.parse('2025-08-21'));
	});

	test('an unparseable timestamp sorts last rather than throwing', () => {
		expect(smsTimestampEpoch('not a timestamp')).toBe(Number.NEGATIVE_INFINITY);
	});
});

describe('sortAndCapSms — newest first, undated last', () => {
	test('orders on the carrier timestamp, not the object index', () => {
		const sorted = sortAndCapSms([
			message('1', '2025-08-21T10:00:00-05'),
			message('99', '2025-08-20T10:00:00-05'),
			message('50', '2025-08-22T10:00:00-05'),
		]);
		expect(sorted.map((entry) => entry.id)).toEqual(['50', '1', '99']);
	});

	test('an undated message sorts LAST, never promoted to the top', () => {
		const sorted = sortAndCapSms([message('5'), message('1', '2025-08-21T10:00:00-05')]);
		expect(sorted.map((entry) => entry.id)).toEqual(['1', '5']);
	});

	test('ties fall back to the index, descending', () => {
		const stamp = '2025-08-21T10:00:00-05';
		const sorted = sortAndCapSms([message('3', stamp), message('9', stamp), message('7', stamp)]);
		expect(sorted.map((entry) => entry.id)).toEqual(['9', '7', '3']);
	});

	test('caps at SMS_INBOX_CAP', () => {
		const many = Array.from({ length: 120 }, (_, index) => message(String(index)));
		expect(sortAndCapSms(many)).toHaveLength(SMS_INBOX_CAP);
		expect(SMS_INBOX_CAP).toBe(50);
	});
});

describe('selectReadablePaths — bounded BEFORE any per-message read', () => {
	test('keeps the highest-indexed cap and drops the rest', () => {
		const paths = Array.from(
			{ length: 120 },
			(_, index) => `/org/freedesktop/ModemManager1/SMS/${index}`,
		);
		const selected = selectReadablePaths(paths);
		expect(selected).toHaveLength(SMS_INBOX_CAP);
		expect(selected[0]).toBe('/org/freedesktop/ModemManager1/SMS/119');
	});

	test('refuses a path that does not match the grammar', () => {
		expect(selectReadablePaths(['/org/freedesktop/ModemManager1/SMS/1; rm -rf /'])).toEqual([]);
	});
});

describe('smsPathIndex + normalizeSmsState', () => {
	test('reads the trailing index, and NaN when there is none', () => {
		expect(smsPathIndex('/org/freedesktop/ModemManager1/SMS/36')).toBe(36);
		expect(Number.isNaN(smsPathIndex('36'))).toBe(true);
	});

	test('every ModemManager state passes through verbatim', () => {
		for (const state of ['unknown', 'stored', 'receiving', 'received', 'sending', 'sent']) {
			expect(normalizeSmsState(state)).toBe(state as never);
		}
		expect(normalizeSmsState(undefined)).toBe('unknown');
	});
});

describe('classifySmsFailure — four distinct operator facts', () => {
	test.each([
		["couldn't find modem 'nope'", 'unknown_modem'],
		['error: modem has no messaging capabilities', 'unsupported'],
		['error: modem not enabled yet', 'not_enabled'],
		['something else entirely', 'read_failed'],
	])('%s -> %s', (description, expected) => {
		expect(classifySmsFailure(description)).toBe(expected as never);
	});
});
