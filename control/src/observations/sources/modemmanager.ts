// ModemManager → normalized observation.
//
// Every decode here is the MIGRATED logic (`domain/mm-enums.ts`,
// `domain/modem-presentation.ts`, `hardware/router-parsers.ts` for SIM presence) —
// this module adds provenance and reason-carrying unknowns, and decodes nothing
// itself. Where a decoder answers `'unknown'` or `undefined`, the distinction it
// cannot make is made here from the RAW record: a field that was never in the payload
// is `not-reported`, an interface nobody read is `not-observed`, and a field that WAS
// present but decoded to nothing is `malformed` with a diagnostic note. Collapsing
// those three into one absent value is precisely the loss this layer exists to stop.

import {
	decode3gppLacCi,
	decodeEsimStatus,
	decodeMmAccessTechnologies,
	decodeMmState,
	decodeRegistrationState,
	decodeSimType,
	decodeStateFailedReason,
	decodeUnlockRequired,
	type ModemHardwareIdentity,
	modeMaskToLabel,
	modemHardwareLabel,
	modemHardwareName,
	type ObservationEnvelope,
	type RadioAccessTechnology,
} from '../../domain';
import { readSimPresence, type SimPresenceFacts } from '../../hardware/router-parsers';
import { freshObservation, metricProvenance, type NormalizationContext } from '../envelope';
import { knownMetric, type NormalizedMetric, unknownMetric } from '../metric';
import type { NormalizedCell, NormalizedModemObservation, SimPresenceValue } from '../model';
import {
	createObservationDiagnostics,
	type ObservationDiagnosticNote,
	type RawFieldRecord,
	type RawFieldValue,
} from '../provenance';
import {
	hasRawDictMember,
	hasRawField,
	mergeRawRecords,
	prefixRawRecord,
	rawBooleanAt,
	rawDictNumber,
	rawKey,
	rawNumber,
	rawNumberAt,
	rawString,
	rawStringArray,
} from '../raw';

const SOURCE = 'modemmanager' as const;

/**
 * The decoded ModemManager property records, one per D-Bus interface.
 *
 * A body left out is a body nobody read, and reads as `not-observed` rather than as a
 * modem that reports nothing — that difference decides whether a consumer retries or
 * hides a control.
 */
export type ModemManagerObservationInput = {
	readonly modem?: Readonly<Record<string, RawFieldValue>>;
	readonly modem3gpp?: Readonly<Record<string, RawFieldValue>>;
	readonly sim?: Readonly<Record<string, RawFieldValue>>;
	readonly signal?: Readonly<Record<string, RawFieldValue>>;
	/**
	 * The `Modem.Location` reading, keyed by DECODED SOURCE NAME (`3gpp-lac-ci`).
	 *
	 * On the wire that property is an `a{uv}` keyed by the `MMModemLocationSource` BIT,
	 * and the bit-to-name vocabulary lives in `backend/mm-location.ts`. Naming the
	 * source here instead keeps this layer reading a flat named field like every other
	 * body, and keeps exactly one copy of that vocabulary.
	 *
	 * Supplying it enables nothing. A location SOURCE is switched on by
	 * `Location.Setup`, which this layer never calls; reading a value that is already
	 * being reported is a normalization step. `3gpp-lac-ci` in particular is coarse cell
	 * context rather than a GNSS fix, so it stays outside `GNSS_SOURCES` and the GNSS
	 * enable/disable path is untouched by it.
	 *
	 * NOTHING SUPPLIES IT TODAY, and the reason is the fence rather than an oversight.
	 * ModemManager masks the `Location` PROPERTY unless `Location.Setup` was called with
	 * `signal_location = true` — which broadcasts the value over `PropertiesChanged` and
	 * is therefore permanently forbidden here (`backend/mm-location.ts`). The value has
	 * to come from an explicit `GetLocation()` call instead, and the provider's snapshot
	 * path makes no such call. So an MM observation reads `not-observed` for `cell`:
	 * nobody looked, which is the honest answer and is distinct from a modem that
	 * reported nothing. Cell identity that IS wired today comes from `Modem.GetCellInfo`
	 * through `backend/cell-info.ts`, a different method that needs no location source.
	 */
	readonly location?: Readonly<Record<string, RawFieldValue>>;
};

