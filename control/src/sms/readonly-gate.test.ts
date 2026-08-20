// The SMS surface is READ-ONLY, and this is the lock.
//
// A comment saying "never add a send path" is not a control — the next person to
// touch this surface will not read it. This test greps the ACTUAL SMS source for
// every ModemManager verb and identifier that would turn the inbox into a write
// surface, and fails the build if one appears. Sending or deleting a message is
// billable, irreversible, and adds real modem-control capability over the
// subscriber's account to what is otherwise a diagnostic read; it is out of
// scope PERMANENTLY, not until later.
//
// It is the modem-stack half of the same gate CeraUI has carried since Phase A
// (`apps/backend/src/tests/modem-sms-readonly-gate.test.ts`). Neither half may
// be deleted or narrowed to land a write path — that is exactly the move they
// exist to stop, and it would be a new spec change with its own confirmation and
// interlock design.

import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const SMS_DIR = import.meta.dir;
const PORT_FILE = join(SMS_DIR, '..', 'ports', 'sms.ts');

/** This gate names the forbidden verbs, so it must not scan itself. */
const SELF = 'readonly-gate.test.ts';

/**
 * ModemManager's SMS WRITE surface (`Modem.Messaging.Create` / `Delete`, and
 * `Sms.Send` / `Sms.Store`), mmcli's spelling of the same verbs, and the
 * identifiers a hand-rolled write path would use. `'--send'` is listed on its
 * own because mmcli spells the send as `-s <path> --send`, with no `sms` token
 * anywhere in the flag.
 */
const FORBIDDEN: ReadonlyArray<{ label: string; re: RegExp }> = [
	{ label: "MM Messaging 'Create'", re: /['"`]Create['"`]/ },
	{ label: "MM Messaging 'Delete'", re: /['"`]Delete['"`]/ },
	{ label: "MM Sms 'Send'", re: /['"`]Send['"`]/ },
	{ label: "MM Sms 'Store'", re: /['"`]Store['"`]/ },
	{ label: 'mmcli --messaging-create-sms', re: /--messaging-create-sms/ },
	{ label: 'mmcli --messaging-delete-sms', re: /--messaging-delete-sms/ },
	{ label: 'mmcli --create-sms', re: /--create-sms/ },
	{ label: 'mmcli --delete-sms', re: /--delete-sms/ },
	{ label: 'mmcli --send', re: /['"`]--send['"`]/ },
	{ label: 'mmcli --store', re: /['"`]--store['"`]/ },
	{ label: 'a sendSms identifier', re: /\bsendSms\b/i },
	{ label: 'a deleteSms identifier', re: /\bdeleteSms\b/i },
	{ label: 'a createSms identifier', re: /\bcreateSms\b/i },
	{ label: 'an smsSend identifier', re: /\bsmsSend\b/i },
	{ label: 'an smsDelete identifier', re: /\bsmsDelete\b/i },
	{ label: 'an smsStore identifier', re: /\bsmsStore\b/i },
];

/**
 * Scan CODE, not prose. The port and this gate both state the read-only
 * invariant by NAMING the very verbs they forbid, and a gate that cannot tell
 * "we will never call Delete" from an actual `Delete` call is a gate nobody can
 * document around. Full-line and block comments are stripped; a trailing `//` on
 * a code line is left alone so a URL inside a string cannot swallow the rest.
 */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, ' ')
		.split('\n')
		.filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
		.join('\n');
}

function smsSourceFiles(): string[] {
	const files = readdirSync(SMS_DIR)
		.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && name !== SELF)
		.map((name) => join(SMS_DIR, name));
	return [...files, PORT_FILE];
}

const CODE = new Map<string, string>();
for (const path of smsSourceFiles()) {
	CODE.set(path, stripComments(await Bun.file(path).text()));
}

describe('the SMS surface is read-only, and stays that way', () => {
	test('scans the whole SMS surface, port included', () => {
		// Guards the gate itself: a moved directory would otherwise make this
		// suite pass vacuously by scanning nothing.
		expect(CODE.size).toBeGreaterThanOrEqual(5);
		for (const expected of [
			'ports/sms.ts',
			'sms/normalize.ts',
			'sms/mmcli-parse.ts',
			'sms/inbox-store.ts',
			'sms/dbus-messaging.ts',
		]) {
			expect([...CODE.keys()].some((path) => path.endsWith(expected))).toBe(true);
		}
	});

	for (const { label, re } of FORBIDDEN) {
		test(`has no ${label} anywhere on the SMS surface`, () => {
			const offenders = [...CODE.entries()]
				.filter(([, source]) => re.test(source))
				.map(([path]) => path.slice(path.lastIndexOf('/src/') + 5));
			expect(offenders).toEqual([]);
		});
	}

	test('every D-Bus METHOD the surface calls is a read', () => {
		// Members are named in two places — an outgoing `callMethod` and an
		// incoming `subscribeSignal` filter — and only the first can mutate a
		// device, so they are asserted separately rather than as one bag.
		const called = new Set<string>();
		for (const source of CODE.values()) {
			for (const region of source.matchAll(/callMethod\(\{[\s\S]*?\}\)/g)) {
				for (const match of region[0].matchAll(/member:\s*'([A-Za-z]+)'/g)) {
					const name = match[1];
					if (name !== undefined) {
						called.add(name);
					}
				}
			}
		}
		expect([...called].sort()).toEqual(['GetAll', 'List']);
	});

	test('the only signals it subscribes to are the inbox observations', () => {
		const subscribed = new Set<string>();
		for (const source of CODE.values()) {
			for (const region of source.matchAll(/subscribeSignal\(\s*\{[\s\S]*?\}/g)) {
				for (const match of region[0].matchAll(/member:\s*'([A-Za-z]+)'/g)) {
					const name = match[1];
					if (name !== undefined) {
						subscribed.add(name);
					}
				}
			}
		}
		expect([...subscribed].sort()).toEqual(['Added', 'Deleted']);
	});

	test('the port declares list/observe/stop and nothing that mutates', () => {
		const port = CODE.get(PORT_FILE) ?? '';
		for (const expected of ['list(', 'observe(', 'stop(']) {
			expect(port).toContain(expected);
		}
		expect(/\b(create|send|store|delete)\s*\(/i.test(port)).toBe(false);
	});

	test('the detector is not vacuous (self-test)', () => {
		const rogue = stripComments("await transport.callMethod({ member: 'Delete' });");
		const flagged = FORBIDDEN.filter(({ re }) => re.test(rogue)).map(({ label }) => label);
		expect(flagged).toContain("MM Messaging 'Delete'");
	});
});
