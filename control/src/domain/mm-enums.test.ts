import { describe, expect, test } from 'bun:test';
import {
	decodeMmAccessTechnologies,
	decodeMmState,
	decodeNetworkRejectionError,
	decodeRegistrationState,
	decodeUnlockRequired,
	modeMaskToLabel,
	runtimeIdFromPath,
} from './mm-enums';

describe('ModemManager enum normalization', () => {
	test('folds access and mode masks into shared wire vocabulary', () => {
		expect([...decodeMmAccessTechnologies((1 << 14) | (1 << 15))]).toEqual(['lte', '5gnr']);
		expect(modeMaskToLabel((1 << 2) | (1 << 3) | (1 << 4))).toBe('5g4g3g');
	});

	test('decodes states, locks, and reject causes', () => {
		expect(decodeMmState(11)).toBe('connected');
		expect(decodeRegistrationState(9)).toBe('roaming');
		expect(decodeUnlockRequired(3)).toBe('sim-pin2');
		expect(decodeNetworkRejectionError(8)).toBe('gprs-and-non-gprs-not-allowed');
	});

	test('extracts only a trailing numeric runtime id', () => {
		expect(runtimeIdFromPath('/org/freedesktop/ModemManager1/Modem/7')).toBe(7);
		expect(runtimeIdFromPath('/org/freedesktop/ModemManager1/Modem/x')).toBeUndefined();
	});
});