const MODEM = 'Modem';
const MODEM3GPP = 'Modem3gpp';
const SIM = 'Sim';
const SIGNAL = 'Signal';
const LOCATION = 'Location';

export function normalizeModemManagerObservation(
	input: ModemManagerObservationInput,
	context: NormalizationContext,
): ObservationEnvelope<NormalizedModemObservation> {
	const raw = mergeRawRecords(
		prefixRawRecord(MODEM, input.modem),
		prefixRawRecord(MODEM3GPP, input.modem3gpp),
		prefixRawRecord(SIM, input.sim),
		prefixRawRecord(SIGNAL, input.signal),
		prefixRawRecord(LOCATION, input.location),
	);
	const notes: ObservationDiagnosticNote[] = [];
	const consumed: string[] = [];
	const provenance = (...fields: readonly string[]) => {
		consumed.push(...fields);
		return metricProvenance(SOURCE, context, fields);
	};

	// A dict-sourced metric CONSUMES the whole `a{sv}` property (that is the raw key it
	// actually has) while NAMING the exact member it read, so provenance stays precise
	// without `unmapped` gaining a key that was never in the payload.
	const dictProvenance = (dict: string, member: string) => {
		consumed.push(dict);
		return metricProvenance(SOURCE, context, [`${dict}.${member}`]);
	};

	const hardware = normalizeHardware(raw, provenance);
	const radio = normalizeRadio(raw, provenance, notes);
	const signal = normalizeSignal(
		raw,
		input.signal !== undefined,
		provenance,
		dictProvenance,
		notes,
	);
	const sim = normalizeSim(raw, input.sim !== undefined, provenance, notes);
	const cell = normalizeCell(raw, input.location !== undefined, provenance, notes);

	return freshObservation<NormalizedModemObservation>(SOURCE, context, {
		source: SOURCE,
		hardware,
		radio,
		signal,
		sim,
		cell,
		diagnostics: createObservationDiagnostics({ source: SOURCE, raw, consumed, notes }),
	});
}

type Provenance = (...fields: readonly string[]) => ReturnType<typeof metricProvenance>;
type DictProvenance = (dict: string, member: string) => ReturnType<typeof metricProvenance>;

const MODEL = rawKey(MODEM, 'Model');
const MANUFACTURER = rawKey(MODEM, 'Manufacturer');
const REVISION = rawKey(MODEM, 'Revision');
const EQUIPMENT_ID = rawKey(MODEM, 'EquipmentIdentifier');
const STATE = rawKey(MODEM, 'State');
const CURRENT_MODES = rawKey(MODEM, 'CurrentModes');
const ACCESS_TECHNOLOGIES = rawKey(MODEM, 'AccessTechnologies');
const SIGNAL_QUALITY = rawKey(MODEM, 'SignalQuality');
const SIM_PATH = rawKey(MODEM, 'Sim');
const SIM_SLOTS = rawKey(MODEM, 'SimSlots');
const FAILED_REASON = rawKey(MODEM, 'StateFailedReason');
const UNLOCK_REQUIRED = rawKey(MODEM, 'UnlockRequired');
const REGISTRATION_STATE = rawKey(MODEM3GPP, 'RegistrationState');
const OPERATOR_NAME = rawKey(MODEM3GPP, 'OperatorName');
const OPERATOR_CODE = rawKey(MODEM3GPP, 'OperatorCode');
const SIM_TYPE = rawKey(SIM, 'SimType');
const ESIM_STATUS = rawKey(SIM, 'EsimStatus');
// The `Modem.Location` entry for MM's coarse-cell source. Named, not bit-keyed — see
// `ModemManagerObservationInput.location`.
const LAC_CI = rawKey(LOCATION, '3gpp-lac-ci');

