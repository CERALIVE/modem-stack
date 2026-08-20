export function parseHilinkXmlValue(body: string, tag: string): string | undefined {
	const match = body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
	return match?.[1]?.trim();
}

export type HilinkSessionDocument = {
	readonly cookie: string;
	readonly token: string;
};

export function parseHilinkSession(body: string): HilinkSessionDocument | undefined {
	const cookie = parseHilinkXmlValue(body, 'SesInfo');
	const token = parseHilinkXmlValue(body, 'TokInfo');
	return cookie === undefined || cookie === '' || token === undefined || token === ''
		? undefined
		: { cookie, token };
}

export type HilinkUserState = {
	readonly state: string;
	readonly passwordType: 3 | 4;
};

export function parseHilinkUserState(body: string): HilinkUserState | undefined {
	const state = parseHilinkXmlValue(body, 'State');
	const rawPasswordType = parseHilinkXmlValue(body, 'password_type');
	if (state === undefined || (rawPasswordType !== '3' && rawPasswordType !== '4')) return undefined;
	return { state, passwordType: rawPasswordType === '3' ? 3 : 4 };
}

export type HilinkProtocolUnknownReason =
	| 'unsupported'
	| 'not-reported'
	| 'malformed'
	| 'auth-expired'
	| 'unreachable';
export type HilinkDataCapability =
	| { readonly state: 'reported'; readonly enabled: boolean }
	| {
			readonly state: 'unavailable';
			readonly reason: HilinkProtocolUnknownReason | 'refused';
			readonly code?: string;
	  };

export function parseHilinkDataCapability(body: string): HilinkDataCapability {
	const code = parseHilinkXmlValue(body, 'code');
	if (code === '125002') return { state: 'unavailable', reason: 'auth-expired' };
	if (code !== undefined) return { state: 'unavailable', reason: 'refused', code };
	const value = parseHilinkXmlValue(body, 'dataswitch');
	if (value === undefined)
		return { state: 'unavailable', reason: body === '' ? 'unreachable' : 'malformed' };
	if (value !== '0' && value !== '1') return { state: 'unavailable', reason: 'malformed' };
	return { state: 'reported', enabled: value === '1' };
}

export type HilinkNetModeCapability =
	| {
			readonly state: 'reported';
			readonly modes: readonly { readonly id: string; readonly name?: string }[];
			readonly current?: string;
	  }
	| {
			readonly state: 'unavailable';
			readonly reason: HilinkProtocolUnknownReason | 'refused';
			readonly code?: string;
	  };

export function parseHilinkCapabilities(input: {
	readonly netModeList: string;
	readonly netMode?: string;
}): { readonly net_mode: HilinkNetModeCapability } {
	const code = parseHilinkXmlValue(input.netModeList, 'code');
	if (code === '125002') return { net_mode: { state: 'unavailable', reason: 'auth-expired' } };
	if (code !== undefined) return { net_mode: { state: 'unavailable', reason: 'refused', code } };
	if (input.netModeList === '')
		return { net_mode: { state: 'unavailable', reason: 'unreachable' } };
	if (!/<NetworkModeList>/i.test(input.netModeList))
		return { net_mode: { state: 'unavailable', reason: 'malformed' } };
	const modes = [...input.netModeList.matchAll(/<NetworkMode>([\s\S]*?)<\/NetworkMode>/gi)].flatMap(
		(match) => {
			const id = parseHilinkXmlValue(match[1] ?? '', 'Index');
			if (id === undefined || id === '') return [];
			const name = parseHilinkXmlValue(match[1] ?? '', 'Name');
			return name === undefined || name === '' ? [{ id }] : [{ id, name }];
		},
	);
	if (modes.length === 0) return { net_mode: { state: 'unavailable', reason: 'not-reported' } };
	const current = parseHilinkXmlValue(input.netMode ?? '', 'NetworkMode');
	return current === undefined || current === ''
		? { net_mode: { state: 'reported', modes } }
		: { net_mode: { state: 'reported', modes, current } };
}
