// The AT lease's three guarantees: the allowlist rejects anything but ATI + catalog
// commands (and never touches the sender when it does); the watchdog fires + rejects
// a hung command; every attempt is audited through `redact`, so a secret in the
// context is stripped before it is stored.

import { describe, expect, test } from 'bun:test';
import {
	AT_BASELINE_ALLOWLIST,
	AT_RUNTIME_QUERY_ALLOWLIST,
	AtCommandLease,
	AtCommandNotAllowedError,
	type AtCommandSender,
	AtCommandTimeoutError,
	type AtResponse,
	computeAtAllowlist,
} from './at-lease';

const CATALOG_COMMAND = 'AT+QCFG="usbnet",2';

function recordingSender(): { sender: AtCommandSender; sent: string[] } {
	const sent: string[] = [];
	return {
		sent,
		sender: {
			send(command: string): Promise<AtResponse> {
				sent.push(command);
				return Promise.resolve({ ok: true, raw: 'OK' });
			},
		},
	};
}

describe('AtCommandLease — allowlist', () => {
	test('the named baseline is ATI plus only the reviewed vendor READ/TEST forms', () => {
		expect([...AT_RUNTIME_QUERY_ALLOWLIST]).toEqual([
			'AT+GTUSBMODE?',
			'AT+GTUSBMODE=?',
			'AT+QCFG="usbnet"',
			'AT+QCFG=?',
			'AT+CUSBPIDSWITCH?',
			'AT+CUSBPIDSWITCH=?',
			'AT!USBCOMP?',
			'AT!USBCOMP=?',
		]);
		expect([...AT_BASELINE_ALLOWLIST]).toEqual(['ATI', ...AT_RUNTIME_QUERY_ALLOWLIST]);
		const allowlist = computeAtAllowlist([CATALOG_COMMAND]);
		expect(allowlist.has('ATI')).toBe(true);
		expect(allowlist.has(CATALOG_COMMAND)).toBe(true);
	});

	test('a SET-shaped neighbour is still refused unless explicitly unioned for one transition', async () => {
		const { sender, sent } = recordingSender();
		const lease = new AtCommandLease({ sender, allowlist: computeAtAllowlist([]) });
		await expect(lease.run('AT+GTUSBMODE=40')).rejects.toBeInstanceOf(AtCommandNotAllowedError);
		expect(sent).toEqual([]);
	});

	test('ATI and the catalog command are allowed', async () => {
		const { sender, sent } = recordingSender();
		const lease = new AtCommandLease({ sender, allowlist: computeAtAllowlist([CATALOG_COMMAND]) });
		await lease.run('ATI');
		await lease.run(CATALOG_COMMAND);
		expect(sent).toEqual(['ATI', CATALOG_COMMAND]);
	});

	test('a command outside the allowlist is rejected WITHOUT touching the sender', async () => {
		const { sender, sent } = recordingSender();
		const lease = new AtCommandLease({ sender, allowlist: computeAtAllowlist([CATALOG_COMMAND]) });
		await expect(lease.run('AT+DANGEROUS')).rejects.toBeInstanceOf(AtCommandNotAllowedError);
		expect(sent).toEqual([]);
	});
});

describe('AtCommandLease — watchdog', () => {
	test('a hung command fires the watchdog and rejects with a timeout', async () => {
		const hangingSender: AtCommandSender = { send: () => new Promise<AtResponse>(() => undefined) };
		const watchdogHits: string[] = [];
		const lease = new AtCommandLease({
			sender: hangingSender,
			allowlist: computeAtAllowlist([]),
			timeoutMs: 20,
			onWatchdog: (command) => {
				watchdogHits.push(command);
			},
		});
		await expect(lease.run('ATI')).rejects.toBeInstanceOf(AtCommandTimeoutError);
		expect(watchdogHits).toEqual(['ATI']);
	});
});

describe('AtCommandLease — audit + redaction', () => {
	test('a sensitive value in the audit context is redacted before recording', async () => {
		const { sender } = recordingSender();
		const entries: unknown[] = [];
		const lease = new AtCommandLease({
			sender,
			allowlist: computeAtAllowlist([]),
			audit: { record: (entry) => entries.push(entry) },
		});
		await lease.run('ATI', { subscriptionId: 'SECRET-ICCID', note: 'keep-me' });
		expect(entries).toHaveLength(1);
		const recorded = entries[0] as {
			command: string;
			outcome: string;
			context: Record<string, unknown>;
		};
		expect(recorded.command).toBe('ATI');
		expect(recorded.outcome).toBe('sent');
		expect(recorded.context.subscriptionId).toBe('[redacted]');
		expect(recorded.context.note).toBe('keep-me');
	});

	test('a rejected command is audited with outcome "rejected"', async () => {
		const { sender } = recordingSender();
		const entries: Array<{ outcome: string }> = [];
		const lease = new AtCommandLease({
			sender,
			allowlist: computeAtAllowlist([]),
			audit: { record: (entry) => entries.push(entry as { outcome: string }) },
		});
		await expect(lease.run('AT+NOPE')).rejects.toBeInstanceOf(AtCommandNotAllowedError);
		expect(entries[0]?.outcome).toBe('rejected');
	});
});
