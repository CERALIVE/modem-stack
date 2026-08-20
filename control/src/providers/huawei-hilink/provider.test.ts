import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { ResourceOwnershipPort } from '../../ports/resource-ownership';
import { createHuaweiHiLinkDefinition, HILINK_PATHS, HILINK_PROFILES } from './provider';
import type { HilinkHttpRequest, HilinkHttpResponse, HilinkTransport } from './transport';

const PASSWORD = 'fixture-password';
const USERNAME = 'admin';
const TYPE4_HASH = Buffer.from(
	createHash('sha256')
		.update(
			`${USERNAME}${Buffer.from(createHash('sha256').update(PASSWORD).digest('hex')).toString('base64')}type4-token`,
		)
		.digest('hex'),
).toString('base64');
const acquired: ResourceOwnershipPort = {
	acquire: async () => ({
		status: 'acquired',
		lease: {
			holder: { pid: 1, startedAtEpochMs: 1 },
			lost: new Promise(() => {}),
			release: async () => {},
		},
	}),
};
const context = (profile: string) => ({
	physicalModemId: 'fixture-device' as never,
	generation: 1 as never,
	transport: 'network' as const,
	passiveFacts: [],
	composition: 'rndis',
	firmware: profile.includes('22.200') ? '22.200.05.00.1080' : '22.333.01.00.00',
	profile,
});

function replay(responses: readonly HilinkHttpResponse[]) {
	const calls: HilinkHttpRequest[] = [];
	const pending = [...responses];
	const transport: HilinkTransport = {
		request: async (request) => {
			calls.push(request);
			const response = pending.shift();
			if (response === undefined) throw new Error('unexpected replay request');
			return response;
		},
	};
	return { calls, transport, remaining: () => pending.length };
}

function definition(transport: HilinkTransport, ownership = acquired) {
	return createHuaweiHiLinkDefinition({
		interfaceName: 'eth9',
		adminUrl: 'http://192.168.8.1',
		transport,
		ownership,
		credentials: { username: USERNAME, password: PASSWORD },
	});
}

const session = (token: string, cookie = `SessionID=${token}-cookie`): HilinkHttpResponse => ({
	status: 200,
	body: `<response><SesInfo>${cookie}</SesInfo><TokInfo>${token}</TokInfo></response>`,
});
const state = (passwordType: 3 | 4): HilinkHttpResponse => ({
	status: 200,
	body: `<response><State>-1</State><password_type>${passwordType}</password_type></response>`,
});
const loggedIn: HilinkHttpResponse = {
	status: 200,
	body: '<response>OK</response>',
	headers: {
		'set-cookie': 'SessionID=logged-in; Path=/',
		__requestverificationtoken: 'write-token',
	},
};

describe('Huawei HiLink firmware replay profiles', () => {
	for (const fixture of [
		{
			profile: HILINK_PROFILES[0],
			token: 'type3-token',
			password: Buffer.from(PASSWORD).toString('base64'),
		},
		{ profile: HILINK_PROFILES[1], token: 'type4-token', password: TYPE4_HASH },
	] as const) {
		test(`replays exact ${fixture.profile.id} login request`, async () => {
			const h = replay([session(fixture.token), state(fixture.profile.passwordType), loggedIn]);
			const result = await definition(h.transport).authenticatedProfile?.authenticate(
				context(fixture.profile.id),
				[fixture.profile.id],
			);
			expect(result).toEqual({
				status: 'matched',
				profile: fixture.profile.id,
				detail: 'login-ok',
			});
			expect(h.calls).toHaveLength(3);
			expect(h.calls[2]).toEqual({
				method: 'POST',
				url: `http://192.168.8.1${HILINK_PATHS.login}`,
				body: `<?xml version="1.0" encoding="UTF-8"?><request><Username>${USERNAME}</Username><Password>${fixture.password}</Password><password_type>${fixture.profile.passwordType}</password_type></request>`,
				headers: [
					`Cookie: SessionID=${fixture.token}-cookie`,
					`__RequestVerificationToken: ${fixture.token}`,
					'Content-Type: application/xml',
				],
				interfaceName: 'eth9',
				redirect: 'error',
			});
			expect(h.remaining()).toBe(0);
		});
	}

	test('refuses profile mismatch without cycling to another password algorithm', async () => {
		const h = replay([session('mismatch-token'), state(4)]);
		const profile = HILINK_PROFILES[0];
		const result = await definition(h.transport).authenticatedProfile?.authenticate(
			context(profile.id),
			[profile.id],
		);
		expect(result).toEqual({ status: 'refused', detail: 'profile-mismatch' });
		expect(h.calls).toHaveLength(2);
	});
});

describe('Huawei HiLink write safety', () => {
	test('requires a fresh authenticated readback before reporting applied', async () => {
		const profile = HILINK_PROFILES[1];
		const h = replay([
			session('write-session'),
			state(4),
			loggedIn,
			{ status: 200, body: '<response><dataswitch>0</dataswitch></response>' },
			{ status: 200, body: '<response>OK</response>' },
			session('readback-session'),
			state(4),
			loggedIn,
			{ status: 200, body: '<response><dataswitch>1</dataswitch></response>' },
		]);
		const result = await definition(h.transport)
			.operations(profile.id)
			.data.write(context(profile.id), true);
		expect(result.status).toBe('applied');
		expect(h.calls.map((call) => new URL(call.url).pathname)).toEqual([
			HILINK_PATHS.session,
			HILINK_PATHS.loginState,
			HILINK_PATHS.login,
			HILINK_PATHS.data,
			HILINK_PATHS.data,
			HILINK_PATHS.session,
			HILINK_PATHS.loginState,
			HILINK_PATHS.login,
			HILINK_PATHS.data,
		]);
	});

	test('expires mid-write with no credential retry and no secret in the refusal', async () => {
		const profile = HILINK_PROFILES[0];
		const h = replay([
			session('expired-token', 'SessionID=private-cookie'),
			state(3),
			loggedIn,
			{ status: 200, body: '<response><dataswitch>0</dataswitch></response>' },
			{ status: 200, body: '<response><code>125002</code></response>' },
		]);
		const result = await definition(h.transport)
			.operations(profile.id)
			.data.write(context(profile.id), true);
		expect(result).toMatchObject({ status: 'refused', reason: 'auth-expired' });
		expect(h.calls.filter((call) => call.url.endsWith(HILINK_PATHS.login))).toHaveLength(1);
		const serialized = JSON.stringify(result);
		for (const secret of [PASSWORD, 'private-cookie', Buffer.from(PASSWORD).toString('base64')]) {
			expect(serialized).not.toContain(secret);
		}
	});

	test('does not infer data writability when the data read endpoint refuses capability', async () => {
		const profile = HILINK_PROFILES[0];
		const h = replay([
			session('capability-token'),
			state(3),
			loggedIn,
			{ status: 200, body: '<response><code>112008</code></response>' },
		]);
		const result = await definition(h.transport)
			.operations(profile.id)
			.data.write(context(profile.id), true);
		expect(result).toMatchObject({ status: 'refused', reason: 'capability-unavailable' });
		expect(
			h.calls.some((call) => call.method === 'POST' && call.url.endsWith(HILINK_PATHS.data)),
		).toBe(false);
	});
});
