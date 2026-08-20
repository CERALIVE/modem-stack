// Expected transcripts — the exact wire a firmware profile is entitled to see.
//
// These builders are written from the PROTOCOL, not from the provider: a HiLink session
// GET carries no headers at all, an authenticated HiLink GET carries exactly one
// `Cookie:`, a HiLink POST carries cookie + verification token + content-type IN THAT
// ORDER, a goform request always carries browser-equivalent `Origin`/`Referer`, and a
// HIMI read carries `Authorization` before its content-type. Rebuilding them here is
// what makes `toEqual` against a recorded transcript an assertion rather than an echo.
//
// Header ORDER is part of the literal on purpose. A router firmware that rejects an
// out-of-order request is a real class of failure, and an order-insensitive comparison
// cannot see the day a refactor reorders them.

import { HILINK_PATHS } from '../../src/providers/huawei-hilink/provider';
import { UFI_API_PATH } from '../../src/providers/ufi-himi/transport';
import { ZTE_PATHS } from '../../src/providers/zte-goform/provider';
import {
	CONFORMANCE_CREDENTIALS,
	HILINK_TOKENS,
	type HilinkProfileId,
	hilinkLoginDocument,
	UFI_SESSION,
	ZTE_ADMIN_URL,
} from './corpus';
import type { RecordedExchange } from './exchange';

/** The `SessionID=…` cookie a HiLink profile's session document hands out. */
export function hilinkCookieFor(profileId: HilinkProfileId): string {
	return `SessionID=${HILINK_TOKENS[profileId]}-cookie`;
}

/** An unauthenticated HiLink GET — no cookie, no token, no headers whatsoever. */
export function hilinkOpenGet(path: string, interfaceName: string): RecordedExchange {
	return {
		provider: 'huawei-hilink',
		method: 'GET',
		path,
		query: {},
		headers: [],
		cookie: undefined,
		body: { kind: 'none' },
		interfaceName,
		redirect: 'error',
	};
}

/** An authenticated HiLink GET — exactly one `Cookie:` header and nothing else. */
export function hilinkGet(path: string, interfaceName: string, cookie: string): RecordedExchange {
	return {
		provider: 'huawei-hilink',
		method: 'GET',
		path,
		query: {},
		headers: [`Cookie: ${cookie}`],
		cookie,
		body: { kind: 'none' },
		interfaceName,
		redirect: 'error',
	};
}

/** The ONE login POST a profile is allowed, with its exact derived password document. */
export function hilinkLoginPost(
	profileId: HilinkProfileId,
	interfaceName: string,
): RecordedExchange {
	const cookie = hilinkCookieFor(profileId);
	return {
		provider: 'huawei-hilink',
		method: 'POST',
		path: HILINK_PATHS.login,
		query: {},
		headers: [
			`Cookie: ${cookie}`,
			`__RequestVerificationToken: ${HILINK_TOKENS[profileId]}`,
			'Content-Type: application/xml',
		],
		cookie,
		body: { kind: 'xml', text: hilinkLoginDocument(profileId) },
		interfaceName,
		redirect: 'error',
	};
}

/** A goform GET. `multiData` adds `multi_data=1`; `cookie` adds the `stok` jar entry. */
export function zteGet(
	cmd: string,
	interfaceName: string,
	options: { readonly cookie?: string; readonly multiData?: boolean } = {},
): RecordedExchange {
	const query: Record<string, string> = { isTest: 'false', cmd };
	if (options.multiData === true) query.multi_data = '1';
	return {
		provider: 'zte-goform',
		method: 'GET',
		path: ZTE_PATHS.get,
		query,
		headers: [
			...(options.cookie === undefined ? [] : [`Cookie: ${options.cookie}`]),
			`Origin: ${ZTE_ADMIN_URL}`,
			`Referer: ${ZTE_ADMIN_URL}/index.html`,
		],
		cookie: options.cookie,
		body: { kind: 'none' },
		interfaceName,
		redirect: 'error',
	};
}

/** A goform POST — form-encoded, browser-equivalent, never JSON. */
export function ztePost(
	fields: Readonly<Record<string, string>>,
	interfaceName: string,
): RecordedExchange {
	return {
		provider: 'zte-goform',
		method: 'POST',
		path: ZTE_PATHS.set,
		query: {},
		headers: [
			'Content-Type: application/x-www-form-urlencoded; charset=UTF-8',
			`Origin: ${ZTE_ADMIN_URL}`,
			`Referer: ${ZTE_ADMIN_URL}/index.html`,
		],
		cookie: undefined,
		body: { kind: 'form', fields },
		interfaceName,
		redirect: 'error',
	};
}

/** The HIMI login POST — the ONE command in the vocabulary that is not a `get*`. */
export function ufiLoginPost(interfaceName: string): RecordedExchange {
	return {
		provider: 'ufi-himi',
		method: 'POST',
		path: UFI_API_PATH,
		query: {},
		headers: ['Content-Type: application/json;charset=UTF-8'],
		cookie: undefined,
		body: {
			kind: 'json',
			fields: {
				cmdid: 'login',
				username: CONFORMANCE_CREDENTIALS.username,
				password: CONFORMANCE_CREDENTIALS.password,
			},
		},
		interfaceName,
		redirect: 'error',
	};
}

/** A HIMI read — same path, same method, verb in the body, session in the header. */
export function ufiReadPost(command: string, interfaceName: string): RecordedExchange {
	return {
		provider: 'ufi-himi',
		method: 'POST',
		path: UFI_API_PATH,
		query: {},
		headers: [`Authorization: ${UFI_SESSION}`, 'Content-Type: application/json;charset=UTF-8'],
		cookie: undefined,
		body: { kind: 'json', fields: { cmdid: command, sessionId: UFI_SESSION } },
		interfaceName,
		redirect: 'error',
	};
}
