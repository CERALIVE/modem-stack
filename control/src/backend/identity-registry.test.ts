import { describe, expect, test } from 'bun:test';
import { imeiEquipmentId, logicalSlotId, runtimePath } from '../domain';
import { type ModemIdentityFacts, resolveModemIdentity } from './identity-ladder';
import { IdentityRegistry } from './identity-registry';

const IMEI_A = '490154203237518';
const IMEI_B = '356938035643809';

function resolvedAt(
	device: string,
	imei: string,
	path: string,
	extra: Partial<ModemIdentityFacts> = {},
) {
	return resolveModemIdentity({
		runtimePath: path,
		device,
		equipmentId: imeiEquipmentId(imei),
		...extra,
	});
}

describe('IdentityRegistry transitions', () => {
	test('a fresh stable key attaches a new row', () => {
		const registry = new IdentityRegistry();
		const transition = registry.apply(resolvedAt('slot-a', IMEI_A, '/Modem/0'));
		expect(transition.kind).toBe('attached');
		expect(registry.rows).toHaveLength(1);
	});

	test('replug into the SAME slot keeps ONE row and updates the path', () => {
		const registry = new IdentityRegistry();
		registry.apply(resolvedAt('slot-a', IMEI_A, '/Modem/0'));
		const transition = registry.apply(resolvedAt('slot-a', IMEI_A, '/Modem/7'));

		expect(transition.kind).toBe('replugged');
		expect(registry.rows).toHaveLength(1);
		expect(registry.rows[0]?.runtimePath).toBe(runtimePath('/Modem/7'));
		if (transition.kind === 'replugged') {
			expect(transition.previousPath).toBe(runtimePath('/Modem/0'));
		}
	});

	test('a different modem in the SAME slot is an equipment-swap (slot inherits policy)', () => {
		const registry = new IdentityRegistry();
		registry.apply(resolvedAt('slot-a', IMEI_A, '/Modem/0'));
		const transition = registry.apply(resolvedAt('slot-a', IMEI_B, '/Modem/1'));

		expect(transition.kind).toBe('equipment-swapped-in-slot');
		expect(registry.rows).toHaveLength(1);
		expect(registry.rows[0]?.logicalSlotId).toBe(logicalSlotId('slot-a'));
		expect(
			registry.rows[0]?.equipmentId.provenance === 'imei' && registry.rows[0]?.equipmentId.value,
		).toBe(IMEI_B);
		if (transition.kind === 'equipment-swapped-in-slot') {
			expect(
				transition.previousEquipment.provenance === 'imei' && transition.previousEquipment.value,
			).toBe(IMEI_A);
		}
	});

	test('the SAME equipment in a different slot is an equipment-move', () => {
		const registry = new IdentityRegistry();
		registry.apply(resolvedAt('slot-a', IMEI_A, '/Modem/0'));
		const transition = registry.apply(resolvedAt('slot-b', IMEI_A, '/Modem/2'));

		expect(transition.kind).toBe('equipment-moved');
		expect(registry.rows).toHaveLength(1);
		expect(registry.rows[0]?.logicalSlotId).toBe(logicalSlotId('slot-b'));
		if (transition.kind === 'equipment-moved') {
			expect(transition.previousKey).toBe('slot:slot-a');
			expect(transition.previousSlot).toBe(logicalSlotId('slot-a'));
		}
	});

	test('two distinct slots keep two independent rows', () => {
		const registry = new IdentityRegistry();
		registry.apply(resolvedAt('slot-a', IMEI_A, '/Modem/0'));
		registry.apply(resolvedAt('slot-b', IMEI_B, '/Modem/1'));
		expect(registry.rows).toHaveLength(2);
	});

	test('remove drops a row by stable key', () => {
		const registry = new IdentityRegistry();
		registry.apply(resolvedAt('slot-a', IMEI_A, '/Modem/0'));
		registry.remove('slot:slot-a');
		expect(registry.rows).toHaveLength(0);
	});
});
