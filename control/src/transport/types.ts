// Public value and message types for the D-Bus transport seam.
//
// These types are the transport's own vocabulary. None of the underlying
// `@httptoolkit/dbus-native` types appear here or in `./index.ts`, so the package's
// public surface never leaks the library — swapping the implementation (see README:
// documented fallback `@particle/dbus-next`) would not change a single caller type.

// A decoded / encodable D-Bus value.
//
// 64-bit integers (`x`, `t`) are ALWAYS `bigint`, never `number`. Byte arrays (`ay`)
// are `Uint8Array`. Arrays, structs, and dict entries are all plain arrays; a dict
// `a{KV}` decodes to an array of `[key, value]` entry pairs, preserving order and
// tolerating duplicate/non-string keys losslessly. Variants are wrapped in
// `DbusVariant` so their inner signature survives a round-trip.
export type DbusValue = string | number | boolean | bigint | Uint8Array | DbusVariant | DbusValue[];

// A D-Bus variant (`v`): a value tagged with the signature of its contained type.
export interface DbusVariant {
	readonly signature: string;
	readonly value: DbusValue;
}

// Construct a variant for encoding, e.g. `variant('u', 42)` or `variant('t', 5n)`.
export function variant(signature: string, value: DbusValue): DbusVariant {
	return { signature, value };
}

// Narrowing guard for a decoded variant.
export function isVariant(value: DbusValue): value is DbusVariant {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Uint8Array) &&
		typeof (value as DbusVariant).signature === 'string' &&
		'value' in value
	);
}

// An outgoing method call.
export interface MethodCall {
	readonly destination: string;
	readonly path: string;
	readonly interface: string;
	readonly member: string;
	// D-Bus signature of `args`. Omit (or empty) for a no-argument call.
	readonly signature?: string;
	readonly args?: readonly DbusValue[];
	// Per-call reply timeout in ms. Defaults to the transport's configured timeout.
	readonly timeoutMs?: number;
}

// A decoded method reply.
export interface MethodReply {
	readonly signature: string;
	readonly body: DbusValue[];
}

// A signal subscription filter. `interface` and `member` are required; `path` and
// `sender` narrow further when supplied (MM emits the same signal from many paths).
export interface SignalSpec {
	readonly interface: string;
	readonly member: string;
	readonly path?: string;
	readonly sender?: string;
}

// A decoded signal delivered to a subscriber.
export interface SignalEvent {
	readonly path: string;
	readonly interface: string;
	readonly member: string;
	readonly sender: string | undefined;
	readonly signature: string;
	readonly body: DbusValue[];
}

export type SignalListener = (event: SignalEvent) => void;

// Handle returned by `subscribeSignal`; call `unsubscribe` to detach the listener and
// (when it was the last subscriber for its match rule) drop the bus-side match.
export interface Subscription {
	unsubscribe(): Promise<void>;
}

export type TransportEvent = 'connected' | 'reconnected' | 'disconnected' | 'error';

export interface DbusTransportOptions {
	// Encoded bus address. Defaults to `DBUS_SESSION_BUS_ADDRESS`.
	readonly busAddress?: string;
	// Unix socket path (an alternative to `busAddress` for a private test bus).
	readonly socket?: string;
	// Default per-call reply timeout in ms (default 30000).
	readonly callTimeoutMs?: number;
	// Automatic reconnect after an unexpected bus drop (default enabled).
	readonly reconnect?: ReconnectOptions;
}

export interface ReconnectOptions {
	readonly enabled?: boolean;
	readonly initialDelayMs?: number;
	readonly maxDelayMs?: number;
	// 0 = retry forever (default).
	readonly maxAttempts?: number;
}

// The transport seam. This is the entire surface the A3.x D-Bus backend builds on.
export interface DbusTransport {
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	isConnected(): boolean;
	callMethod(call: MethodCall): Promise<MethodReply>;
	subscribeSignal(spec: SignalSpec, listener: SignalListener): Promise<Subscription>;
	on(event: TransportEvent, handler: (payload?: unknown) => void): void;
	off(event: TransportEvent, handler: (payload?: unknown) => void): void;
	// Number of live signal subscriptions — exposed for leak assertions in tests.
	subscriptionCount(): number;
}
