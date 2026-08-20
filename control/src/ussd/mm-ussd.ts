// The ModemManager USSD adapter — `Modem3gpp.Ussd` driven by the pure session
// machine in `./session`.
//
// Three properties are load-bearing and none of them is obvious from the D-Bus
// API alone:
//
//  1. **Every verb runs through the shared per-modem `ModemActor`.** A USSD
//     session is a single network-side resource per subscriber, so two verbs
//     interleaving on one modem is exactly the double-dialogue the network
//     answers busy. The actor is keyed on the STABLE key, so the serialization
//     survives a replug like every other disruptive op in this package.
//
//  2. **An unanswered session is closed at a bound, and the CANCEL is attempted.**
//     A session nobody responds to stays open NETWORK-side; letting it expire in
//     silence would leave the next `Initiate` failing busy for reasons the
//     operator cannot see. The bound closes our machine and best-effort releases
//     the network's — best-effort because a modem that did not answer the last
//     call may not answer this one either, and a timeout must still terminate.
//
//  3. **A `closed` session resets the STORED state to idle, while the CALLER is
//     told `closed`.** The machine is deliberately terminal so a finished session
//     cannot be resurrected; the adapter's map is per-modem and long-lived, so it
//     starts each new dialogue from a fresh machine.
//
// The carrier's text rides `ussdReply` and NOTHING here logs it. That field name
// is not cosmetic: `../redact` is key-based, so the name IS what guarantees the
// value is masked in every receipt, bundle, and log line it can reach.

import { MM_BUS_NAME } from '../backend/constants';
import type { ModemActor } from '../backend/modem-actor';
import type { ModemRef } from '../ports';
import type { DbusTransport } from '../transport';
import {
	callCancel,
	callInitiate,
	callRespond,
	decodeRepliedState,
	readUssdState,
	type UssdCallTarget,
} from './calls';
import { classifyUssdFailure, type UssdRefusalReason } from './refusal';
import { readUssdRegistrationFacts } from './registration';
import {
	IDLE_SESSION,
	reduceUssdSession,
	type UssdSessionEvent,
	type UssdSessionSnapshot,
} from './session';

/** A network round-trip. USSD legitimately takes tens of seconds. */
const DEFAULT_CALL_TIMEOUT_MS = 45_000;
/** How long a session may sit awaiting an operator response before it is closed. */
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 120_000;

export interface UssdTimerHandle {
	cancel(): void;
}
export type UssdScheduler = (delayMs: number, run: () => void) => UssdTimerHandle;

const defaultScheduler: UssdScheduler = (delayMs, run) => {
	const timer = setTimeout(run, delayMs);
	timer.unref?.();
	return {
		cancel: () => {
			clearTimeout(timer);
		},
	};
};

export interface UssdVerbResult {
	readonly ok: boolean;
	readonly snapshot: UssdSessionSnapshot;
	/** Carrier text. Redacted by key everywhere it is serialized. */
	readonly ussdReply?: string;
	readonly refusal?: UssdRefusalReason;
}

export interface MmUssdDeps {
	readonly transport: DbusTransport;
	readonly actor: ModemActor;
	readonly destination?: string;
	readonly resolveStableKey: (modem: ModemRef) => string;
	readonly callTimeoutMs?: number;
	readonly sessionIdleTimeoutMs?: number;
	readonly scheduler?: UssdScheduler;
	/** Notified on every stored-state change, so a UI can follow a session. */
	readonly onSessionChange?: (stableKey: string, snapshot: UssdSessionSnapshot) => void;
}

export class MmUssd {
	readonly #deps: MmUssdDeps;
	readonly #destination: string;
	readonly #callTimeoutMs: number;
	readonly #idleTimeoutMs: number;
	readonly #scheduler: UssdScheduler;
	readonly #sessions = new Map<string, UssdSessionSnapshot>();
	readonly #timers = new Map<string, UssdTimerHandle>();

	constructor(deps: MmUssdDeps) {
		this.#deps = deps;
		this.#destination = deps.destination ?? MM_BUS_NAME;
		this.#callTimeoutMs = deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
		this.#idleTimeoutMs = deps.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
		this.#scheduler = deps.scheduler ?? defaultScheduler;
	}

	snapshot(modem: ModemRef): UssdSessionSnapshot {
		return this.#sessions.get(this.#deps.resolveStableKey(modem)) ?? IDLE_SESSION;
	}

