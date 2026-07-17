// The D-Bus transport seam implementation.
//
// Wraps `@httptoolkit/dbus-native` behind the `DbusTransport` interface. This module owns the
// connection lifecycle — handshake, a reconnect loop that re-issues every match rule after a
// bus restart, and teardown — and delegates method-call dispatch to `./calls` and signal
// subscription/match-rule tracking to `./signals`. Its single `message` listener fans out to
// the signal registry, so subscribing never grows the listener count (the 100-cycle leak check).

import { EventEmitter } from 'node:events';
import { CallDispatcher, DEFAULT_CALL_TIMEOUT_MS } from './calls';
import {
	type CreateClientOptions,
	createClient,
	type RawBus,
	type RawMessage,
} from './dbus-native';
import { DisconnectedError, TransportError } from './errors';
import { SignalRegistry } from './signals';
import type {
	DbusTransport,
	DbusTransportOptions,
	MethodCall,
	MethodReply,
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

class DbusTransportImpl implements DbusTransport {
	readonly #options: DbusTransportOptions;
	readonly #reconnect: ResolvedReconnect;
	readonly #emitter = new EventEmitter();
	readonly #calls: CallDispatcher;
	readonly #signals: SignalRegistry;

	#bus: RawBus | null = null;
	#state: State = 'idle';
	#closing = false;

	// Bound once so the same references can be detached from a dead connection.
	readonly #onMessage = (message: RawMessage): void => this.#signals.dispatch(message);
	readonly #onConnectionError = (cause: unknown): void =>
		this.#handleDrop(cause instanceof Error ? cause : new DisconnectedError(String(cause)));
	readonly #onConnectionEnd = (): void =>
		this.#handleDrop(new DisconnectedError('bus connection ended'));

	constructor(options: DbusTransportOptions) {
		this.#options = options;
		this.#calls = new CallDispatcher(options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
		this.#signals = new SignalRegistry({
			currentBus: () => this.#bus,
			isConnected: () => this.#state === 'connected',
			emitError: (error) => this.#emitter.emit('error', error),
		});
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
		this.#calls.rejectAll(new DisconnectedError('transport closed'));
		if (bus) {
			this.#quiesce(bus);
			await bus.disconnect().catch(() => undefined);
		}
	}

	callMethod(call: MethodCall): Promise<MethodReply> {
		return this.#calls.call(this.#bus, this.#state === 'connected', call);
	}

	subscribeSignal(spec: SignalSpec, listener: SignalListener): Promise<Subscription> {
		return this.#signals.subscribe(spec, listener);
	}

	subscriptionCount(): number {
		return this.#signals.count();
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
			await this.#signals.reissueRules(bus);

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
		this.#calls.rejectAll(cause);
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