// `Modem.Signal` publishes ONE `a{sv}` per RAT, and the member sets differ (MM 1.24.2
// `org.freedesktop.ModemManager1.Modem.Signal.xml`):
//   Cdma rssi/ecio/error-rate       Evdo rssi/ecio/SINR/io/error-rate
//   Gsm  rssi/error-rate            Umts rssi/rscp/ecio/error-rate
//   Lte  rssi/rsrq/rsrp/snr/error-rate    Nr5g rsrq/rsrp/snr/error-rate
const SIGNAL_CDMA = rawKey(SIGNAL, 'Cdma');
const SIGNAL_EVDO = rawKey(SIGNAL, 'Evdo');
const SIGNAL_GSM = rawKey(SIGNAL, 'Gsm');
const SIGNAL_UMTS = rawKey(SIGNAL, 'Umts');
const SIGNAL_LTE = rawKey(SIGNAL, 'Lte');
const SIGNAL_NR5G = rawKey(SIGNAL, 'Nr5g');

/**
 * Where one extended metric may be claimed from, in order.
 *
 * `dicts` is the RAT ladder, NEWEST FIRST: on an NSA attach both `Nr5g` and `Lte` are
 * populated with genuinely different measurements (the NR leg and the LTE anchor), so
 * one of them has to be the reported reading — and `rawFields` names WHICH, rather than
 * leaving a consumer to guess. Nothing is lost either way: every dict stays verbatim in
 * the diagnostics block. `flat` is the mmcli-flattened spelling of the same datum, kept
 * for the same reason `rawStructMember` answers at index 0 for a flattened struct.
 */
type ExtendedSignalMetric = {
	readonly member: string;
	readonly dicts: readonly string[];
	readonly flat: string;
};

const RSSI: ExtendedSignalMetric = {
	member: 'rssi',
	dicts: [SIGNAL_LTE, SIGNAL_UMTS, SIGNAL_GSM, SIGNAL_EVDO, SIGNAL_CDMA],
	flat: rawKey(SIGNAL, 'rssi'),
};
const RSRP: ExtendedSignalMetric = {
	member: 'rsrp',
	dicts: [SIGNAL_NR5G, SIGNAL_LTE],
	flat: rawKey(SIGNAL, 'rsrp'),
};
const RSRQ: ExtendedSignalMetric = {
	member: 'rsrq',
	dicts: [SIGNAL_NR5G, SIGNAL_LTE],
	flat: rawKey(SIGNAL, 'rsrq'),
};
const SNR: ExtendedSignalMetric = {
	member: 'snr',
	dicts: [SIGNAL_NR5G, SIGNAL_LTE],
	flat: rawKey(SIGNAL, 'snr'),
};
// SINR is a member of the `Evdo` dict and of NO other, so an LTE/NR modem reporting no
// SINR is a READ-class `not-reported` — ModemManager CAN express it, this modem did not.
// The NR SINR a device may publish through `Modem.GetCellInfo` is a different call on a
// different interface and is deliberately not folded in here.
const SINR: ExtendedSignalMetric = {
	member: 'sinr',
	dicts: [SIGNAL_EVDO],
	flat: rawKey(SIGNAL, 'sinr'),
};

function hardwareIdentity(raw: RawFieldRecord): ModemHardwareIdentity {
	const model = rawString(raw, MODEL);
	const manufacturer = rawString(raw, MANUFACTURER);
	const firmwareRevision = rawString(raw, REVISION);
	const equipmentId = rawString(raw, EQUIPMENT_ID);
	return {
		...(model === undefined ? {} : { model }),
		...(manufacturer === undefined ? {} : { manufacturer }),
		...(firmwareRevision === undefined ? {} : { firmwareRevision }),
		...(equipmentId === undefined ? {} : { equipmentId }),
	};
}

