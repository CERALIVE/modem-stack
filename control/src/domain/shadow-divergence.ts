export type ShadowGeneration = '2G' | '3G' | '4G' | '5G';
export type ShadowSignalBucket = 'none' | 'poor' | 'fair' | 'good' | 'excellent';
export interface ShadowModemState {
	readonly deviceKey: string;
	readonly present: boolean;
	readonly registration?: string;
	readonly signalBucket?: ShadowSignalBucket;
	readonly operatorName?: string;
	readonly simPresent?: boolean;
	readonly networkType?: ShadowGeneration;
}
export const SHADOW_COMPARABLE_FIELDS = [
	'present',
	'registration',
	'signalBucket',
	'operatorName',
	'simPresent',
	'networkType',
] as const;
export type ShadowComparableField = (typeof SHADOW_COMPARABLE_FIELDS)[number];
export interface ShadowFieldDivergence {
	readonly field: ShadowComparableField;
	readonly mmcli: unknown;
	readonly dbus: unknown;
}
export interface ShadowModemDivergence {
	readonly deviceKey: string;
	readonly kind: 'only-in-mmcli' | 'only-in-dbus' | 'field-mismatch';
	readonly fields?: readonly ShadowFieldDivergence[];
}

export function classifyShadowDivergences(
	mmcli: readonly ShadowModemState[],
	dbus: readonly ShadowModemState[],
): ShadowModemDivergence[] {
	const left = new Map(mmcli.map((state) => [state.deviceKey, state]));
	const right = new Map(dbus.map((state) => [state.deviceKey, state]));
	const result: ShadowModemDivergence[] = [];
	for (const [deviceKey, mmcliState] of left) {
		const dbusState = right.get(deviceKey);
		if (dbusState === undefined) {
			result.push({ deviceKey, kind: 'only-in-mmcli' });
			continue;
		}
		const fields: ShadowFieldDivergence[] = [];
		for (const field of SHADOW_COMPARABLE_FIELDS) {
			const a = mmcliState[field];
			const b = dbusState[field];
			if (a !== undefined && b !== undefined && a !== b) fields.push({ field, mmcli: a, dbus: b });
		}
		if (fields.length > 0) result.push({ deviceKey, kind: 'field-mismatch', fields });
	}
	for (const deviceKey of right.keys())
		if (!left.has(deviceKey)) result.push({ deviceKey, kind: 'only-in-dbus' });
	return result;
}

const GENERATIONS: Readonly<Record<string, ShadowGeneration>> = {
	'2g': '2G',
	gsm: '2G',
	'3g': '3G',
	'3g+': '3G',
	umts: '3G',
	'4g': '4G',
	lte: '4G',
	'5g': '5G',
	'5gnr': '5G',
};
const ORDER: readonly ShadowGeneration[] = ['2G', '3G', '4G', '5G'];
export function foldGeneration(token: string): ShadowGeneration | undefined {
	return GENERATIONS[token.trim().toLowerCase()];
}
export function foldGenerations(tokens: Iterable<string>): ShadowGeneration | undefined {
	let best: ShadowGeneration | undefined;
	for (const token of tokens) {
		const value = foldGeneration(token);
		if (value !== undefined && (best === undefined || ORDER.indexOf(value) > ORDER.indexOf(best)))
			best = value;
	}
	return best;
}
export function foldSignalBucket(quality: number | undefined): ShadowSignalBucket | undefined {
	if (quality === undefined || !Number.isFinite(quality)) return undefined;
	return quality <= 0
		? 'none'
		: quality < 25
			? 'poor'
			: quality < 50
				? 'fair'
				: quality < 75
					? 'good'
					: 'excellent';
}
