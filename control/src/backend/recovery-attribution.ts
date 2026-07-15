// Fault attribution — the safety gate the recovery ladder is built around.
//
// Before any disruptive recovery action, a fault MUST be attributed. Recovery may
// ONLY ever act on a confident `modem-fault`; `network-fault` and `indeterminate`
// never authorise a disruptive step (draft §Oracle recovery: "fault attribution
// required before disruptive action"). This module is pure — it classifies from a
// narrow projection of one snapshot and never performs I/O.

import type {
	CellularSnapshot,
	MmState,
	NmActivation,
	Presence,
	RegistrationStatus,
	SourceHealth,
} from '../domain';
import { isRegistered } from '../domain';

/**
 * The confident classification of a modem fault:
 *   - `modem-fault`    — the modem itself is broken (only this may be disruptive).
 *   - `network-fault`  — attached to (or refused by) the network; the modem is fine.
 *   - `indeterminate`  — ambiguous, or observed from an unreliable source.
 */
export type FaultAttribution = 'modem-fault' | 'network-fault' | 'indeterminate';

/** The narrow set of symptoms attribution reasons over. */
export interface FaultSymptoms {
	readonly sourceHealth: SourceHealth;
	readonly presence: Presence;
	readonly mmState: MmState;
	readonly registration: RegistrationStatus;
	readonly nmActivation: NmActivation;
}

/**
 * Classify a modem fault from observed symptoms.
 *
 * HARD SAFETY INVARIANT (draft §round-5 stale-forces-indeterminate): if the
 * observation SOURCE is not `live` — i.e. `stale` or `sourceUnavailable`, as A3.1's
 * epoch observer reports on owner loss / bus disconnect / old-epoch signals — the
 * attribution is FORCED to `indeterminate`. We never guess `modem-fault` or
 * `network-fault` from unreliable data. Because only a confident `modem-fault` can
 * later authorise a disruptive step, forcing indeterminate here makes stale input
 * strictly safe: no ladder step can fire off data we do not trust.
 */
export function attributeFault(symptoms: FaultSymptoms): FaultAttribution {
	// 1. Unreliable source → never guess. (The invariant — checked first.)
	if (symptoms.sourceHealth !== 'live') {
		return 'indeterminate';
	}
	// 2. Nothing present to attribute (and nothing to act on via D-Bus).
	if (symptoms.presence === 'absent') {
		return 'indeterminate';
	}
	// 3. MM — a healthy source — reports THIS modem terminally failed → modem-fault.
	if (symptoms.mmState === 'failed') {
		return 'modem-fault';
	}
	// 4. The network refused registration → network-fault (not the modem's fault).
	if (symptoms.registration === 'denied') {
		return 'network-fault';
	}
	// 5. Registered to a network but data is not up → registered-but-no-data.
	if (isRegistered(symptoms.registration) && symptoms.nmActivation !== 'activated') {
		return 'network-fault';
	}
	// 6. Anything else is ambiguous — stay safe.
	return 'indeterminate';
}

/** Project the symptoms attribution needs out of a full snapshot. */
export function symptomsFromSnapshot(snapshot: CellularSnapshot): FaultSymptoms {
	return {
		sourceHealth: snapshot.sourceHealth,
		presence: snapshot.presence,
		mmState: snapshot.mmState,
		registration: snapshot.registration.status,
		nmActivation: snapshot.nmActivation,
	};
}

/** Attribute a fault directly from a snapshot (symptoms projection + classify). */
export function attributeSnapshot(snapshot: CellularSnapshot): FaultAttribution {
	return attributeFault(symptomsFromSnapshot(snapshot));
}
