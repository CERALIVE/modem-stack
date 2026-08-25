import type { RadioAccessTechnology } from './state';

const ACCESS_TECH_BITS: ReadonlyArray<readonly [number, RadioAccessTechnology]> = [
	[1 << 1, 'gsm'],
	[1 << 2, 'gsm'],
	[1 << 3, 'gsm'],
	[1 << 4, 'gsm'],
	[1 << 5, 'umts'],
	[1 << 6, 'umts'],
	[1 << 7, 'umts'],
	[1 << 8, 'umts'],
	[1 << 9, 'umts'],
	[1 << 14, 'lte'],
	[1 << 15, '5gnr'],
	[1 << 16, 'lte'],
	[1 << 17, 'lte'],
];

export function decodeMmAccessTechnologies(mask: number | undefined): Set<RadioAccessTechnology> {
	const result = new Set<RadioAccessTechnology>();
	if (mask === undefined || mask <= 0) return result;
	for (const [bit, rat] of ACCESS_TECH_BITS) if ((mask & bit) !== 0) result.add(rat);
	return result;
}

export function modeMaskToLabel(mask: number | undefined): string | undefined {
	if (mask === undefined || mask <= 0) return undefined;
	const tokens = [
		[1 << 1, '2g'],
		[1 << 2, '3g'],
		[1 << 3, '4g'],
		[1 << 4, '5g'],
	] as const;
	const named = tokens.filter(([bit]) => (mask & bit) !== 0).map(([, token]) => token);
	return named.length === 0 ? undefined : named.reverse().join('');
}

const MM_STATES = new Map<number, string>([
	[-1, 'failed'],
	[1, 'initializing'],
	[2, 'locked'],
	[3, 'disabled'],
	[4, 'disabling'],
	[5, 'enabling'],
	[6, 'enabled'],
	[7, 'searching'],
	[8, 'registered'],
	[9, 'disconnecting'],
	[10, 'connecting'],
	[11, 'connected'],
]);
export function decodeMmState(state: number | undefined): string {
	return state === undefined ? 'unknown' : (MM_STATES.get(state) ?? 'unknown');
}

export function decodeRegistrationState(state: number | undefined): string {
	if (state === 0) return 'idle';
	if (state === 1 || state === 6 || state === 7) return 'home';
	if (state === 2) return 'searching';
	if (state === 3) return 'denied';
	if (state === 5 || state === 8 || state === 9) return 'roaming';
	return state === 11 ? 'emergency-only' : 'unknown';
}

/**
 * `MMModemStateFailedReason` → its mmcli spelling.
 *
 * This decoder is what makes "there is no SIM" an EXPLICIT reading rather than an
 * inference. `Modem.StateFailedReason` is a `u` on D-Bus, so a provider that copies
 * the property verbatim holds a NUMBER, while the migrated SIM-presence rule
 * (`deriveSimPresence`) matches the mmcli STRING `sim-missing` that CeraUI has always
 * read. Without this decoder the D-Bus path can never produce the one fact that
 * proves absence, and a modem with no SIM reads `unknown` forever — or, worse,
 * invites a consumer to infer absence from the blank `Sim` object path, which is
 * exactly the guess this package refuses to make.
 *
 * An unrecognized value answers `undefined`: a reason this build cannot place says
 * nothing, and must not be laundered into one that does.
 */
const STATE_FAILED_REASONS = new Map<number, string>([
	[0, 'none'],
	// MM's own `UNKNOWN` member. Spelled distinctly so it is never confused with the
	// `'unknown'` sentinel the label decoders use to mean "this build could not place it".
	[1, 'unknown-reason'],
	[2, 'sim-missing'],
	[3, 'sim-error'],
	[4, 'unknown-capabilities'],
	[5, 'esim-without-profiles'],
]);
export function decodeStateFailedReason(value: number | undefined): string | undefined {
	return value === undefined ? undefined : STATE_FAILED_REASONS.get(value);
}

export function decodeUnlockRequired(lock: number | undefined): string | undefined {
	return lock === 1
		? 'none'
		: lock === 2
			? 'sim-pin'
			: lock === 3
				? 'sim-pin2'
				: lock === 4
					? 'sim-puk'
					: lock === 5
						? 'sim-puk2'
						: undefined;
}
export function decodeSimType(value: number | undefined): 'physical' | 'esim' | undefined {
	return value === 1 ? 'physical' : value === 2 ? 'esim' : undefined;
}
export function decodeEsimStatus(
	value: number | undefined,
): 'no-profiles' | 'with-profiles' | undefined {
	return value === 1 ? 'no-profiles' : value === 2 ? 'with-profiles' : undefined;
}
export function decodePacketServiceState(
	value: number | undefined,
): 'detached' | 'attached' | undefined {
	return value === 1 ? 'detached' : value === 2 ? 'attached' : undefined;
}

