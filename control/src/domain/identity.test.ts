import { describe, expect, test } from 'bun:test';
import { PolicyBindingRefusedError } from './errors';
import {
	canBindPolicy,
	demoteToLowConfidence,
	imeiEquipmentId,
	type ModemIdentity,
	NO_EQUIPMENT_ID,
	runtimePath,
	serialEquipmentId,
} from './identity';
import { policyBindingKey } from './policy';

const PATH = runtimePath('/org/freedesktop/ModemManager1/Modem/0');

function identityWith(equipmentId: ModemIdentity['equipmentId']): ModemIdentity {
	return { equipmentId, runtimePath: PATH };
}

describe('equipment id confidence grading', () => {
	test('a canonical 15-digit IMEI grades high', () => {
		const id = imeiEquipmentId('490154203237518');
		expect(id).toEqual({ provenance: 'imei', value: '490154203237518', confidence: 'high' });
	});

	test('an all-zeros IMEI grades low (ambiguous placeholder)', () => {
		expect(imeiEquipmentId('000000000000000').confidence).toBe('low');
	});

	test('a blank IMEI grades low', () => {
		expect(imeiEquipmentId('   ').confidence).toBe('low');
	});

	test('a non-standard IMEI shape grades medium', () => {
		expect(imeiEquipmentId('49015420').confidence).toBe('medium');
	});

	test('a serial fallback caps at medium', () => {
		expect(serialEquipmentId('SN-ABC-123').confidence).toBe('medium');
	});

	test('the none provenance carries no value and is always low', () => {
		expect(NO_EQUIPMENT_ID).toEqual({ provenance: 'none', confidence: 'low' });
	});
});

describe('duplicate demotion', () => {
	test('a duplicate IMEI is demoted to low confidence but keeps its value', () => {
		const original = imeiEquipmentId('490154203237518');
		const demoted = demoteToLowConfidence(original);
		expect(demoted).toEqual({ provenance: 'imei', value: '490154203237518', confidence: 'low' });
	});

	test('demoting a none id is a no-op', () => {
		expect(demoteToLowConfidence(NO_EQUIPMENT_ID)).toBe(NO_EQUIPMENT_ID);
	});
});

describe('durable policy binding gate', () => {
	test('a high-confidence identity may bind policy and yields a key', () => {
		const identity = identityWith(imeiEquipmentId('490154203237518'));
		expect(canBindPolicy(identity)).toBe(true);
		expect(policyBindingKey(identity)).toEqual({ equipmentId: identity.equipmentId });
	});

	test('a low-confidence (zero IMEI) identity is refused', () => {
		const identity = identityWith(imeiEquipmentId('000000000000000'));
		expect(canBindPolicy(identity)).toBe(false);
		expect(() => policyBindingKey(identity)).toThrow(PolicyBindingRefusedError);
	});

	test('a duplicate-demoted identity is refused', () => {
		const identity = identityWith(demoteToLowConfidence(imeiEquipmentId('490154203237518')));
		expect(canBindPolicy(identity)).toBe(false);
		expect(() => policyBindingKey(identity)).toThrow(PolicyBindingRefusedError);
	});

	test('a none-provenance identity is refused (never binds durable policy)', () => {
		const identity = identityWith(NO_EQUIPMENT_ID);
		expect(canBindPolicy(identity)).toBe(false);
		expect(() => policyBindingKey(identity)).toThrow(PolicyBindingRefusedError);
	});
});
