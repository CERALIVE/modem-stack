import { describe, expect, test } from 'bun:test';
import {
	canBindPolicy,
	imeiEquipmentId,
	logicalSlotId,
	NO_EQUIPMENT_ID,
	PolicyBindingRefusedError,
	policyBindingKey,
} from '../domain';
import {
	looksLikeSlotUid,
	type ModemIdentityFacts,
	resolveModemIdentities,
	resolveModemIdentity,
} from './identity-ladder';

const IMEI_A = '490154203237518';
const IMEI_B = '356938035643809';
const PATH = '/org/freedesktop/ModemManager1/Modem/0';

function facts(overrides: Partial<ModemIdentityFacts> = {}): ModemIdentityFacts {
	return { runtimePath: PATH, equipmentId: imeiEquipmentId(IMEI_A), ...overrides };
}

describe('looksLikeSlotUid', () => {
	test('our slot-* naming is detected', () => {
		expect(looksLikeSlotUid('slot-usb2-1')).toBe(true);
	});

	test('MM path-shaped default is not a slot UID', () => {
		expect(looksLikeSlotUid('/sys/devices/pci0000:00/usb2')).toBe(false);
	});

	test('the bare prefix alone is not a slot UID', () => {
		expect(looksLikeSlotUid('slot-')).toBe(false);
	});

	test('an absent Device is not a slot UID', () => {
		expect(looksLikeSlotUid(undefined)).toBe(false);
	});
});

describe('identity ladder rungs (in priority order)', () => {
	test('rung 1: a slot-UID Device wins over Physdev and ports', () => {
		const resolved = resolveModemIdentity(
			facts({ device: 'slot-usb2-1', physdev: '/sys/devices/usb2', ports: ['ttyUSB0'] }),
		);
		expect(resolved.slotSource).toBe('device-slot-uid');
		expect(resolved.confidence).toBe('high');
		expect(resolved.identity.logicalSlotId).toBe(logicalSlotId('slot-usb2-1'));
		expect(resolved.stableKey).toBe('slot:slot-usb2-1');
	});

	test('rung 2: Physdev is used when Device is a path-shaped default', () => {
		const resolved = resolveModemIdentity(
			facts({ device: '/sys/devices/usb2', physdev: '/sys/devices/pci/usb2/2-1' }),
		);
		expect(resolved.slotSource).toBe('physdev');
		expect(resolved.confidence).toBe('high');
		expect(resolved.stableKey).toBe('physdev:/sys/devices/pci/usb2/2-1');
	});

	test('rung 3: a ports-derived sysfs walk when no slot UID or Physdev', () => {
		const resolved = resolveModemIdentity(facts({ ports: ['wwan0', 'ttyUSB2', 'ttyUSB0'] }));
		expect(resolved.slotSource).toBe('sysfs-walk');
		expect(resolved.confidence).toBe('medium');
		expect(resolved.stableKey).toBe('sysfs:ttyUSB0+ttyUSB2+wwan0');
	});

	test('rung 4: equipment fallback is low confidence with no slot', () => {
		const resolved = resolveModemIdentity(facts());
		expect(resolved.slotSource).toBe('equipment-fallback');
		expect(resolved.confidence).toBe('low');
		expect(resolved.identity.logicalSlotId).toBeUndefined();
		expect(resolved.stableKey).toBe(`equip:${IMEI_A}`);
	});

	test('rung 4 with no equipment id keys off the transient path', () => {
		const resolved = resolveModemIdentity(facts({ equipmentId: NO_EQUIPMENT_ID }));
		expect(resolved.stableKey).toBe(`path:${PATH}`);
	});
});

describe('durable policy binding through the ladder', () => {
	test('a slot-resolved unique modem may bind durable policy', () => {
		const resolved = resolveModemIdentity(facts({ device: 'slot-usb2-1' }));
		expect(canBindPolicy(resolved.identity)).toBe(true);
		expect(policyBindingKey(resolved.identity).logicalSlotId).toBe(logicalSlotId('slot-usb2-1'));
	});

	test('duplicate-IMEI fixture: the ladder falls to low-confidence equipment fallback and refuses binding', () => {
		const resolved = resolveModemIdentities([
			facts({
				runtimePath: '/org/freedesktop/ModemManager1/Modem/0',
				equipmentId: imeiEquipmentId(IMEI_A),
			}),
			facts({
				runtimePath: '/org/freedesktop/ModemManager1/Modem/1',
				equipmentId: imeiEquipmentId(IMEI_A),
			}),
		]);
		for (const each of resolved) {
			expect(each.slotSource).toBe('equipment-fallback');
			expect(each.identity.equipmentId.confidence).toBe('low');
			expect(canBindPolicy(each.identity)).toBe(false);
			expect(() => policyBindingKey(each.identity)).toThrow(PolicyBindingRefusedError);
		}
	});

	test('unique IMEIs are NOT demoted in a batch resolve', () => {
		const resolved = resolveModemIdentities([
			facts({ device: 'slot-a', equipmentId: imeiEquipmentId(IMEI_A) }),
			facts({ device: 'slot-b', equipmentId: imeiEquipmentId(IMEI_B) }),
		]);
		expect(resolved.every((each) => each.identity.equipmentId.confidence === 'high')).toBe(true);
	});
});