function normalizeHardware(raw: RawFieldRecord, provenance: Provenance) {
	const identity = hardwareIdentity(raw);
	const named =
		identity.model !== undefined ||
		identity.manufacturer !== undefined ||
		identity.firmwareRevision !== undefined;
	const labelProvenance = provenance(MODEL, MANUFACTURER, REVISION);
	const nameProvenance = provenance(MODEL, MANUFACTURER, REVISION, EQUIPMENT_ID);
	return {
		label: named
			? knownMetric(modemHardwareLabel(identity), labelProvenance)
			: unknownMetric<string>('not-reported', labelProvenance),
		displayName: named
			? knownMetric(modemHardwareName(identity), nameProvenance)
			: unknownMetric<string>('not-reported', nameProvenance),
	};
}

function normalizeRadio(
	raw: RawFieldRecord,
	provenance: Provenance,
	notes: ObservationDiagnosticNote[],
) {
	return {
		modemState: decodedLabel(raw, STATE, decodeMmState, provenance, notes),
		registration: decodedLabel(raw, REGISTRATION_STATE, decodeRegistrationState, provenance, notes),
		accessTechnologies: normalizeAccessTechnologies(raw, provenance, notes),
		modeLabel: normalizeModeLabel(raw, provenance, notes),
		// `Modem3gpp`, never `Sim` — the registered operator, not the SIM's home one.
		// A modem that is not registered reports these empty, which is `not-reported`:
		// the property exists and this read carried no value.
		operatorName: registrationString(raw, OPERATOR_NAME, provenance),
		operatorCode: registrationString(raw, OPERATOR_CODE, provenance),
	};
}

/** A `Modem3gpp` registration string — present-and-empty is still no reading. */
function registrationString(
	raw: RawFieldRecord,
	key: string,
	provenance: Provenance,
): NormalizedMetric<string> {
	const source = provenance(key);
	const value = rawString(raw, key);
	return value === undefined
		? unknownMetric<string>('not-reported', source)
		: knownMetric(value, source);
}

/**
 * Coarse cell context from the `3gpp-lac-ci` location reading.
 *
 * The whole value is ONE string, so a `cellId` and a `tac` read out of it necessarily
 * agree with each other — they came from the same reported cell, never from two reads
 * that raced. A value in an unrecognized shape is `malformed` for both rather than
 * partially decoded; see `decode3gppLacCi`.
 */
function normalizeCell(
	raw: RawFieldRecord,
	locationRead: boolean,
	provenance: Provenance,
	notes: ObservationDiagnosticNote[],
): NormalizedCell {
	const source = provenance(LAC_CI);
	if (!hasRawField(raw, LAC_CI)) {
		const reason = locationRead ? ('not-reported' as const) : ('not-observed' as const);
		return {
			cellId: unknownMetric<string>(reason, source),
			tac: unknownMetric<string>(reason, source),
		};
	}
	const decoded = decode3gppLacCi(rawString(raw, LAC_CI));
	if (decoded === undefined) {
		notes.push({ code: 'field-shape-unrecognized', field: LAC_CI });
		return {
			cellId: unknownMetric<string>('malformed', source),
			tac: unknownMetric<string>('malformed', source),
		};
	}
	return {
		cellId: knownMetric(decoded.cellId, source),
		// MM emits an EMPTY tracking-area code on a device with no LTE/NR attach — the
		// reading arrived, this field of it did not.
		tac:
			decoded.trackingAreaCode === ''
				? unknownMetric<string>('not-reported', source)
				: knownMetric(decoded.trackingAreaCode, source),
	};
}

/** A decoder whose "I could not place this" answer is the literal string `unknown`. */
function decodedLabel(
	raw: RawFieldRecord,
	key: string,
	decode: (value: number | undefined) => string,
	provenance: Provenance,
	notes: ObservationDiagnosticNote[],
): NormalizedMetric<string> {
	const source = provenance(key);
	if (!hasRawField(raw, key)) {
		return unknownMetric<string>('not-reported', source);
	}
	const decoded = decode(rawNumber(raw, key));
	if (decoded === 'unknown') {
		notes.push({ code: 'field-shape-unrecognized', field: key });
		return unknownMetric<string>('malformed', source);
	}
	return knownMetric(decoded, source);
}

