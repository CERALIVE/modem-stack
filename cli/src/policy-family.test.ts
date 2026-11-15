import { expect, test } from 'bun:test';
import { imeiEquipmentId } from '@ceralive/modem-control';
import { parsePolicyText, toDesiredPolicy } from './policy-file';

const base = {
	enabled: true,
	connection: { apn: 'auto' },
	roaming: false,
	radio: { preferenceOrdered: ['lte'] },
};
const binding = { equipmentId: imeiEquipmentId('490154203237518') };

test('policy files default omission to dual stack and preserve each explicit family', () => {
	const omitted = toDesiredPolicy(parsePolicyText(JSON.stringify(base), 'policy.json'), binding);
	expect(omitted.connection).toEqual({ apn: 'auto', ipFamily: 'ipv4v6' });
	for (const ipFamily of ['ipv4', 'ipv6', 'ipv4v6'] as const) {
		const input = { ...base, connection: { apn: 'auto', ipFamily } };
		expect(
			toDesiredPolicy(parsePolicyText(JSON.stringify(input), 'policy.json'), binding).connection
				.ipFamily,
		).toBe(ipFamily);
	}
});

test('policy files reject unknown family values', () => {
	expect(() =>
		parsePolicyText(
			JSON.stringify({ ...base, connection: { apn: 'auto', ipFamily: 'any' } }),
			'policy.json',
		),
	).toThrow('connection.ipFamily');
});
