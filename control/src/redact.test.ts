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

test('redacts a GNSS fix — coordinates never survive redaction', () => {
	const fix = { latitude: 4.60971, longitude: -74.08175, altitude: 2640, observedAt: 1000 };
	const out = redact(fix) as Record<string, unknown>;

	expect(out.latitude).toBe(REDACTED);
	expect(out.longitude).toBe(REDACTED);
	expect(out.altitude).toBe(REDACTED);
	expect(out.observedAt).toBe(1000);
});

test('redacts raw NMEA sentences, which carry the position in their payload', () => {
	const input = { nmea: '$GPGGA,123519.00,4807.038,N,01131.000,E,1,08,0.9,545.4,M,,,,*47' };
	const out = redact(input) as Record<string, unknown>;
	expect(out.nmea).toBe(REDACTED);
});

test('redacts a fix nested inside a modem row and inside an array', () => {
	const input = {
		modems: [
			{ stableKey: 'slot:a', gnss: { fix: { lat: 4.6, lng: -74.08 } } },
			{ stableKey: 'slot:b', gnss: { fix: undefined } },
		],
	};
	const serialized = JSON.stringify(redact(input));

	expect(serialized).not.toContain('4.6');
	expect(serialized).not.toContain('-74.08');
	expect(serialized).toContain('slot:a');
});

test('coarse cell location stays visible — the GNSS fence does not blank cell-info', () => {
	// `3gpp-lac-ci` is the cell-info module's own gated output. Redacting it here
	// would silently blank a shipping surface that never opted into the GNSS fence.
	const input = { lac: '0x1a2b', ci: '0x00c1f204', tac: '0x1234' };
	const out = redact(input) as Record<string, unknown>;
	expect(out.lac).toBe('0x1a2b');
	expect(out.ci).toBe('0x00c1f204');
	expect(out.tac).toBe('0x1234');
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

test('SMS content is redacted by key, in every spelling', () => {
	const out = redact({
		smsText: 'Tu pin es 4821',
		sms_body: 'code 9911',
		smsNumber: '85573',
		smsSender: '+573103154363',
		sender: '85573',
		msisdn: '+573001112233',
		'sms.content.text': 'Tu pin es 4821',
		'sms.content.number': '85573',
	}) as Record<string, unknown>;
	for (const value of Object.values(out)) {
		expect(value).toBe(REDACTED);
	}
});

test('a message body nested in an inbox array is redacted at depth', () => {
	const out = redact({
		inbox: [{ id: '36', smsText: 'Tu pin es 4821', state: 'received' }],
	}) as { inbox: Array<Record<string, unknown>> };
	expect(out.inbox[0]?.smsText).toBe(REDACTED);
	expect(out.inbox[0]?.id).toBe('36');
	expect(out.inbox[0]?.state).toBe('received');
});

test('the SMS class does not over-redact ordinary text and number fields', () => {
	// This is why the SMS keys are their own set: `SENSITIVE_KEYS` matches a leaf
	// name exactly, so adding `text` / `number` / `sender` to it would blank a
	// receipt reason, a slot number, and a signal reading across the package.
	const out = redact({
		text: 'reason: unsupported',
		number: 3,
		reason: 'no messaging capabilities',
		smsCount: 37,
		senderName: 'CeraLive',
	}) as Record<string, unknown>;
	expect(out.text).toBe('reason: unsupported');
	expect(out.number).toBe(3);
	expect(out.reason).toBe('no messaging capabilities');
	expect(out.smsCount).toBe(37);
	expect(out.senderName).toBe('CeraLive');
});

test('every USSD carrier-text key is redacted, in both directions', () => {
	const out = redact({
		ussd: '*123#',
		ussdCommand: '*123*1234567890123456#',
		ussdReply: 'Your balance is $4.20',
		ussd_response: '1',
		ussdText: 'Menu: 1) Balance 2) Data',
		networkNotification: 'You have been topped up',
		network_request: 'Enter your PIN',
	}) as Record<string, unknown>;
	for (const value of Object.values(out)) {
		expect(value).toBe(REDACTED);
	}
});

test('a USSD reply nested in a session snapshot is redacted at depth', () => {
	const out = redact({
		session: { state: 'awaiting-reply', ussdReply: 'Your balance is $4.20' },
	}) as { session: Record<string, unknown> };
	expect(out.session.ussdReply).toBe(REDACTED);
	expect(out.session.state).toBe('awaiting-reply');
});

test('the USSD class does not over-redact ordinary reply and command fields', () => {
	const out = redact({
		reply: 'ok',
		command: 'AT+CFUN?',
		response: 'OK',
		ussdCapable: true,
		ussdSessionState: 'active',
	}) as Record<string, unknown>;
	expect(out.reply).toBe('ok');
	expect(out.command).toBe('AT+CFUN?');
	expect(out.response).toBe('OK');
	expect(out.ussdCapable).toBe(true);
	expect(out.ussdSessionState).toBe('active');
});

test('the SIM own-number is redacted in every spelling the stack can produce', () => {
	const out = redact({
		ownNumbers: ['+573115422359'],
		own_number: '+573115422359',
		OwnNumbers: ['+573115422359'],
		phoneNumber: '+573115422359',
		simNumber: '+573115422359',
		subscriberNumber: '+573115422359',
		'modem.generic.own-numbers': ['+573115422359'],
	}) as Record<string, unknown>;
	for (const value of Object.values(out)) {
		expect(value).toBe(REDACTED);
	}
});

test('an own-number nested inside an identity is redacted at depth', () => {
	const out = redact({
		identity: {
			equipmentId: { provenance: 'imei', value: '867978050016855', confidence: 'high' },
			ownNumbers: ['+573115422359'],
			runtimePath: '/org/freedesktop/ModemManager1/Modem/3',
		},
	}) as { identity: Record<string, unknown> };
	expect(out.identity.ownNumbers).toBe(REDACTED);
	expect(out.identity.runtimePath).toBe('/org/freedesktop/ModemManager1/Modem/3');
});

test('the own-number class does not over-redact ordinary number fields', () => {
	// This is why it is its own whole-key set: `SENSITIVE_KEYS` matches a leaf
	// name, so `number`/`numbers` there would blank a slot index and a band count.
	const out = redact({
		number: 3,
		numbers: [1, 2, 3],
		slotNumber: 1,
		serialNumber: 'c6125db3',
		ownNumberSupported: true,
	}) as Record<string, unknown>;
	expect(out.number).toBe(3);
	expect(out.numbers).toEqual([1, 2, 3]);
	expect(out.slotNumber).toBe(1);
	expect(out.serialNumber).toBe('c6125db3');
	expect(out.ownNumberSupported).toBe(true);
});
