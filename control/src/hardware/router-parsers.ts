import { z } from 'zod';
import { parseHilinkXmlValue } from './hilink-protocol';

export * from './hilink-protocol';

export type SimPresence = 'present' | 'absent' | 'unknown';
export type SimPresenceFacts = {
	readonly sim?: string;
	readonly simSlots?: readonly string[];
	readonly failedReason?: string;
};

const SIM_OBJECT_PATH = /^\/org\/freedesktop\/ModemManager1\/SIM\/\d+$/;

/** The mmcli spelling of `MM_MODEM_STATE_FAILED_REASON_SIM_MISSING` — the ONLY proof of absence. */
export const SIM_MISSING_FAILED_REASON = 'sim-missing';

/** The fields a presence decision may be drawn from, in the order they are inspected. */
export const SIM_PRESENCE_FIELDS = ['sim', 'simSlots', 'failedReason'] as const;
export type SimPresenceField = (typeof SIM_PRESENCE_FIELDS)[number];

/**
 * WHICH FACT decided a SIM presence — the whole point of this type.
 *
 * `absent` is reachable through exactly ONE member (`state-failed-reason`), so a
 * consumer can prove that no code path inferred "there is no SIM" from a blank or
 * missing field. A modem that exports `Sim: '/'` and says nothing else is
 * `no-evidence`/`unknown`: an empty object path is ModemManager's answer for "no SIM
 * object is bound right now", which a modem also reports while it is still
 * initializing, while its SIM is locked out, and while a slot switch is in flight.
 *
 * `vendor-code-unclaimed` is the router half. HiLink, goform and HIMI each report
 * their own presence code with vendor semantics no migrated decoder covers, so the
 * code is NAMED here and its value stays verbatim in the diagnostics block, rather
 * than being guessed into a presence.
 */
export type SimPresenceEvidence =
	| { readonly kind: 'sim-object-path'; readonly field: 'sim'; readonly value: string }
	| { readonly kind: 'sim-slot-object-path'; readonly field: 'simSlots'; readonly value: string }
	| {
			readonly kind: 'state-failed-reason';
			readonly field: 'failedReason';
			readonly value: typeof SIM_MISSING_FAILED_REASON;
	  }
	| { readonly kind: 'no-evidence'; readonly inspected: readonly SimPresenceField[] }
	| { readonly kind: 'vendor-code-unclaimed'; readonly field: string };

export type SimPresenceReading = {
	readonly presence: SimPresence;
	readonly evidence: SimPresenceEvidence;
};

/** The presence decision together with the fact that produced it. */
export function readSimPresence(facts: SimPresenceFacts): SimPresenceReading {
	const sim = facts.sim?.trim() ?? '';
	if (SIM_OBJECT_PATH.test(sim)) {
		return { presence: 'present', evidence: { kind: 'sim-object-path', field: 'sim', value: sim } };
	}
	const slot = facts.simSlots
		?.map((each) => each.trim())
		.find((each) => SIM_OBJECT_PATH.test(each));
	if (slot !== undefined) {
		return {
			presence: 'present',
			evidence: { kind: 'sim-slot-object-path', field: 'simSlots', value: slot },
		};
	}
	if (facts.failedReason === SIM_MISSING_FAILED_REASON) {
		return {
			presence: 'absent',
			evidence: {
				kind: 'state-failed-reason',
				field: 'failedReason',
				value: SIM_MISSING_FAILED_REASON,
			},
		};
	}
	return { presence: 'unknown', evidence: { kind: 'no-evidence', inspected: SIM_PRESENCE_FIELDS } };
}

export function deriveSimPresence(facts: SimPresenceFacts): SimPresence {
	return readSimPresence(facts).presence;
}

export type RouterSignalUnknownReason =
	| 'unsupported'
	| 'not-reported'
	| 'malformed'
	| 'auth-expired'
	| 'unreachable';
export type RouterSignalMetric =
	| { readonly state: 'known'; readonly value: number }
	| { readonly state: 'unknown'; readonly reason: RouterSignalUnknownReason };
export type RouterSignalModel = {
	readonly provenance: 'hilink-admin-api' | 'zte-goform' | 'ufi-himiapi';
	readonly freshness: 'live' | 'unknown';
	readonly bars: RouterSignalMetric;
	readonly max_bars: RouterSignalMetric;
	readonly dbm: RouterSignalMetric;
	readonly rsrp: RouterSignalMetric;
	readonly rsrq: RouterSignalMetric;
	readonly snr: RouterSignalMetric;
	readonly sinr: RouterSignalMetric;
};

