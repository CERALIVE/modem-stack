// Huawei HiLink admin API → normalized observation.
//
// The decoding is the migrated `parseHilinkSignal` / `parseHilinkCapabilities`; this
// module adds provenance, retains both XML bodies field-for-field, and states the
// capability boundary honestly. HiLink is a ROUTER admin API, not a modem stack: it
// has no ModemManager state, no 3GPP registration state and no access-technology
// bitmask, so those read `unsupported` — a claim about this source, which stays true
// on the next poll — while a field the API could carry and did not reads
// `not-reported`.
//
// Its `<ConnectionStatus>` and `<SimStatus>` are NOT folded into `radio.registration`
// or `sim.presence`. They are vendor codes with vendor semantics and no migrated
// decoder claims them, so they stay verbatim in the diagnostics block instead of
// being guessed into a normalized field.

import type { ObservationEnvelope } from '../../domain';
import { parseHilinkCapabilities, parseHilinkSignal } from '../../hardware/router-parsers';
import { freshObservation, metricProvenance, type NormalizationContext } from '../envelope';
import {
	knownMetric,
	metricFromRouterSignal,
	metricUnknownReasonFromRouter,
	type NormalizedMetric,
	unknownMetric,
} from '../metric';
import type { NormalizedModemObservation } from '../model';
import { createObservationDiagnostics, type ObservationDiagnosticNote } from '../provenance';
import { flattenXmlBody, hasRawField, mergeRawRecords, rawKey } from '../raw';
import {
	type RouterProvenance,
	routerHardware,
	routerSim,
	unsupportedQualityRecent,
	unsupportedRadioMetric,
} from './router-shared';

const SOURCE = 'huawei-hilink' as const;
const STATUS = 'monitoring-status';
const SIGNAL = 'device-signal';
const NET_MODE_LIST = 'net-mode-list';
const NET_MODE = 'net-mode';
/** HiLink's own SIM presence code. Named as evidence, never decoded into a presence. */
const SIM_STATUS = rawKey(STATUS, 'SimStatus');

export type HilinkObservationInput = {
	readonly status: string;
	readonly signal: string;
	readonly netModeList?: string;
	readonly netMode?: string;
};

const AUTH_REFUSAL_CODE = '125002';

export function normalizeHilinkObservation(
	input: HilinkObservationInput,
	context: NormalizationContext,
): ObservationEnvelope<NormalizedModemObservation> {
	const raw = mergeRawRecords(
		flattenXmlBody(input.status, STATUS),
		flattenXmlBody(input.signal, SIGNAL),
		flattenXmlBody(input.netModeList ?? '', NET_MODE_LIST),
		flattenXmlBody(input.netMode ?? '', NET_MODE),
	);
	const notes: ObservationDiagnosticNote[] = [];
	const consumed: string[] = [];
	const provenance: RouterProvenance = (fields, authority) => {
		consumed.push(...fields);
		return authority === undefined
			? metricProvenance(SOURCE, context, fields)
			: metricProvenance(SOURCE, context, fields, authority);
	};

	for (const [body, text] of [
		[STATUS, input.status],
		[SIGNAL, input.signal],
	] as const) {
		if (text.includes(`<code>${AUTH_REFUSAL_CODE}</code>`)) {
			notes.push({ code: 'auth-expired', field: rawKey(body, 'code') });
		}
	}

	const signalModel = parseHilinkSignal({ status: input.status, signal: input.signal });
	const capabilities = parseHilinkCapabilities({
		netModeList: input.netModeList ?? '',
		...(input.netMode === undefined ? {} : { netMode: input.netMode }),
	});

	return freshObservation<NormalizedModemObservation>(SOURCE, context, {
		source: SOURCE,
		hardware: routerHardware(provenance, undefined),
		radio: {
			modemState: unsupportedRadioMetric(provenance),
			registration: unsupportedRadioMetric(provenance),
			accessTechnologies: unknownMetric('unsupported', provenance([])),
			modeLabel: normalizeModeLabel(capabilities.net_mode, provenance),
		},
		signal: {
			quality: unknownMetric<number>('unsupported', provenance([])),
			qualityRecent: unsupportedQualityRecent(provenance),
			bars: metricFromRouterSignal(
				signalModel.bars,
				provenance([rawKey(STATUS, 'SignalIcon')], 'derived'),
			),
			maxBars: metricFromRouterSignal(
				signalModel.max_bars,
				provenance([rawKey(STATUS, 'maxsignal')], 'derived'),
			),
			dbm: metricFromRouterSignal(signalModel.dbm, provenance([rawKey(SIGNAL, 'rssi')])),
			rsrp: metricFromRouterSignal(signalModel.rsrp, provenance([rawKey(SIGNAL, 'rsrp')])),
			rsrq: metricFromRouterSignal(signalModel.rsrq, provenance([rawKey(SIGNAL, 'rsrq')])),
			snr: metricFromRouterSignal(signalModel.snr, provenance([])),
			sinr: metricFromRouterSignal(signalModel.sinr, provenance([rawKey(SIGNAL, 'sinr')])),
		},
		sim: routerSim(provenance, hasRawField(raw, SIM_STATUS) ? SIM_STATUS : undefined),
		diagnostics: createObservationDiagnostics({ source: SOURCE, raw, consumed, notes }),
	});
}

function normalizeModeLabel(
	capability: ReturnType<typeof parseHilinkCapabilities>['net_mode'],
	provenance: RouterProvenance,
): NormalizedMetric<string> {
	const source = provenance([rawKey(NET_MODE, 'NetworkMode')]);
	if (capability.state === 'unavailable') {
		return unknownMetric<string>(metricUnknownReasonFromRouter(capability.reason), source);
	}
	return capability.current === undefined
		? unknownMetric<string>('not-reported', source)
		: knownMetric(capability.current, source);
}
