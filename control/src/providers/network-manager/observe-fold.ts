import type { DeviceGeneration, EpochMillis } from '../../domain';
import { freshObservation, observedState, unavailableObservation } from '../../observations';
import type { ConnectionId, DeviceIfname } from '../../ports';
import type { ConnectionSlots } from './state';
import { targetIfname } from './state';
import type {
	NmAppliedLoss,
	NmAppliedOutcome,
	NmBearerState,
	NmConnectionOutcome,
	NmObservationInput,
	NmObservationResult,
	NmObservedDevice,
} from './types';
import { boundBearer, unboundBearer } from './types';

const SOURCE = 'networkmanager' as const;
const TRANSITIONAL_STATES: ReadonlySet<string> = new Set([
	'prepare',
	'config',
	'need-auth',
	'ip-config',
	'ip-check',
	'secondaries',
	'deactivating',
]);

export interface ObservationFold {
	readonly generation: DeviceGeneration;
	readonly result: NmObservationResult;
}

export function foldObservation(
	slotsByConnection: Map<ConnectionId, ConnectionSlots>,
	observedGeneration: DeviceGeneration | null,
	input: NmObservationInput,
): ObservationFold {
	const generation = input.context.generation;
	if (observedGeneration !== null && generation < observedGeneration) {
		return {
			generation: observedGeneration,
			result: {
				kind: 'refused',
				reason: 'superseded-generation',
				currentGeneration: observedGeneration,
			},
		};
	}
	const devices = new Map<DeviceIfname, NmObservedDevice>(
		input.devices.map((device) => [device.ifname, device]),
	);
	const outcomes: NmConnectionOutcome[] = [];
	const losses: NmAppliedLoss[] = [];
	for (const [id, slots] of slotsByConnection) {
		const ifname = targetIfname(slots);
		if (ifname === undefined) {
			continue;
		}
		const device = devices.get(ifname);
		slots.observed = observedState(
			device === undefined
				? unavailableObservation<NmBearerState>(SOURCE, input.context, 'device-absent')
				: freshObservation(SOURCE, input.context, observedBearer(device)),
		);
		const outcome = classifyApplied(id, slots, ifname, device, input.context.observedAt);
		outcomes.push({ connectionId: id, outcome });
		if (outcome.status === 'lost') {
			losses.push(outcome.loss);
		}
	}
	return {
		generation,
		result: {
			kind: 'accepted',
			generation,
			observedAt: input.context.observedAt,
			outcomes,
			losses,
		},
	};
}

function classifyApplied(
	id: ConnectionId,
	slots: ConnectionSlots,
	ifname: DeviceIfname,
	device: NmObservedDevice | undefined,
	observedAt: EpochMillis,
): NmAppliedOutcome {
	const applied = slots.applied;
	if (applied === null) {
		return { status: 'unapplied' };
	}
	const lose = (reason: NmAppliedLoss['reason']): NmAppliedOutcome => {
		slots.applied = null;
		return {
			status: 'lost',
			loss: {
				connectionId: id,
				deviceIfname: ifname,
				reason,
				lostAt: observedAt,
				generation: applied.generation,
				previous: applied,
			},
		};
	};
	if (device === undefined) {
		return lose('interface-absent');
	}
	if (device.state === 'failed') {
		return lose('activation-failed');
	}
	if (applied.configuration.kind === 'unbound') {
		return device.activeConnection === undefined
			? { status: 'retained', applied }
			: lose('connection-replaced');
	}
	if (device.activeConnection === undefined) {
		return lose('interface-detached');
	}
	if (device.activeConnection.connectionId !== id) {
		return lose('connection-replaced');
	}
	if (device.state === 'activated') {
		return { status: 'retained', applied };
	}
	return TRANSITIONAL_STATES.has(device.state)
		? { status: 'pending', applied, deviceState: device.state }
		: lose('interface-detached');
}

function observedBearer(device: NmObservedDevice): NmBearerState {
	const active = device.activeConnection;
	return active === undefined
		? unboundBearer(device.ifname)
		: boundBearer({
				connectionId: active.connectionId,
				deviceIfname: device.ifname,
				apn: active.apn,
				autoConfig: active.autoConfig,
				homeOnly: active.homeOnly,
			});
}
