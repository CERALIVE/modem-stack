// Classifying a failed USSD call — and the one distinction this module exists
// for: a carrier that will not carry USSD on a packet-only registration is NOT a
// modem that cannot do USSD.

import { expect, test } from 'bun:test';
import { classifyUssdFailure, isPacketSwitchedOnly } from './refusal';

/** MM raises D-Bus errors whose `name` is the fully-qualified error name. */
function dbusError(name: string, message = 'operation failed'): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

const CS_CAPABLE = { registered: true, csDomain: true, accessTechnologies: ['umts'] };
const LTE_ONLY = { registered: true, csDomain: false, accessTechnologies: ['lte'] };
const UNREAD = { registered: false };

test('an unsupported error on a CS-capable registration is a device limit', () => {
	const reason = classifyUssdFailure(
		dbusError('org.freedesktop.ModemManager1.Error.Core.Unsupported'),
		CS_CAPABLE,
	);
	expect(reason).toBe('unsupported');
});

test('the SAME error on an LTE-only registration is reported as a carrier policy', () => {
	const reason = classifyUssdFailure(
		dbusError('org.freedesktop.ModemManager1.Error.Core.Unsupported'),
		LTE_ONLY,
	);
	expect(reason).toBe('lte-only-unsupported');
});

test('a generic Core.Failed on an LTE-only registration is promoted too', () => {
	const reason = classifyUssdFailure(
		dbusError('org.freedesktop.ModemManager1.Error.Core.Failed', 'network rejected the request'),
		LTE_ONLY,
	);
	expect(reason).toBe('lte-only-unsupported');
});

test('an UNREAD registration never earns the more specific claim', () => {
	// "We did not look" is not evidence, so the honest answer stays the generic
	// one. This is the property that makes the promotion above safe.
	const reason = classifyUssdFailure(
		dbusError('org.freedesktop.ModemManager1.Error.Core.Unsupported'),
		UNREAD,
	);
	expect(reason).toBe('unsupported');
});

test('a not-registered failure is NOT promoted, on any registration', () => {
	const reason = classifyUssdFailure(
		dbusError('org.freedesktop.ModemManager1.Error.Core.NoNetwork'),
		LTE_ONLY,
	);
	expect(reason).toBe('not-registered');
});

test('a bus failure is NOT promoted and stays transport-failed', () => {
	const reason = classifyUssdFailure(new Error('D-Bus connection is not established'), LTE_ONLY);
	expect(reason).toBe('transport-failed');
});

test('an in-progress error is the busy session', () => {
	expect(
		classifyUssdFailure(dbusError('org.freedesktop.ModemManager1.Error.Core.InProgress')),
	).toBe('session-busy');
});

test('the transport timeout message classifies as a timeout', () => {
	const reason = classifyUssdFailure(
		new Error('Method call Modem3gpp.Ussd.Initiate timed out after 45000ms'),
	);
	expect(reason).toBe('timeout');
});

test('a Core.Failed naming no active session is no-session, not carrier-rejected', () => {
	const reason = classifyUssdFailure(
		dbusError('org.freedesktop.ModemManager1.Error.Core.Failed', 'no active USSD session'),
	);
	expect(reason).toBe('no-session');
});

test('an error carrying its D-Bus name on `dbusName` is read too', () => {
	const error = Object.assign(new Error('boom'), {
		dbusName: 'org.freedesktop.ModemManager1.Error.Core.Unsupported',
	});
	expect(classifyUssdFailure(error, CS_CAPABLE)).toBe('unsupported');
});

test('an unrecognised failure of any shape is transport-failed', () => {
	expect(classifyUssdFailure('something went wrong')).toBe('transport-failed');
	expect(classifyUssdFailure(undefined)).toBe('transport-failed');
	expect(classifyUssdFailure({})).toBe('transport-failed');
});

test('packet-switched-only needs evidence in BOTH directions', () => {
	expect(isPacketSwitchedOnly(LTE_ONLY)).toBe(true);
	expect(
		isPacketSwitchedOnly({ registered: true, csDomain: false, accessTechnologies: ['5gnr'] }),
	).toBe(true);
	// A CS domain that is present, unknown, or contradicted by a CS radio all
	// answer false — the claim requires a positive absence.
	expect(isPacketSwitchedOnly(CS_CAPABLE)).toBe(false);
	expect(isPacketSwitchedOnly({ registered: true, accessTechnologies: ['lte'] })).toBe(false);
	expect(
		isPacketSwitchedOnly({
			registered: true,
			csDomain: false,
			accessTechnologies: ['lte', 'umts'],
		}),
	).toBe(false);
	expect(isPacketSwitchedOnly({ registered: true, csDomain: false, accessTechnologies: [] })).toBe(
		false,
	);
	expect(
		isPacketSwitchedOnly({ registered: false, csDomain: false, accessTechnologies: ['lte'] }),
	).toBe(false);
});
