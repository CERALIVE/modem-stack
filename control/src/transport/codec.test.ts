// Pure, in-process encode/decode round-trip: no bus, fully deterministic. Marshals with
// the library's own marshaller and reads it back with its DBusBuffer under
// `ReturnLongjs: true` — exactly the wire path a real call takes — so a green run here is
// exact proof the codec is lossless, independent of any daemon timing.

import { expect, test } from 'bun:test';
import DBusBuffer from '@httptoolkit/dbus-native/lib/dbus-buffer';
import marshall from '@httptoolkit/dbus-native/lib/marshall';
import { decodeBody, encodeBody } from './codec';
import { BigIntRequiredError, SixtyFourBitRangeError, UnsupportedSignatureError } from './errors';
import { type DbusValue, variant } from './types';

const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);
const UINT64_MAX = 2n ** 64n - 1n;

function roundTrip(signature: string, values: readonly DbusValue[]): DbusValue[] {
	const encoded = encodeBody(signature, values);
	const buffer = marshall(signature, encoded);
	const reader = new DBusBuffer(buffer, 0, { ayBuffer: true, ReturnLongjs: true });
	const raw = reader.read(signature) as unknown[];
	return decodeBody(signature, raw);
}

test('2^63-1 round-trips through an INT64 exactly (bigint equality)', () => {
	const [value] = roundTrip('x', [INT64_MAX]);
	expect(value).toBe(INT64_MAX);
	expect(typeof value).toBe('bigint');
});

test('the full UINT64 range (2^64-1) round-trips exactly', () => {
	const [value] = roundTrip('t', [UINT64_MAX]);
	expect(value).toBe(UINT64_MAX);
});

test('INT64 minimum round-trips exactly', () => {
	const [value] = roundTrip('x', [INT64_MIN]);
	expect(value).toBe(INT64_MIN);
});

test('a value just above 2^53 survives (no silent Number coercion)', () => {
	const beyondSafe = 2n ** 53n + 1n;
	const [asInt, asUint] = roundTrip('xt', [beyondSafe, beyondSafe]);
	expect(asInt).toBe(beyondSafe);
	expect(asUint).toBe(beyondSafe);
	// The precision-losing path would have produced 9007199254740992n (== 2^53).
	expect(asInt).not.toBe(2n ** 53n);
});

test('the MM GetManagedObjects shape a{oa{sa{sv}}} round-trips with a 64-bit variant', () => {
	const managed: DbusValue = [
		[
			'/org/freedesktop/ModemManager1/Modem/0',
			[
				[
					'org.freedesktop.ModemManager1.Modem',
					[
						['SupportedCapabilities', variant('t', UINT64_MAX)],
						['SignalQuality', variant('u', 87)],
						['DeviceIdentifier', variant('s', 'dev-0')],
					],
				],
			],
		],
	];
	const [decoded] = roundTrip('a{oa{sa{sv}}}', [managed]);
	expect(decoded).toEqual(managed);
});

test('a variant preserves its inner signature and 64-bit value across a round-trip', () => {
	const [decoded] = roundTrip('v', [variant('t', UINT64_MAX)]);
	expect(decoded).toEqual({ signature: 't', value: UINT64_MAX });
});

test('a byte array (ay) round-trips as a Uint8Array', () => {
	const bytes = new Uint8Array([0, 1, 2, 254, 255]);
	const [decoded] = roundTrip('ay', [bytes]);
	expect(decoded).toBeInstanceOf(Uint8Array);
	expect(Array.from(decoded as Uint8Array)).toEqual([0, 1, 2, 254, 255]);
});

test('a struct with mixed 64-bit fields round-trips', () => {
	const [decoded] = roundTrip('(xtu)', [[INT64_MIN, UINT64_MAX, 7]]);
	expect(decoded).toEqual([INT64_MIN, UINT64_MAX, 7]);
});

test('signature h (UNIX_FD) is rejected on encode with a typed error', () => {
	expect(() => encodeBody('h', [0])).toThrow(UnsupportedSignatureError);
});

test('signature h nested inside a container is rejected on encode', () => {
	expect(() => encodeBody('a{sh}', [[]])).toThrow(UnsupportedSignatureError);
});

test('signature h is rejected on decode with a typed error', () => {
	expect(() => decodeBody('h', [0])).toThrow(UnsupportedSignatureError);
});

test('the UnsupportedSignatureError carries the offending type', () => {
	try {
		encodeBody('h', [0]);
		throw new Error('expected throw');
	} catch (error) {
		expect(error).toBeInstanceOf(UnsupportedSignatureError);
		expect((error as UnsupportedSignatureError).unsupportedType).toBe('h');
	}
});

test('passing a JS number for a 64-bit field throws BigIntRequiredError', () => {
	expect(() => encodeBody('t', [123])).toThrow(BigIntRequiredError);
	expect(() => encodeBody('x', [123])).toThrow(BigIntRequiredError);
});

test('an out-of-range 64-bit bigint throws SixtyFourBitRangeError', () => {
	expect(() => encodeBody('t', [-1n])).toThrow(SixtyFourBitRangeError);
	expect(() => encodeBody('x', [2n ** 63n])).toThrow(SixtyFourBitRangeError);
	expect(() => encodeBody('t', [2n ** 64n])).toThrow(SixtyFourBitRangeError);
});
