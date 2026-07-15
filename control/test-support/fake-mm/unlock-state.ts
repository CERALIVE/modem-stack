// The fake's SIM-unlock state machine — pure spec transitions for SendPin / SendPuk.
//
// A wrong PIN decrements the SIM-PIN retry budget and, once it hits zero, trips the
// SIM into a PUK lock; a wrong PUK decrements the PUK budget (zero remaining is a
// permanent block). A correct secret clears the lock. This mirrors real MM so the
// backend's read-before-submit / exactly-once logic can be exercised against it.

import { MM_LOCK_NONE, MM_LOCK_SIM_PIN, MM_LOCK_SIM_PUK, type ModemSpec } from './object-model';

/** Which MM error a rejected submission raises (empty ⇒ the secret was accepted). */
export type UnlockReject = 'SimPin' | 'SimPuk';

/** The spec after a submission, plus the rejection (if the secret was wrong). */
export interface UnlockOutcome {
	readonly next: ModemSpec;
	readonly reject?: UnlockReject;
}

function retriesMap(spec: ModemSpec): Map<number, number> {
	return new Map<number, number>(spec.unlockRetries ?? []);
}

/** Apply a `SendPin` submission to a spec. */
export function submitPin(
	spec: ModemSpec,
	expected: string | undefined,
	pin: unknown,
): UnlockOutcome {
	if (expected !== undefined && pin !== expected) {
		const retries = retriesMap(spec);
		const left = Math.max(0, (retries.get(MM_LOCK_SIM_PIN) ?? 0) - 1);
		retries.set(MM_LOCK_SIM_PIN, left);
		const unlockRequired = left === 0 ? MM_LOCK_SIM_PUK : (spec.unlockRequired ?? MM_LOCK_SIM_PIN);
		return { next: { ...spec, unlockRetries: [...retries], unlockRequired }, reject: 'SimPin' };
	}
	return { next: { ...spec, unlockRequired: MM_LOCK_NONE } };
}

/** Apply a `SendPuk` submission to a spec. */
export function submitPuk(
	spec: ModemSpec,
	expected: string | undefined,
	puk: unknown,
): UnlockOutcome {
	if (expected !== undefined && puk !== expected) {
		const retries = retriesMap(spec);
		const left = Math.max(0, (retries.get(MM_LOCK_SIM_PUK) ?? 0) - 1);
		retries.set(MM_LOCK_SIM_PUK, left);
		return { next: { ...spec, unlockRetries: [...retries] }, reject: 'SimPuk' };
	}
	return { next: { ...spec, unlockRequired: MM_LOCK_NONE } };
}

/** Raise the MM MobileEquipment error a wrong secret produces (never returns). */
export function simLockError(path: string, kind: UnlockReject): never {
	const error = new Error(`incorrect ${kind} for ${path}`) as Error & { dbusName?: string };
	error.dbusName = `org.freedesktop.ModemManager1.Error.MobileEquipment.${kind}`;
	throw error;
}
