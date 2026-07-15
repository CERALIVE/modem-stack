// Power contract — only `none` is implemented, so every capability returns
// `unsupported` in Phase A (ladder rung 4 never actuates on today's hardware).

import { describe, expect, test } from 'bun:test';
import { epochMillis } from '../domain';
import {
	NONE_POWER_CAPABILITY,
	NONE_POWER_HOOK,
	type PowerCapability,
	unsupportedPowerHook,
} from './power-contract';

const context = { stableKey: 'slot:a', at: epochMillis(0) };

describe('power contract — Phase A', () => {
	test('the none capability describes a no-op with an enumeration timeout', () => {
		expect(NONE_POWER_CAPABILITY.power).toBe('none');
		expect(NONE_POWER_CAPABILITY.enumerationTimeoutMs).toBeGreaterThan(0);
	});

	test('NONE_POWER_HOOK.cycle always returns unsupported', async () => {
		const result = await NONE_POWER_HOOK.cycle(context);
		expect(result.status).toBe('unsupported');
		expect(result.reason).toContain('none');
	});

	test('a real capability is typed but unsupported (declared, not implemented)', async () => {
		const gpio: PowerCapability = {
			power: 'gpio-cut',
			usbReset: true,
			enumerationTimeoutMs: 15_000,
			preferredUsbMode: 'qmi',
		};
		const hook = unsupportedPowerHook(gpio);
		expect(hook.capability.power).toBe('gpio-cut');
		const result = await hook.cycle(context);
		expect(result.status).toBe('unsupported');
		expect(result.reason).toContain('gpio-cut');
	});
});
