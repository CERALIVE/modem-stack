import type { NormalizationContext, StateDivergence } from '../../observations';
import { describeStateDivergence } from '../../observations';
import type { ConnectionId } from '../../ports';
import { projectStateView } from './projection';
import type { ConnectionSlots } from './state';
import { nmBearerStateEquals } from './types';

export function projectDivergence(
	slotsByConnection: ReadonlyMap<ConnectionId, ConnectionSlots>,
	id: ConnectionId,
	context: NormalizationContext,
): StateDivergence | null {
	const view = projectStateView(slotsByConnection, id, context);
	return view === null ? null : describeStateDivergence(view, nmBearerStateEquals);
}
