// SIM PIN / PUK unlock — read-before-submit, exactly-once, CeraUI-taxonomy-faithful.
//
// The ordering is the whole point (mirrors CeraUI `mmcli.ts` unlockSimPin/Puk): the
// lock state is READ first, and the secret is submitted EXACTLY ONCE. A blind
// resubmit walks the SIM toward an irreversible PUK / permanent lockout, so on a
// failure we only RE-READ the lock state to report remaining attempts — we never
// resubmit. A PUK cannot be cleared with a PIN, so a PUK-locked SIM is surfaced, not
// submitted into.
//
// The result outcomes map onto A2.2's `SimUnlockResult` / `SimPukUnlockResult`, which
// mirror CeraUI's own shapes so Phase-B adoption is a rename, not a rewrite:
//   success → unlocked · wrong-pin → incorrect-pin(+remaining) · puk-required →
//   sim-puk-required · wrong-puk → incorrect-puk(+remaining) · locked(0) →
//   permanently-blocked · read failure → error · nothing-to-unlock → unlocked.
// The secret is passed only as a call arg and is NEVER placed in a `reason` string.

import type { SimPukUnlockResult, SimUnlockResult } from '../ports';
import type { DbusTransport } from '../transport';
import { MODEM_IFACE, SIM_IFACE } from './constants';
import {
	type DecodedManagedObjects,
	fetchManagedObjects,
	findInterface,
	numberProp,
	propValue,
	stringProp,
} from './managed-objects';

// MMModemLock values we branch on.
const LOCK_SIM_PIN = 2;
const LOCK_SIM_PUK = 4;
const LOCK_SIM_PUK2 = 5;

/** A modem's current SIM lock state, read before any submit. */
interface LockState {
	readonly required: number;
	readonly retries: ReadonlyMap<number, number>;
}

function readLockState(tree: DecodedManagedObjects, modemPath: string): LockState | undefined {
	const modem = findInterface(tree, modemPath, MODEM_IFACE);
	if (modem === undefined) {
		return undefined;
	}
	const required = numberProp(modem, 'UnlockRequired') ?? 0;
	const retries = new Map<number, number>();
	const raw = propValue(modem, 'UnlockRetries');
	if (Array.isArray(raw)) {
		for (const entry of raw) {
			if (Array.isArray(entry) && typeof entry[0] === 'number' && typeof entry[1] === 'number') {
				retries.set(entry[0], entry[1]);
			}
		}
	}
	return { required, retries };
}

/** The object path of a modem's active SIM (its `Sim` property), when present. */
function activeSimPath(tree: DecodedManagedObjects, modemPath: string): string | undefined {
	const path = stringProp(findInterface(tree, modemPath, MODEM_IFACE), 'Sim');
	return path?.startsWith('/') && path !== '/' ? path : undefined;
}

const isPukLock = (lock: number): boolean => lock === LOCK_SIM_PUK || lock === LOCK_SIM_PUK2;

/**
 * Submit a SIM PIN read-before-submit and exactly-once. On a wrong PIN the lock state
 * is re-read (never resubmitted) to report remaining attempts or a resulting PUK lock.
 */
export async function sendSimPin(
	transport: DbusTransport,
	destination: string,
	modemPath: string,
	pin: string,
): Promise<SimUnlockResult> {
	let tree: DecodedManagedObjects;
	try {
		tree = await fetchManagedObjects(transport, destination);
	} catch {
		return { outcome: 'error', reason: 'could not read modem lock state before PIN submit' };
	}
	const state = readLockState(tree, modemPath);
	if (state === undefined) {
		return { outcome: 'error', reason: 'modem not found while reading lock state' };
	}
	if (isPukLock(state.required)) {
		return { outcome: 'sim-puk-required', reason: 'SIM is PUK-locked; a PIN cannot clear it' };
	}
	if (state.required !== LOCK_SIM_PIN) {
		return { outcome: 'unlocked', reason: 'no SIM PIN is pending' };
	}
	const simPath = activeSimPath(tree, modemPath);
	if (simPath === undefined) {
		return { outcome: 'error', reason: 'no active SIM object to submit the PIN to' };
	}
	try {
		await transport.callMethod({
			destination,
			path: simPath,
			interface: SIM_IFACE,
			member: 'SendPin',
			signature: 's',
			args: [pin],
		});
		return { outcome: 'unlocked', reason: 'PIN accepted' };
	} catch {
		return classifyPinFailure(transport, destination, modemPath);
	}
}

async function classifyPinFailure(
	transport: DbusTransport,
	destination: string,
	modemPath: string,
): Promise<SimUnlockResult> {
	const state = await readLockState(await fetchManagedObjects(transport, destination), modemPath);
	if (state !== undefined && isPukLock(state.required)) {
		return { outcome: 'sim-puk-required', reason: 'wrong PIN tripped the SIM into a PUK lock' };
	}
	const remaining = state?.retries.get(LOCK_SIM_PIN);
	return {
		outcome: 'incorrect-pin',
		...(remaining !== undefined ? { remainingAttempts: remaining } : {}),
		reason: 'PIN was rejected',
	};
}

/**
 * Submit a SIM PUK + new PIN read-before-submit and exactly-once. On a wrong PUK the
 * remaining PUK attempts are re-read (never resubmitted); zero remaining is a
 * permanent block.
 */
export async function sendSimPuk(
	transport: DbusTransport,
	destination: string,
	modemPath: string,
	puk: string,
	newPin: string,
): Promise<SimPukUnlockResult> {
	let tree: DecodedManagedObjects;
	try {
		tree = await fetchManagedObjects(transport, destination);
	} catch {
		return { outcome: 'error', reason: 'could not read modem lock state before PUK submit' };
	}
	const state = readLockState(tree, modemPath);
	if (state === undefined) {
		return { outcome: 'error', reason: 'modem not found while reading lock state' };
	}
	if (!isPukLock(state.required)) {
		return { outcome: 'unlocked', reason: 'no SIM PUK is pending' };
	}
	const pukKind = state.required;
	const simPath = activeSimPath(tree, modemPath);
	if (simPath === undefined) {
		return { outcome: 'error', reason: 'no active SIM object to submit the PUK to' };
	}
	try {
		await transport.callMethod({
			destination,
			path: simPath,
			interface: SIM_IFACE,
			member: 'SendPuk',
			signature: 'ss',
			args: [puk, newPin],
		});
		return { outcome: 'unlocked', reason: 'PUK accepted; new PIN set' };
	} catch {
		return classifyPukFailure(transport, destination, modemPath, pukKind);
	}
}

async function classifyPukFailure(
	transport: DbusTransport,
	destination: string,
	modemPath: string,
	pukKind: number,
): Promise<SimPukUnlockResult> {
	const state = await readLockState(await fetchManagedObjects(transport, destination), modemPath);
	const remaining = state?.retries.get(pukKind);
	if (remaining === 0) {
		return {
			outcome: 'permanently-blocked',
			remainingAttempts: 0,
			reason: 'PUK attempts exhausted; SIM is permanently locked',
		};
	}
	return {
		outcome: 'incorrect-puk',
		...(remaining !== undefined ? { remainingAttempts: remaining } : {}),
		reason: 'PUK was rejected',
	};
}
