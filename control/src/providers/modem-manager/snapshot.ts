import {
	MODEM_IFACE,
	MODEM_LOCATION_IFACE,
	MODEM3GPP_IFACE,
	MODEM3GPP_USSD_IFACE,
	SIM_IFACE,
} from '../../backend/constants';
import {
	type DecodedManagedObjects,
	type DecodedProps,
	findInterface,
	pathsWithInterface,
	propValue,
} from '../../backend/managed-objects';
import { type BandCertificationEntry, decodeBandList } from '../../band';
import { MESSAGING_IFACE } from '../../capability';
import type { RadioPower } from '../../domain';
import {
	decodeStateFailedReason,
	epochMillis,
	sourceEpoch,
	stableKeyFromPhysicalModemId,
} from '../../domain';
import { readSimPresence } from '../../hardware/router-parsers';
import type { NormalizationContext, RawFieldRecord, RawFieldValue } from '../../observations';
import { normalizeModemManagerObservation } from '../../observations';
import { describeBandWriteCertification, readRadioModeTruth } from '../../radio';
import type { DbusValue } from '../../transport';
import type { ProviderExecutionContext } from '../contracts';
import type {
	ModemManagerCapabilities,
	ModemManagerProviderSnapshot,
	ModemManagerRadioState,
	ModemManagerSignalState,
	ModemManagerSimState,
} from './types';

const SIGNAL_IFACE = `${MODEM_IFACE}.Signal`;

function rawValue(value: DbusValue): RawFieldValue | undefined {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
		return value;
	if (Array.isArray(value)) {
		const result: RawFieldValue[] = [];
		for (const item of value) {
			const decoded = rawValue(item);
			if (decoded !== undefined) result.push(decoded);
		}
		return result;
	}
	return undefined;
}

function propsRecord(props: DecodedProps | undefined): RawFieldRecord | undefined {
	if (props === undefined) return undefined;
	const record: Record<string, RawFieldValue> = {};
	for (const [name, wrapped] of props) {
		const decoded = rawValue(wrapped.value);
		if (decoded !== undefined) record[name] = decoded;
	}
	return record;
}

function tuple(value: DbusValue | undefined): readonly [number, number] {
	if (!Array.isArray(value)) return [0, 0];
	const allowed = value[0];
	const preferred = value[1];
	return [typeof allowed === 'number' ? allowed : 0, typeof preferred === 'number' ? preferred : 0];
}

function modePairs(value: DbusValue | undefined): ModemManagerRadioState['supported'] {
	if (!Array.isArray(value)) return [];
	const result: { allowed: number; preferred: number }[] = [];
	for (const candidate of value) {
		const [allowed, preferred] = tuple(candidate);
		if (allowed > 0) result.push({ allowed, preferred });
	}
	return result;
}

/**
 * A `DbusValue` as the retention layer keeps it.
 *
 * `rawValue` already produces exactly this for a struct (an array of its members), so
 * `SupportedModes` and `CurrentModes` reach the verbatim decoder in the same shape the
 * diagnostics block retains — one representation, so the two cannot disagree.
 */
function structValue(value: DbusValue | undefined): unknown {
	return value === undefined ? undefined : rawValue(value);
}

function signalState(
	modem: DecodedProps,
	signal: DecodedProps | undefined,
): ModemManagerSignalState {
	const quality = tuple(propValue(modem, 'SignalQuality'));
	return {
		...(quality[0] >= 0 ? { quality: quality[0] } : {}),
		...(Array.isArray(propValue(modem, 'SignalQuality')) ? { recent: quality[1] !== 0 } : {}),
		extendedAvailable: signal !== undefined,
	};
}

function simState(tree: DecodedManagedObjects, modem: DecodedProps): ModemManagerSimState {
	const activePath = propValue(modem, 'Sim');
	const slots = propValue(modem, 'SimSlots');
	const paths = Array.isArray(slots)
		? slots.filter((value): value is string => typeof value === 'string' && value !== '/')
		: [];
	const active =
		typeof activePath === 'string' ? findInterface(tree, activePath, SIM_IFACE) : undefined;
	const lockRequired = propValue(modem, 'UnlockRequired');
	const rawFailedReason = propValue(modem, 'StateFailedReason');
	const failedReason =
		typeof rawFailedReason === 'number'
			? decodeStateFailedReason(rawFailedReason)
			: typeof rawFailedReason === 'string'
				? rawFailedReason
				: undefined;
	const primarySlot = propValue(modem, 'PrimarySimSlot');
	const simType = propValue(active, 'SimType');
	const esimStatus = propValue(active, 'EsimStatus');
	const reading = readSimPresence({
		...(typeof activePath === 'string' ? { sim: activePath } : {}),
		...(paths.length > 0 ? { simSlots: paths } : {}),
		...(failedReason === undefined ? {} : { failedReason }),
	});
	return {
		// POSITIVE evidence only: an exported SIM object path proves a SIM. Its ABSENCE
		// proves nothing — `presence` below is the answer to "is there a SIM", and it
		// says `unknown` unless the modem stated `sim-missing` itself.
		present: typeof activePath === 'string' && activePath !== '/',
		presence: reading.presence,
		presenceEvidence: reading.evidence,
		slotCount: paths.length,
		primarySlot: typeof primarySlot === 'number' ? primarySlot : 0,
		...(typeof lockRequired === 'number' ? { lockRequired } : {}),
		...(typeof simType === 'number' ? { simType } : {}),
		...(typeof esimStatus === 'number' ? { esimStatus } : {}),
	};
}

