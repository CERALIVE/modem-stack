import { DisconnectedError, TransportError } from '../../transport';

export const MODEM_MANAGER_REFUSAL_REASONS = [
	'unauthorized',
	'unsupported',
	'wrong-state',
	'busy',
	'not-found',
	'timed-out',
	'disconnected',
	'failed',
] as const;

export type ModemManagerRefusalReason = (typeof MODEM_MANAGER_REFUSAL_REASONS)[number];

export type ModemManagerRefusal = {
	readonly reason: ModemManagerRefusalReason;
	readonly retryable: boolean;
};

function errorIdentity(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const dbusName = Reflect.get(error, 'dbusName');
	return `${typeof dbusName === 'string' ? dbusName : error.name} ${error.message}`;
}

export function mapModemManagerError(error: unknown): ModemManagerRefusal {
	if (error instanceof DisconnectedError) return { reason: 'disconnected', retryable: true };
	const identity = errorIdentity(error);
	if (/Unauthorized|AccessDenied/i.test(identity))
		return { reason: 'unauthorized', retryable: false };
	if (/Unsupported|NotSupported/i.test(identity))
		return { reason: 'unsupported', retryable: false };
	if (/WrongState|InvalidState/i.test(identity)) return { reason: 'wrong-state', retryable: true };
	if (/InProgress|Busy/i.test(identity)) return { reason: 'busy', retryable: true };
	if (/NotFound|UnknownObject|UnknownModem/i.test(identity)) {
		return { reason: 'not-found', retryable: false };
	}
	if (error instanceof TransportError && /timed out/i.test(error.message)) {
		return { reason: 'timed-out', retryable: true };
	}
	return { reason: 'failed', retryable: false };
}
