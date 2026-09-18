import type { AppliedConfiguration, DesiredProfile, ObservedState } from '../../observations';
import type { ConnectionId, DeviceIfname } from '../../ports';
import type { NmBearerState } from './types';

export interface ConnectionSlots {
	desired: DesiredProfile<NmBearerState> | null;
	applied: AppliedConfiguration<NmBearerState> | null;
	observed: ObservedState<NmBearerState> | null;
}

export function slotsFor(
	slotsByConnection: Map<ConnectionId, ConnectionSlots>,
	id: ConnectionId,
): ConnectionSlots {
	const existing = slotsByConnection.get(id);
	if (existing !== undefined) {
		return existing;
	}
	const created: ConnectionSlots = { desired: null, applied: null, observed: null };
	slotsByConnection.set(id, created);
	return created;
}

export function targetIfname(slots: ConnectionSlots): DeviceIfname | undefined {
	const state = slots.applied?.configuration ?? slots.desired?.profile;
	if (state === undefined) {
		return undefined;
	}
	return state.kind === 'bound' ? state.binding.deviceIfname : state.deviceIfname;
}
