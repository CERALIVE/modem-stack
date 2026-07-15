// Receipt taxonomy — every status reachable, "prefer 5G on 4G-only" is surfaced as
// `unsupported` (never silently downgraded), and every receipt carries a reason.

import { expect, test } from 'bun:test';
import {
	type DesiredCellularPolicy,
	defaultCellularPolicy,
	imeiEquipmentId,
	type PolicyBindingKey,
	policyBindingKey,
	runtimePath,
} from '../domain';
import { connectionId, deviceIfname } from './network-manager';
import type { PolicyDimension, Receipt } from './receipts';
import { type AppliedCellularState, type ModemCapabilities, planReconcile } from './reconcile';

const BOUND_TO: PolicyBindingKey = policyBindingKey({
	equipmentId: imeiEquipmentId('490154203237518'),
	runtimePath: runtimePath('/org/freedesktop/ModemManager1/Modem/0'),
});

const FOUR_G_ONLY: ModemCapabilities = {
	supportedRats: new Set(['lte', 'umts', 'gsm']),
	simSlotCount: 1,
	supportsAutoApn: true,
};

const FIVE_G_DUAL_SLOT: ModemCapabilities = {
	supportedRats: new Set(['5gnr', 'lte', 'umts', 'gsm']),
	simSlotCount: 2,
	supportsAutoApn: true,
};

const ADDRESSABLE = {
	connectionId: connectionId('conn-uuid'),
	deviceIfname: deviceIfname('wwan0'),
	appliedApn: 'auto',
	appliedRoaming: false,
	appliedRadioPreference: ['5gnr', 'lte', 'umts', 'gsm'],
} as const;

function receiptFor(receipts: readonly Receipt[], dimension: PolicyDimension): Receipt {
	const found = receipts.find((entry) => entry.dimension === dimension);
	if (found === undefined) {
		throw new Error(`no receipt for dimension ${dimension}`);
	}
	return found;
}

test('prefer 5G on a 4G-only modem is unsupported with a reason, never silently applied', () => {
	const policy = defaultCellularPolicy(BOUND_TO);
	const applied: AppliedCellularState = { nmActivation: 'disconnected', hasProfile: false };
	const { ops, receipts } = planReconcile(applied, policy, FOUR_G_ONLY);

	const radio = receiptFor(receipts, 'radio');
	expect(radio.status).toBe('unsupported');
	expect(radio.reason).toContain('5gnr');
	expect(radio.reason.length).toBeGreaterThan(0);
	expect(ops.filter((op) => op.port === 'mm' && op.op.kind === 'setRadioModes')).toEqual([]);
});

test('all four receipt statuses are reachable', () => {
	const policy = defaultCellularPolicy(BOUND_TO);

	const applied: AppliedCellularState = {
		nmActivation: 'activated',
		hasProfile: true,
		...ADDRESSABLE,
	};
	expect(
		receiptFor(planReconcile(applied, policy, FIVE_G_DUAL_SLOT).receipts, 'enabled').status,
	).toBe('applied');

	const pending: AppliedCellularState = {
		nmActivation: 'disconnected',
		hasProfile: true,
		...ADDRESSABLE,
	};
	expect(
		receiptFor(planReconcile(pending, policy, FIVE_G_DUAL_SLOT).receipts, 'enabled').status,
	).toBe('pending');

	const unsupported: AppliedCellularState = { nmActivation: 'disconnected', hasProfile: false };
	expect(receiptFor(planReconcile(unsupported, policy, FOUR_G_ONLY).receipts, 'radio').status).toBe(
		'unsupported',
	);

	const failed: AppliedCellularState = {
		nmActivation: 'failed',
		hasProfile: true,
		activationFailureReason: 'no-signal',
		...ADDRESSABLE,
	};
	const failedReceipt = receiptFor(
		planReconcile(failed, policy, FIVE_G_DUAL_SLOT).receipts,
		'enabled',
	);
	expect(failedReceipt.status).toBe('failed');
	expect(failedReceipt.reason).toContain('no-signal');
});

test('every dimension yields a receipt and every receipt has a non-empty reason', () => {
	const policy = defaultCellularPolicy(BOUND_TO);
	const { receipts } = planReconcile(
		{ nmActivation: 'disconnected', hasProfile: false },
		policy,
		FOUR_G_ONLY,
	);
	for (const entry of receipts) {
		expect(entry.reason.length).toBeGreaterThan(0);
	}
	const expectedDimensions: PolicyDimension[] = [
		'connection',
		'enabled',
		'radio',
		'recovery',
		'roaming',
		'simSlot',
		'usage',
	];
	expect(receipts.map((entry) => entry.dimension).sort()).toEqual(expectedDimensions.sort());
});

test('primary SIM slot selection is unsupported on a single-slot modem', () => {
	const policy: DesiredCellularPolicy = { ...defaultCellularPolicy(BOUND_TO), simSlot: 2 };
	const { receipts } = planReconcile(
		{ nmActivation: 'disconnected', hasProfile: false },
		policy,
		FOUR_G_ONLY,
	);
	expect(receiptFor(receipts, 'simSlot').status).toBe('unsupported');
});

test('an out-of-range primary SIM slot is a failed receipt', () => {
	const policy: DesiredCellularPolicy = { ...defaultCellularPolicy(BOUND_TO), simSlot: 5 };
	const { receipts } = planReconcile(
		{ nmActivation: 'disconnected', hasProfile: false },
		policy,
		FIVE_G_DUAL_SLOT,
	);
	expect(receiptFor(receipts, 'simSlot').status).toBe('failed');
});

test('Auto-APN is unsupported when the stack cannot auto-configure', () => {
	const policy = defaultCellularPolicy(BOUND_TO);
	const caps: ModemCapabilities = { ...FIVE_G_DUAL_SLOT, supportsAutoApn: false };
	const { receipts } = planReconcile(
		{ nmActivation: 'disconnected', hasProfile: false },
		policy,
		caps,
	);
	expect(receiptFor(receipts, 'connection').status).toBe('unsupported');
});
