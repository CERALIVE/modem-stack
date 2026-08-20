// NMEA GGA decoding — checksum-verified, quality-gated, never throwing.
//
// The negative cases matter more than the positive one here: this parser sits
// behind the honest no-fix path, so anything it CANNOT prove is a fix must come
// back `undefined` rather than a plausible-looking coordinate.

import { describe, expect, test } from 'bun:test';
import { parseNmeaFix } from './nmea';

const VALID_GGA = '$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47';
const SEARCHING_GGA = '$GPGGA,000000,,,,,0,00,99.99,,,,,,*48';
const SOUTHWEST_GGA =
	'$GNGGA,181908.00,3404.7041778,S,07044.3966270,W,1,13,0.98,1113.0,M,-21.3,M,,*59';
const RMC = '$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W*6A';

describe('a real fix decodes', () => {
	test('ddmm.mmmm is converted to signed degrees', () => {
		const fix = parseNmeaFix(VALID_GGA);
		expect(fix?.latitude).toBeCloseTo(48.1173, 4);
		expect(fix?.longitude).toBeCloseTo(11.516667, 5);
		expect(fix?.altitude).toBeCloseTo(545.4, 1);
	});

	test('southern and western hemispheres come back negative', () => {
		const fix = parseNmeaFix(SOUTHWEST_GGA);
		expect(fix?.latitude).toBeLessThan(0);
		expect(fix?.longitude).toBeLessThan(0);
		expect(fix?.latitude).toBeCloseTo(-34.0784, 3);
		expect(fix?.longitude).toBeCloseTo(-70.7399, 3);
	});

	test('the LAST valid fix in a multi-sentence block wins', () => {
		const fix = parseNmeaFix([VALID_GGA, RMC, SOUTHWEST_GGA].join('\r\n'));
		expect(fix?.latitude).toBeLessThan(0);
	});

	test('a talker-agnostic GGA is accepted — GN as well as GP', () => {
		expect(parseNmeaFix(SOUTHWEST_GGA)).toBeDefined();
	});
});

describe('anything unproven is NOT a fix', () => {
	test('quality 0 — a receiver that is still searching', () => {
		expect(parseNmeaFix(SEARCHING_GGA)).toBeUndefined();
	});

	test('a searching block never falls back to an earlier fix in the same blob', () => {
		// A block whose ONLY sentences are quality-0 must decode to nothing, even
		// though the parser retains a `latest` across lines.
		expect(parseNmeaFix([SEARCHING_GGA, SEARCHING_GGA].join('\n'))).toBeUndefined();
	});

	test('a corrupted checksum is rejected even though the fields parse cleanly', () => {
		expect(parseNmeaFix(VALID_GGA.replace('*47', '*48'))).toBeUndefined();
	});

	test('a sentence with no checksum at all is rejected', () => {
		expect(parseNmeaFix(VALID_GGA.slice(0, VALID_GGA.lastIndexOf('*')))).toBeUndefined();
	});

	test('RMC is not read — only GGA carries the quality flag this module needs', () => {
		expect(parseNmeaFix(RMC)).toBeUndefined();
	});

	test('an out-of-range coordinate is refused, not clamped', () => {
		const bogus = '$GPGGA,123519,9959.999,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,';
		let sum = 0;
		for (const char of bogus.slice(1)) {
			sum ^= char.charCodeAt(0);
		}
		const sentence = `${bogus}*${sum.toString(16).toUpperCase().padStart(2, '0')}`;
		expect(parseNmeaFix(sentence)).toBeUndefined();
	});

	test('never throws on hostile or truncated input', () => {
		for (const input of ['', '$', '$*', '$GPGGA*00', '\0\0\0', '$GPGGA,,,,,,,,,,,,,,*4E']) {
			expect(() => parseNmeaFix(input)).not.toThrow();
			expect(parseNmeaFix(input)).toBeUndefined();
		}
	});
});
