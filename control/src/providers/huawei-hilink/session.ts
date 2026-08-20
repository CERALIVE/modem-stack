import { createHash } from 'node:crypto';
import {
	parseHilinkSession,
	parseHilinkUserState,
	parseHilinkXmlValue,
} from '../../hardware/router-parsers';
import type { ProviderExecutionContext, ProviderMatchRequest } from '../contracts';
import { HILINK_PATHS, type HilinkOptions, type HilinkProfile } from './provider';
import type { HilinkHttpResponse } from './transport';

export type HilinkSession = { readonly cookie: string; readonly token: string };
export type HilinkSessionFailure =
	| 'auth-expired'
	| 'http-failure'
	| 'malformed'
	| 'profile-mismatch'
	| 'unreachable';
export type HilinkSessionResult =
	| { readonly status: 'ready'; readonly session: HilinkSession }
	| { readonly status: 'refused'; readonly reason: HilinkSessionFailure };

function base64(value: string): string {
	return Buffer.from(value).toString('base64');
}

function derivePassword(profile: HilinkProfile, username: string, password: string, token: string) {
	if (profile.passwordType === 3) return base64(password);
	const passwordHash = base64(createHash('sha256').update(password).digest('hex'));
	const loginHash = createHash('sha256').update(`${username}${passwordHash}${token}`).digest('hex');
	return base64(loginHash);
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

function loginDocument(profile: HilinkProfile, username: string, password: string, token: string) {
	return `<?xml version="1.0" encoding="UTF-8"?><request><Username>${escapeXml(username)}</Username><Password>${derivePassword(profile, username, password, token)}</Password><password_type>${profile.passwordType}</password_type></request>`;
}

function responseHeader(response: HilinkHttpResponse, name: string): string | undefined {
	const expected = name.toLowerCase();
	return Object.entries(response.headers ?? {}).find(
		([key]) => key.toLowerCase() === expected,
	)?.[1];
}

function loggedInSession(response: HilinkHttpResponse, fallback: HilinkSession): HilinkSession {
	const cookie =
		responseHeader(response, 'set-cookie')?.split(';', 1)[0]?.trim() ?? fallback.cookie;
	const tokenHeader =
		responseHeader(response, '__requestverificationtoken') ??
		responseHeader(response, '__requestverificationtokenone');
	const token = tokenHeader?.split('#', 1)[0]?.trim() ?? fallback.token;
	return { cookie, token };
}

export class HilinkSessionRuntime {
	protected readonly options: HilinkOptions;
	readonly #authenticated = new Map<string, HilinkSession>();
	readonly #serial = new Map<string, Promise<unknown>>();

	constructor(options: HilinkOptions) {
		this.options = options;
	}

	protected async withDevice<T>(
		context: ProviderExecutionContext,
		run: () => Promise<T>,
	): Promise<T> {
		const key = String(context.physicalModemId);
		const prior = this.#serial.get(key) ?? Promise.resolve();
		let release = () => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chain = prior.then(() => current);
		this.#serial.set(key, chain);
		await prior;
		try {
			return await run();
		} finally {
			release();
			if (this.#serial.get(key) === chain) this.#serial.delete(key);
		}
	}

	protected sessionKey(context: ProviderMatchRequest): string {
		return `${context.physicalModemId}:${context.generation}`;
	}

	protected cachedSession(context: ProviderMatchRequest): HilinkSession | undefined {
		return this.#authenticated.get(this.sessionKey(context));
	}

	protected async authenticate(
		context: ProviderMatchRequest,
		profile: HilinkProfile,
		cache: boolean,
	): Promise<HilinkSessionResult> {
		const sessionResponse = await this.request('GET', HILINK_PATHS.session);
		if (sessionResponse.status === 401 || sessionResponse.status === 403)
			return { status: 'refused', reason: 'auth-expired' };
		if (sessionResponse.status !== 200) return { status: 'refused', reason: 'unreachable' };
		const initial = parseHilinkSession(sessionResponse.body);
		if (initial === undefined) return { status: 'refused', reason: 'malformed' };

		const stateResponse = await this.getResponse(HILINK_PATHS.loginState, initial);
		if (this.authExpired(stateResponse)) return { status: 'refused', reason: 'auth-expired' };
		const state = parseHilinkUserState(stateResponse.body);
		if (state === undefined) return { status: 'refused', reason: 'malformed' };
		if (state.passwordType !== profile.passwordType)
			return { status: 'refused', reason: 'profile-mismatch' };

		const login = await this.postResponse(
			HILINK_PATHS.login,
			loginDocument(
				profile,
				this.options.credentials.username,
				this.options.credentials.password,
				initial.token,
			),
			initial,
		);
		if (this.authExpired(login)) return { status: 'refused', reason: 'auth-expired' };
		if (login.status !== 200 || !/<response>\s*OK\s*<\/response>/i.test(login.body))
			return { status: 'refused', reason: 'http-failure' };
		const session = loggedInSession(login, initial);
		if (cache) this.#authenticated.set(this.sessionKey(context), session);
		return { status: 'ready', session };
	}

	protected authExpired(response: HilinkHttpResponse): boolean {
		return (
			response.status === 401 ||
			response.status === 403 ||
			parseHilinkXmlValue(response.body, 'code') === '125002'
		);
	}

	protected getResponse(path: string, session: HilinkSession): Promise<HilinkHttpResponse> {
		return this.request('GET', path, undefined, [`Cookie: ${session.cookie}`]);
	}

	protected postResponse(
		path: string,
		body: string,
		session: HilinkSession,
	): Promise<HilinkHttpResponse> {
		return this.request('POST', path, body, [
			`Cookie: ${session.cookie}`,
			`__RequestVerificationToken: ${session.token}`,
			'Content-Type: application/xml',
		]);
	}

	protected request(
		method: 'GET' | 'POST',
		path: string,
		body?: string,
		headers: readonly string[] = [],
	): Promise<HilinkHttpResponse> {
		return this.options.transport.request({
			method,
			url: `${this.options.adminUrl}${path}`,
			...(body === undefined ? {} : { body }),
			headers,
			interfaceName: this.options.interfaceName,
			redirect: 'error',
		});
	}
}
