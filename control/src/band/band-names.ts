// MMModemBand ↔ band NAME, in both directions.
//
// The D-Bus surface speaks numbers: `Modem.SupportedBands` and
// `Modem.CurrentBands` are `au`, and `Modem.SetCurrentBands` takes `au`. Every
// operator-facing surface — mmcli's `--set-current-bands`, this package's API,
// CeraUI's selector — speaks the NAME (`eutran-3`, `utran-1`, `egsm`, `any`).
// One mapping, here, so the two can never disagree.
//
// WHERE THE NUMBERS COME FROM. ModemManager's `MMModemBand` (`mm-enums.h`) is
// two different things stitched together, and this module reproduces exactly
// that shape rather than flattening it into one big table:
//
//   * the GSM/UTRAN block (1..20) is IRREGULAR — `UTRAN_2` is 12 while `UTRAN_6`
//     is 8 — because MM appended bands in the order they were needed, so it is
//     an explicit table and can only ever be an explicit table;
//   * every later block is ARITHMETIC, by MM's own construction: `EUTRAN_n` is
//     `30 + n`, `CDMA_BCn` is `128 + n`, `NGRAN_n` is `300 + n`.
//
// Deriving the arithmetic blocks rather than transcribing ~350 constants is the
// point: a transcription is where a wrong band number would hide, and a wrong
// band number sets a radio to a band the SIM's network does not operate on.
//
// A value this module does not recognise is NEVER dropped and NEVER guessed at.
// It round-trips as `band-<value>`, so an unfamiliar band a future ModemManager
// reports is still shown to the operator, still comparable, and still settable —
// the same "unknown is an answer about the read" discipline `detect.ts` follows.

/** A band as every operator-facing surface spells it. Opaque; compare by equality. */
export type BandName = string;

/** `MM_MODEM_BAND_UNKNOWN`. Never a member of a supported/current set we act on. */
export const BAND_UNKNOWN = 'unknown';

/**
 * `MM_MODEM_BAND_ANY` (256) — "let the modem choose", i.e. the reset value.
 * Setting exactly this is how a band lock is released; there is no separate
 * ModemManager verb for it.
 */
export const BAND_ANY = 'any';
const BAND_ANY_VALUE = 256;

/**
 * The irregular head of the enum (`MM_MODEM_BAND_EGSM` = 1 … `G810` = 20),
 * transcribed because it cannot be derived.
 */
const IRREGULAR: Readonly<Record<number, BandName>> = {
	0: BAND_UNKNOWN,
	1: 'egsm',
	2: 'dcs',
	3: 'pcs',
	4: 'g850',
	5: 'utran-1',
	6: 'utran-3',
	7: 'utran-4',
	8: 'utran-6',
	9: 'utran-5',
	10: 'utran-8',
	11: 'utran-9',
	12: 'utran-2',
	13: 'utran-7',
	14: 'g450',
	15: 'g480',
	16: 'g750',
	17: 'g380',
	18: 'g410',
	19: 'g710',
	20: 'g810',
	[BAND_ANY_VALUE]: BAND_ANY,
};

/** Arithmetic blocks: `[prefix, base, firstIndex, lastIndex]`. */
const ARITHMETIC: readonly (readonly [string, number, number, number])[] = [
	// MM_MODEM_BAND_EUTRAN_1 = 31 … EUTRAN_71 = 101.
	['eutran-', 30, 1, 71],
	// MM_MODEM_BAND_CDMA_BC0 = 128 … CDMA_BC19 = 147.
	['cdma-bc', 128, 0, 19],
	// MM_MODEM_BAND_NGRAN_1 = 301 … the 5G NR block.
	['ngran-', 300, 1, 261],
];

const NUMBER_TO_NAME = new Map<number, BandName>();
const NAME_TO_NUMBER = new Map<BandName, number>();

for (const [value, name] of Object.entries(IRREGULAR)) {
	NUMBER_TO_NAME.set(Number(value), name);
	NAME_TO_NUMBER.set(name, Number(value));
}
for (const [prefix, base, first, last] of ARITHMETIC) {
	for (let index = first; index <= last; index += 1) {
		const name = `${prefix}${index}`;
		NUMBER_TO_NAME.set(base + index, name);
		NAME_TO_NUMBER.set(name, base + index);
	}
}

/** The passthrough spelling for a band value this build does not name. */
const PASSTHROUGH_RE = /^band-(\d+)$/;

/** Decode one `MMModemBand` value. Total: an unknown value round-trips. */
export function bandName(value: number): BandName {
	return NUMBER_TO_NAME.get(value) ?? `band-${value}`;
}

/** Encode one band name. `undefined` for a name this build cannot place. */
export function bandValue(name: BandName): number | undefined {
	const known = NAME_TO_NUMBER.get(name);
	if (known !== undefined) return known;
	const passthrough = PASSTHROUGH_RE.exec(name);
	if (passthrough?.[1] === undefined) return undefined;
	const parsed = Number(passthrough[1]);
	return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** True when this build recognises the name (a `band-<n>` passthrough does not). */
export function isNamedBand(name: BandName): boolean {
	return NAME_TO_NUMBER.has(name);
}

/**
 * Decode a `SupportedBands` / `CurrentBands` property value.
 *
 * Non-numeric members are DROPPED rather than coerced — a malformed member says
 * nothing about the radio, and coercing it would invent a band. `unknown` is
 * dropped for the same reason: MM emits it for "the modem did not say", which is
 * not a band an operator can select.
 */
export function decodeBandList(value: unknown): readonly BandName[] {
	if (!Array.isArray(value)) return [];
	const names: BandName[] = [];
	for (const member of value) {
		if (typeof member !== 'number' || !Number.isSafeInteger(member)) continue;
		const name = bandName(member);
		if (name === BAND_UNKNOWN) continue;
		names.push(name);
	}
	return names;
}

/**
 * Encode a band selection for `SetCurrentBands`.
 *
 * FAILS CLOSED AS A WHOLE. One unplaceable name rejects the entire request
 * rather than silently narrowing the selection: a partial band set is a
 * DIFFERENT lock from the one the operator asked for, and applying it would
 * strand the radio on bands they never chose.
 */
export function encodeBandList(
	names: readonly BandName[],
):
	| { readonly ok: true; readonly values: number[] }
	| { readonly ok: false; readonly unknown: BandName } {
	const values: number[] = [];
	for (const name of names) {
		const value = bandValue(name);
		if (value === undefined) return { ok: false, unknown: name };
		values.push(value);
	}
	return { ok: true, values };
}

/** True when the selection is exactly the reset value (`any`, alone). */
export function isResetSelection(names: readonly BandName[]): boolean {
	return names.length === 1 && names[0] === BAND_ANY;
}
