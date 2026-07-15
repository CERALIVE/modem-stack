// The D-Bus transport seam implementation.
//
// Wraps `@httptoolkit/dbus-native` behind the `DbusTransport` interface: method calls,
// signal subscriptions, and an automatic reconnect loop that re-issues every match rule
// after a bus restart. A single persistent `message` listener fans out to the live
// subscription registry, so subscribing/unsubscribing never grows the connection's
// listener count — the 100-cycle leak check depends on this.

import { EventEmitter } from 'node:events';
import { decodeBody, encodeBody } from './codec';
import {
	type CreateClientOptions,
	createClient,
	messageType,
	type RawBus,
	type RawMessage,
	type ReplyContext,
} from './dbus-native';
import { DisconnectedError, TransportError } from './errors';
import type {
	DbusTransport,
	DbusTransportOptions,
	DbusValue,
	MethodCall,
	MethodReply,
	SignalEvent,
	SignalListener,
	SignalSpec,
	Subscription,
	TransportEvent,
} from './types';

type State = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'closed';

interface ResolvedReconnect {
	readonly enabled: boolean;
	readonly initialDelayMs: number;
	readonly maxDelayMs: number;
	readonly maxAttempts: number;
}

interface SubscriptionRecord {
	readonly id: number;
	readonly spec: SignalSpec;
	readonly listener: SignalListener;
	readonly rule: string;
}

interface PendingCall {
	settle(): void;
	reject(error: unknown): void;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;
// Bound a single connect/auth attempt so a stalled handshake cannot freeze the reconnect
// loop. A local unix-socket D-Bus connect completes in milliseconds; 2s is ample headroom
// while keeping reconnect responsive after a bus restart.
const CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_RECONNECT: ResolvedReconnect = {
	enabled: true,
	initialDelayMs: 50,
	maxDelayMs: 2_000,
	maxAttempts: 0,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

class DbusTransportImpl implements DbusTransport {
	readonly #options: DbusTransportOptions;
	readonly #reconnect: ResolvedReconnect;
	readonly #callTimeoutMs: number;
	readonly #emitter = new EventEmitter();
	readonly #subscriptions = new Map<number, SubscriptionRecord>();
	readonly #matchRuleRefcount = new Map<string, number>();
	readonly #pending = new Set<PendingCall>();

	#bus: RawBus | null = null;
	#state: State = 'idle';
	#closing = false;
	#nextSubId = 1;

	// Bound once so the same references can be detached from a dead connection.
	readonly #onMessage = (message: RawMessage): void => this.#dispatchSignal(message);
	readonly #onConnectionError = (cause: unknown): void =>
		this.#handleDrop(cause instanceof Error ? cause : new DisconnectedError(String(cause)));
	readonly #onConnectionEnd = (): void =>
		this.#handleDrop(new DisconnectedError('bus connection ended'));

	constructor(options: DbusTransportOptions) {
		this.#options = options;
		this.#callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
		this.#reconnect = {
			enabled: options.reconnect?.enabled ?? DEFAULT_RECONNECT.enabled,
			initialDelayMs: options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT.initialDelayMs,
			maxDelayMs: options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT.maxDelayMs,
			maxAttempts: options.reconnect?.maxAttempts ?? DEFAULT_RECONNECT.maxAttempts,
		};
		// Avoid MaxListeners warnings when many consumers observe transport events.
		this.#emitter.setMaxListeners(0);
	}

	async connect(): Promise<void> {
		if (this.#state === 'connected') {
			return;
		}
		if (this.#closing) {
			throw new TransportError('Transport is closed');
		}
		this.#state = 'connecting';
		await this.#establish();
		this.#emitter.emit('connected');
	}

	isConnected(): boolean {
		return this.#state === 'connected';
	}

	async disconnect(): Promise<void> {
		this.#closing = true;
		this.#state = 'closed';
		const bus = this.#bus;
		this.#bus = null;
		this.#rejectPending(new DisconnectedError('transport closed'));
		if (bus) {
			this.#quiesce(bus);
			await bus.disconnect().catch(() => undefined);
		}
	}

	async callMethod(call: MethodCall): Promise<MethodReply> {
		const bus = this.#bus;
		if (this.#state !== 'connected' || bus === null) {
			throw new DisconnectedError('cannot call method: transport not connected');
		}

		const signature = call.signature ?? '';
		const args = call.args ?? [];
		const message: RawMessage = {
			type: messageType.methodCall,
			destination: call.destination,
			path: call.path,
			interface: call.interface,
			member: call.member,
		};
		if (signature.length > 0) {
			// Throws UnsupportedSignatureError / BigIntRequiredError before anything hits
			// the wire.
			message.signature = signature;
			message.body = encodeBody(signature, args);
		}

		const timeoutMs = call.timeoutMs ?? this.#callTimeoutMs;
		const pendingSet = this.#pending;
		return new Promise<MethodReply>((resolve, reject) => {
			let done = false;
			const pending: PendingCall = {
				settle: finish,
				reject: (error) => {
					finish();
					reject(error);
				},
			};

			function finish(): void {
				if (done) {
					return;
				}
				done = true;
				clearTimeout(timer);
				pendingSet.delete(pending);
			}

			const timer = setTimeout(() => {
				finish();
				reject(
					new TransportError(
						`Method call ${call.interface}.${call.member} timed out after ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);

			pendingSet.add(pending);

			bus.invoke(
				message,
				function reply(this: ReplyContext, error: unknown, ...body: unknown[]): void {
					if (done) {
						// Reply arrived after timeout/disconnect already settled the promise — ignore.
						return;
					}
					finish();
					if (error) {
						reject(error instanceof Error ? error : new TransportError(String(error)));
						return;
					}
					try {
						const replySignature = this.signature ?? '';
						const decoded: DbusValue[] =
							replySignature.length > 0 ? decodeBody(replySignature, body) : [];
						resolve({ signature: replySignature, body: decoded });
					} catch (decodeError) {
						reject(decodeError);
					}
				},
			);
		});
	}

	async subscribeSignal(spec: SignalSpec, listener: SignalListener): Promise<Subscription> {
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

	subscriptionCount(): number {
		return this.#subscriptions.size;
	}

	on(event: TransportEvent, handler: (payload?: unknown) => void): void {
		this.#emitter.on(event, handler);
	}

	off(event: TransportEvent, handler: (payload?: unknown) => void): void {
		this.#emitter.off(event, handler);
	}

	// ── internals ──────────────────────────────────────────────────────────────────

	async #establish(): Promise<void> {
		const options: CreateClientOptions = { ReturnLongjs: true };
		if (this.#options.socket !== undefined) {
			options.socket = this.#options.socket;
		} else if (this.#options.busAddress !== undefined) {
			options.busAddress = this.#options.busAddress;
		}

		const bus = createClient(options);
		try {
			await new Promise<void>((resolve, reject) => {
				const onConnect = (): void => {
					cleanup();
					resolve();
				};
				const onError = (error: unknown): void => {
					cleanup();
					reject(error instanceof Error ? error : new TransportError(String(error)));
				};
				const timer = setTimeout(() => {
					cleanup();
					reject(new TransportError(`bus connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
				}, CONNECT_TIMEOUT_MS);
				const cleanup = (): void => {
					clearTimeout(timer);
					bus.connection.removeListener('connect', onConnect);
					bus.connection.removeListener('error', onError);
				};
				bus.connection.once('connect', onConnect);
				bus.connection.once('error', onError);
			});

			bus.connection.on('message', this.#onMessage as (...args: unknown[]) => void);
			bus.connection.on('error', this.#onConnectionError);
			bus.connection.on('end', this.#onConnectionEnd);

			// Re-issue every live match rule so a reconnect resubscribes transparently.
			for (const rule of this.#matchRuleRefcount.keys()) {
				await bus.addMatch(rule);
			}

			this.#bus = bus;
			this.#state = 'connected';
		} catch (error) {
			this.#detachHandlers(bus);
			bus.connection.removeAllListeners();
			bus.connection.on('error', () => undefined);
			try {
				bus.connection.end();
			} catch {
				// The half-open connection is already dead; nothing to close.
			}
			throw error;
		}
	}

	#dispatchSignal(message: RawMessage): void {
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
				this.#emitter.emit('error', error);
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
				this.#emitter.emit('error', error);
			}
		}
	}

	async #addMatchRule(rule: string): Promise<void> {
		const current = this.#matchRuleRefcount.get(rule) ?? 0;
		this.#matchRuleRefcount.set(rule, current + 1);
		if (current === 0 && this.#state === 'connected' && this.#bus) {
			await this.#bus.addMatch(rule);
		}
	}

	async #removeMatchRule(rule: string): Promise<void> {
		const current = this.#matchRuleRefcount.get(rule) ?? 0;
		if (current <= 1) {
			this.#matchRuleRefcount.delete(rule);
			if (current === 1 && this.#state === 'connected' && this.#bus) {
				await this.#bus.removeMatch(rule).catch(() => undefined);
			}
		} else {
			this.#matchRuleRefcount.set(rule, current - 1);
		}
	}

