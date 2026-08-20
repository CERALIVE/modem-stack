// The sanitized per-firmware HTTP transcript corpus.
//
// REPO-LOCAL AND UNPUBLISHED, like everything else under `test-support/`: it is not in
// `control/src`, so `files: ["dist"]` cannot carry it to npm, and it is not the public
// `./testing` contract-fakes surface either.
//
// It REUSES the payload fixtures todos 18/24/25/26 already built rather than minting a
// second set that can drift from them: `HILINK_FIXTURE`, `ZTE_FIXTURE`, `UFI_FIXTURE`
// and the auth-expired/malformed variants all come from `observation-fixtures.ts`. What
// is new here is only what those fixtures do not carry — the session, login and
// challenge documents that sit BEFORE a telemetry read, and the exact request each one
// is answered by.
//
// SANITIZATION IS STRUCTURAL, not a review promise. Every credential is a declared
// literal in `CONFORMANCE_CREDENTIALS` that says in its own text that it is not real,
// and every subscriber-scale identifier anywhere in the corpus is a member of the frozen
// `SANITIZED_SUBSCRIBER_IDENTIFIERS` table with its provenance recorded. A digit run
// that is in the corpus and not in that table fails `conformance-matrix.test.ts`.

import { createHash } from 'node:crypto';
import { HILINK_PATHS } from '../../src/providers/huawei-hilink/provider';
import { UFI_API_PATH } from '../../src/providers/ufi-himi/transport';
import { ZTE_PATHS } from '../../src/providers/zte-goform/provider';
import {
	HILINK_AUTH_EXPIRED_FIXTURE,
	HILINK_FIXTURE,
	UFI_AUTH_EXPIRED_FIXTURE,
	UFI_FIXTURE,
	ZTE_FIXTURE,
	ZTE_MALFORMED_FIXTURE,
} from '../observation-fixtures';
import type { RecordedExchange, ScriptedDevice, ScriptedResponse } from './exchange';
import { goformId, himiCommand, NOT_THIS_VENDOR } from './exchange';

// ── identity and credential sanitation ──────────────────────────────────────────────

/**
 * The ONLY credential any conformance device accepts. It says what it is in its own
 * text so a grep over the corpus cannot mistake it for a captured secret, and it is
 * deliberately NOT read from the environment — `MF79U_BENCH_PASSWORD` and
 * `UFI_BENCH_PASSWORD` are ephemeral bench inputs for the supervised harnesses in
 * todos 25/26 and have no business inside a committed fixture.
 */
export const CONFORMANCE_CREDENTIALS = {
	username: 'admin',
	password: 'conformance-fixture-password-not-a-real-secret',
} as const;

/**
 * Every subscriber-scale identifier the corpus contains, with its provenance.
 *
 * A conformance corpus is the one place a real capture is most likely to be pasted in
 * unedited, so the rule is inverted: a digit run of 14+ characters is a FAILURE unless
 * it is listed here. Each entry is synthetic and says where it came from.
 */
export const SANITIZED_SUBSCRIBER_IDENTIFIERS: readonly {
	readonly value: string;
	readonly kind: 'imsi' | 'iccid' | 'imei' | 'device-identifier';
	readonly provenance: string;
}[] = [
	{
		value: '732123456789012',
		kind: 'imsi',
		provenance:
			'synthetic value already carried by UFI_FIXTURE (test-support/observation-fixtures.ts)',
	},
	{
		value: '8957010000000000001',
		kind: 'iccid',
		provenance:
			'synthetic value already carried by UFI_FIXTURE (test-support/observation-fixtures.ts)',
	},
];

// ── device addresses ────────────────────────────────────────────────────────────────

/**
 * Two HiLink twins on the SAME address. That duplication is the point: a HiLink dongle
 * hard-codes `192.168.8.1`, so a board with two of them can only tell them apart by the
 * interface a request is bound to.
 */
export const HILINK_ADMIN_URL = 'http://192.168.8.1';
export const ZTE_ADMIN_URL = 'http://192.168.0.1';
export const UFI_ADMIN_URL = 'http://192.168.100.1';