const NETWORK_REJECTIONS = new Map<number, string>([
	[2, 'imsi-unknown-in-hlr'],
	[3, 'illegal-ms'],
	[4, 'imsi-unknown-in-vlr'],
	[5, 'imei-not-accepted'],
	[6, 'illegal-me'],
	[7, 'gprs-not-allowed'],
	[8, 'gprs-and-non-gprs-not-allowed'],
	[11, 'plmn-not-allowed'],
	[12, 'location-area-not-allowed'],
	[13, 'roaming-not-allowed-in-location-area'],
	[14, 'gprs-not-allowed-in-plmn'],
	[15, 'no-cells-in-location-area'],
	[17, 'network-failure'],
	[22, 'congestion'],
]);
export function decodeNetworkRejectionError(value: number | undefined): string | undefined {
	return value === undefined ? undefined : NETWORK_REJECTIONS.get(value);
}
export function runtimeIdFromPath(path: string): number | undefined {
	const value = /\/(\d+)$/.exec(path)?.[1];
	return value === undefined ? undefined : Number.parseInt(value, 10);
}

/**
 * The coarse registration context ModemManager's `3gpp-lac-ci` location source reports.
 *
 * Every field is kept as the SOURCE'S OWN TEXT. `locationAreaCode` / `cellId` /
 * `trackingAreaCode` arrive as uppercase hexadecimal and a consumer that parsed them to
 * a decimal number would render a different identifier than every other tool on the
 * device shows; `mnc` is two OR three digits and its width is significant, so a numeric
 * round-trip loses a leading zero that distinguishes two real operators.
 *
 * This is COARSE CELL location and is deliberately NOT a GNSS fix: it names a cell, not
 * a position. It carries no coordinate, so it is outside the GNSS redaction class and
 * outside `GNSS_SOURCES`, and decoding it enables nothing — `Location.Setup`'s
 * `signal_location` argument stays false and this decoder never touches a mask.
 */
export interface Mm3gppLacCi {
	readonly mcc: string;
	readonly mnc: string;
	readonly locationAreaCode: string;
	readonly cellId: string;
	readonly trackingAreaCode: string;
}

// ModemManager 1.24.2 `libmm-glib/mm-location-3gpp.c` builds this value with
//   g_strdup_printf ("%.3s,%s,%lX,%lX,%lX", operator_code, operator_code + 3, lac, ci, tac)
// so it is a STRING of exactly five comma-separated tokens — MCC, MNC, then LAC, CI and
// TAC in uppercase hex. Its own parser reads exactly `split[0]`..`split[4]`, so a value
// with a different token count is not a shape this build should guess at.
const LAC_CI_TOKENS = 5;

/**
 * Decode the `3gpp-lac-ci` location string, or `undefined` when it is not that shape.
 *
 * A token count other than five, or an empty MCC/MNC/CI, decodes to nothing rather than
 * to a partially-populated record: a cell identifier that is wrong is worse than one
 * that is missing, because only the second is visible as missing.
 */
export function decode3gppLacCi(value: string | undefined): Mm3gppLacCi | undefined {
	if (value === undefined) return undefined;
	const tokens = value.trim().split(',');
	if (tokens.length !== LAC_CI_TOKENS) return undefined;
	const [mcc, mnc, locationAreaCode, cellId, trackingAreaCode] = tokens.map((token) =>
		token.trim(),
	) as [string, string, string, string, string];
	if (mcc === '' || mnc === '' || cellId === '') return undefined;
	return { mcc, mnc, locationAreaCode, cellId, trackingAreaCode };
}

/**
 * The PLMN id (`Modem3gpp.OperatorCode`'s spelling) for a decoded `3gpp-lac-ci` value.
 *
 * MCC and MNC are concatenated with no separator and no padding — MM splits the operator
 * code back apart at exactly three characters, so this is the inverse of its own
 * serialization rather than a guess about the MNC's width.
 */
export function lacCiOperatorCode(decoded: Mm3gppLacCi): string {
	return `${decoded.mcc}${decoded.mnc}`;
}
