import { describe, expect, test } from 'bun:test';
import { type ImpossibleStateCode, ImpossibleStateError } from './errors';
import { imeiEquipmentId, type ModemIdentity, runtimePath } from './identity';
import type { CellularSnapshot } from './snapshot';
import { createSnapshot, revision } from './snapshot';
import { epochMillis } from './state';

const IDENTITY: ModemIdentity = {
	equipmentId: imeiEquipmentId('490154203237518'),
	runtimePath: runtimePath('/org/freedesktop/ModemManager1/Modem/0'),
};

/** A fully valid registered + connected + NM-activated snapshot to mutate from. */
function connectedBase(): CellularSnapshot {
	return {
		identity: IDENTITY,
		presence: 'present',
		sourceHealth: 'live',
		simSlots: [{ index: 1, occupied: true, active: true, lock: 'none' }],
		radioPower: 'on',
		mmState: 'connected',
		registration: { status: 'home', activeRats: new Set(['lte']) },
		nmActivation: 'activated',
		dataInterface: { present: true, name: 'wwan0' },
		reconcileStatus: 'converged',
		recoveryState: { stage: 'idle', attempts: 0 },
		revision: revision(5),
	};
}

function expectImpossible(fields: CellularSnapshot, code: ImpossibleStateCode): void {
	expect(() => createSnapshot(fields)).toThrow(ImpossibleStateError);
	try {
		createSnapshot(fields);
	} catch (error) {
		expect(error).toBeInstanceOf(ImpossibleStateError);
		expect((error as ImpossibleStateError).code).toBe(code);
		return;
	}
	throw new Error(`expected ${code} to throw`);
}

describe('valid snapshots pass', () => {
	test('a coherent connected snapshot constructs', () => {
		expect(() => createSnapshot(connectedBase())).not.toThrow();
	});

	test('mmState locked WITH an occupied pin-locked slot is valid', () => {
		const s: CellularSnapshot = {
			...connectedBase(),
			mmState: 'locked',
			nmActivation: 'disconnected',
			registration: { status: 'idle', activeRats: new Set() },
			radioPower: 'on',
			dataInterface: { present: false },
			simSlots: [{ index: 1, occupied: true, active: true, lock: 'sim-pin' }],
		};
		expect(() => createSnapshot(s)).not.toThrow();
	});

	test('a cooldown recovery state with a deadline is valid', () => {
		const s: CellularSnapshot = {
			...connectedBase(),
			recoveryState: {
				stage: 'cooldown',
				attempts: 2,
				cooldownUntil: epochMillis(1_700_000_000_000),
			},
		};
		expect(() => createSnapshot(s)).not.toThrow();
	});
});

describe('impossible combinations throw typed errors', () => {
	test('registered while absent (the named guard)', () => {
		expectImpossible({ ...connectedBase(), presence: 'absent' }, 'registered-while-absent');
	});

	test('registered with the radio off', () => {
		expectImpossible({ ...connectedBase(), radioPower: 'off' }, 'registered-radio-off');
	});

	test('registered with an empty RAT set', () => {
		expectImpossible(
			{ ...connectedBase(), registration: { status: 'home', activeRats: new Set() } },
			'registered-empty-rat-set',
		);
	});

	test('an active MM state while absent', () => {
		expectImpossible(
			{
				...connectedBase(),
				presence: 'absent',
				mmState: 'enabled',
				registration: { status: 'idle', activeRats: new Set() },
				nmActivation: 'disconnected',
				dataInterface: { present: false },
			},
			'active-state-while-absent',
		);
	});

	test('the radio off while searching', () => {
		expectImpossible(
			{
				...connectedBase(),
				radioPower: 'off',
				mmState: 'searching',
				registration: { status: 'searching', activeRats: new Set() },
				nmActivation: 'disconnected',
				dataInterface: { present: false },
			},
			'radio-off-while-active',
		);
	});

	test('NM activated while absent', () => {
		expectImpossible(
			{
				...connectedBase(),
				presence: 'absent',
				mmState: 'disabled',
				registration: { status: 'idle', activeRats: new Set() },
				dataInterface: { present: false },
			},
			'nm-activated-while-absent',
		);
	});

	test('NM activated without a data interface', () => {
		expectImpossible(
			{ ...connectedBase(), dataInterface: { present: false } },
			'nm-activated-without-interface',
		);
	});

	test('NM activated while MM is not connected', () => {
		expectImpossible(
			{ ...connectedBase(), mmState: 'registered' },
			'nm-activated-without-mm-connected',
		);
	});

	test('more than one active SIM slot', () => {
		expectImpossible(
			{
				...connectedBase(),
				simSlots: [
					{ index: 1, occupied: true, active: true, lock: 'none' },
					{ index: 2, occupied: true, active: true, lock: 'none' },
				],
			},
			'multiple-active-sim-slots',
		);
	});

	test('a locked SIM in an empty slot', () => {
		expectImpossible(
			{
				...connectedBase(),
				simSlots: [{ index: 1, occupied: false, active: false, lock: 'sim-pin' }],
			},
			'locked-sim-in-empty-slot',
		);
	});

	test('MM locked without any locked SIM', () => {
		expectImpossible(
			{
				...connectedBase(),
				mmState: 'locked',
				nmActivation: 'disconnected',
				registration: { status: 'idle', activeRats: new Set() },
				dataInterface: { present: false },
				simSlots: [{ index: 1, occupied: true, active: true, lock: 'none' }],
			},
			'mm-locked-without-sim-lock',
		);
	});

	test('a data-interface name without presence', () => {
		expectImpossible(
			{
				...connectedBase(),
				mmState: 'disabled',
				nmActivation: 'disconnected',
				registration: { status: 'idle', activeRats: new Set() },
				dataInterface: { present: false, name: 'wwan0' },
			},
			'data-interface-name-without-presence',
		);
	});

	test('a negative recovery attempt count', () => {
		expectImpossible(
			{ ...connectedBase(), recoveryState: { stage: 'nm-cycle', attempts: -1 } },
			'recovery-attempts-negative',
		);
	});

	test('a cooldown deadline outside the cooldown stage', () => {
		expectImpossible(
			{
				...connectedBase(),
				recoveryState: { stage: 'nm-cycle', attempts: 1, cooldownUntil: epochMillis(123) },
			},
			'recovery-cooldown-stage-mismatch',
		);
	});

	test('idle recovery carrying attempts', () => {
		expectImpossible(
			{ ...connectedBase(), recoveryState: { stage: 'idle', attempts: 3 } },
			'recovery-idle-with-attempts',
		);
	});
});