function normalizeAccessTechnologies(
	raw: RawFieldRecord,
	provenance: Provenance,
	notes: ObservationDiagnosticNote[],
): NormalizedMetric<readonly RadioAccessTechnology[]> {
	const source = provenance(ACCESS_TECHNOLOGIES);
	if (!hasRawField(raw, ACCESS_TECHNOLOGIES)) {
		return unknownMetric<readonly RadioAccessTechnology[]>('not-reported', source);
	}
	const mask = rawNumber(raw, ACCESS_TECHNOLOGIES);
	// MM's 0 is `UNKNOWN` — the modem did not say, which is not a malformed answer.
	if (mask === undefined || mask <= 0) {
		return unknownMetric<readonly RadioAccessTechnology[]>('not-reported', source);
	}
	const decoded = [...decodeMmAccessTechnologies(mask)].sort();
	if (decoded.length === 0) {
		notes.push({ code: 'field-shape-unrecognized', field: ACCESS_TECHNOLOGIES });
		return unknownMetric<readonly RadioAccessTechnology[]>('malformed', source);
	}
	return knownMetric<readonly RadioAccessTechnology[]>(decoded, source);
}

function normalizeModeLabel(
	raw: RawFieldRecord,
	provenance: Provenance,
	notes: ObservationDiagnosticNote[],
): NormalizedMetric<string> {
	const source = provenance(CURRENT_MODES);
	if (!hasRawField(raw, CURRENT_MODES)) {
		return unknownMetric<string>('not-reported', source);
	}
	// `CurrentModes` is a `(uu)`; the ALLOWED mask is member 0. A flattened scalar
	// (mmcli's shape) decodes at the same index, so both retentions work here.
	const mask = rawNumberAt(raw, CURRENT_MODES, 0);
	if (mask === undefined || mask <= 0) {
		return unknownMetric<string>('not-reported', source);
	}
	const label = modeMaskToLabel(mask);
	if (label === undefined) {
		notes.push({ code: 'field-shape-unrecognized', field: CURRENT_MODES });
		return unknownMetric<string>('malformed', source);
	}
	return knownMetric(label, source);
}

function normalizeSignal(
	raw: RawFieldRecord,
	signalRead: boolean,
	provenance: Provenance,
	dictProvenance: DictProvenance,
	notes: ObservationDiagnosticNote[],
) {
	const missing = signalRead ? ('not-reported' as const) : ('not-observed' as const);
	const extended = (metric: ExtendedSignalMetric): NormalizedMetric<number> => {
		for (const dict of metric.dicts) {
			if (!hasRawDictMember(raw, dict, metric.member)) continue;
			const source = dictProvenance(dict, metric.member);
			const value = rawDictNumber(raw, dict, metric.member);
			if (value === undefined) {
				notes.push({ code: 'field-shape-unrecognized', field: `${dict}.${metric.member}` });
				return unknownMetric<number>('malformed', source);
			}
			return knownMetric(value, source);
		}
		const source = provenance(metric.flat);
		const value = rawNumber(raw, metric.flat);
		return value === undefined
			? unknownMetric<number>(hasRawField(raw, metric.flat) ? 'malformed' : missing, source)
			: knownMetric(value, source);
	};
	// `SignalQuality` is a `(ub)`: percentage at 0, "measured recently" at 1. Both are
	// claimed; a source that retained only the percentage answers `not-reported` for the
	// flag, which is a claim about the READ, never about ModemManager's capability.
	const quality = rawNumberAt(raw, SIGNAL_QUALITY, 0);
	const recent = rawBooleanAt(raw, SIGNAL_QUALITY, 1);
	const qualityProvenance = provenance(SIGNAL_QUALITY);
	return {
		quality:
			quality === undefined
				? unknownMetric<number>('not-reported', qualityProvenance)
				: knownMetric(quality, qualityProvenance),
		qualityRecent:
			recent === undefined
				? unknownMetric<boolean>('not-reported', provenance(SIGNAL_QUALITY))
				: knownMetric(recent, provenance(SIGNAL_QUALITY)),
		// ModemManager reports a percentage and no bar scale. Deriving bars from the
		// percentage would be inventing a reading, so this is a capability claim.
		bars: unknownMetric<number>('unsupported', metricProvenanceEmpty(provenance)),
		maxBars: unknownMetric<number>('unsupported', metricProvenanceEmpty(provenance)),
		dbm: extended(RSSI),
		rsrp: extended(RSRP),
		rsrq: extended(RSRQ),
		snr: extended(SNR),
		sinr: extended(SINR),
	};
}