	initiate(modem: ModemRef, ussdCommand: string): Promise<UssdVerbResult> {
		return this.#runVerb(modem, { kind: 'initiate' }, (target) =>
			callInitiate(target, ussdCommand),
		);
	}

	respond(modem: ModemRef, ussdResponse: string): Promise<UssdVerbResult> {
		return this.#runVerb(modem, { kind: 'respond' }, (target) => callRespond(target, ussdResponse));
	}

	cancel(modem: ModemRef): Promise<UssdVerbResult> {
		const key = this.#deps.resolveStableKey(modem);
		return this.#deps.actor.run(key, async () => {
			const gate = this.#gate(key, { kind: 'cancel' });
			if (!gate.ok) {
				return gate.result;
			}
			const target = this.#target(modem);
			try {
				await callCancel(target);
				return this.#settle(key, { kind: 'cancelled' });
			} catch (error) {
				return this.#fail(key, modem, error);
			}
		});
	}

	/** Drop every timer. A live session on the modem is NOT cancelled by this. */
	stop(): void {
		for (const timer of this.#timers.values()) {
			timer.cancel();
		}
		this.#timers.clear();
	}

	async #runVerb(
		modem: ModemRef,
		event: UssdSessionEvent,
		dispatch: (target: UssdCallTarget) => Promise<string>,
	): Promise<UssdVerbResult> {
		const key = this.#deps.resolveStableKey(modem);
		return this.#deps.actor.run(key, async () => {
			const gate = this.#gate(key, event);
			if (!gate.ok) {
				return gate.result;
			}
			const target = this.#target(modem);
			try {
				const ussdReply = await dispatch(target);
				const sessionState = decodeRepliedState(await readUssdState(target));
				const settled = this.#settle(key, { kind: 'replied', sessionState });
				// A session the network kept open — whether or not it asked a
				// question — is what the idle bound exists to release.
				if (sessionState !== 'released') {
					this.#armIdleTimeout(key, modem);
				}
				return { ...settled, ussdReply };
			} catch (error) {
				return this.#fail(key, modem, error);
			}
		});
	}

	/**
	 * Apply the operator's verb to the machine. A refusal is returned WITHOUT
	 * touching the stored state or dialling the bus — a doomed verb must not
	 * disturb a live session.
	 */
	#gate(
		key: string,
		event: UssdSessionEvent,
	): { ok: true } | { ok: false; result: UssdVerbResult } {
		const current = this.#sessions.get(key) ?? IDLE_SESSION;
		const transition = reduceUssdSession(current, event);
		if (!transition.ok) {
			return {
				ok: false,
				result: { ok: false, snapshot: current, refusal: transition.refusal },
			};
		}
		this.#store(key, transition.snapshot);
		return { ok: true };
	}

	#settle(key: string, event: UssdSessionEvent): UssdVerbResult {
		const current = this.#sessions.get(key) ?? IDLE_SESSION;
		const transition = reduceUssdSession(current, event);
		if (!transition.ok) {
			return { ok: false, snapshot: current, refusal: transition.refusal };
		}
		this.#store(key, transition.snapshot);
		const closedRefusal = transition.snapshot.refusal;
		return {
			ok: closedRefusal === undefined,
			snapshot: transition.snapshot,
			...(closedRefusal === undefined ? {} : { refusal: closedRefusal }),
		};
	}

	async #fail(key: string, modem: ModemRef, error: unknown): Promise<UssdVerbResult> {
		const registration = await readUssdRegistrationFacts(
			this.#deps.transport,
			this.#destination,
			modem,
		);
		return this.#settle(key, { kind: 'failed', reason: classifyUssdFailure(error, registration) });
	}

	/**
	 * A session reaching `closed` is REPORTED as closed and STORED as idle, so the
	 * next `initiate` starts from a fresh machine rather than the terminal one.
	 */
	#store(key: string, snapshot: UssdSessionSnapshot): void {
		this.#clearTimer(key);
		if (snapshot.state === 'closed') {
			this.#sessions.delete(key);
		} else {
			this.#sessions.set(key, snapshot);
		}
		this.#deps.onSessionChange?.(key, snapshot);
	}

	#armIdleTimeout(key: string, modem: ModemRef): void {
		this.#clearTimer(key);
		this.#timers.set(
			key,
			this.#scheduler(this.#idleTimeoutMs, () => {
				void this.#expire(key, modem);
			}),
		);
	}

	#clearTimer(key: string): void {
		this.#timers.get(key)?.cancel();
		this.#timers.delete(key);
	}

	/**
	 * The bound elapsed. The machine closes `timed-out` FIRST — that outcome is
	 * the operator's answer whether or not the release lands — and the modem-side
	 * cancel is attempted afterwards, best-effort.
	 */
	async #expire(key: string, modem: ModemRef): Promise<void> {
		await this.#deps.actor.run(key, async () => {
			if (!this.#sessions.has(key)) {
				return;
			}
			this.#settle(key, { kind: 'timeout' });
			try {
				await callCancel(this.#target(modem));
			} catch {
				// The modem that did not answer the dialogue may not answer this
				// either; the session is already closed on our side.
			}
		});
	}

	#target(modem: ModemRef): UssdCallTarget {
		return {
			transport: this.#deps.transport,
			destination: this.#destination,
			modem,
			timeoutMs: this.#callTimeoutMs,
		};
	}
}
