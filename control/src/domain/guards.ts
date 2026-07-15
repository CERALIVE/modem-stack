// Impossible-combination guards.
//
// The orthogonal dimensions are independent, but not EVERY combination is
// physically real. A modem cannot be `registered` while `absent`; the radio
// cannot be `off` while the modem is `connected`. Each rule below rejects one
// such impossible cross-dimension combination with a distinct code, so a bad
// construction names exactly what it violated instead of silently persisting an
// incoherent snapshot. `checkSnapshot` returns the first violation (or null);
// `assertSnapshot` throws `ImpossibleStateError`.

import type { ImpossibleStateCode } from './errors';
import { ImpossibleStateError } from './errors';
import type { CellularSnapshot } from './snapshot';
import { isRegistered, MM_STATES_REQUIRING_RADIO, SIM_LOCK_REQUIRES_CARD } from './state';

type Violation = { readonly code: ImpossibleStateCode; readonly detail: string } | null;

function checkRegistration(s: CellularSnapshot): Violation {
	if (!isRegistered(s.registration.status)) {
		return null;
	}
	if (s.presence === 'absent') {
		return { code: 'registered-while-absent', detail: `status=${s.registration.status}` };
	}
	if (s.radioPower === 'off') {
		return { code: 'registered-radio-off', detail: `status=${s.registration.status}` };
	}
	if (s.registration.activeRats.size === 0) {
		return { code: 'registered-empty-rat-set', detail: `status=${s.registration.status}` };
	}
	return null;
}

function radioIsOnTheAir(s: CellularSnapshot): boolean {
	return (
		MM_STATES_REQUIRING_RADIO.has(s.mmState) ||
		s.registration.status === 'searching' ||
		s.nmActivation === 'activating' ||
		s.nmActivation === 'activated'
	);
}

function checkRadioAndPresence(s: CellularSnapshot): Violation {
	if (MM_STATES_REQUIRING_RADIO.has(s.mmState) && s.presence === 'absent') {
		return { code: 'active-state-while-absent', detail: `mmState=${s.mmState}` };
	}
	if (s.radioPower === 'off' && radioIsOnTheAir(s)) {
		return { code: 'radio-off-while-active', detail: `mmState=${s.mmState}` };
	}
	return null;
}

function checkNmActivation(s: CellularSnapshot): Violation {
	if (s.nmActivation !== 'activated') {
		return null;
	}
	if (s.presence === 'absent') {
		return { code: 'nm-activated-while-absent', detail: 'nmActivation=activated' };
	}
	if (!s.dataInterface.present) {
		return { code: 'nm-activated-without-interface', detail: 'nmActivation=activated' };
	}
	if (s.mmState !== 'connected') {
		return { code: 'nm-activated-without-mm-connected', detail: `mmState=${s.mmState}` };
	}
	return null;
}

function checkSimSlots(s: CellularSnapshot): Violation {
	let activeCount = 0;
	let hasLockedCard = false;
	for (const slot of s.simSlots) {
		if (slot.active) {
			activeCount += 1;
		}
		if (!slot.occupied && SIM_LOCK_REQUIRES_CARD.has(slot.lock)) {
			return { code: 'locked-sim-in-empty-slot', detail: `slot=${slot.index} lock=${slot.lock}` };
		}
		if (slot.occupied && SIM_LOCK_REQUIRES_CARD.has(slot.lock)) {
			hasLockedCard = true;
		}
	}
	if (activeCount > 1) {
		return { code: 'multiple-active-sim-slots', detail: `active=${activeCount}` };
	}
	if (s.mmState === 'locked' && !hasLockedCard) {
		return { code: 'mm-locked-without-sim-lock', detail: 'mmState=locked' };
	}
	return null;
}

function checkDataInterface(s: CellularSnapshot): Violation {
	if (!s.dataInterface.present && s.dataInterface.name !== undefined) {
		return {
			code: 'data-interface-name-without-presence',
			detail: `name=${s.dataInterface.name}`,
		};
	}
	return null;
}

function checkRecovery(s: CellularSnapshot): Violation {
	const { stage, attempts, cooldownUntil } = s.recoveryState;
	if (!Number.isSafeInteger(attempts) || attempts < 0) {
		return { code: 'recovery-attempts-negative', detail: `attempts=${attempts}` };
	}
	if ((cooldownUntil !== undefined) !== (stage === 'cooldown')) {
		return { code: 'recovery-cooldown-stage-mismatch', detail: `stage=${stage}` };
	}
	if (stage === 'idle' && attempts !== 0) {
		return { code: 'recovery-idle-with-attempts', detail: `attempts=${attempts}` };
	}
	return null;
}

const CHECKS: ReadonlyArray<(s: CellularSnapshot) => Violation> = [
	checkRegistration,
	checkRadioAndPresence,
	checkNmActivation,
	checkSimSlots,
	checkDataInterface,
	checkRecovery,
];

/** Return the first impossible-combination code the snapshot violates, or null. */
export function checkSnapshot(snapshot: CellularSnapshot): ImpossibleStateCode | null {
	for (const check of CHECKS) {
		const violation = check(snapshot);
		if (violation !== null) {
			return violation.code;
		}
	}
	return null;
}

/** Throw `ImpossibleStateError` if the snapshot holds an impossible combination. */
export function assertSnapshot(snapshot: CellularSnapshot): void {
	for (const check of CHECKS) {
		const violation = check(snapshot);
		if (violation !== null) {
			throw new ImpossibleStateError(violation.code, violation.detail);
		}
	}
}
