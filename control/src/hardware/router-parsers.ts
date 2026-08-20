import { z } from 'zod';

export type SimPresence = 'present' | 'absent' | 'unknown';
export type SimPresenceFacts = {
	readonly sim?: string;
	readonly simSlots?: readonly string[];
	readonly failedReason?: string;
};

const SIM_OBJECT_PATH = /^\/org\/freedesktop\/ModemManager1\/SIM\/\d+$/;

export function deriveSimPresence(facts: SimPresenceFacts): SimPresence {
	if (SIM_OBJECT_PATH.test(facts.sim?.trim() ?? '')) return 'present';
	if (facts.simSlots?.some((slot) => SIM_OBJECT_PATH.test(slot.trim()))) return 'present';
	return facts.failedReason === 'sim-missing' ? 'absent' : 'unknown';
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

function xmlValue(body: string, tag: string): string | undefined {
	const match = body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
	return match?.[1]?.trim();
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
	const authStatus = xmlValue(input.status, 'code') === '125002';
	const authSignal = xmlValue(input.signal, 'code') === '125002';
	const statusReason = authStatus ? 'auth-expired' : 'not-reported';
	const signalReason = authSignal ? 'auth-expired' : 'not-reported';
	const metric = (tag: string): RouterSignalMetric =>
		authSignal ? unknown(signalReason) : numericMetric(xmlValue(input.signal, tag));
	return {
		provenance: 'hilink-admin-api',
		freshness: authStatus && authSignal ? 'unknown' : 'live',
		bars: authStatus ? unknown(statusReason) : numericMetric(xmlValue(input.status, 'SignalIcon')),
		max_bars: authStatus
			? unknown(statusReason)
			: numericMetric(xmlValue(input.status, 'maxsignal')),
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

function stated(value: string | number | undefined): string | undefined {
	if (value === undefined) return undefined;
	const normalized = String(value).trim();
	return normalized === '' || normalized === '-' ? undefined : normalized;
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
		['network_band', stated(value.wan_active_band) ?? stated(value.lte_band) ?? stated(value.band)],
		['carrier_aggregation', stated(value.wan_lte_ca)],
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

export type HilinkNetModeCapability =
	| {
			readonly state: 'reported';
			readonly modes: readonly { readonly id: string; readonly name?: string }[];
			readonly current?: string;
	  }
	| {
			readonly state: 'unavailable';
			readonly reason: RouterSignalUnknownReason | 'refused';
			readonly code?: string;
	  };

export function parseHilinkCapabilities(input: {
	readonly netModeList: string;
	readonly netMode?: string;
}): { readonly net_mode: HilinkNetModeCapability } {
	const code = xmlValue(input.netModeList, 'code');
	if (code === '125002') return { net_mode: { state: 'unavailable', reason: 'auth-expired' } };
	if (code !== undefined) return { net_mode: { state: 'unavailable', reason: 'refused', code } };
	if (input.netModeList === '')
		return { net_mode: { state: 'unavailable', reason: 'unreachable' } };
	if (!/<NetworkModeList>/i.test(input.netModeList))
		return { net_mode: { state: 'unavailable', reason: 'malformed' } };
	const modes = [...input.netModeList.matchAll(/<NetworkMode>([\s\S]*?)<\/NetworkMode>/gi)].flatMap(
		(match) => {
			const id = xmlValue(match[1] ?? '', 'Index');
			if (id === undefined || id === '') return [];
			const name = xmlValue(match[1] ?? '', 'Name');
			return name === undefined || name === '' ? [{ id }] : [{ id, name }];
		},
	);
	if (modes.length === 0) return { net_mode: { state: 'unavailable', reason: 'not-reported' } };
	const current = xmlValue(input.netMode ?? '', 'NetworkMode');
	return current === undefined || current === ''
		? { net_mode: { state: 'reported', modes } }
		: { net_mode: { state: 'reported', modes, current } };
}
