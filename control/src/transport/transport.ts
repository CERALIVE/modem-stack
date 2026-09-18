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

const DEFAULT_RECONNECT: ResolvedReconnect = {
	enabled: true,
	initialDelayMs: 50,
	maxDelayMs: 2_000,
	maxAttempts: 0,
};

// Every wall-clock bound this transport enforces, in ONE named object rather than scattered
// module constants — so a caller (or a test) moves them together and cannot leave the connect
// bound and the call bound disagreeing about how patient the transport is.
//
// The defaults are exactly the values this module has always used, unchanged. `connectTimeoutMs`
// bounds a single connect/auth attempt so a stalled handshake cannot freeze the reconnect loop:
// a local unix-socket D-Bus connect completes in milliseconds, so 2s is ample headroom while
// keeping reconnect responsive after a bus restart. `callTimeoutMs` is the per-call reply bound
// `./calls` has always defaulted to.
export interface TransportTimingPolicy {
	readonly connectTimeoutMs: number;
	readonly callTimeoutMs: number;
}

export const DEFAULT_TRANSPORT_TIMING: TransportTimingPolicy = {
	connectTimeoutMs: 2_000,
	callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
};

// `timing` outranks the standalone `callTimeoutMs`, which stays honoured so a caller that
// only cares about the reply bound never has to name the whole policy.
export interface DbusTransportSeamOptions extends DbusTransportOptions {
	readonly timing?: Partial<TransportTimingPolicy>;
}

function resolveTimingPolicy(options: DbusTransportSeamOptions): TransportTimingPolicy {
	return {
		connectTimeoutMs: options.timing?.connectTimeoutMs ?? DEFAULT_TRANSPORT_TIMING.connectTimeoutMs,
		callTimeoutMs:
			options.timing?.callTimeoutMs ??
			options.callTimeoutMs ??
			DEFAULT_TRANSPORT_TIMING.callTimeoutMs,
	};
}

// Which teardown the transport was performing, and which step of it failed. Both are needed:
// the same step fails for different reasons depending on whether a caller asked to close or
// the transport is abandoning a half-open connection mid-reconnect.
export type TransportTeardownPhase = 'disconnect' | 'establish-abort';
export type TransportTeardownStep = 'bus-disconnect' | 'connection-end';

// A teardown step failed. This is REPORTED on the transport's existing `error` event and is
// never thrown: by the time it happens the caller is already closing (or the establish error
// is already on its way up), so escalating would replace the failure a caller must act on with
// one they cannot. It is an `Error` subclass because everything else on that event is —
// consumers narrow with `instanceof` and branch on `phase` / `step`.
export class TransportTeardownFailure extends TransportError {
	readonly phase: TransportTeardownPhase;
	readonly step: TransportTeardownStep;

	constructor(phase: TransportTeardownPhase, step: TransportTeardownStep, cause: unknown) {
		super(`D-Bus transport teardown step "${step}" failed during ${phase}`, { cause });
		this.name = 'TransportTeardownFailure';
		this.phase = phase;
		this.step = step;
	}
}

// How the transport obtains a raw bus. Production is `createClient`; a test supplies its own
// through `createDbusTransportForTest`, so lifecycle failure paths are reachable without a
// real daemon to break.
export type BusFactory = (options: CreateClientOptions) => RawBus;

class DbusTransportImpl implements DbusTransport {
	readonly #options: DbusTransportSeamOptions;
	readonly #reconnect: ResolvedReconnect;
	readonly #timing: TransportTimingPolicy;
	readonly #createBus: BusFactory;
	readonly #emitter = new EventEmitter();
	readonly #calls: CallDispatcher;
	readonly #signals: SignalRegistry;

	#bus: RawBus | null = null;
	#state: State = 'idle';
	#closing = false;
	// The single live reconnect loop, retained rather than fired and forgotten: a second drop
	// cannot start a second loop, and `disconnect()` has something to await so it can promise
	// that no loop outlives it.
	#reconnectLoopPromise: Promise<void> | null = null;
	// Set only while that loop is parked in its backoff sleep; calling it cuts the sleep short.
	#wakeBackoff: (() => void) | null = null;

	// Bound once so the same references can be detached from a dead connection.
	readonly #onMessage = (message: RawMessage): void => this.#signals.dispatch(message);
	readonly #onConnectionError = (cause: unknown): void =>
		this.#handleDrop(cause instanceof Error ? cause : new DisconnectedError(String(cause)));
	readonly #onConnectionEnd = (): void =>
		this.#handleDrop(new DisconnectedError('bus connection ended'));

