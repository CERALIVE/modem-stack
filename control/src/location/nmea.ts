// Minimal NMEA decoding — GGA only, checksum-verified.
//
// It exists because `gps-nmea` is the one GNSS source EVERY GNSS-capable modem on
// the fleet advertises, while `gps-raw` (MM's pre-decoded dict) is not guaranteed:
// a `gps-unmanaged`-style device hands over sentences and nothing else. Without this
// the module would have to answer "no fix" to a modem that is reporting one, which
// is exactly the dishonesty the rest of this module is built to avoid.
//
// GGA is the only sentence read: it is the only standard sentence carrying fix
// QUALITY alongside the position, so "the receiver has not locked on" is decodable
// rather than inferred. RMC's A/V validity flag would do, but no fleet modem emits
// RMC without also emitting GGA.

export interface NmeaFix {
	readonly latitude: number;
	readonly longitude: number;
	readonly altitude?: number;
}

/** XOR of every character between `$` and `*` — the NMEA checksum. */
function checksumOf(body: string): number {
	let sum = 0;
	for (let i = 0; i < body.length; i += 1) {
		sum ^= body.charCodeAt(i);
	}
	return sum;
}

function verifiedBody(sentence: string): string | undefined {
	const trimmed = sentence.trim();
	if (!trimmed.startsWith('$')) {
		return undefined;
	}
	const star = trimmed.lastIndexOf('*');
	if (star < 0) {
		return undefined;
	}
	const body = trimmed.slice(1, star);
	const declared = Number.parseInt(trimmed.slice(star + 1, star + 3), 16);
	return Number.isNaN(declared) || checksumOf(body) !== declared ? undefined : body;
}

/** `ddmm.mmmm` + hemisphere → signed degrees. `degreeDigits` is 2 for lat, 3 for lon. */
function toDegrees(value: string, hemisphere: string, degreeDigits: number): number | undefined {
	if (value.length < degreeDigits + 1) {
		return undefined;
	}
	const degrees = Number.parseFloat(value.slice(0, degreeDigits));
	const minutes = Number.parseFloat(value.slice(degreeDigits));
	if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) {
		return undefined;
	}
	const magnitude = degrees + minutes / 60;
	const negative = hemisphere === 'S' || hemisphere === 'W';
	return negative ? -magnitude : magnitude;
}

function parseGga(fields: readonly string[]): NmeaFix | undefined {
	const quality = Number.parseInt(fields[6] ?? '', 10);
	// Quality 0 is "fix not available". A receiver that is searching emits GGA with
	// empty position fields and quality 0, so this is the honest no-fix signal.
	if (!Number.isFinite(quality) || quality <= 0) {
		return undefined;
	}
	const latitude = toDegrees(fields[2] ?? '', fields[3] ?? '', 2);
	const longitude = toDegrees(fields[4] ?? '', fields[5] ?? '', 3);
	if (latitude === undefined || longitude === undefined) {
		return undefined;
	}
	if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
		return undefined;
	}
	const altitude = Number.parseFloat(fields[9] ?? '');
	return {
		latitude,
		longitude,
		...(Number.isFinite(altitude) ? { altitude } : {}),
	};
}

/**
 * The LAST valid GGA fix in a block of sentences, or `undefined` when none of them
 * carries one. Never throws — a truncated or corrupt blob is simply not a fix.
 */
export function parseNmeaFix(text: string): NmeaFix | undefined {
	let latest: NmeaFix | undefined;
	for (const line of text.split(/[\r\n]+/)) {
		const body = verifiedBody(line);
		if (body === undefined) {
			continue;
		}
		const fields = body.split(',');
		const type = fields[0] ?? '';
		if (type.length !== 5 || !type.endsWith('GGA')) {
			continue;
		}
		latest = parseGga(fields) ?? latest;
	}
	return latest;
}
