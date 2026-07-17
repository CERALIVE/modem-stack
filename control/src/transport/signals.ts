// Signal subscription and match-rule tracking for the D-Bus transport seam.
//
// The transport's single persistent `message` listener fans out here: `dispatch` walks the
// live subscription registry and delivers each decoded signal to every matching listener.
// Match rules are refcounted so N subscriptions sharing a rule add/remove it on the bus
// exactly once, and `reissueRules` re-adds every live rule after a reconnect — so
// subscribing/unsubscribing never grows the connection's listener count (the 100-cycle
// leak check depends on this).

import { decodeBody } from './codec';
import { messageType, type RawBus, type RawMessage } from './dbus-native';
import type { DbusValue, SignalEvent, SignalListener, SignalSpec, Subscription } from './types';

// The live connection context the registry reads through. The transport supplies these so
// the registry always sees the current bus/connected state (which change across reconnects)
// rather than capturing a stale reference, and routes decode/listener failures to the
// transport's `error` event.
export interface SignalHost {
	currentBus(): RawBus | null;
	isConnected(): boolean;
	emitError(error: unknown): void;
}

interface SubscriptionRecord {
	readonly id: number;
	readonly spec: SignalSpec;
	readonly listener: SignalListener;
	readonly rule: string;
}

function buildMatchRule(spec: SignalSpec): string {
	const parts = [`type='signal'`, `interface='${spec.interface}'`, `member='${spec.member}'`];
	if (spec.path !== undefined) {
		parts.push(`path='${spec.path}'`);
	}
	if (spec.sender !== undefined) {
		parts.push(`sender='${spec.sender}'`);
	}
	return parts.join(',');
}

function signalMatches(spec: SignalSpec, message: RawMessage): boolean {
	if (message.interface !== spec.interface || message.member !== spec.member) {
		return false;
	}
	if (spec.path !== undefined && message.path !== spec.path) {
		return false;
	}
	if (spec.sender !== undefined && message.sender !== spec.sender) {
		return false;
	}
	return true;
}

export class SignalRegistry {
	readonly #host: SignalHost;
	readonly #subscriptions = new Map<number, SubscriptionRecord>();
	readonly #matchRuleRefcount = new Map<string, number>();
	#nextSubId = 1;

	constructor(host: SignalHost) {
		this.#host = host;
	}

	async subscribe(spec: SignalSpec, listener: SignalListener): Promise<Subscription> {
		const rule = buildMatchRule(spec);
		const id = this.#nextSubId++;
		this.#subscriptions.set(id, { id, spec, listener, rule });
		await this.#addMatchRule(rule);

		let removed = false;
		return {
			unsubscribe: async (): Promise<void> => {
				if (removed) {
					return;
				}
				removed = true;
				this.#subscriptions.delete(id);
				await this.#removeMatchRule(rule);
			},
		};
	}

	count(): number {
		return this.#subscriptions.size;
	}

	// Re-issue every live match rule against a freshly established bus so a reconnect
	// resubscribes transparently. Called by `#establish` before it swaps in the new bus, so
	// the fresh bus is passed in explicitly rather than read from the host.
	async reissueRules(bus: RawBus): Promise<void> {
		for (const rule of this.#matchRuleRefcount.keys()) {
			await bus.addMatch(rule);
		}
	}

	dispatch(message: RawMessage): void {
		if (message.type !== messageType.signal) {
			return;
		}
		for (const record of this.#subscriptions.values()) {
			if (!signalMatches(record.spec, message)) {
				continue;
			}
			let body: DbusValue[];
			try {
				const signature = message.signature ?? '';
				body = signature.length > 0 ? decodeBody(signature, message.body ?? []) : [];
			} catch (error) {
				this.#host.emitError(error);
				continue;
			}
			const event: SignalEvent = {
				path: message.path ?? '',
				interface: message.interface ?? '',
				member: message.member ?? '',
				sender: message.sender,
				signature: message.signature ?? '',
				body,
			};
			try {
				record.listener(event);
			} catch (error) {
				this.#host.emitError(error);
			}
		}
	}

	async #addMatchRule(rule: string): Promise<void> {
		const current = this.#matchRuleRefcount.get(rule) ?? 0;
		this.#matchRuleRefcount.set(rule, current + 1);
		const bus = this.#host.currentBus();
		if (current === 0 && this.#host.isConnected() && bus) {
			await bus.addMatch(rule);
		}
	}

	async #removeMatchRule(rule: string): Promise<void> {
		const current = this.#matchRuleRefcount.get(rule) ?? 0;
		if (current <= 1) {
			this.#matchRuleRefcount.delete(rule);
			const bus = this.#host.currentBus();
			if (current === 1 && this.#host.isConnected() && bus) {
				await bus.removeMatch(rule).catch(() => undefined);
			}
		} else {
			this.#matchRuleRefcount.set(rule, current - 1);
		}
	}
}
