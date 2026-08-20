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
import type { NormalizedModemObservation, SimPresenceValue } from '../model';
import {
	createObservationDiagnostics,
	type ObservationDiagnosticNote,
	type RawFieldRecord,
	type RawFieldValue,
} from '../provenance';
import {
	hasRawField,
	mergeRawRecords,
	prefixRawRecord,
	rawBooleanAt,
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
};

const MODEM = 'Modem';
const MODEM3GPP = 'Modem3gpp';
const SIM = 'Sim';
const SIGNAL = 'Signal';

export function normalizeModemManagerObservation(
	input: ModemManagerObservationInput,
	context: NormalizationContext,
): ObservationEnvelope<NormalizedModemObservation> {
	const raw = mergeRawRecords(
		prefixRawRecord(MODEM, input.modem),
		prefixRawRecord(MODEM3GPP, input.modem3gpp),
		prefixRawRecord(SIM, input.sim),
		prefixRawRecord(SIGNAL, input.signal),
	);
	const notes: ObservationDiagnosticNote[] = [];
	const consumed: string[] = [];
	const provenance = (...fields: readonly string[]) => {
		consumed.push(...fields);
		return metricProvenance(SOURCE, context, fields);
	};

	const hardware = normalizeHardware(raw, provenance);
	const radio = normalizeRadio(raw, provenance, notes);
	const signal = normalizeSignal(raw, input.signal !== undefined, provenance);
	const sim = normalizeSim(raw, input.sim !== undefined, provenance, notes);

	return freshObservation<NormalizedModemObservation>(SOURCE, context, {
		source: SOURCE,
		hardware,
		radio,
		signal,
		sim,
		diagnostics: createObservationDiagnostics({ source: SOURCE, raw, consumed, notes }),
	});
}

type Provenance = (...fields: readonly string[]) => ReturnType<typeof metricProvenance>;

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
const SIM_TYPE = rawKey(SIM, 'SimType');
const ESIM_STATUS = rawKey(SIM, 'EsimStatus');
const RSSI = rawKey(SIGNAL, 'rssi');
const RSRP = rawKey(SIGNAL, 'rsrp');
const RSRQ = rawKey(SIGNAL, 'rsrq');
const SNR = rawKey(SIGNAL, 'snr');

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

function normalizeSignal(raw: RawFieldRecord, signalRead: boolean, provenance: Provenance) {
	const missing = signalRead ? ('not-reported' as const) : ('not-observed' as const);
	const extended = (key: string): NormalizedMetric<number> => {
		const source = provenance(key);
		const value = rawNumber(raw, key);
		return value === undefined
			? unknownMetric<number>(hasRawField(raw, key) ? 'malformed' : missing, source)
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
		// `Modem.Signal` exposes rssi/rsrp/rsrq/snr/ecio/io/rscp — there is no SINR member.
		sinr: unknownMetric<number>('unsupported', metricProvenanceEmpty(provenance)),
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
