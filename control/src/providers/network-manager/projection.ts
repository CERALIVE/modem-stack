import type { ModemStateView, NormalizationContext } from '../../observations';
import { observedState, unavailableObservation } from '../../observations';
import type { ConnectionId } from '../../ports';
import type { ConnectionSlots } from './state';
import type { NmBearerState } from './types';

const SOURCE = 'networkmanager' as const;

export function projectStateView(
	slotsByConnection: ReadonlyMap<ConnectionId, ConnectionSlots>,
	id: ConnectionId,
	context: NormalizationContext,
): ModemStateView<NmBearerState, NmBearerState, NmBearerState> | null {
	const slots = slotsByConnection.get(id);
	if (slots === undefined) {
		return null;
	}
	return {
		desired: slots.desired,
		applied: slots.applied,
		observed:
			slots.observed ??
			observedState(unavailableObservation<NmBearerState>(SOURCE, context, 'provider-unavailable')),
	};
}
