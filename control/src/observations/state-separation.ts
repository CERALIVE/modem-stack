// Desired, applied and observed are THREE things, and this module refuses to make
// them one.
//
// The pattern is NetworkManager's: a connection PROFILE is what an operator asked
// for, an active connection's BEARER is what was actually put into force, and the
// device's own reported state is what the hardware is currently doing. All three are
// routinely different at once — a profile edited but not re-activated, a bearer that
// survived a profile change, a device that dropped registration without anything
// having been re-applied — and a merged "current state" blob has to pick one of them
// and silently lose the other two.
//
// Concretely, collapsing them makes these questions unanswerable:
//   · did the operator's last change actually take effect, or is it only pending?
//   · is what the device reports the consequence of our write, or of the network?
//   · when a rollback is needed, what exactly do we roll back TO?
//
// So the three live in separate slots with separate `kind` discriminants, and the
// comparison below reports TWO independent divergences instead of one verdict.
// `NetworkManagerAdapter` (a later change) consumes exactly this shape.

import type { DeviceGeneration, EpochMillis, ObservationEnvelope } from '../domain';
import { viewEnvelope } from './envelope';

/** What an operator asked for. Not a claim that anything acted on it. */
export type DesiredProfile<T> = {
	readonly kind: 'desired';
	readonly profile: T;
	readonly requestedAt: EpochMillis;
	/** Opaque origin label (an RPC caller, a policy engine). Never a credential. */
	readonly requestedBy: string;
};

/** What was actually put into force, and by which operation, in which generation. */
export type AppliedConfiguration<T> = {
	readonly kind: 'applied';
	readonly configuration: T;
	readonly appliedAt: EpochMillis;
	readonly generation: DeviceGeneration;
	readonly operationId: string;
};

/** What the device itself reports — always through an envelope, never bare. */
export type ObservedState<T> = {
	readonly kind: 'observed';
	readonly observation: ObservationEnvelope<T>;
};

export function desiredProfile<T>(
	profile: T,
	requestedAt: EpochMillis,
	requestedBy: string,
): DesiredProfile<T> {
	return { kind: 'desired', profile, requestedAt, requestedBy };
}

export function appliedConfiguration<T>(input: {
	readonly configuration: T;
	readonly appliedAt: EpochMillis;
	readonly generation: DeviceGeneration;
	readonly operationId: string;
}): AppliedConfiguration<T> {
	return { kind: 'applied', ...input };
}

export function observedState<T>(observation: ObservationEnvelope<T>): ObservedState<T> {
	return { kind: 'observed', observation };
}

/**
 * The three-slot view. There is deliberately no fourth field holding a merged
 * "effective" value: an effective value is a RENDERING decision, and computing one
 * here would bake a policy every consumer would then have to work around.
 */
export type ModemStateView<TDesired, TApplied, TObserved> = {
	readonly desired: DesiredProfile<TDesired> | null;
	readonly applied: AppliedConfiguration<TApplied> | null;
	readonly observed: ObservedState<TObserved>;
};

export const STATE_VIEW_SLOTS = ['desired', 'applied', 'observed'] as const;
export type StateViewSlot = (typeof STATE_VIEW_SLOTS)[number];

export type SlotComparison =
	| { readonly status: 'aligned' }
	| { readonly status: 'diverged' }
	/** One side has nothing to compare — NOT the same as agreeing. */
	| { readonly status: 'indeterminate'; readonly missing: StateViewSlot };

/**
 * Two independent comparisons, never one verdict.
 *
 * `desiredVsApplied` answers "did our write happen"; `appliedVsObserved` answers "did
 * it stick". A single boolean cannot distinguish a request that was never carried out
 * from one the network undid a second later, and those need opposite responses.
 */
export type StateDivergence = {
	readonly desiredVsApplied: SlotComparison;
	readonly appliedVsObserved: SlotComparison;
};

export function describeStateDivergence<T>(
	view: ModemStateView<T, T, T>,
	equals: (left: T, right: T) => boolean,
): StateDivergence {
	return {
		desiredVsApplied: compareSlots(
			view.desired === null ? undefined : view.desired.profile,
			view.applied === null ? undefined : view.applied.configuration,
			view.desired === null ? 'desired' : 'applied',
			equals,
		),
		appliedVsObserved: compareSlots(
			view.applied === null ? undefined : view.applied.configuration,
			observedValue(view.observed),
			view.applied === null ? 'applied' : 'observed',
			equals,
		),
	};
}

/**
 * The observed value, or `undefined` when the observation carries none.
 *
 * An unavailable observation is `indeterminate` against anything, never `aligned`:
 * "we could not read it" is not evidence that it matches.
 */
function observedValue<T>(observed: ObservedState<T>): T | undefined {
	const view = viewEnvelope(observed.observation);
	return view.kind === 'unavailable' ? undefined : view.value;
}

function compareSlots<T>(
	left: T | undefined,
	right: T | undefined,
	missing: StateViewSlot,
	equals: (left: T, right: T) => boolean,
): SlotComparison {
	if (left === undefined || right === undefined) {
		return { status: 'indeterminate', missing };
	}
	return equals(left, right) ? { status: 'aligned' } : { status: 'diverged' };
}
