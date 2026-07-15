// Idempotent re-apply — a minimal in-memory stack executes the planner's
// port-tagged ops; re-applying the same policy performs ZERO new side effects and
// returns the same receipts. NOT the A2.3 fake D-Bus harness — just enough to prove
// the pure planner converges to a fixpoint.

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
import type { PortTaggedOp } from './ops';
import type { Receipt } from './receipts';
import { type AppliedCellularState, type ModemCapabilities, planReconcile } from './reconcile';

const BOUND_TO: PolicyBindingKey = policyBindingKey({
	equipmentId: imeiEquipmentId('490154203237518'),
	runtimePath: runtimePath('/org/freedesktop/ModemManager1/Modem/0'),
});

const FIVE_G_DUAL_SLOT: ModemCapabilities = {
	supportedRats: new Set(['5gnr', 'lte', 'umts', 'gsm']),
	simSlotCount: 2,
	supportsAutoApn: true,
};

const FOUR_G_ONLY: ModemCapabilities = {
	supportedRats: new Set(['lte', 'umts', 'gsm']),
	simSlotCount: 2,
	supportsAutoApn: true,
};

class InMemoryStack {
	private state: AppliedCellularState;
	readonly executed: PortTaggedOp[] = [];

	constructor(
		initial: AppliedCellularState,
		private readonly capabilities: ModemCapabilities,
	) {
		this.state = initial;
	}

	private execute(op: PortTaggedOp): void {
		this.executed.push(op);
		if (op.port === 'mm') {
			this.state =
				op.op.kind === 'setRadioModes'
					? { ...this.state, appliedRadioPreference: op.op.preference.preferenceOrdered }
					: { ...this.state, activePrimarySlot: op.op.slotIndex };
			return;
		}
		switch (op.op.kind) {
			case 'createGsmProfile':
				this.state = {
					...this.state,
					hasProfile: true,
					connectionId: connectionId('conn-generated'),
					appliedApn: op.op.profile.autoConfig ? 'auto' : op.op.profile.apn,
					appliedRoaming: !op.op.profile.homeOnly,
				};
				break;
			case 'updateGsmProfile': {
				const { patch } = op.op;
				const nextApn = patch.autoConfig ? 'auto' : patch.apn;
				this.state = {
					...this.state,
					...(nextApn !== undefined ? { appliedApn: nextApn } : {}),
					...(patch.homeOnly !== undefined ? { appliedRoaming: !patch.homeOnly } : {}),
				};
				break;
			}
			case 'activate':
				this.state = { ...this.state, nmActivation: 'activated' };
				break;
			case 'deactivate':
				this.state = { ...this.state, nmActivation: 'disconnected' };
				break;
		}
	}

	apply(desired: DesiredCellularPolicy): readonly Receipt[] {
		for (let iteration = 0; iteration < 20; iteration += 1) {
			const plan = planReconcile(this.state, desired, this.capabilities);
			if (plan.ops.length === 0) {
				return plan.receipts;
			}
			for (const op of plan.ops) {
				this.execute(op);
			}
		}
		throw new Error('reconcile did not converge within the iteration budget');
	}
}

function baseState(): AppliedCellularState {
	return { nmActivation: 'disconnected', hasProfile: false, deviceIfname: deviceIfname('wwan0') };
}

test('a fresh policy converges, then re-apply does nothing and returns the same receipts', () => {
	const stack = new InMemoryStack(baseState(), FIVE_G_DUAL_SLOT);
	const policy = defaultCellularPolicy(BOUND_TO);

	const first = stack.apply(policy);
	const sideEffectsAfterFirst = stack.executed.length;
	expect(sideEffectsAfterFirst).toBeGreaterThan(0);

	const second = stack.apply(policy);
	expect(stack.executed.length).toBe(sideEffectsAfterFirst);
	expect(second).toEqual(first);

	for (const entry of second) {
		expect(entry.status).toBe('applied');
	}
});

test('each op is executed exactly once across convergence (no double side-effects)', () => {
	const stack = new InMemoryStack(baseState(), FIVE_G_DUAL_SLOT);
	const policy = defaultCellularPolicy(BOUND_TO);
	stack.apply(policy);

	const kinds = stack.executed.map((op) => op.op.kind).sort();
	expect(kinds).toEqual(['activate', 'createGsmProfile', 'setRadioModes']);
});

test('an unsupported dimension is never applied as an op, on the first apply or any re-apply', () => {
	const stack = new InMemoryStack(baseState(), FOUR_G_ONLY);
	const policy = defaultCellularPolicy(BOUND_TO);

	const first = stack.apply(policy);
	stack.apply(policy);

	expect(stack.executed.some((op) => op.port === 'mm' && op.op.kind === 'setRadioModes')).toBe(
		false,
	);
	expect(first.find((entry) => entry.dimension === 'radio')?.status).toBe('unsupported');
});

test('deactivation is idempotent — disabling an already-inactive connection is a no-op', () => {
	const stack = new InMemoryStack(baseState(), FIVE_G_DUAL_SLOT);
	const policy: DesiredCellularPolicy = { ...defaultCellularPolicy(BOUND_TO), enabled: false };

	stack.apply(policy);
	const sideEffects = stack.executed.length;
	stack.apply(policy);
	expect(stack.executed.length).toBe(sideEffects);
	expect(stack.executed.some((op) => op.port === 'nm' && op.op.kind === 'activate')).toBe(false);
});