	#detachHandlers(bus: RawBus): void {
		bus.connection.removeListener('message', this.#onMessage as (...args: unknown[]) => void);
		bus.connection.removeListener('error', this.#onConnectionError);
		bus.connection.removeListener('end', this.#onConnectionEnd);
	}

	// Detach our handlers from a dead connection, then swallow any late socket error it
	// still emits — without a listener, Node re-throws an EventEmitter 'error' and crashes
	// the process mid-reconnect.
	#quiesce(bus: RawBus): void {
		this.#detachHandlers(bus);
		bus.connection.on('error', () => undefined);
	}

	#rejectPending(cause: unknown): void {
		for (const pending of this.#pending) {
			pending.reject(cause);
		}
		this.#pending.clear();
	}

	#handleDrop(cause: unknown): void {
		if (this.#closing) {
			return;
		}
		if (this.#state === 'disconnected' || this.#state === 'reconnecting') {
			return;
		}
		this.#state = 'disconnected';
		if (this.#bus) {
			this.#quiesce(this.#bus);
		}
		this.#bus = null;
		this.#rejectPending(cause);
		this.#emitter.emit('disconnected', cause);
		if (this.#reconnect.enabled) {
			void this.#reconnectLoop();
		}
	}

	async #reconnectLoop(): Promise<void> {
		this.#state = 'reconnecting';
		let delay = this.#reconnect.initialDelayMs;
		let attempt = 0;
		while (!this.#closing) {
			attempt += 1;
			try {
				await this.#establish();
				this.#emitter.emit('reconnected');
				return;
			} catch (error) {
				if (this.#reconnect.maxAttempts > 0 && attempt >= this.#reconnect.maxAttempts) {
					this.#state = 'disconnected';
					this.#emitter.emit('error', error);
					return;
				}
				await sleep(delay);
				delay = Math.min(delay * 2, this.#reconnect.maxDelayMs);
			}
		}
	}
}

export function createDbusTransport(options: DbusTransportOptions = {}): DbusTransport {
	return new DbusTransportImpl(options);
}
