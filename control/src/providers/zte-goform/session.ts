import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthenticatedProfileResult, ProviderMatchRequest } from '../contracts';
import {
	ZTE_PATHS,
	ZTE_UNKNOWN_PROFILE,
	type ZteOptions,
	type ZteProfile,
	zteProfileById,
	zteProfileForFirmware,
} from './provider';
import type { ZteHttpResponse } from './transport';

type ZteSession = { readonly cookie: string; readonly ad?: string };
const flatRecordSchema = z.record(z.string(), z.union([z.string(), z.number()]));

export function parseZteRecord(
	body: string,
): Readonly<Record<string, string | number>> | undefined {
	const result = z
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
	return result.success ? result.data : undefined;
}

function stokCookie(response: ZteHttpResponse): string | undefined {
	const expected = 'set-cookie';
	const header = Object.entries(response.headers ?? {}).find(
		([key]) => key.toLowerCase() === expected,
	)?.[1];
	const cookie = header?.split(';', 1)[0]?.trim();
	return cookie?.startsWith('stok=') ? cookie : undefined;
}

function sha256(value: string): string {
	return createHash('sha256').update(value).digest('hex').toUpperCase();
}

export class ZteSessionRuntime {
	readonly #sessions = new Map<string, ZteSession>();

	constructor(protected readonly options: ZteOptions) {}

	async authenticateProfile(
		request: ProviderMatchRequest,
		candidates: readonly string[],
	): Promise<AuthenticatedProfileResult> {
		const candidate = candidates.length === 1 ? candidates[0] : undefined;
		if (candidate === ZTE_UNKNOWN_PROFILE) {
			return { status: 'matched', profile: ZTE_UNKNOWN_PROFILE, detail: 'read-only-fingerprint' };
		}
		const profile = zteProfileById(candidate ?? '');
		if (profile === undefined || zteProfileForFirmware(request.firmware)?.id !== profile.id) {
			return { status: 'refused', detail: 'profile-mismatch' };
		}
		return profile.algorithm === 'legacy-base64'
			? this.loginLegacy(request, profile)
			: this.loginSalted(request, profile);
	}

	protected sessionCookie(request: ProviderMatchRequest): string | undefined {
		return this.#sessions.get(this.sessionKey(request))?.cookie;
	}

	protected get(cmd: string, cookie?: string, multiData = false): Promise<ZteHttpResponse> {
		const query = new URLSearchParams({ isTest: 'false', cmd });
		if (multiData) query.set('multi_data', '1');
		return this.request('GET', `${ZTE_PATHS.get}?${query.toString()}`, undefined, cookie);
	}

	private async loginLegacy(
		request: ProviderMatchRequest,
		profile: ZteProfile,
	): Promise<AuthenticatedProfileResult> {
		const response = await this.post(
			new URLSearchParams({
				goformId: 'LOGIN',
				isTest: 'false',
				password: Buffer.from(this.options.credentials.password).toString('base64'),
			}).toString(),
		);
		const record = parseZteRecord(response.body);
		const cookie = stokCookie(response);
		if (response.status !== 200 || record?.result !== '0' || cookie === undefined) {
			return {
				status: 'refused',
				detail: record?.LD === undefined ? 'auth-rejection' : 'protocol-mismatch',
			};
		}
		this.#sessions.set(this.sessionKey(request), { cookie });
		return { status: 'matched', profile: profile.id, detail: 'login-ok' };
	}

	private async loginSalted(
		request: ProviderMatchRequest,
		profile: ZteProfile,
	): Promise<AuthenticatedProfileResult> {
		const ldResponse = await this.get('LD');
		const ld = parseZteRecord(ldResponse.body)?.LD;
		if (ldResponse.status !== 200 || typeof ld !== 'string') {
			return { status: 'refused', detail: 'protocol-mismatch' };
		}
		const login = await this.post(
			new URLSearchParams({
				goformId: 'LOGIN_MULTI_USER',
				isTest: 'false',
				password: sha256(`${sha256(this.options.credentials.password)}${ld}`),
				IP: 'localhost',
				user: this.options.credentials.username,
			}).toString(),
		);
		const cookie = stokCookie(login);
		if (
			login.status !== 200 ||
			parseZteRecord(login.body)?.result !== '0' ||
			cookie === undefined
		) {
			return { status: 'refused', detail: 'auth-rejection' };
		}
		const versions = parseZteRecord(
			(await this.get('wa_inner_version,cr_version', cookie, true)).body,
		);
		const rd = parseZteRecord((await this.get('RD', cookie)).body)?.RD;
		const waVersion = versions?.wa_inner_version;
		const crVersion = versions?.cr_version;
		if (typeof waVersion !== 'string' || typeof crVersion !== 'string' || typeof rd !== 'string') {
			return { status: 'refused', detail: 'protocol-mismatch' };
		}
		this.#sessions.set(this.sessionKey(request), {
			cookie,
			ad: sha256(`${sha256(`${waVersion}${crVersion}`)}${rd}`),
		});
		return { status: 'matched', profile: profile.id, detail: 'login-ok' };
	}

	private sessionKey(request: ProviderMatchRequest): string {
		return `${request.physicalModemId}:${request.generation}`;
	}

	private post(body: string): Promise<ZteHttpResponse> {
		return this.request('POST', ZTE_PATHS.set, body);
	}

	private request(
		method: 'GET' | 'POST',
		path: string,
		body?: string,
		cookie?: string,
	): Promise<ZteHttpResponse> {
		const headers = [
			...(method === 'POST'
				? ['Content-Type: application/x-www-form-urlencoded; charset=UTF-8']
				: []),
			...(cookie === undefined ? [] : [`Cookie: ${cookie}`]),
			`Origin: ${this.options.adminUrl}`,
			`Referer: ${this.options.adminUrl}/index.html`,
		];
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
