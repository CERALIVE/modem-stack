// Qualcomm UFI / HIMI → normalized observation.
//
// UFI answers three endpoints per read, each an envelope of its own (`{reply, params}`),
// and the migrated `parseUfiSignal` already folds them in the vendor's own precedence
// order. This module keeps all three bodies verbatim — including the `reply` field,
// which is how a `SessionOut` refusal is told apart from a body that simply lacked the
// key — and reports the ONE signal reading the source actually provides.
//
// Its overview endpoint returns an IMSI and an ICCID. They are retained, because
// normalization does not get to decide what a diagnostician may need, and they are
// masked by the shared key-based redactor on the way to anything that renders. That
// split — retain here, redact at the boundary — is why `raw` is documented as a
// redaction-class surface rather than as safe-by-default data.

import type { ObservationEnvelope } from '../../domain';
import { parseUfiDetails, parseUfiSignal } from '../../hardware/router-parsers';
import { freshObservation, metricProvenance, type NormalizationContext } from '../envelope';
import { metricFromRouterSignal, unknownMetric } from '../metric';
import type { NormalizedModemObservation } from '../model';
import {
	createObservationDiagnostics,
	type ObservationDiagnosticNote,
	type RawFieldValue,
} from '../provenance';
import {
	hasRawField,
	mergeRawRecords,
	normalizeRawValue,
	parseJsonObject,
	prefixRawRecord,
	rawKey,
} from '../raw';
import {
	type RouterProvenance,
	routerHardware,
	routerSim,
	unsupportedQualityRecent,
	unsupportedRadioMetric,
} from './router-shared';

const SOURCE = 'ufi-himiapi' as const;
const SYSINFO = 'sysinfo';
const OVERVIEW = 'overview';
const STATUS = 'status';
const PRODUCE_INFO = 'produce-info';
const SESSION_REFUSAL = 'SessionOut';
/** HIMI's own SIM presence code. Named as evidence, never decoded into a presence. */
const SIM_STATE = rawKey(SYSINFO, 'simstate');

export type UfiObservationInput = {
	readonly sysinfo: string;
	readonly overview: string;
	readonly status: string;
	readonly produceInfo?: string;
};

export function normalizeUfiObservation(
	input: UfiObservationInput,
	context: NormalizationContext,
): ObservationEnvelope<NormalizedModemObservation> {
	const bodies = [
		[SYSINFO, input.sysinfo],
		[OVERVIEW, input.overview],
		[STATUS, input.status],
		[PRODUCE_INFO, input.produceInfo ?? ''],
	] as const;

	const notes: ObservationDiagnosticNote[] = [];
	const records = bodies.map(([name, text]) => {
		const parsed = parseJsonObject(text);
		if (parsed === undefined && text.trim() !== '') {
			notes.push({ code: 'unparseable-body', field: name });
		}
		if (parsed?.reply === SESSION_REFUSAL) {
			notes.push({ code: 'auth-expired', field: rawKey(name, 'reply') });
		}
		return prefixRawRecord(name, flattenUfiEnvelope(parsed));
	});

	const raw = mergeRawRecords(...records);
	const consumed: string[] = [];
	const provenance: RouterProvenance = (fields, authority) => {
		consumed.push(...fields);
		return authority === undefined
			? metricProvenance(SOURCE, context, fields)
			: metricProvenance(SOURCE, context, fields, authority);
	};

	const signalModel = parseUfiSignal({
		sysinfo: input.sysinfo,
		overview: input.overview,
		status: input.status,
	});
	const details = parseUfiDetails({
		overview: input.overview,
		sysinfo: input.sysinfo,
		...(input.produceInfo === undefined ? {} : { produceInfo: input.produceInfo }),
	});
	const product = details?.product;

	return freshObservation<NormalizedModemObservation>(SOURCE, context, {
		source: SOURCE,
		hardware: routerHardware(
			provenance,
			product === undefined
				? undefined
				: { name: product, field: rawKey(PRODUCE_INFO, 'productname') },
		),
		radio: {
			modemState: unsupportedRadioMetric(provenance),
			registration: unsupportedRadioMetric(provenance),
			accessTechnologies: unknownMetric('unsupported', provenance([])),
			modeLabel: unknownMetric<string>('not-reported', provenance([])),
		},
		signal: {
			quality: unknownMetric<number>('unsupported', provenance([])),
			qualityRecent: unsupportedQualityRecent(provenance),
			bars: metricFromRouterSignal(signalModel.bars, provenance([])),
			maxBars: metricFromRouterSignal(signalModel.max_bars, provenance([])),
			dbm: metricFromRouterSignal(
				signalModel.dbm,
				provenance([
					rawKey(SYSINFO, 'SIGNAL'),
					rawKey(OVERVIEW, 'SIGNAL'),
					rawKey(STATUS, 'signalStrength'),
				]),
			),
			rsrp: metricFromRouterSignal(signalModel.rsrp, provenance([])),
			rsrq: metricFromRouterSignal(signalModel.rsrq, provenance([])),
			snr: metricFromRouterSignal(signalModel.snr, provenance([])),
			sinr: metricFromRouterSignal(signalModel.sinr, provenance([])),
		},
		sim: routerSim(provenance, hasRawField(raw, SIM_STATE) ? SIM_STATE : undefined),
		diagnostics: createObservationDiagnostics({ source: SOURCE, raw, consumed, notes }),
	});
}

/** `{reply, params}` flattened to one level — `params` members keep their own names. */
function flattenUfiEnvelope(
	parsed: Readonly<Record<string, unknown>> | undefined,
): Record<string, RawFieldValue> {
	const out: Record<string, RawFieldValue> = {};
	if (parsed === undefined) {
		return out;
	}
	for (const [key, value] of Object.entries(parsed)) {
		if (key === 'params' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
			for (const [field, param] of Object.entries(value as Record<string, unknown>)) {
				out[field] = normalizeRawValue(param);
			}
			continue;
		}
		out[key] = normalizeRawValue(value);
	}
	return out;
}
