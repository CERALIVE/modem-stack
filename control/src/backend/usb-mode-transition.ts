// The certified USB-mode transition transaction.
//
// A mode switch is destructive: the modem physically re-enumerates, its interface
// name changes, and MM briefly loses sight of it. This transaction runs the switch
// through A3.3's shared per-modem `ModemActor` (keyed on stableKey, so it serialises
// behind every other disruptive op) in a FIXED order:
//
//   1 NM-quiesce → 2 inhibit-by-cached-UID → 3 AT command → 3b catalog `applyCommand`
//   (only for a SKU whose AT command writes NV without re-enumerating) → 4 expected
//   port-drop → 5 uninhibit → 6 await SAME physical UID → 7 POSTCONDITION →
//   8 resolve new ifname → 9 reactivate (uuid, newIfname) → 10 release interlock
//   (finally, always).
//
// THE POSTCONDITION IS THE ONLY PROOF OF SUCCESS. An AT `OK` proves nothing. Tier 1 is
// the strongest proof and remains unchanged: a reviewed catalog transition must match
// both descriptors and canonical mode. Tier 2 exists only when no reviewed transition
// matches: the re-enumerated device must report the raw target through its own vendor READ.
// Tier 2 is explicitly weaker because it proves reported mode, not descriptor composition.
// On a postcondition MISMATCH the whole transaction fails `degraded`, does NOT
// reactivate, and still releases the interlock via `finally`. A hung command trips the
// AT watchdog, which force-uninhibits so the system reprobes rather than wedging.

import type { DeviceIfname, InhibitLease, ModemManagerPort, NetworkManagerPort } from '../ports';
import { deviceIfname } from '../ports';
import {
	CERTIFIED_CATALOG,
	type CertifiedCatalog,
	readRuntimeCompositionCurrent,
} from '../usb-mode';
import {
	type AtAuditSink,
	AtCommandLease,
	type AtCommandSender,
	computeAtAllowlist,
} from './at-lease';
import { descriptorsMatch, detectUsbMode, type UsbDeviceSnapshot } from './device-classifier';
import type { ModemActor } from './modem-actor';
import {
	ALLOW_ALL_TRANSITION_INTERLOCK,
	checkTransitionPreconditions,
	type TransitionInterlock,
	type UsbModeTransitionOutcome,
	type UsbModeTransitionPlan,
	type UsbModeTransitionRequest,
} from './transition-preconditions';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_WATCHDOG_MS = 30_000;
const DEFAULT_REENUM_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 250;

/** Construction dependencies for the transition. Everything I/O is injectable. */
export interface UsbModeTransitionDeps {
	readonly actor: ModemActor;
	readonly nm: NetworkManagerPort;
	readonly modemManager: Pick<ModemManagerPort, 'inhibit' | 'uninhibit'>;
	readonly atSender: AtCommandSender;
	/** Refresh-triggered USB enumeration (e.g. `createUsbEnumerator().enumerate`). */
	readonly enumerate: () => Promise<readonly UsbDeviceSnapshot[]>;
	readonly interlock?: TransitionInterlock;
	readonly catalog?: CertifiedCatalog;
	readonly audit?: AtAuditSink;
	readonly resolveIfname?: (device: UsbDeviceSnapshot) => DeviceIfname | undefined;
	readonly watchdogMs?: number;
	readonly reenumerationTimeoutMs?: number;
	readonly pollIntervalMs?: number;
}

function defaultResolveIfname(device: UsbDeviceSnapshot): DeviceIfname | undefined {
	return device.ifname !== undefined && device.ifname !== ''
		? deviceIfname(device.ifname)
		: undefined;
}

