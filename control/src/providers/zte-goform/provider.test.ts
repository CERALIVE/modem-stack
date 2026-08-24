import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createProviderMatcher } from '../matcher';
import { createProviderRegistry } from '../registry';
import {
	createZteGoformDefinition,
	ZTE_EVIDENCE_CMD,
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

const evidence = (values: Readonly<Record<string, string>>): ZteHttpResponse =>
	response(
		JSON.stringify({
			psw_fail_num_str: '5',
			login_lock_time: '0',
			wa_inner_version: 'BD_MF79UV1.0.0B04',
			cr_version: 'CR_MF79UV1.0.0B04',
			...values,
		}),
	);

function profile(profileId: (typeof ZTE_PROFILES)[number]['id']) {
	const selected = ZTE_PROFILES.find((candidate) => candidate.id === profileId);
	if (selected === undefined) throw new Error(`missing ZTE profile fixture: ${profileId}`);
	return selected;
}

describe('ZTE goform firmware replay profiles', () => {
	test('replays the exact MF79U legacy login request once', async () => {
		// Given
		const h = replay([
			evidence({}),
			response('{"result":"0"}', { 'set-cookie': 'stok=legacy-token; Path=/' }),
		]);
		const selectedProfile = profile('mf79u-legacy');

		// When
		const result = await definition(h.transport).authenticatedProfile?.authenticate(
			context(selectedProfile.id, selectedProfile.firmware),
			[selectedProfile.id],
		);

		// Then
		expect(result).toEqual({ status: 'matched', profile: selectedProfile.id, detail: 'login-ok' });
		expect(h.calls).toEqual([
			{
				method: 'GET',
				url: `${ADMIN_URL}${ZTE_PATHS.get}?isTest=false&cmd=${encodeURIComponent(ZTE_EVIDENCE_CMD)}&multi_data=1`,
				headers: [`Origin: ${ADMIN_URL}`, `Referer: ${ADMIN_URL}/index.html`],
				interfaceName: 'eth9',
				redirect: 'error',
			},
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

	test('selects the MF79U LD-salted encoding and posts the exact bare LOGIN body', async () => {
		// Given
		const ld = 'fixture-mf79u-ld';
		const password = createHash('sha256')
			.update(`${createHash('sha256').update(PASSWORD).digest('hex').toUpperCase()}${ld}`)
			.digest('hex')
			.toUpperCase();
		const h = replay([
			evidence({ LD: ld, wa_inner_version: 'BD_XCBZHKMF79UV1.0.0B03' }),
			response('{"result":"0"}', { 'set-cookie': 'stok=mf79u-salted-token; Path=/' }),
		]);
		const selectedProfile = profile('mf79u-ld-salted');

		// When
		const result = await definition(h.transport).authenticatedProfile?.authenticate(
			context(selectedProfile.id, selectedProfile.firmware),
			[selectedProfile.id],
		);

		// Then
		expect(result).toEqual({ status: 'matched', profile: selectedProfile.id, detail: 'login-ok' });
		expect(h.calls[1]?.body).toBe(`goformId=LOGIN&isTest=false&password=${password}`);
		expect(h.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
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
			evidence({ LD: ld, wa_inner_version: waVersion, cr_version: crVersion }),
			response('{"result":"0"}', { 'set-cookie': 'stok=salted-token; Path=/' }),
			response(`{"RD":"${rd}"}`),
		]);
		const selectedProfile = profile('mf266-salted');

		// When
		const result = await definition(h.transport).authenticatedProfile?.authenticate(
			context(selectedProfile.id, selectedProfile.firmware),
			[selectedProfile.id],
		);

		// Then
		expect(result).toEqual({ status: 'matched', profile: selectedProfile.id, detail: 'login-ok' });
		expect(
			h.calls.map(({ method, url, body, headers }) => ({ method, url, body, headers })),
		).toEqual([
			{
				method: 'GET',
				url: `${ADMIN_URL}${ZTE_PATHS.get}?isTest=false&cmd=${encodeURIComponent(ZTE_EVIDENCE_CMD)}&multi_data=1`,
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
				url: `${ADMIN_URL}${ZTE_PATHS.get}?isTest=false&cmd=RD`,
				body: undefined,
				headers: [
					`Cookie: stok=salted-token`,
					`Origin: ${ADMIN_URL}`,
					`Referer: ${ADMIN_URL}/index.html`,
				],
			},
		]);
		expect(
			definition(h.transport).contractFixtures.find((fixture) => fixture.profile === 'mf266-salted')
				?.response,
		).toEqual({
			status: 'matched',
			sessionMaterial: '[redacted]',
			ad: '[redacted]',
		});
		expect(JSON.stringify(result)).not.toContain(ad);
		expect(h.remaining()).toBe(0);
	});

	test('refuses a positive lockout probe before issuing any login POST', async () => {
		// Given
		const h = replay([
			evidence({
				LD: 'fixture-ld',
				wa_inner_version: 'BD_XCBZHKMF79UV1.0.0B03',
				psw_fail_num_str: '0',
				login_lock_time: '180',
			}),
		]);
		const selectedProfile = profile('mf79u-ld-salted');

		// When
		const result = await definition(h.transport).authenticatedProfile?.authenticate(
			context(selectedProfile.id, selectedProfile.firmware),
			[selectedProfile.id],
		);

		// Then
		expect(result).toEqual({ status: 'refused', detail: 'lockout' });
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]?.method).toBe('GET');
		expect(h.calls[0]?.url).toContain(`cmd=${encodeURIComponent(ZTE_EVIDENCE_CMD)}`);
		expect(h.calls.filter((call) => call.method === 'POST')).toEqual([]);
	});

	test('classifies login result 3 as auth-rejection', async () => {
		// Given
		const h = replay([evidence({}), response('{"result":"3"}')]);
		const selectedProfile = profile('mf79u-legacy');

		// When
		const result = await definition(h.transport).authenticatedProfile?.authenticate(
			context(selectedProfile.id, selectedProfile.firmware),
			[selectedProfile.id],
		);

		// Then
		expect(result).toEqual({ status: 'refused', detail: 'auth-rejection' });
		expect(h.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	});

	test('classifies login result 1 as protocol-mismatch without cycling encodings', async () => {
		// Given
		const h = replay([evidence({}), response('{"result":"1"}')]);
		const selectedProfile = profile('mf79u-legacy');

		// When
		const result = await definition(h.transport).authenticatedProfile?.authenticate(
			context(selectedProfile.id, selectedProfile.firmware),
			[selectedProfile.id],
		);

		// Then
		expect(result).toEqual({ status: 'refused', detail: 'protocol-mismatch' });
		expect(h.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
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
