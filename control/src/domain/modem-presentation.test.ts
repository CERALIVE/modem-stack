import { describe, expect, test } from 'bun:test';
import { firmwareIdentityLabel, modemHardwareLabel, modemHardwareName } from './modem-presentation';

describe('modem hardware presentation', () => {
	test('keeps an informative model and adds the IMEI tail', () => {
		expect(modemHardwareName({ model: 'RM530N-GL', equipmentId: '868837088254863' })).toBe(
			'RM530N-GL - 54863',
		);
	});

	test('replaces a numeric model with the firmware family', () => {
		const identity = {
			model: '0',
			manufacturer: '1',
			firmwareRevision: 'HIMI_U01_MODEM_V1.0  1  [Sep 09 2015 10:00:00]',
		};
		expect(firmwareIdentityLabel(identity.firmwareRevision)).toBe('HIMI_U01_MODEM_V1.0');
		expect(modemHardwareLabel(identity)).toBe('HIMI_U01_MODEM_V1.0');
	});

	test('uses the unnamed floor when every reported field is uninformative', () => {
		expect(
			modemHardwareName({ model: '--', manufacturer: '1', firmwareRevision: '81600.0000.00' }),
		).toBe('Cellular modem');
	});
});