export const HILINK_PRIMARY_INTERFACE = 'enx001a2b3c4d01';
export const HILINK_TWIN_INTERFACE = 'enx001a2b3c4d02';
export const ZTE_INTERFACE = 'enx001a2b3c4d03';
export const UFI_INTERFACE = 'enx001a2b3c4d04';

/** USB composition ids the fleet enumerates. Vendor:product only — never a serial. */
export const USB_IDS = {
	huaweiE3372h: '12d1:14dc',
	zteMf79u: '19d2:1405',
	zteMf266: '19d2:1476',
	ufiRndisAdb: '05c6:9024',
	ufiFirmwareSpecific: '05c6:9091',
} as const;

// ── Huawei HiLink documents ─────────────────────────────────────────────────────────

export const HILINK_TOKENS = {
	'e3372h-22.200-password-type-3': 'conformance-hilink-token-22200',
	'e3372h-22.333-password-type-4': 'conformance-hilink-token-22333',
} as const;
export type HilinkProfileId = keyof typeof HILINK_TOKENS;

export const HILINK_FIRMWARE = {
	'e3372h-22.200-password-type-3': '22.200.05.00.1080',
	'e3372h-22.333-password-type-4': '22.333.01.00.00',
} as const;

const hilinkCookie = (token: string): string => `SessionID=${token}-cookie`;

const hilinkSessionBody = (token: string): string =>
	`<response><SesInfo>${hilinkCookie(token)}</SesInfo><TokInfo>${token}</TokInfo></response>`;

/** A `SesTokInfo` reply with neither tag — `parseHilinkSession` answers `undefined`. */
export const HILINK_SESSION_MALFORMED = '<response><error><code>100002</code></error></response>';

const hilinkStateBody = (passwordType: 3 | 4): string =>
	`<response><State>-1</State><password_type>${passwordType}</password_type></response>`;

export const HILINK_LOGIN_OK = '<response>OK</response>';
export const HILINK_LOGIN_AUTH_EXPIRED = '<response><code>125002</code></response>';
export const HILINK_LOGIN_REJECTED = '<response><error><code>108003</code></error></response>';
export const HILINK_DATA_ENABLED = '<response><dataswitch>1</dataswitch></response>';

/** The password each profile's login POST must carry, derived the way the wire does. */
export function hilinkWirePassword(profileId: HilinkProfileId): string {
	const { username, password } = CONFORMANCE_CREDENTIALS;
	if (profileId === 'e3372h-22.200-password-type-3') {
		return Buffer.from(password).toString('base64');
	}
	const token = HILINK_TOKENS[profileId];
	const passwordHash = Buffer.from(createHash('sha256').update(password).digest('hex')).toString(
		'base64',
	);
	const loginHash = createHash('sha256').update(`${username}${passwordHash}${token}`).digest('hex');
	return Buffer.from(loginHash).toString('base64');
}

export function hilinkLoginDocument(profileId: HilinkProfileId): string {
	const passwordType = profileId === 'e3372h-22.200-password-type-3' ? 3 : 4;
	return `<?xml version="1.0" encoding="UTF-8"?><request><Username>${CONFORMANCE_CREDENTIALS.username}</Username><Password>${hilinkWirePassword(profileId)}</Password><password_type>${passwordType}</password_type></request>`;
}

export type HilinkScript = {
	readonly profileId: HilinkProfileId;
	/** What `SesTokInfo` answers. */
	readonly session?: 'valid' | 'malformed' | 'unreachable';
	/** The password type `state-login` REPORTS — a twin reports the other one. */
	readonly reportedPasswordType?: 3 | 4;
	readonly login?: 'ok' | 'auth-expired' | 'rejected';
	readonly telemetry?: 'reported' | 'auth-expired';
};

