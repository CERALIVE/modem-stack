import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createProviderMatcher } from '../matcher';
import { createProviderRegistry } from '../registry';
import {
	createZteGoformDefinition,
	ZTE_PATHS,
	ZTE_PROFILES,
	ZTE_UNKNOWN_PROFILE,
} from './provider';
import type { ZteHttpRequest, ZteHttpResponse, ZteTransport } from './transport';

const PASSWORD = 'fixture-password';
const ADMIN_URL = 'http://192.168.0.1';
const context = (profile: string, firmware: string) => ({
	physicalModemId: 'fixture-zte' as never,
	generation: 1 as never,
	transport: 'network' as const,
	passiveFacts: [{ kind: 'firmware' as const, value: firmware }],
	composition: 'rndis',
	firmware,
	profile,
});

function replay(responses: readonly ZteHttpResponse[]) {
	const calls: ZteHttpRequest[] = [];
	const pending = [...responses];
	const transport: ZteTransport = {
		request: async (request) => {
			calls.push(request);
			const response = pending.shift();
			if (response === undefined) throw new Error('unexpected replay request');
			return response;
		},
	};
	return { calls, transport, remaining: () => pending.length };
}

function definition(transport: ZteTransport) {
	return createZteGoformDefinition({
		interfaceName: 'eth9',
		adminUrl: ADMIN_URL,
		transport,
		credentials: { username: 'admin', password: PASSWORD },
	});
}

const response = (body: string, headers?: Readonly<Record<string, string>>): ZteHttpResponse => ({
	status: 200,
	body,
	...(headers === undefined ? {} : { headers }),
});

describe('ZTE goform firmware replay profiles', () => {
	test('replays the exact MF79U legacy login request once', async () => {
		// Given
		const h = replay([response('{"result":"0"}', { 'set-cookie': 'stok=legacy-token; Path=/' })]);
		const profile = ZTE_PROFILES[0];

		// When
		const result = await definition(h.transport).authenticatedProfile?.authenticate(
			context(profile.id, profile.firmware),
			[profile.id],
		);

		// Then
		expect(result).toEqual({ status: 'matched', profile: profile.id, detail: 'login-ok' });
		expect(h.calls).toEqual([
			{
				method: 'POST',
				url: `${ADMIN_URL}${ZTE_PATHS.set}`,
				body: `goformId=LOGIN&isTest=false&password=${encodeURIComponent(Buffer.from(PASSWORD).toString('base64'))}`,
				headers: [
					'Content-Type: application/x-www-form-urlencoded; charset=UTF-8',
					`Origin: ${ADMIN_URL}`,
					`Referer: ${ADMIN_URL}/index.html`,
				],
				interfaceName: 'eth9',
				redirect: 'error',
			},
		]);
		expect(h.remaining()).toBe(0);
	});

	test('replays the MF266 LD login RD and AD derivation without persisting session material', async () => {
		// Given
		const ld = 'fixture-ld';
		const rd = 'fixture-rd';
		const waVersion = 'BD_MF266V1.0.0B01';
		const crVersion = 'CR_MF266V1.0.0B01';
		const password = createHash('sha256')
			.update(`${createHash('sha256').update(PASSWORD).digest('hex').toUpperCase()}${ld}`)
			.digest('hex')
			.toUpperCase();
		const ad = createHash('sha256')
			.update(
				`${createHash('sha256').update(`${waVersion}${crVersion}`).digest('hex').toUpperCase()}${rd}`,
			)
			.digest('hex')
			.toUpperCase();
		const h = replay([
			response(`{"LD":"${ld}"}`),
			response('{"result":"0"}', { 'set-cookie': 'stok=salted-token; Path=/' }),
			response(`{"wa_inner_version":"${waVersion}","cr_version":"${crVersion}"}`),
			response(`{"RD":"${rd}"}`),
		]);
		const profile = ZTE_PROFILES[1];

		// When
		const result = await definition(h.transport).authenticatedProfile?.authenticate(
			context(profile.id, profile.firmware),
			[profile.id],
		);

		// Then
		expect(result).toEqual({ status: 'matched', profile: profile.id, detail: 'login-ok' });
		expect(
			h.calls.map(({ method, url, body, headers }) => ({ method, url, body, headers })),
		).toEqual([
			{
				method: 'GET',
				url: `${ADMIN_URL}${ZTE_PATHS.get}?isTest=false&cmd=LD`,
				body: undefined,
				headers: [`Origin: ${ADMIN_URL}`, `Referer: ${ADMIN_URL}/index.html`],
			},
			{
				method: 'POST',
				url: `${ADMIN_URL}${ZTE_PATHS.set}`,
				body: `goformId=LOGIN_MULTI_USER&isTest=false&password=${password}&IP=localhost&user=admin`,
				headers: [
					'Content-Type: application/x-www-form-urlencoded; charset=UTF-8',
					`Origin: ${ADMIN_URL}`,
					`Referer: ${ADMIN_URL}/index.html`,
				],
			},
			{
				method: 'GET',
				url: `${ADMIN_URL}${ZTE_PATHS.get}?isTest=false&cmd=wa_inner_version%2Ccr_version&multi_data=1`,
				body: undefined,
				headers: [
					`Cookie: stok=salted-token`,
					`Origin: ${ADMIN_URL}`,
					`Referer: ${ADMIN_URL}/index.html`,
				],
			},
			{
				method: 'GET',
				url: `${ADMIN_URL}${ZTE_PATHS.get}?isTest=false&cmd=RD`,
				body: undefined,
				headers: [
					`Cookie: stok=salted-token`,
					`Origin: ${ADMIN_URL}`,
					`Referer: ${ADMIN_URL}/index.html`,
				],
			},
		]);
		expect(definition(h.transport).contractFixtures[1]?.response).toEqual({
			status: 'matched',
			sessionMaterial: '[redacted]',
			ad: '[redacted]',
		});
		expect(JSON.stringify(result)).not.toContain(ad);
		expect(h.remaining()).toBe(0);
	});

	test('refuses MF266 responses for MF79U without trying a second algorithm', async () => {
		// Given
		const h = replay([response('{"LD":"salted-shape"}')]);
		const profile = ZTE_PROFILES[0];

		// When
		const result = await definition(h.transport).authenticatedProfile?.authenticate(
			context(profile.id, profile.firmware),
			[profile.id],
		);

		// Then
		expect(result).toEqual({ status: 'refused', detail: 'protocol-mismatch' });
		expect(h.calls).toHaveLength(1);
	});

	test('selects unknown ZTE firmware as read-only without authenticating', async () => {
		// Given
		const h = replay([
			response('{"cr_version":"unknown-zte-build","network_type":"LTE"}'),
			response('{"network_type":"LTE","signalbar":"3"}'),
		]);
		const registry = createProviderRegistry();
		registry.register(definition(h.transport));

		// When
		const result = await createProviderMatcher(registry).match(
			context(ZTE_UNKNOWN_PROFILE, 'unknown-zte-build'),
		);

		// Then
		expect(result).toMatchObject({
			status: 'selected',
			provider: 'zte-goform',
			profile: ZTE_UNKNOWN_PROFILE,
			writable: false,
			operations: { access: 'read-only' },
		});
		expect(h.calls.every((call) => call.method === 'GET')).toBe(true);
	});
});
