// Signature-aware encode / decode between the transport's public value vocabulary
// (`DbusValue`, `bigint` for 64-bit, `DbusVariant`) and the shape the underlying
// `@httptoolkit/dbus-native` marshaller consumes and produces.
//
// Two invariants this layer enforces that the library does not:
//   * 64-bit `x`/`t` are `bigint` end-to-end. On decode the library returns Long.js
//     objects (only under `ReturnLongjs: true`); we convert them to `bigint` losslessly
//     via their exact decimal `toString()`. On encode the library accepts a decimal
//     string for the full 64-bit range but silently truncates a `number` above 2^53 —
//     so we require a `bigint` and convert it to a decimal string ourselves.
//   * `h` (UNIX_FD) is rejected up front with a typed error rather than reaching the
//     library, which would throw a generic "Unknown/Unsupported type" instead.

import { BigIntRequiredError, SixtyFourBitRangeError, UnsupportedSignatureError } from './errors';
import { parseSignature, type SignatureNode, signatureFromNode } from './signature';
import type { DbusValue, DbusVariant } from './types';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;

// A Long.js instance as the library hands it back with `ReturnLongjs: true`. We never
// import `long` (it is a transitive dependency, not ours) — we duck-type and use the
// exact decimal `toString()`, so no library type crosses this boundary.
interface LongLike {
	readonly low: number;
	readonly high: number;
	readonly unsigned: boolean;
	toString(): string;
}

function isLongLike(value: unknown): value is LongLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as LongLike).low === 'number' &&
		typeof (value as LongLike).high === 'number' &&
		typeof (value as LongLike).unsigned === 'boolean'
	);
}

function longToBigInt(value: LongLike): bigint {
	return BigInt(value.toString());
}

// ── Encode ─────────────────────────────────────────────────────────────────────────
// Public values → library-native body. `assertSupportedSignature` is applied to the
// whole signature first, so no `h` reaches the recursion.
export function encodeBody(signature: string, args: readonly DbusValue[]): unknown[] {
	if (signature.includes('h')) {
		throw new UnsupportedSignatureError(signature, 'h');
	}
	const nodes = parseSignature(signature);
	if (nodes.length !== args.length) {
		throw new Error(
			`Body arity ${args.length} does not match signature "${signature}" (${nodes.length} types)`,
		);
	}
	return nodes.map((node, i) => encodeNode(node, args[i] as DbusValue));
}

function encodeNode(node: SignatureNode, value: DbusValue): unknown {
	switch (node.type) {
		case 'x':
			return encode64(node.type, value, INT64_MIN, INT64_MAX);
		case 't':
			return encode64(node.type, value, 0n, UINT64_MAX);
		case 'a':
			return encodeArray(node, value);
		case '(':
			return encodeStruct(node, value);
		case '{':
			return encodeDictEntry(node, value);
		case 'v':
			return encodeVariant(value);
		default:
			// y b n q i u d s o g — the library validates range/type on marshal.
			return value;
	}
}

function encode64(type: string, value: DbusValue, min: bigint, max: bigint): string {
	if (typeof value !== 'bigint') {
		throw new BigIntRequiredError(type, value);
	}
	if (value < min || value > max) {
		throw new SixtyFourBitRangeError(type, value);
	}
	// Decimal string: the library parses this across the full 64-bit range losslessly.
	return value.toString();
}

function encodeArray(node: SignatureNode, value: DbusValue): unknown {
	const element = node.child[0] as SignatureNode;
	// `ay` byte arrays pass straight through as a Uint8Array / Buffer (index-addressable).
	if (element.type === 'y' && value instanceof Uint8Array) {
		return value;
	}
	if (!Array.isArray(value)) {
		throw new Error(`Expected array for signature "a${element.type}"`);
	}
	return value.map((item) => encodeNode(element, item));
}

function encodeStruct(node: SignatureNode, value: DbusValue): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error('Expected array for struct value');
	}
	if (value.length !== node.child.length) {
		throw new Error(`Struct arity ${value.length} does not match ${node.child.length} field types`);
	}
	return node.child.map((child, i) => encodeNode(child, value[i] as DbusValue));
}

function encodeDictEntry(node: SignatureNode, value: DbusValue): unknown[] {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new Error('Expected [key, value] pair for dict entry');
	}
	const keyNode = node.child[0] as SignatureNode;
	const valueNode = node.child[1] as SignatureNode;
	return [encodeNode(keyNode, value[0] as DbusValue), encodeNode(valueNode, value[1] as DbusValue)];
}

