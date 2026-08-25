import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseJsonWith } from '../../json-boundary';
import type { AuthenticatedProfileResult, ProviderMatchRequest } from '../contracts';
import {
	ZTE_EVIDENCE_CMD,
	ZTE_PATHS,
	ZTE_UNKNOWN_PROFILE,
	type ZteOptions,
	type ZteProfile,
	zteProfileById,
	zteProfilesForFirmware,
} from './provider';
import type { ZteHttpResponse } from './transport';

type ZteSession = { readonly cookie: string; readonly ad?: string };
type ZteEvidence = {
	readonly record: Readonly<Record<string, string | number>>;
	readonly profile: ZteProfile | undefined;
};
type ZteLoginResult =
	| { readonly status: 'accepted'; readonly cookie: string }
	| { readonly status: 'refused'; readonly detail: 'auth-rejection' | 'protocol-mismatch' };
const flatRecordSchema = z.record(z.string(), z.union([z.string(), z.number()]));

export function parseZteRecord(
	body: string,
): Readonly<Record<string, string | number>> | undefined {
	return parseJsonWith(flatRecordSchema, body);
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

function evidenceNumber(value: string | number | undefined): number | undefined {
	if (typeof value === 'string' && value.trim() === '') return undefined;
	const parsed = typeof value === 'number' ? value : Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function profileFromEvidence(
	firmware: string | undefined,
	record: Readonly<Record<string, string | number>>,
): ZteProfile | undefined {
	const versionEvidence =
		`${record.wa_inner_version ?? ''} ${record.cr_version ?? ''}`.toUpperCase();
	const family = versionEvidence.includes('MF266')
		? 'MF266'
		: versionEvidence.includes('MF79U')
			? 'MF79U'
			: firmware;
	const hasLd = typeof record.LD === 'string' && record.LD.length > 0;
	const profileId =
		family === 'MF266'
			? hasLd
				? 'mf266-salted'
				: undefined
			: family === 'MF79U'
				? hasLd
					? 'mf79u-ld-salted'
					: 'mf79u-legacy'
				: undefined;
	return zteProfilesForFirmware(family).find((profile) => profile.id === profileId);
}

function classifyLogin(response: ZteHttpResponse): ZteLoginResult {
	const result = parseZteRecord(response.body)?.result;
	if (response.status !== 200 || result === '1') {
		return { status: 'refused', detail: 'protocol-mismatch' };
	}
	if (result === '3') return { status: 'refused', detail: 'auth-rejection' };
	const cookie = stokCookie(response);
	return result === '0' && cookie !== undefined
		? { status: 'accepted', cookie }
		: { status: 'refused', detail: 'protocol-mismatch' };
}

export class ZteSessionRuntime {
	readonly #sessions = new Map<string, ZteSession>();
	readonly #evidence = new Map<string, ZteEvidence>();

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
		if (profile === undefined) {
			return { status: 'refused', detail: 'profile-mismatch' };
		}
		const evidence =
			this.#evidence.get(this.sessionKey(request)) ?? (await this.probeEvidence(request));
		if (evidence === undefined) return { status: 'refused', detail: 'protocol-mismatch' };
		const remainingAttempts = evidenceNumber(evidence.record.psw_fail_num_str);
		const lockTime = evidenceNumber(evidence.record.login_lock_time);
		if (remainingAttempts === undefined || lockTime === undefined) {
			return { status: 'refused', detail: 'protocol-mismatch' };
		}
		if (lockTime > 0 || remainingAttempts === 0) {
			return { status: 'refused', detail: 'lockout' };
		}
		if (evidence.profile?.id !== profile.id) {
			return { status: 'refused', detail: 'protocol-mismatch' };
		}
		switch (profile.algorithm) {
			case 'legacy-base64':
				return this.login(
					request,
					profile,
					Buffer.from(this.options.credentials.password).toString('base64'),
				);
			case 'login-salted-sha256': {
				const ld = evidence.record.LD;
				if (typeof ld !== 'string') return { status: 'refused', detail: 'protocol-mismatch' };
				return this.login(
					request,
					profile,
					sha256(`${sha256(this.options.credentials.password)}${ld}`),
				);
			}
			case 'multi-user-salted-sha256':
				return this.loginSalted(request, profile, evidence.record);
			default: {
				const exhaustive: never = profile.algorithm;
				return exhaustive;
			}
		}
	}

	protected async probeEvidence(request: ProviderMatchRequest): Promise<ZteEvidence | undefined> {
		const response = await this.get(ZTE_EVIDENCE_CMD, undefined, true);
		const record = response.status === 200 ? parseZteRecord(response.body) : undefined;
		if (record === undefined) return undefined;
		const evidence = { record, profile: profileFromEvidence(request.firmware, record) };
		this.#evidence.set(this.sessionKey(request), evidence);
		return evidence;
	}

	protected sessionCookie(request: ProviderMatchRequest): string | undefined {
		return this.#sessions.get(this.sessionKey(request))?.cookie;
	}

	protected get(cmd: string, cookie?: string, multiData = false): Promise<ZteHttpResponse> {
		const query = new URLSearchParams({ isTest: 'false', cmd });
		if (multiData) query.set('multi_data', '1');
		return this.request('GET', `${ZTE_PATHS.get}?${query.toString()}`, undefined, cookie);
	}

	private async login(
		request: ProviderMatchRequest,
		profile: ZteProfile,
		password: string,
	): Promise<AuthenticatedProfileResult> {
		const response = await this.post(
			new URLSearchParams({
				goformId: 'LOGIN',
				isTest: 'false',
				password,
			}).toString(),
		);
		const result = classifyLogin(response);
		if (result.status === 'refused') return result;
		this.#sessions.set(this.sessionKey(request), { cookie: result.cookie });
		return { status: 'matched', profile: profile.id, detail: 'login-ok' };
	}

	private async loginSalted(
		request: ProviderMatchRequest,
		profile: ZteProfile,
		evidence: Readonly<Record<string, string | number>>,
	): Promise<AuthenticatedProfileResult> {
		const ld = evidence.LD;
		if (typeof ld !== 'string') {
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
		const result = classifyLogin(login);
		if (result.status === 'refused') return result;
		const rd = parseZteRecord((await this.get('RD', result.cookie)).body)?.RD;
		const waVersion = evidence.wa_inner_version;
		const crVersion = evidence.cr_version;
		if (typeof waVersion !== 'string' || typeof crVersion !== 'string' || typeof rd !== 'string') {
			return { status: 'refused', detail: 'protocol-mismatch' };
		}
		this.#sessions.set(this.sessionKey(request), {
			cookie: result.cookie,
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