export function hilinkDevice(script: HilinkScript): ScriptedDevice {
	const token = HILINK_TOKENS[script.profileId];
	const reported =
		script.reportedPasswordType ?? (script.profileId === 'e3372h-22.200-password-type-3' ? 3 : 4);
	const telemetryRefused = script.telemetry === 'auth-expired';
	return (exchange: RecordedExchange): ScriptedResponse => {
		switch (exchange.path) {
			case HILINK_PATHS.session:
				if (script.session === 'unreachable') return { status: 503, body: '' };
				return {
					status: 200,
					body:
						script.session === 'malformed' ? HILINK_SESSION_MALFORMED : hilinkSessionBody(token),
				};
			case HILINK_PATHS.loginState:
				return { status: 200, body: hilinkStateBody(reported) };
			case HILINK_PATHS.login:
				if (script.login === 'auth-expired')
					return { status: 200, body: HILINK_LOGIN_AUTH_EXPIRED };
				if (script.login === 'rejected') return { status: 200, body: HILINK_LOGIN_REJECTED };
				return {
					status: 200,
					body: HILINK_LOGIN_OK,
					headers: {
						'set-cookie': `${hilinkCookie(token)}; Path=/`,
						__requestverificationtoken: token,
					},
				};
			case HILINK_PATHS.status:
				return {
					status: 200,
					body: telemetryRefused ? HILINK_AUTH_EXPIRED_FIXTURE.status : HILINK_FIXTURE.status,
				};
			case HILINK_PATHS.signal:
				return {
					status: 200,
					body: telemetryRefused ? HILINK_AUTH_EXPIRED_FIXTURE.signal : HILINK_FIXTURE.signal,
				};
			case HILINK_PATHS.modeList:
				return {
					status: 200,
					body: telemetryRefused
						? (HILINK_AUTH_EXPIRED_FIXTURE.netModeList ?? '')
						: (HILINK_FIXTURE.netModeList ?? ''),
				};
			case HILINK_PATHS.mode:
				return { status: 200, body: HILINK_FIXTURE.netMode ?? '' };
			case HILINK_PATHS.data:
				return {
					status: 200,
					body: telemetryRefused ? HILINK_LOGIN_AUTH_EXPIRED : HILINK_DATA_ENABLED,
				};
			default:
				return NOT_THIS_VENDOR;
		}
	};
}

/**
 * Two devices behind ONE address, resolved by the interface a request was bound to.
 *
 * This is the duplicate-IP fleet reality, and it is why every provider request carries
 * `interfaceName`. A request bound to an interface nobody claims reaches the fallback —
 * which is the honest answer, because on a real board it reaches whichever twin the
 * route table happened to pick.
 */
export function interfaceRoutedDevice(
	byInterface: Readonly<Record<string, ScriptedDevice>>,
	fallback: ScriptedDevice,
): ScriptedDevice {
	return (exchange) => (byInterface[exchange.interfaceName] ?? fallback)(exchange);
}

// ── ZTE goform documents ────────────────────────────────────────────────────────────

export const ZTE_LD = 'conformance-ld';
export const ZTE_RD = 'conformance-rd';
export const ZTE_STOK = 'stok=conformance-stok';
export const ZTE_WA_VERSION = 'BD_MF266V1.0.0B01';
export const ZTE_CR_VERSION = 'CR_MF266V1.0.0B01';

const sha256Upper = (value: string): string =>
	createHash('sha256').update(value).digest('hex').toUpperCase();

/** The salted password an MF266 `LOGIN_MULTI_USER` must carry. */
export const ZTE_SALTED_PASSWORD = sha256Upper(
	`${sha256Upper(CONFORMANCE_CREDENTIALS.password)}${ZTE_LD}`,
);
/** The legacy MF79U password: base64, form-encoded. */
export const ZTE_LEGACY_PASSWORD = Buffer.from(CONFORMANCE_CREDENTIALS.password).toString('base64');

export const ZTE_FINGERPRINT_BODIES = {
	MF79U: JSON.stringify({ cr_version: 'CR_MF79UV1.0.0B04', network_type: 'LTE' }),
	MF266: JSON.stringify({ cr_version: ZTE_CR_VERSION, network_type: 'LTE' }),
	unknown: JSON.stringify({ cr_version: 'CR_ZTEUNKNOWNV9.9.9', network_type: 'LTE' }),
} as const;

