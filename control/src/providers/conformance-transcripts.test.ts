// Sanitized per-firmware HTTP transcripts, asserted EXACTLY.
//
// The matrix next door proves each device reaches the right provider. This file proves
// the provider got there over the right wire: exact method, exact path, exact query,
// exact form/JSON/XML body, exact header ARRAY (order included) and the exact cookie —
// per firmware profile, end to end through the real matcher rather than through a
// hand-driven call.
//
// The expected transcripts are rebuilt from the protocol in
// `test-support/conformance/transcripts.ts`, not read back from the provider, so this is
// a comparison and not an echo. A `toEqual` on the whole array additionally pins the
// COUNT: an extra request nobody asked for — a second login, a re-probe, a stray
// capability read — fails here even when the decision is unchanged.

import { describe, expect, test } from 'bun:test';
import {
	CONFORMANCE_CASES,
	CONFORMANCE_CREDENTIALS,
	HILINK_FIRMWARE,
	HILINK_PRIMARY_INTERFACE,
	hilinkCookieFor,
	hilinkGet,
	hilinkLoginPost,
	hilinkOpenGet,
	UFI_INTERFACE,
	ufiLoginPost,
	ufiReadPost,
	ZTE_EVIDENCE_CMD,
	ZTE_INTERFACE,
	ZTE_LEGACY_PASSWORD,
	ZTE_MF79U_WA_VERSION,
	ZTE_SALTED_PASSWORD,
	ZTE_STOK,
	ZTE_TELEMETRY_CMD,
	zteGet,
	ztePost,
} from '../../test-support/conformance';
import { HILINK_PATHS } from './huawei-hilink/provider';

async function transcriptsOf(caseId: string) {
	const entry = CONFORMANCE_CASES.find((candidate) => candidate.id === caseId);
	if (entry === undefined) throw new Error(`unknown conformance case: ${caseId}`);
	return (await entry.run()).transcripts;
}

describe('Huawei HiLink per-firmware transcripts', () => {
	test('22.200 password-type-3: one open probe, one session, one state read, ONE login, four capability reads', async () => {
		// Given
		const profile = 'e3372h-22.200-password-type-3' as const;
		const cookie = hilinkCookieFor(profile);

		// When
		const transcripts = await transcriptsOf('fleet/huawei-e3372h-22.200');

		// Then
		expect(transcripts.hilink).toEqual([
			hilinkOpenGet(HILINK_PATHS.session, HILINK_PRIMARY_INTERFACE),
			hilinkOpenGet(HILINK_PATHS.session, HILINK_PRIMARY_INTERFACE),
			hilinkGet(HILINK_PATHS.loginState, HILINK_PRIMARY_INTERFACE, cookie),
			hilinkLoginPost(profile, HILINK_PRIMARY_INTERFACE),
			hilinkGet(HILINK_PATHS.status, HILINK_PRIMARY_INTERFACE, cookie),
			hilinkGet(HILINK_PATHS.signal, HILINK_PRIMARY_INTERFACE, cookie),
			hilinkGet(HILINK_PATHS.modeList, HILINK_PRIMARY_INTERFACE, cookie),
			hilinkGet(HILINK_PATHS.data, HILINK_PRIMARY_INTERFACE, cookie),
		]);
	});

	test('22.333 password-type-4: identical shape, a DIFFERENT derived password document', async () => {
		// Given
		const profile = 'e3372h-22.333-password-type-4' as const;
		const cookie = hilinkCookieFor(profile);

		// When
		const transcripts = await transcriptsOf('fleet/huawei-e3372h-22.333');

		// Then
		expect(transcripts.hilink).toEqual([
			hilinkOpenGet(HILINK_PATHS.session, HILINK_PRIMARY_INTERFACE),
			hilinkOpenGet(HILINK_PATHS.session, HILINK_PRIMARY_INTERFACE),
			hilinkGet(HILINK_PATHS.loginState, HILINK_PRIMARY_INTERFACE, cookie),
			hilinkLoginPost(profile, HILINK_PRIMARY_INTERFACE),
			hilinkGet(HILINK_PATHS.status, HILINK_PRIMARY_INTERFACE, cookie),
			hilinkGet(HILINK_PATHS.signal, HILINK_PRIMARY_INTERFACE, cookie),
			hilinkGet(HILINK_PATHS.modeList, HILINK_PRIMARY_INTERFACE, cookie),
			hilinkGet(HILINK_PATHS.data, HILINK_PRIMARY_INTERFACE, cookie),
		]);
	});

	test('the two firmwares never share a login document, and neither carries the raw password', async () => {
		// Given
		const type3 = hilinkLoginPost('e3372h-22.200-password-type-3', HILINK_PRIMARY_INTERFACE);
		const type4 = hilinkLoginPost('e3372h-22.333-password-type-4', HILINK_PRIMARY_INTERFACE);

		// When
		const documents = [type3.body, type4.body].map((body) =>
			body.kind === 'xml' ? body.text : '',
		);

		// Then
		expect(documents[0]).not.toEqual(documents[1]);
		expect(documents[0]).toContain('<password_type>3</password_type>');
		expect(documents[1]).toContain('<password_type>4</password_type>');
		for (const document of documents) {
			expect(document).not.toContain(CONFORMANCE_CREDENTIALS.password);
		}
		expect(HILINK_FIRMWARE['e3372h-22.200-password-type-3']).not.toBe(
			HILINK_FIRMWARE['e3372h-22.333-password-type-4'],
		);
	});
});