function encodeVariant(value: DbusValue): [string, unknown] {
	const asVariant = value as DbusVariant;
	if (typeof asVariant?.signature !== 'string' || !('value' in (asVariant as object))) {
		throw new Error('Expected a DbusVariant ({ signature, value }) for variant field');
	}
	if (asVariant.signature.includes('h')) {
		throw new UnsupportedSignatureError(asVariant.signature, 'h');
	}
	const inner = parseSignature(asVariant.signature);
	if (inner.length !== 1) {
		throw new Error(`Variant signature "${asVariant.signature}" must be exactly one complete type`);
	}
	return [asVariant.signature, encodeNode(inner[0] as SignatureNode, asVariant.value)];
}

// ── Decode ─────────────────────────────────────────────────────────────────────────
// Library-native body → public values. The library must have been created with
// `ReturnLongjs: true` so `x`/`t` arrive as Long objects (this transport does exactly
// that); a raw `number` in a 64-bit slot means that flag was lost and is treated as a
// bug, not silently accepted.
export function decodeBody(signature: string, body: readonly unknown[]): DbusValue[] {
	if (signature.includes('h')) {
		throw new UnsupportedSignatureError(signature, 'h');
	}
	const nodes = parseSignature(signature);
	return nodes.map((node, i) => decodeNode(node, body[i]));
}

function decodeNode(node: SignatureNode, value: unknown): DbusValue {
	switch (node.type) {
		case 'x':
		case 't':
			return decode64(node.type, value);
		case 'a':
			return decodeArray(node, value);
		case '(':
			return decodeStruct(node, value);
		case '{':
			return decodeDictEntry(node, value);
		case 'v':
			return decodeVariant(value);
		case 'y':
		case 'b':
		case 'n':
		case 'q':
		case 'i':
		case 'u':
		case 'd':
		case 's':
		case 'o':
		case 'g':
			return value as DbusValue;
		default:
			throw new UnsupportedSignatureError(node.type, node.type);
	}
}

function decode64(type: string, value: unknown): bigint {
	if (isLongLike(value)) {
		return longToBigInt(value);
	}
	if (typeof value === 'bigint') {
		return value;
	}
	// A plain number reaching here means ReturnLongjs was not applied — refuse it rather
	// than risk having already lost precision above 2^53.
	throw new BigIntRequiredError(type, value);
}

function decodeArray(node: SignatureNode, value: unknown): DbusValue {
	const element = node.child[0] as SignatureNode;
	if (element.type === 'y') {
		// `ay`: the library returns a Buffer; normalise to a plain Uint8Array.
		if (value instanceof Uint8Array) {
			return new Uint8Array(value);
		}
	}
	if (!Array.isArray(value)) {
		throw new Error(`Expected array while decoding "a${element.type}"`);
	}
	return value.map((item) => decodeNode(element, item));
}

function decodeStruct(node: SignatureNode, value: unknown): DbusValue {
	if (!Array.isArray(value)) {
		throw new Error('Expected array while decoding struct');
	}
	return node.child.map((child, i) => decodeNode(child, value[i]));
}

function decodeDictEntry(node: SignatureNode, value: unknown): DbusValue {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new Error('Expected [key, value] pair while decoding dict entry');
	}
	const keyNode = node.child[0] as SignatureNode;
	const valueNode = node.child[1] as SignatureNode;
	return [decodeNode(keyNode, value[0]), decodeNode(valueNode, value[1])];
}

// The library decodes a variant to `[parseTree, [innerValue]]`. We recover the inner
// signature from the tree and decode the contained value recursively, preserving both.
function decodeVariant(value: unknown): DbusVariant {
	if (!Array.isArray(value) || value.length !== 2) {
		throw new Error('Malformed variant from library (expected [tree, [value]])');
	}
	const tree = value[0] as SignatureNode[];
	const inner = value[1] as unknown[];
	if (!Array.isArray(tree) || tree.length !== 1 || !Array.isArray(inner)) {
		throw new Error('Malformed variant tree from library');
	}
	const innerNode = tree[0] as SignatureNode;
	const innerSignature = signatureFromNode(innerNode);
	return {
		signature: innerSignature,
		value: decodeNode(innerNode, inner[0]),
	};
}
