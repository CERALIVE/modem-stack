import { describe, expect, test } from 'bun:test';
import { DisconnectedError, TransportError } from '../../transport';
import { mapModemManagerError } from './errors';

function namedError(name: string): Error {
	const error = new Error(name);
	Object.defineProperty(error, 'dbusName', { value: name });
	return error;
}

describe('mapModemManagerError', () => {
	test('maps Core.Unauthorized to the exact domain refusal', () => {
		expect(
			mapModemManagerError(namedError('org.freedesktop.ModemManager1.Error.Core.Unauthorized')),
		).toEqual({ reason: 'unauthorized', retryable: false });
	});

	test('keeps unsupported, wrong-state, busy, timeout, and disconnect distinct', () => {
		expect(mapModemManagerError(namedError('x.Error.Core.Unsupported')).reason).toBe('unsupported');
		expect(mapModemManagerError(namedError('x.Error.Core.WrongState')).reason).toBe('wrong-state');
		expect(mapModemManagerError(namedError('x.Error.Core.InProgress')).reason).toBe('busy');
		expect(mapModemManagerError(new TransportError('call timed out')).reason).toBe('timed-out');
		expect(mapModemManagerError(new DisconnectedError()).reason).toBe('disconnected');
	});
});