/** The USB-mode transition transaction. One instance is reusable across requests. */
export class UsbModeTransition {
	readonly #actor: ModemActor;
	readonly #nm: NetworkManagerPort;
	readonly #modemManager: Pick<ModemManagerPort, 'inhibit' | 'uninhibit'>;
	readonly #atSender: AtCommandSender;
	readonly #enumerate: () => Promise<readonly UsbDeviceSnapshot[]>;
	readonly #interlock: TransitionInterlock;
	readonly #catalog: CertifiedCatalog;
	readonly #audit: AtAuditSink | undefined;
	readonly #resolveIfname: (device: UsbDeviceSnapshot) => DeviceIfname | undefined;
	readonly #watchdogMs: number;
	readonly #reenumMs: number;
	readonly #pollMs: number;

	constructor(deps: UsbModeTransitionDeps) {
		this.#actor = deps.actor;
		this.#nm = deps.nm;
		this.#modemManager = deps.modemManager;
		this.#atSender = deps.atSender;
		this.#enumerate = deps.enumerate;
		this.#interlock = deps.interlock ?? ALLOW_ALL_TRANSITION_INTERLOCK;
		this.#catalog = deps.catalog ?? CERTIFIED_CATALOG;
		this.#audit = deps.audit;
		this.#resolveIfname = deps.resolveIfname ?? defaultResolveIfname;
		this.#watchdogMs = deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
		this.#reenumMs = deps.reenumerationTimeoutMs ?? DEFAULT_REENUM_TIMEOUT_MS;
		this.#pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	}

	/** Run one transition. Preconditions are checked at entry, then again in-actor. */
	async execute(request: UsbModeTransitionRequest): Promise<UsbModeTransitionOutcome> {
		const steps: string[] = [];
		// ENTRY check — a doomed request NEVER enters the actor (TIER A: zero calls).
		const entry = await checkTransitionPreconditions(request, this.#catalog, this.#interlock);
		if (!entry.ok) {
			return { status: 'refused', stage: 'entry', reason: entry.reason, steps };
		}
		return this.#actor.run(request.stableKey, () => this.#inActor(request, steps));
	}

	async #inActor(
		request: UsbModeTransitionRequest,
		steps: string[],
	): Promise<UsbModeTransitionOutcome> {
		steps.push('actor-enter');
		// IN-ACTOR re-check — catches a race that closed a gate while queued (TIER B).
		const recheck = await checkTransitionPreconditions(request, this.#catalog, this.#interlock);
		if (!recheck.ok) {
			return { status: 'refused', stage: 'in-actor', reason: recheck.reason, steps };
		}
		const hold = await this.#interlock.hold({ stableKey: request.stableKey });
		try {
			return await this.#runTransaction(request, recheck.allowlistedCommands, recheck.plan, steps);
		} finally {
			steps.push('release-interlock');
			await hold.release().catch(() => undefined);
		}
	}

	async #runTransaction(
		request: UsbModeTransitionRequest,
		allowlistedCommands: readonly string[],
		plan: UsbModeTransitionPlan,
		steps: string[],
	): Promise<UsbModeTransitionOutcome> {
		let inhibit: InhibitLease | undefined;
		let reactivated = false;
		const forceUninhibit = async (): Promise<void> => {
			if (inhibit === undefined) {
				return;
			}
			const held = inhibit;
			inhibit = undefined;
			steps.push('force-uninhibit');
			await this.#modemManager.uninhibit(held).catch(() => undefined);
		};
		const lease = new AtCommandLease({
			sender: this.#atSender,
			allowlist: computeAtAllowlist(allowlistedCommands),
			timeoutMs: this.#watchdogMs,
			onWatchdog: forceUninhibit,
			...(this.#audit !== undefined ? { audit: this.#audit } : {}),
		});

		steps.push('nm-quiesce');
		const quiesce = await this.#nm.acquireQuiesceLease(request.connectionId, request.deviceIfname);
		try {
			steps.push('inhibit');
			inhibit = await this.#modemManager.inhibit(request.inhibitUid);

			// AT `OK` is IGNORED for success — only the postcondition below decides.
			steps.push('at-command');
			await lease.run(plan.atCommand, { inhibitUid: request.inhibitUid });

			if (plan.applyCommand !== undefined) {
				steps.push('apply-command');
				await lease.run(plan.applyCommand, { inhibitUid: request.inhibitUid });
			}

			steps.push('await-port-drop');
			await this.#awaitPortDrop(request.cachedPhysicalUid);

			steps.push('uninhibit');
			if (inhibit !== undefined) {
				const held = inhibit;
				inhibit = undefined;
				await this.#modemManager.uninhibit(held);
			}

			steps.push('await-reenumeration');
			const device = await this.#awaitReenumeration(request.cachedPhysicalUid);

			steps.push('postcondition');
			if (plan.proof.tier === 'catalog-descriptors') {
				const observedMode = detectUsbMode(device);
				const descriptorsOk = descriptorsMatch(device, plan.proof.transition.expectedDescriptors);
				if (observedMode !== plan.proof.transition.to || !descriptorsOk) {
					return {
						status: 'failed',
						degraded: true,
						reason: `postcondition mismatch: observed ${observedMode ?? 'unknown'} vs target ${plan.proof.transition.to}; descriptors ${descriptorsOk ? 'ok' : 'mismatch'}`,
						steps,
					};
				}
			} else {
				steps.push('postcondition-runtime-read');
				const response = await lease.run(plan.proof.currentQuery, {
					inhibitUid: request.inhibitUid,
				});
				const observed = readRuntimeCompositionCurrent(plan.proof.vendor, response.raw);
				if (!Object.is(observed, plan.proof.target)) {
					return {
						status: 'failed',
						degraded: true,
						reason: `runtime readback mismatch: observed ${observed ?? 'unknown'} vs target ${plan.proof.target}`,
						steps,
					};
				}
			}

			steps.push('resolve-ifname');
			const newIfname = this.#resolveIfname(device);
			if (newIfname === undefined) {
				return { status: 'failed', degraded: true, reason: 'could not resolve new ifname', steps };
			}

			steps.push('reactivate');
			await this.#nm.activate(request.connectionId, newIfname);
			reactivated = true;
			return { status: 'succeeded', newIfname, steps };
		} catch (error) {
			await forceUninhibit();
			await this.#reprobe();
			return {
				status: 'failed',
				degraded: true,
				reason: error instanceof Error ? error.message : String(error),
				steps,
			};
		} finally {
			await forceUninhibit();
			if (!reactivated) {
				// Failure path: restore the old connection. On success the new-ifname
				// activation supersedes the quiesce lease (old ifname is gone).
				steps.push('release-quiesce');
				await this.#nm.releaseQuiesceLease(quiesce).catch(() => undefined);
			}
		}
	}

	async #awaitPortDrop(uid: string): Promise<void> {
		const deadline = Date.now() + this.#reenumMs;
		while (Date.now() < deadline) {
			const devices = await this.#enumerate();
			if (!devices.some((d) => d.physicalUid === uid)) {
				return;
			}
			await sleep(this.#pollMs);
		}
		throw new Error(`control port did not drop within ${this.#reenumMs}ms (uid ${uid})`);
	}

	async #awaitReenumeration(uid: string): Promise<UsbDeviceSnapshot> {
		const deadline = Date.now() + this.#reenumMs;
		while (Date.now() < deadline) {
			const devices = await this.#enumerate();
			const device = devices.find((d) => d.physicalUid === uid);
			if (device !== undefined) {
				return device;
			}
			await sleep(this.#pollMs);
		}
		throw new Error(`device did not re-enumerate within ${this.#reenumMs}ms (uid ${uid})`);
	}

	/** Best-effort state re-read after a crash — the transaction still fails degraded. */
	async #reprobe(): Promise<void> {
		await this.#enumerate().then(
			() => undefined,
			() => undefined,
		);
	}
}
