import { describe, expect, test } from 'bun:test';
import { fixtureContext } from '../../test-support/observation-fixtures';
import { deviceGeneration, epochMillis } from '../domain';
import { freshObservation, unavailableObservation } from './envelope';
import {
	appliedConfiguration,
	describeStateDivergence,
	desiredProfile,
	type ModemStateView,
	observedState,
	STATE_VIEW_SLOTS,
} from './state-separation';

const CONTEXT = fixtureContext();

type Apn = { readonly apn: string };

const DESIRED = desiredProfile<Apn>({ apn: 'internet.claro' }, epochMillis(10), 'rpc:operator');
const APPLIED = appliedConfiguration<Apn>({
	configuration: { apn: 'internet.claro' },
	appliedAt: epochMillis(20),
	generation: deviceGeneration(7),
	operationId: 'set-apn#1',
});
const OBSERVED = observedState(
	freshObservation<Apn>('modemmanager', CONTEXT, { apn: 'internet.claro' }),
);

const sameApn = (left: Apn, right: Apn) => left.apn === right.apn;

function view(
	overrides: Partial<ModemStateView<Apn, Apn, Apn>> = {},
): ModemStateView<Apn, Apn, Apn> {
	return { desired: DESIRED, applied: APPLIED, observed: OBSERVED, ...overrides };
}

describe('desired, applied and observed stay three things', () => {
	test('Given the state view, when inspected, then it has exactly three slots and no merged value', () => {
		expect(Object.keys(view()).sort()).toEqual([...STATE_VIEW_SLOTS].sort());
	});

	test('Given the three slots, when discriminated, then each declares its own kind', () => {
		const current = view();

		expect(current.desired?.kind).toBe('desired');
		expect(current.applied?.kind).toBe('applied');
		expect(current.observed.kind).toBe('observed');
	});

	test('Given an observed slot, when inspected, then the device value is only reachable through an envelope', () => {
		const current = view();

		expect(current.observed.observation.freshness.state).toBe('fresh');
		expect(current.observed.observation.stableKey).toBe(CONTEXT.stableKey);
		expect('profile' in current.observed).toBe(false);
		expect('configuration' in current.observed).toBe(false);
	});

	test('Given a desired slot, when inspected, then it carries no applied-side evidence', () => {
		expect('generation' in DESIRED).toBe(false);
		expect('operationId' in DESIRED).toBe(false);
		expect(APPLIED.operationId).toBe('set-apn#1');
		expect(APPLIED.generation).toBe(deviceGeneration(7));
	});
});

describe('divergence is reported as two independent comparisons', () => {
	test('Given full agreement, when compared, then both comparisons align', () => {
		expect(describeStateDivergence(view(), sameApn)).toEqual({
			desiredVsApplied: { status: 'aligned' },
			appliedVsObserved: { status: 'aligned' },
		});
	});

	test('Given a request that was never applied, when compared, then only the first comparison diverges', () => {
		const pending = view({
			desired: desiredProfile<Apn>({ apn: 'ims.claro' }, epochMillis(30), 'rpc:operator'),
		});

		expect(describeStateDivergence(pending, sameApn)).toEqual({
			desiredVsApplied: { status: 'diverged' },
			appliedVsObserved: { status: 'aligned' },
		});
	});

	test('Given a write the network undid, when compared, then only the second comparison diverges', () => {
		const drifted = view({
			observed: observedState(freshObservation<Apn>('modemmanager', CONTEXT, { apn: 'ims.claro' })),
		});

		expect(describeStateDivergence(drifted, sameApn)).toEqual({
			desiredVsApplied: { status: 'aligned' },
			appliedVsObserved: { status: 'diverged' },
		});
	});

	test('Given an unavailable observation, when compared, then it is indeterminate rather than aligned', () => {
		const unreadable = view({
			observed: observedState(
				unavailableObservation<Apn>('modemmanager', CONTEXT, 'source-unavailable'),
			),
		});

		expect(describeStateDivergence(unreadable, sameApn)).toEqual({
			desiredVsApplied: { status: 'aligned' },
			appliedVsObserved: { status: 'indeterminate', missing: 'observed' },
		});
	});

	test('Given nothing applied yet, when compared, then both comparisons name the missing slot', () => {
		const unapplied = view({ applied: null });

		expect(describeStateDivergence(unapplied, sameApn)).toEqual({
			desiredVsApplied: { status: 'indeterminate', missing: 'applied' },
			appliedVsObserved: { status: 'indeterminate', missing: 'applied' },
		});
	});
});
