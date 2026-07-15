// Redaction classes — ICCID, IMSI, EID, PIN, PUK, and APN/connection passwords are
// stripped, including deeply nested occurrences and inside arrays; non-secret
// siblings survive and the input is never mutated.

import { expect, test } from 'bun:test';
import { REDACTED, redact } from './redact';

test('redacts every sensitive class at the top level, keeping non-secret siblings', () => {
	const input = {
		iccid: '8988303000000000000',
		imsi: '310150123456789',
		eid: '89049032000000000000000000000000',
		pin: '1234',
		puk: '12345678',
		password: 's3cret',
		apn: 'internet',
		username: 'operator-user',
	};
	const out = redact(input) as Record<string, unknown>;

	expect(out.iccid).toBe(REDACTED);
	expect(out.imsi).toBe(REDACTED);
	expect(out.eid).toBe(REDACTED);
	expect(out.pin).toBe(REDACTED);
	expect(out.puk).toBe(REDACTED);
	expect(out.password).toBe(REDACTED);
	expect(out.apn).toBe('internet');
	expect(out.username).toBe('operator-user');
});

test('redacts an APN password nested three levels deep', () => {
	const policy = { connection: { auth: { username: 'u', password: 'hunter2' } } };
	const out = redact(policy) as { connection: { auth: { username: string; password: string } } };
	expect(out.connection.auth.password).toBe(REDACTED);
	expect(out.connection.auth.username).toBe('u');
});

test('redacts ICCID inside an array of SIM slots', () => {
	const input = {
		simSlots: [
			{ index: 1, iccid: '8988000000000000001' },
			{ index: 2, iccid: '8988000000000000002' },
		],
	};
	const out = redact(input) as { simSlots: Array<{ index: number; iccid: string }> };
	expect(out.simSlots[0]?.iccid).toBe(REDACTED);
	expect(out.simSlots[1]?.iccid).toBe(REDACTED);
	expect(out.simSlots[0]?.index).toBe(1);
	expect(out.simSlots[1]?.index).toBe(2);
});

test('redacts NM-style gsm.password but keeps the gsm.password-flags flag', () => {
	const input = { 'gsm.password': 'secret', 'gsm.password-flags': '0', 'gsm.apn': 'internet' };
	const out = redact(input) as Record<string, unknown>;
	expect(out['gsm.password']).toBe(REDACTED);
	expect(out['gsm.password-flags']).toBe('0');
	expect(out['gsm.apn']).toBe('internet');
});

test('redacts subscriptionId, newPin, and puk2 variants', () => {
	const input = { subscriptionId: '8988303000000000000', newPin: '4321', puk2: '87654321' };
	const out = redact(input) as Record<string, unknown>;
	expect(out.subscriptionId).toBe(REDACTED);
	expect(out.newPin).toBe(REDACTED);
	expect(out.puk2).toBe(REDACTED);
});

test('does not mutate the input', () => {
	const input = { pin: '1234', nested: { iccid: '5678' } };
	const before = JSON.stringify(input);
	redact(input);
	expect(JSON.stringify(input)).toBe(before);
});

test('passes primitives and empty containers through unchanged', () => {
	expect(redact('plain')).toBe('plain');
	expect(redact(42)).toBe(42);
	expect(redact(null)).toBe(null);
	expect(redact(undefined)).toBe(undefined);
	expect(redact({})).toEqual({});
	expect(redact([])).toEqual([]);
});