describe('ZTE goform per-firmware transcripts', () => {
	test('MF79U B03: one batched evidence GET selects salted SHA-256 under bare LOGIN', async () => {
		// When
		const transcripts = await transcriptsOf('fleet/zte-mf79u');

		// Then
		expect(transcripts.zte).toEqual([
			zteGet(ZTE_EVIDENCE_CMD, ZTE_INTERFACE, { multiData: true }),
			ztePost({ goformId: 'LOGIN', isTest: 'false', password: ZTE_SALTED_PASSWORD }, ZTE_INTERFACE),
			zteGet(ZTE_TELEMETRY_CMD, ZTE_INTERFACE),
		]);
	});

	test('MF266 salted: LD challenge, salted login, then AD derivation over the stok cookie', async () => {
		// When
		const transcripts = await transcriptsOf('fleet/zte-mf266');

		// Then
		expect(transcripts.zte).toEqual([
			zteGet(ZTE_EVIDENCE_CMD, ZTE_INTERFACE, { multiData: true }),
			ztePost(
				{
					goformId: 'LOGIN_MULTI_USER',
					isTest: 'false',
					password: ZTE_SALTED_PASSWORD,
					IP: 'localhost',
					user: CONFORMANCE_CREDENTIALS.username,
				},
				ZTE_INTERFACE,
			),
			zteGet('RD', ZTE_INTERFACE, { cookie: ZTE_STOK }),
			zteGet(ZTE_TELEMETRY_CMD, ZTE_INTERFACE),
		]);
	});

	test('all three password shapes stay distinct and no wire value carries the raw password', () => {
		// Given / When / Then
		expect(ZTE_LEGACY_PASSWORD).not.toBe(ZTE_SALTED_PASSWORD);
		expect(ZTE_LEGACY_PASSWORD).not.toContain(CONFORMANCE_CREDENTIALS.password);
		expect(ZTE_SALTED_PASSWORD).toMatch(/^[0-9A-F]{64}$/);
		expect(ZTE_MF79U_WA_VERSION).toBe('BD_XCBZHKMF79UV1.0.0B03');
	});
});

describe('UFI / HIMI transcript', () => {
	test('one endpoint, one method, the verb in the body, and exactly one login', async () => {
		// When
		const transcripts = await transcriptsOf('fleet/ufi-himi-9024');

		// Then
		expect(transcripts.ufi).toEqual([
			ufiLoginPost(UFI_INTERFACE),
			ufiReadPost('getallstatus', UFI_INTERFACE),
			ufiReadPost('getsysinfo', UFI_INTERFACE),
		]);
		expect(transcripts.ufi.every((exchange) => exchange.method === 'POST')).toBe(true);
		expect(new Set(transcripts.ufi.map((exchange) => exchange.path)).size).toBe(1);
	});

	test('the firmware-specific product id takes the SAME read-only transcript', async () => {
		// When
		const transcripts = await transcriptsOf('fleet/ufi-himi-9091');

		// Then
		expect(transcripts.ufi).toEqual([
			ufiLoginPost(UFI_INTERFACE),
			ufiReadPost('getallstatus', UFI_INTERFACE),
			ufiReadPost('getsysinfo', UFI_INTERFACE),
		]);
	});
});

describe('every transcript is interface-bound and redirect-refusing', () => {
	test('no request in the whole corpus leaves an interface unset or follows a redirect', async () => {
		// Given
		const caseIds = CONFORMANCE_CASES.filter((entry) => entry.kind === 'fleet-profile').map(
			(entry) => entry.id,
		);

		// When
		const exchanges = (
			await Promise.all(
				caseIds.map(async (id) => {
					const transcripts = await transcriptsOf(id);
					return [
						...transcripts.hilink,
						...transcripts.hilinkTwin,
						...transcripts.zte,
						...transcripts.ufi,
					];
				}),
			)
		).flat();

		// Then
		expect(exchanges.length).toBeGreaterThan(0);
		for (const exchange of exchanges) {
			expect(exchange.redirect).toBe('error');
			expect(exchange.interfaceName.length).toBeGreaterThan(0);
		}
	});
});