function radioPower(value: DbusValue | undefined): RadioPower {
	switch (value) {
		case 1:
			return 'off';
		case 2:
			return 'low';
		case 3:
			return 'on';
		default:
			return 'unknown';
	}
}

function hasProperty(props: DecodedProps, name: string): boolean {
	return props.some(([property]) => property === name);
}

function findModemPath(
	tree: DecodedManagedObjects,
	context: ProviderExecutionContext,
): string | undefined {
	const [kind, ...parts] = String(context.physicalModemId).split(':');
	const expected = parts.join(':');
	for (const path of pathsWithInterface(tree, MODEM_IFACE)) {
		const modem = findInterface(tree, path, MODEM_IFACE);
		const candidates =
			kind === 'serial'
				? [propValue(modem, 'DeviceIdentifier')]
				: [propValue(modem, 'Device'), propValue(modem, 'Physdev')];
		if (candidates.some((candidate) => candidate === expected)) return path;
	}
	return undefined;
}

export function buildModemManagerSnapshot(
	tree: DecodedManagedObjects,
	context: ProviderExecutionContext,
	now: () => number,
	epoch: number,
	bandCertificationEntry: BandCertificationEntry | undefined,
): ModemManagerProviderSnapshot | undefined {
	const modemPath = findModemPath(tree, context);
	if (modemPath === undefined) return undefined;
	const modem = findInterface(tree, modemPath, MODEM_IFACE);
	if (modem === undefined) return undefined;
	const modem3gpp = findInterface(tree, modemPath, MODEM3GPP_IFACE);
	const signal = findInterface(tree, modemPath, SIGNAL_IFACE);
	const activePath = propValue(modem, 'Sim');
	const sim =
		typeof activePath === 'string' ? findInterface(tree, activePath, SIM_IFACE) : undefined;
	const interfaces = tree.find(([path]) => path === modemPath)?.[1] ?? [];
	const interfaceNames = new Set(interfaces.map(([name]) => name));
	const slots = propValue(modem, 'SimSlots');
	const bandCertification = describeBandWriteCertification({
		entry: bandCertificationEntry,
		supported: decodeBandList(propValue(modem, 'SupportedBands')),
	});
	const capabilities: ModemManagerCapabilities = {
		modeRead: hasProperty(modem, 'CurrentModes'),
		modeWrite: hasProperty(modem, 'CurrentModes'),
		bandRead: hasProperty(modem, 'SupportedBands'),
		bandWrite:
			hasProperty(modem, 'SupportedBands') &&
			bandCertification.satisfied &&
			bandCertification.offerable.length > 0,
		signalRead: hasProperty(modem, 'SignalQuality') || signal !== undefined,
		simRead: hasProperty(modem, 'Sim') || hasProperty(modem, 'SimSlots'),
		multiSim: Array.isArray(slots) && slots.filter((entry) => entry !== '/').length > 1,
		location: interfaceNames.has(MODEM_LOCATION_IFACE),
		sms: interfaceNames.has(MESSAGING_IFACE),
		ussd: interfaceNames.has(MODEM3GPP_USSD_IFACE),
		powerRead: hasProperty(modem, 'PowerState'),
	};
	const [allowed, preferred] = tuple(propValue(modem, 'CurrentModes'));
	const modeTruth = readRadioModeTruth({
		currentModes: structValue(propValue(modem, 'CurrentModes')),
		supportedModes: structValue(propValue(modem, 'SupportedModes')),
	});
	const normalizationContext: NormalizationContext = {
		stableKey: stableKeyFromPhysicalModemId(context.physicalModemId),
		generation: context.generation,
		sourceEpoch: sourceEpoch(epoch),
		observedAt: epochMillis(now()),
	};
	// The struct properties are handed to normalization VERBATIM — `CurrentModes` as its
	// `(uu)` pair, `SignalQuality` as its `(ub)` pair. Flattening them here (which this
	// did) kept the first member and dropped the preferred mode and the recency flag
	// before the diagnostics block ever saw them, which is a drop no downstream layer
	// can undo. The normalizer reads either shape.
	const modemRaw = propsRecord(modem) ?? {};
	return {
		modemPath,
		capabilities,
		bandCertification,
		radio: {
			current: { allowed, preferred },
			supported: modePairs(propValue(modem, 'SupportedModes')),
			truth: modeTruth,
		},
		signal: signalState(modem, signal),
		sim: simState(tree, modem),
		power: radioPower(propValue(modem, 'PowerState')),
		observation: normalizeModemManagerObservation(
			{
				modem: modemRaw,
				...(modem3gpp === undefined ? {} : { modem3gpp: propsRecord(modem3gpp) ?? {} }),
				...(sim === undefined ? {} : { sim: propsRecord(sim) ?? {} }),
				...(signal === undefined ? {} : { signal: propsRecord(signal) ?? {} }),
			},
			normalizationContext,
		),
	};
}
