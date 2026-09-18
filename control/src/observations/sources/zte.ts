// ZTE goform → normalized observation.
//
// One goform response answers many keys at once, so the migrated `parseZteSignal` and
// `parseZteDetails` are both driven from the SAME body here — and everything neither
// of them claims (`wan_lte_ca`, `rmcc`, `lte_pci`, the cell id, the roaming flag) is
// retained verbatim in the diagnostics block. That retention is the point: a
// carrier-aggregation flag no normalized field has a slot for is still the difference
// between a diagnosable report and a shrug.
//
// A body that will not parse is an OBSERVATION whose metrics are `malformed`, not an
// unavailable one. The bytes arrived; what failed was decoding them, and an
// unavailable envelope would have to discard them to say so.

import type { ObservationEnvelope } from '../../domain';
import { parseZteDetails, parseZteSignal } from '../../hardware/router-parsers';
import { freshObservation, metricProvenance, type NormalizationContext } from '../envelope';
import {
	knownMetric,
	metricFromRouterSignal,
	type NormalizedMetric,
	unknownMetric,
} from '../metric';
import type { NormalizedModemObservation } from '../model';
import { createObservationDiagnostics, type ObservationDiagnosticNote } from '../provenance';
import { hasRawField, parseJsonRecord, prefixRawRecord, rawKey } from '../raw';
import {
	type RouterProvenance,
	routerCell,
	routerHardware,
	routerOperator,
	routerSim,
	unsupportedQualityRecent,
	unsupportedRadioMetric,
} from './router-shared';

const SOURCE = 'zte-goform' as const;
const BODY = 'goform';
/** ZTE's own SIM presence code. Named as evidence, never decoded into a presence. */
const SIM_CARD_STATE = rawKey(BODY, 'simcard_state');

export type ZteObservationInput = {
	readonly body: string;
};

export function normalizeZteObservation(
	input: ZteObservationInput,
	context: NormalizationContext,
): ObservationEnvelope<NormalizedModemObservation> {
	const parsed = parseJsonRecord(input.body);
	const raw = prefixRawRecord(BODY, parsed);
	const notes: ObservationDiagnosticNote[] = [];
	if (parsed === undefined) {
		notes.push({ code: input.body.trim() === '' ? 'empty-body' : 'unparseable-body', field: BODY });
	}

	const consumed: string[] = [];
	const provenance: RouterProvenance = (fields, authority) => {
		consumed.push(...fields);
		return authority === undefined
			? metricProvenance(SOURCE, context, fields)
			: metricProvenance(SOURCE, context, fields, authority);
	};

	const signalModel = parseZteSignal(input.body);
	const details = parseZteDetails(input.body);

	return freshObservation<NormalizedModemObservation>(SOURCE, context, {
		source: SOURCE,
		hardware: routerHardware(provenance, undefined),
		radio: {
			modemState: unsupportedRadioMetric(provenance),
			registration: unsupportedRadioMetric(provenance),
			accessTechnologies: unknownMetric('unsupported', provenance([])),
			modeLabel: normalizeModeLabel(details?.network_type, parsed !== undefined, provenance),
			...routerOperator(
				provenance,
				details?.provider === undefined
					? undefined
					: { name: details.provider, field: rawKey(BODY, 'network_provider_fullname') },
			),
		},
		signal: {
			quality: unknownMetric<number>('unsupported', provenance([])),
			qualityRecent: unsupportedQualityRecent(provenance),
			bars: metricFromRouterSignal(
				signalModel.bars,
				provenance([rawKey(BODY, 'signalbar')], 'derived'),
			),
			// The goform payload carries no maximum; the migrated parser states the
			// vendor's fixed five-bar scale, which is a derivation and says so.
			maxBars: metricFromRouterSignal(signalModel.max_bars, provenance([], 'derived')),
			dbm: metricFromRouterSignal(signalModel.dbm, provenance([rawKey(BODY, 'rssi')])),
			rsrp: metricFromRouterSignal(signalModel.rsrp, provenance([rawKey(BODY, 'lte_rsrp')])),
			rsrq: metricFromRouterSignal(signalModel.rsrq, provenance([rawKey(BODY, 'lte_rsrq')])),
			snr: metricFromRouterSignal(signalModel.snr, provenance([rawKey(BODY, 'lte_snr')])),
			sinr: metricFromRouterSignal(signalModel.sinr, provenance([])),
		},
		sim: routerSim(provenance, hasRawField(raw, SIM_CARD_STATE) ? SIM_CARD_STATE : undefined),
		cell: routerCell(
			provenance,
			details?.cell_id === undefined
				? undefined
				: { id: details.cell_id, field: rawKey(BODY, 'cell_id') },
		),
		diagnostics: createObservationDiagnostics({ source: SOURCE, raw, consumed, notes }),
	});
}

function normalizeModeLabel(
	networkType: string | undefined,
	parsed: boolean,
	provenance: RouterProvenance,
): NormalizedMetric<string> {
	const source = provenance([rawKey(BODY, 'network_type')]);
	if (networkType !== undefined) {
		return knownMetric(networkType, source);
	}
	return unknownMetric<string>(parsed ? 'not-reported' : 'malformed', source);
}