export const ZTE_LOGIN_ACCEPTED = JSON.stringify({ result: '0' });
export const ZTE_LOGIN_REJECTED = JSON.stringify({ result: '3' });
/**
 * The MF79U bench shape that CANNOT be classified from one response: a non-zero result
 * with a lock countdown. Rejection and lockout are indistinguishable here on purpose —
 * separating them is what `scripts/mf79u-diagnose.sh` exists for, and the matcher must
 * refuse identically for both rather than guess.
 */
export const ZTE_LOGIN_LOCKOUT_UNKNOWN = JSON.stringify({ result: '1', lockedTime: '180' });
/** An MF266-shaped challenge answered to a legacy `LOGIN` — the cross-profile trap. */
export const ZTE_LOGIN_SALTED_SHAPE = JSON.stringify({ LD: ZTE_LD });

export type ZteScript = {
	readonly firmware: 'MF79U' | 'MF266' | 'unknown';
	readonly fingerprint?: 'reported' | 'malformed';
	readonly login?: 'ok' | 'rejected' | 'lockout-unknown' | 'salted-shape';
	readonly telemetry?: 'reported' | 'malformed';
};

export const ZTE_FINGERPRINT_CMD = 'cr_version,network_type';
export const ZTE_TELEMETRY_CMD = 'network_type,signalbar,rssi,lte_rsrp,lte_rsrq,lte_snr';
export const ZTE_VERSIONS_CMD = 'wa_inner_version,cr_version';

export function zteDevice(script: ZteScript): ScriptedDevice {
	const loginBody =
		script.login === 'rejected'
			? ZTE_LOGIN_REJECTED
			: script.login === 'lockout-unknown'
				? ZTE_LOGIN_LOCKOUT_UNKNOWN
				: script.login === 'salted-shape'
					? ZTE_LOGIN_SALTED_SHAPE
					: ZTE_LOGIN_ACCEPTED;
	const loginAccepted = script.login === undefined || script.login === 'ok';
	return (exchange: RecordedExchange): ScriptedResponse => {
		if (exchange.method === 'POST' && exchange.path === ZTE_PATHS.set) {
			const id = goformId(exchange);
			if (id !== 'LOGIN' && id !== 'LOGIN_MULTI_USER') return NOT_THIS_VENDOR;
			return loginAccepted
				? {
						status: 200,
						body: loginBody,
						headers: { 'set-cookie': `${ZTE_STOK}; Path=/` },
					}
				: { status: 200, body: loginBody };
		}
		if (exchange.path !== ZTE_PATHS.get) return NOT_THIS_VENDOR;
		switch (exchange.query.cmd) {
			case ZTE_FINGERPRINT_CMD:
				return {
					status: 200,
					body:
						script.fingerprint === 'malformed'
							? ZTE_MALFORMED_FIXTURE.body
							: ZTE_FINGERPRINT_BODIES[script.firmware],
				};
			case 'LD':
				return { status: 200, body: JSON.stringify({ LD: ZTE_LD }) };
			case 'RD':
				return { status: 200, body: JSON.stringify({ RD: ZTE_RD }) };
			case ZTE_VERSIONS_CMD:
				return {
					status: 200,
					body: JSON.stringify({
						wa_inner_version: ZTE_WA_VERSION,
						cr_version: ZTE_CR_VERSION,
					}),
				};
			case ZTE_TELEMETRY_CMD:
				return {
					status: 200,
					body: script.telemetry === 'malformed' ? ZTE_MALFORMED_FIXTURE.body : ZTE_FIXTURE.body,
				};
			default:
				return NOT_THIS_VENDOR;
		}
	};
}

// ── Qualcomm UFI / HIMI documents ───────────────────────────────────────────────────

export const UFI_SESSION = 'conformance-himi-session';
export const UFI_LOGIN_OK = JSON.stringify({ reply: 'ok', session: UFI_SESSION });
export const UFI_LOGIN_REJECTED = JSON.stringify({ reply: 'fail' });
export const UFI_MALFORMED = '<html><body>login</body></html>';

