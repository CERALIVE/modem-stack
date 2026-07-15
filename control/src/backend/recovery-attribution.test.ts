// Fault attribution — pure classification with the stale-forces-indeterminate
// invariant as the headline safety test.

import { describe, expect, test } from 'bun:test';
import { imeiEquipmentId, initialSnapshot, type ModemIdentity, runtimePath } from '../domain';
import {
	attributeFault,
	attributeSnapshot,
	type FaultSymptoms,
	symptomsFromSnapshot,
} from './recovery-attribution';

/** A live, present, otherwise-unremarkable symptom baseline. */
function symptoms(overrides: Partial<FaultSymptoms> = {}): FaultSymptoms {
	return {
		sourceHealth: 'live',
		presence: 'present',
		mmState: 'connected',
		registration: 'home',
		nmActivation: 'activated',
		...overrides,
	};
}

describe('attributeFault — confident classification', () => {
	test('MM reporting a failed modem on a live source → modem-fault', () => {
		expect(attributeFault(symptoms({ mmState: 'failed' }))).toBe('modem-fault');
	});

	test('denied registration → network-fault', () => {
		expect(attributeFault(symptoms({ registration: 'denied' }))).toBe('network-fault');
	});

	test('registered but NM not activated (registered-but-no-data) → network-fault', () => {
		expect(attributeFault(symptoms({ registration: 'home', nmActivation: 'failed' }))).toBe(
			'network-fault',
		);
		expect(
			attributeFault(symptoms({ registration: 'roaming', nmActivation: 'disconnected' })),
		).toBe('network-fault');
	});

	test('healthy registered+activated modem → indeterminate (no clear fault)', () => {
		expect(attributeFault(symptoms())).toBe('indeterminate');
	});

	test('a searching modem is ambiguous → indeterminate', () => {
		expect(attributeFault(symptoms({ mmState: 'searching', registration: 'searching' }))).toBe(
			'indeterminate',
		);
	});

	test('absent modem on a live source → indeterminate (nothing to attribute)', () => {
		expect(attributeFault(symptoms({ presence: 'absent', mmState: 'unknown' }))).toBe(
			'indeterminate',
		);
	});
});

describe('attributeFault — HARD INVARIANT: stale / sourceUnavailable forces indeterminate', () => {
	test('a STALE source forces indeterminate even when MM says the modem failed', () => {
		// Without the invariant this would classify modem-fault and could authorise a
		// disruptive step off data we no longer trust.
		expect(attributeFault(symptoms({ sourceHealth: 'stale', mmState: 'failed' }))).toBe(
			'indeterminate',
		);
	});

	test('a sourceUnavailable source forces indeterminate even for a clear modem-fault', () => {
		expect(attributeFault(symptoms({ sourceHealth: 'sourceUnavailable', mmState: 'failed' }))).toBe(
			'indeterminate',
		);
	});

	test('stale input never yields network-fault either', () => {
		expect(attributeFault(symptoms({ sourceHealth: 'stale', registration: 'denied' }))).toBe(
			'indeterminate',
		);
	});
});

describe('symptomsFromSnapshot / attributeSnapshot', () => {
	const identity: ModemIdentity = {
		equipmentId: imeiEquipmentId('359000000000001'),
		runtimePath: runtimePath('/org/freedesktop/ModemManager1/Modem/0'),
	};

	test('projects the attribution-relevant dimensions out of a snapshot', () => {
		const snapshot = initialSnapshot(identity);
		expect(symptomsFromSnapshot(snapshot)).toEqual({
			sourceHealth: 'live',
			presence: 'absent',
			mmState: 'unknown',
			registration: 'unknown',
			nmActivation: 'unavailable',
		});
	});

	test('attributeSnapshot on a fresh (absent) snapshot → indeterminate', () => {
		expect(attributeSnapshot(initialSnapshot(identity))).toBe('indeterminate');
	});
});