/** Provenance for a metric no raw field backs, which is what `unsupported` means. */
function metricProvenanceEmpty(provenance: Provenance) {
	return provenance();
}

/**
 * `Modem.StateFailedReason` in the spelling the presence rule matches.
 *
 * D-Bus types it `u`, so a provider retaining the property verbatim holds a NUMBER,
 * while the migrated rule matches the mmcli STRING. Both are accepted here — the
 * number through the enum decoder, the string as it stands — because the two transports
 * for the same fact must not disagree about whether a modem has a SIM. An
 * unrecognized number decodes to `undefined` and simply proves nothing.
 */
function failedReasonOf(raw: RawFieldRecord): string | undefined {
	const numeric = rawNumber(raw, FAILED_REASON);
	if (numeric !== undefined) return decodeStateFailedReason(numeric);
	return rawString(raw, FAILED_REASON);
}

function simPresenceFacts(raw: RawFieldRecord): SimPresenceFacts {
	const sim = rawString(raw, SIM_PATH);
	const simSlots = rawStringArray(raw, SIM_SLOTS);
	const failedReason = failedReasonOf(raw);
	return {
		...(sim === undefined ? {} : { sim }),
		...(simSlots === undefined ? {} : { simSlots }),
		...(failedReason === undefined ? {} : { failedReason }),
	};
}

function normalizeSim(
	raw: RawFieldRecord,
	simRead: boolean,
	provenance: Provenance,
	notes: ObservationDiagnosticNote[],
) {
	const presenceProvenance = provenance(SIM_PATH, SIM_SLOTS, FAILED_REASON);
	// `absent` here comes from `state-failed-reason` evidence and from nothing else.
	// A blank `Sim` object path with no failure reason stays `unknown`: ModemManager
	// reports `/` while a modem is initializing and while a slot switch is in flight,
	// so reading it as "no SIM" would report an absent SIM on a modem holding one.
	const { presence, evidence } = readSimPresence(simPresenceFacts(raw));
	const missing = simRead ? ('not-reported' as const) : ('not-observed' as const);
	return {
		presence:
			presence === 'unknown'
				? unknownMetric<SimPresenceValue>('not-reported', presenceProvenance)
				: knownMetric<SimPresenceValue>(presence, presenceProvenance),
		presenceEvidence: evidence,
		lockRequired: decodedOptional(raw, UNLOCK_REQUIRED, decodeUnlockRequired, provenance, notes),
		kind: decodedOptional(raw, SIM_TYPE, decodeSimType, provenance, notes, missing),
		esimStatus: decodedOptional(raw, ESIM_STATUS, decodeEsimStatus, provenance, notes, missing),
	};
}

/** A decoder whose "I could not place this" answer is `undefined`. */
function decodedOptional<T>(
	raw: RawFieldRecord,
	key: string,
	decode: (value: number | undefined) => T | undefined,
	provenance: Provenance,
	notes: ObservationDiagnosticNote[],
	absentReason: 'not-reported' | 'not-observed' = 'not-reported',
): NormalizedMetric<T> {
	const source = provenance(key);
	if (!hasRawField(raw, key)) {
		return unknownMetric<T>(absentReason, source);
	}
	const decoded = decode(rawNumber(raw, key));
	if (decoded === undefined) {
		notes.push({ code: 'field-shape-unrecognized', field: key });
		return unknownMetric<T>('malformed', source);
	}
	return knownMetric(decoded, source);
}