export type UfiScript = {
	readonly login?: 'ok' | 'rejected';
	readonly telemetry?: 'reported' | 'session-out' | 'malformed';
};

export function ufiDevice(script: UfiScript = {}): ScriptedDevice {
	const refused = script.telemetry === 'session-out';
	const malformed = script.telemetry === 'malformed';
	return (exchange: RecordedExchange): ScriptedResponse => {
		if (exchange.path !== UFI_API_PATH) return NOT_THIS_VENDOR;
		const command = himiCommand(exchange);
		if (command === 'login') {
			return {
				status: 200,
				body: script.login === 'rejected' ? UFI_LOGIN_REJECTED : UFI_LOGIN_OK,
			};
		}
		if (malformed) return { status: 200, body: UFI_MALFORMED };
		switch (command) {
			case 'getsysinfo':
				return {
					status: 200,
					body: refused ? UFI_AUTH_EXPIRED_FIXTURE.sysinfo : UFI_FIXTURE.sysinfo,
				};
			case 'getoverview':
				return {
					status: 200,
					body: refused ? UFI_AUTH_EXPIRED_FIXTURE.overview : UFI_FIXTURE.overview,
				};
			case 'getallstatus':
				return {
					status: 200,
					body: refused ? UFI_AUTH_EXPIRED_FIXTURE.status : UFI_FIXTURE.status,
				};
			case 'getproduceinfo':
				return { status: 200, body: UFI_FIXTURE.produceInfo ?? '' };
			default:
				return NOT_THIS_VENDOR;
		}
	};
}

/**
 * Every literal body the corpus can put on the wire, for the sanitization gate.
 *
 * A gate that scanned the module SOURCE would be defeated by a template; scanning the
 * bodies themselves is what makes it a statement about what a device actually answers.
 */
export const CORPUS_BODIES: readonly string[] = [
	hilinkSessionBody(HILINK_TOKENS['e3372h-22.200-password-type-3']),
	hilinkSessionBody(HILINK_TOKENS['e3372h-22.333-password-type-4']),
	HILINK_SESSION_MALFORMED,
	hilinkStateBody(3),
	hilinkStateBody(4),
	HILINK_LOGIN_OK,
	HILINK_LOGIN_AUTH_EXPIRED,
	HILINK_LOGIN_REJECTED,
	HILINK_DATA_ENABLED,
	hilinkLoginDocument('e3372h-22.200-password-type-3'),
	hilinkLoginDocument('e3372h-22.333-password-type-4'),
	HILINK_FIXTURE.status,
	HILINK_FIXTURE.signal,
	HILINK_FIXTURE.netModeList ?? '',
	HILINK_FIXTURE.netMode ?? '',
	HILINK_AUTH_EXPIRED_FIXTURE.status,
	HILINK_AUTH_EXPIRED_FIXTURE.signal,
	HILINK_AUTH_EXPIRED_FIXTURE.netModeList ?? '',
	...Object.values(ZTE_FINGERPRINT_BODIES),
	ZTE_LOGIN_ACCEPTED,
	ZTE_LOGIN_REJECTED,
	ZTE_LOGIN_LOCKOUT_UNKNOWN,
	ZTE_LOGIN_SALTED_SHAPE,
	ZTE_FIXTURE.body,
	ZTE_MALFORMED_FIXTURE.body,
	JSON.stringify({ LD: ZTE_LD }),
	JSON.stringify({ RD: ZTE_RD }),
	JSON.stringify({ wa_inner_version: ZTE_WA_VERSION, cr_version: ZTE_CR_VERSION }),
	UFI_LOGIN_OK,
	UFI_LOGIN_REJECTED,
	UFI_MALFORMED,
	UFI_FIXTURE.sysinfo,
	UFI_FIXTURE.overview,
	UFI_FIXTURE.status,
	UFI_FIXTURE.produceInfo ?? '',
	UFI_AUTH_EXPIRED_FIXTURE.sysinfo,
	UFI_AUTH_EXPIRED_FIXTURE.overview,
	UFI_AUTH_EXPIRED_FIXTURE.status,
];