	constructor(options: DbusTransportSeamOptions, createBus: BusFactory) {
		this.#options = options;
		this.#createBus = createBus;
		this.#timing = resolveTimingPolicy(options);
		this.#calls = new CallDispatcher(this.#timing.callTimeoutMs);
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
		// Capture the loop BEFORE waking it: waking lets it run to completion, which clears the
		// field, and a `disconnect()` that lost the handle could not wait for it.
		const loop = this.#reconnectLoopPromise;
		this.#cancelBackoff();
		this.#calls.rejectAll(new DisconnectedError('transport closed'));
		if (bus) {
			this.#quiesce(bus);
			await this.#closeBus(bus, 'disconnect');
		}
		if (loop) {
			await loop;
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

		const connectTimeoutMs = this.#timing.connectTimeoutMs;
		const bus = this.#createBus(options);
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
					reject(new TransportError(`bus connect timed out after ${connectTimeoutMs}ms`));
				}, connectTimeoutMs);
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

			if (this.#closing) {
				// `disconnect()` landed while this attempt was in flight. Fail the attempt so the
				// shared catch below tears the fresh connection down — a closed transport must
				// never publish a live bus that nobody is left to close.
				throw new TransportError('Transport is closed');
			}

			this.#bus = bus;
			this.#state = 'connected';
		} catch (error) {
			this.#detachHandlers(bus);
			bus.connection.removeAllListeners();
			bus.connection.on('error', () => undefined);
			try {
				bus.connection.end();
			} catch (cause) {
				// The half-open connection is usually already dead, so this ordinarily does
				// nothing. When it does fail, that is a real teardown outcome and it is reported
				// rather than discarded — but never rethrown, because `error` is the failure the
				// caller actually needs to see.
				this.#reportTeardownFailure('establish-abort', 'connection-end', cause);
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

	// A rejected `bus.disconnect()` used to vanish into `.catch(() => undefined)`, leaving a
	// consumer no way to learn that a socket it believed closed never actually was.
	async #closeBus(bus: RawBus, phase: TransportTeardownPhase): Promise<void> {
		try {
			await bus.disconnect();
		} catch (cause) {
			this.#reportTeardownFailure(phase, 'bus-disconnect', cause);
		}
	}

	#reportTeardownFailure(
		phase: TransportTeardownPhase,
		step: TransportTeardownStep,
		cause: unknown,
	): void {
		this.#emitObservable('error', new TransportTeardownFailure(phase, step, cause));
	}

	// Node re-throws an unobserved EventEmitter 'error', which would turn a report ABOUT a
	// failed teardown into a process crash on the path that is already unwinding.
	#emitObservable(event: TransportEvent, payload: unknown): void {
		if (event === 'error' && this.#emitter.listenerCount('error') === 0) {
			return;
		}
		this.#emitter.emit(event, payload);
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
			this.#startReconnectLoop();
		}
	}

	// The state guard above already blocks the common double-drop, but holding the promise
	// makes the single-loop property structural instead of a consequence of state ordering,
	// and it is what lets `disconnect()` wait for the loop it just cancelled.
	#startReconnectLoop(): void {
		if (this.#reconnectLoopPromise !== null) {
			return;
		}
		const loop = this.#reconnectLoop().catch((error: unknown) => {
			this.#emitObservable('error', error);
		});
		this.#reconnectLoopPromise = loop;
		void loop.then(() => {
			if (this.#reconnectLoopPromise === loop) {
				this.#reconnectLoopPromise = null;
			}
		});
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
				await this.#backoff(delay);
				delay = Math.min(delay * 2, this.#reconnect.maxDelayMs);
			}
		}
	}

	// A plain `setTimeout` promise holds the loop — and the event loop — for the whole
	// remaining delay after a caller has already asked for teardown. At the default 2s ceiling
	// that is a 2s stall on every close landing mid-backoff, and an unbounded one for a caller
	// that raised the ceiling.
	#backoff(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const finish = (): void => {
				clearTimeout(timer);
				if (this.#wakeBackoff === finish) {
					this.#wakeBackoff = null;
				}
				resolve();
			};
			const timer = setTimeout(finish, ms);
			this.#wakeBackoff = finish;
		});
	}

	#cancelBackoff(): void {
		const wake = this.#wakeBackoff;
		this.#wakeBackoff = null;
		wake?.();
	}
}

export function createDbusTransport(options: DbusTransportSeamOptions = {}): DbusTransport {
	return new DbusTransportImpl(options, createClient);
}

// Deliberately NOT re-exported from `./index.ts`, whose public surface is pinned by
// `no-library-leak.test.ts`. It exists so lifecycle failure paths — a bus whose `disconnect()`
// rejects, a connection whose `end()` throws, a handshake that never completes — are reachable
// deterministically, without a real `dbus-daemon` to break.
export function createDbusTransportForTest(
	options: DbusTransportSeamOptions,
	busFactory: BusFactory,
): DbusTransport {
	return new DbusTransportImpl(options, busFactory);
}