const unknown = (reason: RouterSignalUnknownReason): RouterSignalMetric => ({
	state: 'unknown',
	reason,
});
const known = (value: number): RouterSignalMetric => ({ state: 'known', value });

function numericMetric(value: string | number | undefined): RouterSignalMetric {
	if (value === undefined || String(value).trim() === '') return unknown('not-reported');
	const parsed = Number.parseFloat(String(value));
	return Number.isFinite(parsed) ? known(parsed) : unknown('malformed');
}

const flatRecordSchema = z.record(z.string(), z.union([z.string(), z.number()]));
const ufiBodySchema = z.object({
	reply: z.string(),
	params: flatRecordSchema.optional(),
});

function parseFlatRecord(body: string): Readonly<Record<string, string | number>> | undefined {
	const parsed = z
		.string()
		.transform((value, context) => {
			try {
				return JSON.parse(value);
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
				context.addIssue({ code: 'custom', message: 'invalid JSON' });
				return z.NEVER;
			}
		})
		.pipe(flatRecordSchema)
		.safeParse(body);
	return parsed.success ? parsed.data : undefined;
}

function parseUfiBody(body: string): z.infer<typeof ufiBodySchema> | undefined {
	const parsed = z
		.string()
		.transform((value, context) => {
			try {
				return JSON.parse(value);
			} catch (error) {
				if (!(error instanceof SyntaxError)) throw error;
				context.addIssue({ code: 'custom', message: 'invalid JSON' });
				return z.NEVER;
			}
		})
		.pipe(ufiBodySchema)
		.safeParse(body);
	return parsed.success ? parsed.data : undefined;
}

export function parseHilinkSignal(input: {
	readonly status: string;
	readonly signal: string;
}): RouterSignalModel {
	const authStatus = parseHilinkXmlValue(input.status, 'code') === '125002';
	const authSignal = parseHilinkXmlValue(input.signal, 'code') === '125002';
	const statusReason = authStatus ? 'auth-expired' : 'not-reported';
	const signalReason = authSignal ? 'auth-expired' : 'not-reported';
	const metric = (tag: string): RouterSignalMetric =>
		authSignal ? unknown(signalReason) : numericMetric(parseHilinkXmlValue(input.signal, tag));
	return {
		provenance: 'hilink-admin-api',
		freshness: authStatus && authSignal ? 'unknown' : 'live',
		bars: authStatus
			? unknown(statusReason)
			: numericMetric(parseHilinkXmlValue(input.status, 'SignalIcon')),
		max_bars: authStatus
			? unknown(statusReason)
			: numericMetric(parseHilinkXmlValue(input.status, 'maxsignal')),
		dbm: metric('rssi'),
		rsrp: metric('rsrp'),
		rsrq: metric('rsrq'),
		snr: unknown('unsupported'),
		sinr: metric('sinr'),
	};
}

export function parseZteSignal(body: string): RouterSignalModel {
	const record = parseFlatRecord(body);
	const malformed = record === undefined;
	const metric = (key: string): RouterSignalMetric =>
		malformed ? unknown('malformed') : numericMetric(record[key]);
	const bars = metric('signalbar');
	return {
		provenance: 'zte-goform',
		freshness: malformed ? 'unknown' : 'live',
		bars,
		max_bars: bars.state === 'known' ? known(5) : unknown('not-reported'),
		dbm: metric('rssi'),
		rsrp: metric('lte_rsrp'),
		rsrq: metric('lte_rsrq'),
		snr: metric('lte_snr'),
		sinr: unknown('unsupported'),
	};
}

export function parseUfiSignal(input: {
	readonly sysinfo: string;
	readonly overview: string;
	readonly status: string;
}): RouterSignalModel {
	const bodies = [input.sysinfo, input.overview, input.status].map(parseUfiBody);
	const authExpired = bodies.every((body) => body?.reply === 'SessionOut');
	const answered = bodies.some((body) => body?.reply === 'ok');
	const value =
		bodies[0]?.params?.SIGNAL ?? bodies[1]?.params?.SIGNAL ?? bodies[2]?.params?.signalStrength;
	const dbm = authExpired
		? unknown('auth-expired')
		: answered
			? numericMetric(value)
			: unknown('malformed');
	return {
		provenance: 'ufi-himiapi',
		freshness: answered ? 'live' : 'unknown',
		bars: unknown('unsupported'),
		max_bars: unknown('unsupported'),
		dbm,
		rsrp: unknown('unsupported'),
		rsrq: unknown('unsupported'),
		snr: unknown('unsupported'),
		sinr: unknown('unsupported'),
	};
}

