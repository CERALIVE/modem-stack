// Public surface of the D-Bus transport seam.
//
// This is the ONLY module the rest of `@ceralive/modem-control` (and the A3.x D-Bus
// backend) imports from `./transport`. Every type here is the transport's own — no
// `@httptoolkit/dbus-native` type is re-exported, so swapping the underlying library
// (documented fallback: `@particle/dbus-next`) is invisible to callers. See README.md.

export {
	BigIntRequiredError,
	DisconnectedError,
	SixtyFourBitRangeError,
	TransportError,
	UnsupportedSignatureError,
} from './errors';
export { createDbusTransport } from './transport';
export type {
	DbusTransport,
	DbusTransportOptions,
	DbusValue,
	DbusVariant,
	MethodCall,
	MethodReply,
	ReconnectOptions,
	SignalEvent,
	SignalListener,
	SignalSpec,
	Subscription,
	TransportEvent,
} from './types';
export { isVariant, variant } from './types';
