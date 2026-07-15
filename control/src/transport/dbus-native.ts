// Internal typed facade over the `@httptoolkit/dbus-native` CommonJS module.
//
// The library ships a `types.d.ts` that covers only a fraction of the surface we use
// (no `invoke`, `addMatch`, `connection`, or `messageType`), so we describe the exact
// parts we depend on here and cast once, at this single boundary. NOTHING in this file
// is re-exported from the package's public entry (`../index.ts`): the raw library types
// stay quarantined behind the transport seam. See `./README.md` for why this library
// was chosen and the documented fallback (`@particle/dbus-next`).

import * as dbusNativeModule from '@httptoolkit/dbus-native';

// A D-Bus message as the library marshals/unmarshals it.
export interface RawMessage {
	type?: number;
	path?: string;
	interface?: string;
	member?: string;
	destination?: string;
	sender?: string;
	signature?: string;
	body?: unknown[];
	errorName?: string;
	serial?: number;
	replySerial?: number;
}

// The context (`this`) the library binds when it invokes a reply callback. `signature`
// is the reply's own D-Bus signature — the promisified `invoke` drops this and collapses
// multi-value bodies, which is why we always call `invoke` with an explicit callback.
export interface ReplyContext {
	signature?: string;
	message?: RawMessage;
}

export type ReplyCallback = (this: ReplyContext, error: unknown, ...body: unknown[]) => void;

// The underlying stream/EventEmitter. We drive reconnect off its lifecycle events and
// assert on `listenerCount` in the leak test, so both are part of the facade.
export interface RawConnection {
	on(event: string, handler: (...args: unknown[]) => void): void;
	once(event: string, handler: (...args: unknown[]) => void): void;
	removeListener(event: string, handler: (...args: unknown[]) => void): void;
	removeAllListeners(event?: string): void;
	listenerCount(event: string): number;
	end(): void;
}

export interface RawBus {
	connection: RawConnection;
	invoke(message: RawMessage, callback: ReplyCallback): void;
	addMatch(rule: string): Promise<unknown>;
	removeMatch(rule: string): Promise<unknown>;
	disconnect(): Promise<void>;
}

export interface CreateClientOptions {
	busAddress?: string;
	socket?: string;
	// Return 64-bit `x`/`t` fields as Long.js objects instead of lossy numbers. The
	// transport always sets this so `codec.decodeBody` can convert them to `bigint`.
	ReturnLongjs?: boolean;
	direct?: boolean;
}

export interface DbusNativeModule {
	createClient(options: CreateClientOptions): RawBus;
	messageType: {
		invalid: number;
		methodCall: number;
		methodReturn: number;
		error: number;
		signal: number;
	};
}

// Bun/Node CJS interop: `import *` yields the module namespace whose `default` (when
// present) is `module.exports`. One cast confines the untyped surface to this line.
const resolved = ((dbusNativeModule as { default?: unknown }).default ??
	dbusNativeModule) as unknown as DbusNativeModule;

export const messageType = resolved.messageType;

export function createClient(options: CreateClientOptions): RawBus {
	return resolved.createClient(options);
}
