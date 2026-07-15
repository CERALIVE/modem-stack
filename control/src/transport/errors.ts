// Typed error taxonomy for the D-Bus transport seam.
//
// Wire data crossing the transport boundary is never compile-time checked, so every
// failure mode that a caller (or the A3.x D-Bus backend) must branch on is a real,
// exported class — never a bare thrown string or a generic Error.

export class TransportError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'TransportError';
	}
}

// A D-Bus signature contained a type this transport refuses to handle. The only such
// type today is `h` (UNIX_FD / file-descriptor passing): the transport never marshals
// or unmarshals a file descriptor, so encountering `h` in an outgoing call signature,
// a reply signature, a signal signature, or nested inside a variant throws this rather
// than silently dropping or coercing the descriptor.
export class UnsupportedSignatureError extends TransportError {
	readonly signature: string;
	readonly unsupportedType: string;

	constructor(signature: string, unsupportedType: string) {
		super(
			`D-Bus signature "${signature}" contains unsupported type "${unsupportedType}": ` +
				'UNIX_FD / file-descriptor passing is not supported by this transport',
		);
		this.name = 'UnsupportedSignatureError';
		this.signature = signature;
		this.unsupportedType = unsupportedType;
	}
}

// A 64-bit field (`x` INT64 / `t` UINT64) was handed a JavaScript `number` on encode.
// A `number` cannot carry the full 64-bit range without silent precision loss above
// 2^53, so the transport requires a `bigint` for these fields and refuses `number`
// loudly instead of corrupting the value on the wire.
export class BigIntRequiredError extends TransportError {
	readonly signature: string;
	readonly received: string;

	constructor(signature: string, received: unknown) {
		super(
			`D-Bus 64-bit field "${signature}" requires a bigint, received ${typeof received} ` +
				`(${String(received)}): a JS number silently loses precision above 2^53`,
		);
		this.name = 'BigIntRequiredError';
		this.signature = signature;
		this.received = typeof received;
	}
}

// A 64-bit value was outside the range representable by its signed/unsigned field.
export class SixtyFourBitRangeError extends TransportError {
	readonly signature: string;
	readonly value: bigint;

	constructor(signature: string, value: bigint) {
		super(`Value ${value} is out of range for 64-bit D-Bus field "${signature}"`);
		this.name = 'SixtyFourBitRangeError';
		this.signature = signature;
		this.value = value;
	}
}

// The bus connection dropped (or was never established) while a method call was
// in-flight or pending. The call rejects with this instead of hanging forever; the
// transport's own reconnect loop keeps running independently.
export class DisconnectedError extends TransportError {
	constructor(message = 'D-Bus connection is not established') {
		super(message);
		this.name = 'DisconnectedError';
	}
}