export type RouterDetails = Readonly<Record<string, string>>;

/**
 * The vendor's own "unset" placeholders. A UFI answers `-` for a WAN address, an
 * IMSI and an ICCID it does not have, and the ZTE builds answer `--` / `N/A` for
 * an unpopulated counter — publishing any of those as a reading puts a value on
 * screen that reads like a real one.
 */
const PLACEHOLDERS: ReadonlySet<string> = new Set(['-', '--', 'n/a', 'N/A']);

function stated(value: string | number | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = String(value).trim();
	return normalized === '' || PLACEHOLDERS.has(normalized) ? undefined : normalized;
}

function compact(
	entries: readonly (readonly [string, string | undefined])[],
): RouterDetails | undefined {
	const result: Record<string, string> = {};
	for (const [key, value] of entries) if (value !== undefined) result[key] = value;
	return Object.keys(result).length === 0 ? undefined : result;
}

export function parseZteDetails(body: string): RouterDetails | undefined {
	const value = parseFlatRecord(body);
	if (value === undefined) return undefined;
	return compact([
		['network_type', stated(value.network_type)],
		[
			'provider',
			stated(value.network_provider_fullname) ??
				stated(value.network_provider) ??
				stated(value.provider),
		],
		['cell_id', stated(value.cell_id)],
		['roaming', stated(value.simcard_roam)],
		['mcc', stated(value.rmcc)],
		['mnc', stated(value.rmnc)],
		['pci', stated(value.lte_pci)],
		// `band` and `network_band` are two DIFFERENT readings and must not be
		// folded onto one key: `lte_band` is the serving cell's band, while
		// `wan_active_band` is the band the WAN leg is active on, and the two
		// disagree the moment carrier aggregation is up. Publishing either under
		// the other's name reports a band the device never claimed for that leg.
		['band', stated(value.lte_band) ?? stated(value.band)],
		['network_band', stated(value.wan_active_band)],
		['carrier_aggregation', stated(value.wan_lte_ca)],
		['pcell_arfcn', stated(value.lte_ca_pcell_arfcn)],
		['pcell_band', stated(value.lte_ca_pcell_band)],
		['pcell_bandwidth', stated(value.lte_ca_pcell_bandwidth)],
		['scell_arfcn', stated(value.lte_ca_scell_arfcn)],
		['scell_band', stated(value.lte_ca_scell_band)],
		['scell_bandwidth', stated(value.lte_ca_scell_bandwidth)],
		['monthly_tx_bytes', stated(value.monthly_tx_bytes)],
		['monthly_rx_bytes', stated(value.monthly_rx_bytes)],
		['monthly_time', stated(value.monthly_time)],
		['monthly_period', stated(value.date_month)],
		// Named `session_*` rather than `realtime_*`: these are cumulative counters
		// and a throughput, and the vendor's own prefix reads as "live rate" for
		// all five.
		['session_tx_bytes', stated(value.realtime_tx_bytes)],
		['session_rx_bytes', stated(value.realtime_rx_bytes)],
		['session_tx_rate', stated(value.realtime_tx_thrpt)],
		['session_rx_rate', stated(value.realtime_rx_thrpt)],
		['session_time', stated(value.realtime_time)],
	]);
}

export function parseUfiDetails(input: {
	readonly overview?: string;
	readonly sysinfo?: string;
	readonly produceInfo?: string;
}): RouterDetails | undefined {
	const overview = parseUfiBody(input.overview ?? '')?.params;
	const sysinfo = parseUfiBody(input.sysinfo ?? '')?.params;
	const product = parseUfiBody(input.produceInfo ?? '')?.params;
	return compact([
		['product', stated(product?.productname) ?? stated(product?.ProductName)],
		['ssid', stated(overview?.SSID)],
		['wan_ip', stated(overview?.WANIP)],
		['imsi', stated(overview?.IMSI)],
		['iccid', stated(overview?.ICCID)],
		['web_version', stated(overview?.WEBVER)],
		['cell_id', stated(sysinfo?.cellid)],
		['station_id', stated(sysinfo?.bsid)],
		['cpu_temp', stated(sysinfo?.cputemp)],
		['wifi_clients', stated(sysinfo?.wifinum)],
		['eth_clients', stated(sysinfo?.ethnum)],
	]);
}
