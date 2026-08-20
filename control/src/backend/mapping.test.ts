// `Modem.OwnNumbers` → `identity.ownNumbers` — pure fixtures, no bus.
//
// Board evidence (Quectel RM530N-GL, `mmcli -m 3`): `own: +573115422359`. MM
// publishes the property as `as`, so the read must survive a list, a list the
// carrier left empty, and a property the firmware does not export at all —
// three different facts that must not collapse into one another.

import { describe, expect, test } from 'bun:test';
import { subscriberNumber } from '../domain';
import type { DbusVariant } from '../transport';
import { MODEM_IFACE, MODEM3GPP_IFACE } from './constants';
import type { DecodedManagedObjects, DecodedProps } from './managed-objects';
import { fingerprint, mapModem } from './mapping';

const MODEM_PATH = '/org/freedesktop/ModemManager1/Modem/3';
const BOARD_OWN_NUMBER = '+573115422359';
const SECOND_OWN_NUMBER = '+573001112233';

function variant(value: unknown, signature: string): DbusVariant {
	return { signature, value } as DbusVariant;
}

function props(record: Record<string, DbusVariant>): DecodedProps {
	return Object.entries(record).map(([key, value]) => [key, value] as const);
}

function tree(modemProps: Record<string, DbusVariant>): DecodedManagedObjects {
	return [
		[
			MODEM_PATH,
			[
				[
					MODEM_IFACE,
					props({
						EquipmentIdentifier: variant('867978050016855', 's'),
						State: variant(8, 'i'),
						PowerState: variant(3, 'u'),
						...modemProps,
					}),
				],
				[MODEM3GPP_IFACE, props({ Imei: variant('867978050016855', 's') })],
			],
		],
	];
}

describe('mapModem — the SIM own number', () => {
	test('a published number reaches the identity verbatim', () => {
		const mapped = mapModem(tree({ OwnNumbers: variant([BOARD_OWN_NUMBER], 'as') }), MODEM_PATH);

		expect(mapped.identity.ownNumbers).toEqual([subscriberNumber(BOARD_OWN_NUMBER)]);
	});

	test('a multi-number SIM keeps every number, in order', () => {
		const mapped = mapModem(
			tree({ OwnNumbers: variant([BOARD_OWN_NUMBER, SECOND_OWN_NUMBER], 'as') }),
			MODEM_PATH,
		);

		expect(mapped.identity.ownNumbers).toEqual([
			subscriberNumber(BOARD_OWN_NUMBER),
			subscriberNumber(SECOND_OWN_NUMBER),
		]);
	});

	test('an ABSENT property omits the key entirely', () => {
		const mapped = mapModem(tree({}), MODEM_PATH);

		expect(Object.hasOwn(mapped.identity, 'ownNumbers')).toBe(false);
	});

	test('an EMPTY list reads as not-reported, never as an empty list', () => {
		const mapped = mapModem(tree({ OwnNumbers: variant([], 'as') }), MODEM_PATH);

		expect(Object.hasOwn(mapped.identity, 'ownNumbers')).toBe(false);
	});

	test('blank and non-string members are dropped rather than coerced', () => {
		const mapped = mapModem(
			tree({ OwnNumbers: variant(['  ', BOARD_OWN_NUMBER, 42, ''], 'as') }),
			MODEM_PATH,
		);

		expect(mapped.identity.ownNumbers).toEqual([subscriberNumber(BOARD_OWN_NUMBER)]);
	});

	test('a whitespace-only list reads as not-reported', () => {
		const mapped = mapModem(tree({ OwnNumbers: variant(['   ', ''], 'as') }), MODEM_PATH);

		expect(Object.hasOwn(mapped.identity, 'ownNumbers')).toBe(false);
	});

	test('a changed number bumps the fingerprint, so the row re-publishes', () => {
		const before = fingerprint(
			mapModem(tree({ OwnNumbers: variant([BOARD_OWN_NUMBER], 'as') }), MODEM_PATH),
		);
		const after = fingerprint(
			mapModem(tree({ OwnNumbers: variant([SECOND_OWN_NUMBER], 'as') }), MODEM_PATH),
		);
		const absent = fingerprint(mapModem(tree({}), MODEM_PATH));

		expect(before).not.toBe(after);
		expect(before).not.toBe(absent);
	});

	test('every other mapped dimension is untouched by the read', () => {
		const withNumber = mapModem(
			tree({ OwnNumbers: variant([BOARD_OWN_NUMBER], 'as') }),
			MODEM_PATH,
		);
		const without = mapModem(tree({}), MODEM_PATH);

		expect({ ...withNumber, identity: undefined }).toEqual({ ...without, identity: undefined });
		expect(withNumber.identity.equipmentId).toEqual(without.identity.equipmentId);
		expect(withNumber.identity.runtimePath).toBe(without.identity.runtimePath);
	});
});
