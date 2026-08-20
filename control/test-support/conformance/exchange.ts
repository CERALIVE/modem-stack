// ONE normalized wire shape for THREE vendor transports.
//
// HiLink, goform and HIMI disagree about everything a transcript assertion cares about:
// HiLink posts XML to a path, goform posts a URL-encoded form and carries its verb in a
// `goformId` field, HIMI posts JSON to a single endpoint and carries its verb in the
// body's `cmdid`. Each provider suite (todos 24/25/26) therefore asserts its own request
// literal in its own shape, which is right for a provider suite and useless for a matrix
// that has to compare all of them side by side.
//
// `RecordedExchange` is that comparison shape. It decodes the body into the form the
// vendor actually uses — `form` / `json` / `xml` — instead of flattening everything to a
// string, so a form-field assertion stays a form-field assertion and a header-order
// assertion stays exact. Nothing is normalized AWAY: the header array is kept verbatim
// (order included), the cookie is additionally lifted out because cookie handling is the
// one thing all three do and all three do differently, and `interfaceName` / `redirect`
// ride along because duplicate-IP binding and redirect refusal are safety properties, not
// transport trivia.

import type {
	HilinkHttpRequest,
	HilinkHttpResponse,
	HilinkTransport,
} from '../../src/providers/huawei-hilink/transport';
import type {
	UfiHttpRequest,
	UfiHttpResponse,
	UfiTransport,
} from '../../src/providers/ufi-himi/transport';
import type {
	ZteHttpRequest,
	ZteHttpResponse,
	ZteTransport,
} from '../../src/providers/zte-goform/transport';

/** The vendor's own body encoding, decoded — never flattened to one string. */
export type ExchangeBody =
	| { readonly kind: 'none' }
	| { readonly kind: 'form'; readonly fields: Readonly<Record<string, string>> }
	| { readonly kind: 'json'; readonly fields: Readonly<Record<string, unknown>> }
	| { readonly kind: 'xml'; readonly text: string };

export type RecordedExchange = {
	readonly provider: 'huawei-hilink' | 'zte-goform' | 'ufi-himi';
	readonly method: 'GET' | 'POST';
	readonly path: string;
	readonly query: Readonly<Record<string, string>>;
	readonly headers: readonly string[];
	/** Lifted out of `headers` because cookie handling is where the three diverge. */
	readonly cookie: string | undefined;
	readonly body: ExchangeBody;
	readonly interfaceName: string;
	readonly redirect: 'error';
};

/** What a scripted device answers. `headers` carries `set-cookie` where it matters. */
export type ScriptedResponse = {
	readonly status: number;
	readonly body: string;
	readonly headers?: Readonly<Record<string, string>>;
};

/** A scripted device: the exchange in, its answer out. Never order-dependent. */
export type ScriptedDevice = (exchange: RecordedExchange) => ScriptedResponse;

/** HTTP 404 with an empty body — what a device that is NOT this vendor answers. */
export const NOT_THIS_VENDOR: ScriptedResponse = { status: 404, body: '' };

/** A device that answers nothing this vendor understands, on every path. */
export const absentDevice: ScriptedDevice = () => NOT_THIS_VENDOR;

function cookieOf(headers: readonly string[]): string | undefined {
	const header = headers.find((entry) => entry.toLowerCase().startsWith('cookie:'));
	return header?.slice(header.indexOf(':') + 1).trim();
}

function formFields(body: string): Readonly<Record<string, string>> {
	const fields: Record<string, string> = {};
	for (const [key, value] of new URLSearchParams(body)) fields[key] = value;
	return fields;
}

function jsonFields(body: string): Readonly<Record<string, unknown>> {
	try {
		const parsed: unknown = JSON.parse(body);
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function queryFields(url: URL): Readonly<Record<string, string>> {
	const query: Record<string, string> = {};
	for (const [key, value] of url.searchParams) query[key] = value;
	return query;
}

/** A recorder is one device's transport plus the ordered transcript it produced. */
export type Recorder<T> = {
	readonly transport: T;
	readonly exchanges: readonly RecordedExchange[];
};

class ExchangeLog {
	readonly entries: RecordedExchange[] = [];

	record(exchange: RecordedExchange): RecordedExchange {
		this.entries.push(exchange);
		return exchange;
	}
}

export function recordHilink(device: ScriptedDevice): Recorder<HilinkTransport> {
	const log = new ExchangeLog();
	const transport: HilinkTransport = {
		request: async (request: HilinkHttpRequest): Promise<HilinkHttpResponse> => {
			const url = new URL(request.url);
			const exchange = log.record({
				provider: 'huawei-hilink',
				method: request.method,
				path: url.pathname,
				query: queryFields(url),
				headers: request.headers,
				cookie: cookieOf(request.headers),
				body: request.body === undefined ? { kind: 'none' } : { kind: 'xml', text: request.body },
				interfaceName: request.interfaceName,
				redirect: request.redirect,
			});
			const scripted = device(exchange);
			return scripted.headers === undefined
				? { status: scripted.status, body: scripted.body }
				: { status: scripted.status, body: scripted.body, headers: scripted.headers };
		},
	};
	return { transport, exchanges: log.entries };
}

export function recordZte(device: ScriptedDevice): Recorder<ZteTransport> {
	const log = new ExchangeLog();
	const transport: ZteTransport = {
		request: async (request: ZteHttpRequest): Promise<ZteHttpResponse> => {
			const url = new URL(request.url);
			const exchange = log.record({
				provider: 'zte-goform',
				method: request.method,
				path: url.pathname,
				query: queryFields(url),
				headers: request.headers,
				cookie: cookieOf(request.headers),
				body:
					request.body === undefined
						? { kind: 'none' }
						: { kind: 'form', fields: formFields(request.body) },
				interfaceName: request.interfaceName,
				redirect: request.redirect,
			});
			const scripted = device(exchange);
			return scripted.headers === undefined
				? { status: scripted.status, body: scripted.body }
				: { status: scripted.status, body: scripted.body, headers: scripted.headers };
		},
	};
	return { transport, exchanges: log.entries };
}

export function recordUfi(device: ScriptedDevice): Recorder<UfiTransport> {
	const log = new ExchangeLog();
	const transport: UfiTransport = {
		request: async (request: UfiHttpRequest): Promise<UfiHttpResponse> => {
			const url = new URL(request.url);
			const exchange = log.record({
				provider: 'ufi-himi',
				method: request.method,
				path: url.pathname,
				query: queryFields(url),
				headers: request.headers,
				cookie: cookieOf(request.headers),
				body: { kind: 'json', fields: jsonFields(request.body) },
				interfaceName: request.interfaceName,
				redirect: request.redirect,
			});
			const scripted = device(exchange);
			return { status: scripted.status, body: scripted.body };
		},
	};
	return { transport, exchanges: log.entries };
}

/** The `goformId` a goform POST carries, or `undefined` for a GET. */
export function goformId(exchange: RecordedExchange): string | undefined {
	return exchange.body.kind === 'form' ? exchange.body.fields.goformId : undefined;
}

/** The `cmdid` a HIMI POST carries. */
export function himiCommand(exchange: RecordedExchange): string | undefined {
	const value = exchange.body.kind === 'json' ? exchange.body.fields.cmdid : undefined;
	return typeof value === 'string' ? value : undefined;
}
