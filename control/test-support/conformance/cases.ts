// The conformance case table — every fleet profile and every safety case, run through
// the REAL matcher with all four real providers registered at once.
//
// Each provider suite (todos 22/24/25/26) proves its own provider in isolation, with
// only that provider in the registry. That is the right shape for a provider suite and
// it structurally cannot answer the question this table exists for: does a Huawei dongle
// stay a Huawei dongle when a ZTE provider and a UFI provider are also asking? Every
// case below registers ALL FOUR and scripts the three the device is not as devices that
// answer nothing this vendor understands — which is what a real board looks like.
//
// The expectation is the exact decision, not a shape: provider, profile, writable and
// evidence score. A case that is "close enough" is a case that would not notice a
// provider quietly claiming a neighbour's hardware.

import {
	type DeviceGeneration,
	deviceGeneration,
	type PhysicalModemId,
	physicalModemId,
} from '../../src/domain';
import type { ResourceOwnershipPort } from '../../src/ports/resource-ownership';
import {
	createProviderMatcher,
	createProviderRegistry,
	type MatcherScore,
	type PassiveFact,
	type ProviderMatchRequest,
	type ProviderMatchResult,
	type ProviderTransport,
} from '../../src/providers';
import { createHuaweiHiLinkDefinition } from '../../src/providers/huawei-hilink';
import { createModemManagerProvider } from '../../src/providers/modem-manager';
import { createUfiHimiDefinition } from '../../src/providers/ufi-himi';
import { createZteGoformDefinition } from '../../src/providers/zte-goform';
import type { ModemSpec } from '../fake-mm/object-model';
import {
	CONFORMANCE_CREDENTIALS,
	HILINK_ADMIN_URL,
	HILINK_FIRMWARE,
	HILINK_PRIMARY_INTERFACE,
	HILINK_TWIN_INTERFACE,
	hilinkDevice,
	interfaceRoutedDevice,
	UFI_ADMIN_URL,
	UFI_INTERFACE,
	USB_IDS,
	ufiDevice,
	ZTE_ADMIN_URL,
	ZTE_INTERFACE,
	zteDevice,
} from './corpus';
import {
	absentDevice,
	type RecordedExchange,
	recordHilink,
	recordUfi,
	recordZte,
	type ScriptedDevice,
} from './exchange';
import { FakeMmTransport, type RecordedCall } from './mm-transport';

/** Ownership is not what a matcher exercises; an always-granting port keeps it out. */
const grantingOwnership: ResourceOwnershipPort = {
	acquire: async () => ({
		status: 'acquired',
		lease: {
			holder: { pid: 1, startedAtEpochMs: 1 },
			lost: new Promise(() => {}),
			release: async () => {},
		},
	}),
};

export type ScenarioOptions = {
	readonly hilink?: ScriptedDevice;
	readonly hilinkInterface?: string;
	/** A SECOND write-capable HiLink definition with an identical passive fingerprint. */
	readonly hilinkTwin?: ScriptedDevice;
	readonly zte?: ScriptedDevice;
	readonly ufi?: ScriptedDevice;
	readonly mmModems?: readonly ModemSpec[];
};

export type ScenarioTranscripts = {
	readonly hilink: readonly RecordedExchange[];
	readonly hilinkTwin: readonly RecordedExchange[];
	readonly zte: readonly RecordedExchange[];
	readonly ufi: readonly RecordedExchange[];
};

export type ConformanceRun = {
	readonly result: ProviderMatchResult;
	readonly transcripts: ScenarioTranscripts;
	/** Authentication attempts made by the COLLIDING twin — must stay 0 on a tie. */
	readonly twinAuthAttempts: number;
	readonly mmCalls: readonly RecordedCall[];
};

async function runScenario(
	options: ScenarioOptions,
	request: ProviderMatchRequest,
): Promise<ConformanceRun> {
	const hilinkInterface = options.hilinkInterface ?? HILINK_PRIMARY_INTERFACE;
	const hilink = recordHilink(options.hilink ?? absentDevice);
	const hilinkTwin = recordHilink(options.hilinkTwin ?? absentDevice);
	const zte = recordZte(options.zte ?? absentDevice);
	const ufi = recordUfi(options.ufi ?? absentDevice);
	const mm = new FakeMmTransport({ ...(options.mmModems ? { modems: options.mmModems } : {}) });
	const mmProvider = createModemManagerProvider({ transport: mm });

	const registry = createProviderRegistry();
	registry.register(mmProvider.definition);
	registry.register(
		createHuaweiHiLinkDefinition({
			interfaceName: hilinkInterface,
			adminUrl: HILINK_ADMIN_URL,
			transport: hilink.transport,
			ownership: grantingOwnership,
			credentials: CONFORMANCE_CREDENTIALS,
		}),
	);
	let twinAuthAttempts = 0;
	if (options.hilinkTwin !== undefined) {
		const twin = createHuaweiHiLinkDefinition({
			interfaceName: hilinkInterface,
			adminUrl: HILINK_ADMIN_URL,
			transport: hilinkTwin.transport,
			ownership: grantingOwnership,
			credentials: CONFORMANCE_CREDENTIALS,
		});
		const authenticatedProfile = twin.authenticatedProfile;
		registry.register({
			...twin,
			id: 'huawei-hilink-twin',
			...(authenticatedProfile === undefined
				? {}
				: {
						authenticatedProfile: {
							...authenticatedProfile,
							authenticate: async (context, candidates) => {
								twinAuthAttempts += 1;
								return authenticatedProfile.authenticate(context, candidates);
							},
						},
					}),
		});
	}
	registry.register(
		createZteGoformDefinition({
			interfaceName: ZTE_INTERFACE,
			adminUrl: ZTE_ADMIN_URL,
			transport: zte.transport,
			credentials: CONFORMANCE_CREDENTIALS,
		}),
	);
	registry.register(
		createUfiHimiDefinition({
			interfaceName: UFI_INTERFACE,
			adminUrl: UFI_ADMIN_URL,
			transport: ufi.transport,
			credentials: CONFORMANCE_CREDENTIALS,
			now: () => 1_700_000_000_000,
		}),
	);

	try {
		const result = await createProviderMatcher(registry).match(request);
		return {
			result,
			transcripts: {
				hilink: hilink.exchanges,
				hilinkTwin: hilinkTwin.exchanges,
				zte: zte.exchanges,
				ufi: ufi.exchanges,
			},
			twinAuthAttempts,
			mmCalls: mm.calls,
		};
	} finally {
		await mmProvider.stop();
	}
}

const GENERATION: DeviceGeneration = deviceGeneration(1);

function request(options: {
	readonly id: string;
	readonly transport?: ProviderTransport;
	readonly facts?: readonly PassiveFact[];
	readonly firmware?: string;
	readonly composition?: string;
}): ProviderMatchRequest {
	const id: PhysicalModemId = physicalModemId(options.id);
	return {
		physicalModemId: id,
		generation: GENERATION,
		transport: options.transport ?? 'network',
		passiveFacts: options.facts ?? [],
		composition: options.composition ?? 'rndis',
		...(options.firmware === undefined ? {} : { firmware: options.firmware }),
	};
}

const usbFact = (value: string): PassiveFact => ({ kind: 'usb', value });
const firmwareFact = (value: string): PassiveFact => ({ kind: 'firmware', value });

// ── the fleet's ModemManager-managed specs ──────────────────────────────────────────

/** Bench Quectel RM530N-GL. `DeviceIdentifier` is what the identity ladder keys on. */
export const QUECTEL_SPEC: ModemSpec = {
	index: 1,
	manufacturer: 'Quectel',
	model: 'RM530N-GL',
	revision: 'RM530NGLAAR11A02M4G',
	supportedModes: [[7, 0]],
	currentModes: [7, 0],
	supportedBands: [33, 378],
	sims: [{ index: 1, iccid: '8900000000000000001', imsi: '001010000000001', active: true }],
};

/** Bench SIMCom SIM7600G-H. */
export const SIMCOM_SPEC: ModemSpec = {
	index: 2,
	manufacturer: 'SIMCom',
	model: 'SIM7600G-H',
	revision: 'LE20B04SIM7600G22',
	supportedModes: [[4, 0]],
	currentModes: [4, 0],
	sims: [{ index: 2, iccid: '8900000000000000002', imsi: '001010000000002', active: true }],
};

/**
 * Fibocom FM350-GL as the bench sees it: on an M.2→USB carrier, enumerated and managed
 * by ModemManager. `docs/FM350-DECISION.md` keeps its `0e8d:7127` carrier identity out
 * of the USB composition catalog; that is a MODE-CONTROL exclusion, and it says nothing
 * about matching — the modem is still an MM-managed modem and must still be selected.
 */
export const FM350_USB_SPEC: ModemSpec = {
	index: 4,
	manufacturer: 'Fibocom',
	model: 'FM350-GL',
	revision: '81600.0000.00.19.17.10',
	supportedModes: [[15, 0]],
	currentModes: [15, 0],
	location: { capabilities: 4 },
	sims: [{ index: 4, iccid: '8900000000000000004', imsi: '001010000000004', active: true }],
};

// ── case table ──────────────────────────────────────────────────────────────────────

export type ConformanceKind =
	| 'fleet-profile'
	| 'ambiguity'
	| 'malformed'
	| 'auth-expired'
	| 'lockout'
	| 'unknown-firmware'
	| 'wrong-interface'
	| 'wrong-transport';

export type ConformanceExpectation = {
	readonly status: ProviderMatchResult['status'];
	readonly provider: string | null;
	readonly profile: string | null;
	readonly writable: boolean;
	readonly score: MatcherScore;
};

export type ConformanceCase = {
	readonly id: string;
	readonly kind: ConformanceKind;
	readonly summary: string;
	readonly expected: ConformanceExpectation;
	readonly run: () => Promise<ConformanceRun>;
};

const HILINK_A: keyof typeof HILINK_FIRMWARE = 'e3372h-22.200-password-type-3';
const HILINK_B: keyof typeof HILINK_FIRMWARE = 'e3372h-22.333-password-type-4';

const selected = (
	provider: string,
	profile: string,
	writable: boolean,
): ConformanceExpectation => ({
	status: 'selected',
	provider,
	profile,
	writable,
	score: 'supported',
});

const unresolved = (
	status: 'ambiguous' | 'unsupported',
	score: MatcherScore,
): ConformanceExpectation => ({ status, provider: null, profile: null, writable: false, score });

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
	{
		id: 'fleet/mm-quectel-rm530n',
		kind: 'fleet-profile',
		summary: 'MM-managed Quectel RM530N-GL selects the generic runtime profile',
		expected: selected('modemmanager', 'generic-mm', true),
		run: () =>
			runScenario(
				{ mmModems: [QUECTEL_SPEC] },
				request({
					id: 'serial:fake-device-1',
					transport: 'modemmanager',
					composition: 'quectel-rmnet',
				}),
			),
	},
	{
		id: 'fleet/mm-simcom-sim7600',
		kind: 'fleet-profile',
		summary: 'MM-managed SIMCom SIM7600G-H selects the generic runtime profile',
		expected: selected('modemmanager', 'generic-mm', true),
		run: () =>
			runScenario(
				{ mmModems: [SIMCOM_SPEC] },
				request({
					id: 'serial:fake-device-2',
					transport: 'modemmanager',
					composition: 'simcom-ecm',
				}),
			),
	},
	{
		id: 'fleet/mm-fm350-usb',
		kind: 'fleet-profile',
		summary: 'FM350-GL on an M.2→USB carrier stays an MM-managed modem',
		expected: selected('modemmanager', 'generic-mm', true),
		run: () =>
			runScenario(
				{ mmModems: [FM350_USB_SPEC] },
				request({
					id: 'serial:fake-device-4',
					transport: 'modemmanager',
					composition: 'fm350-usb-carrier',
				}),
			),
	},
	{
		id: 'fleet/huawei-e3372h-22.200',
		kind: 'fleet-profile',
		summary: 'HiLink firmware 22.200 selects the password-type-3 profile',
		expected: selected('huawei-hilink', HILINK_A, true),
		run: () =>
			runScenario(
				{ hilink: hilinkDevice({ profileId: HILINK_A }) },
				request({
					id: 'serial:conformance-hilink-a',
					facts: [usbFact(USB_IDS.huaweiE3372h), firmwareFact(HILINK_FIRMWARE[HILINK_A])],
					firmware: HILINK_FIRMWARE[HILINK_A],
				}),
			),
	},
	{
		id: 'fleet/huawei-e3372h-22.333',
		kind: 'fleet-profile',
		summary: 'HiLink firmware 22.333 selects the password-type-4 profile',
		expected: selected('huawei-hilink', HILINK_B, true),
		run: () =>
			runScenario(
				{ hilink: hilinkDevice({ profileId: HILINK_B }) },
				request({
					id: 'serial:conformance-hilink-b',
					facts: [usbFact(USB_IDS.huaweiE3372h), firmwareFact(HILINK_FIRMWARE[HILINK_B])],
					firmware: HILINK_FIRMWARE[HILINK_B],
				}),
			),
	},
	{
		id: 'fleet/zte-mf79u',
		kind: 'fleet-profile',
		summary: 'MF79U B03 evidence selects salted SHA-256 under bare LOGIN and stays read-only',
		expected: selected('zte-goform', 'mf79u-ld-salted', false),
		run: () =>
			runScenario(
				{ zte: zteDevice({ firmware: 'MF79U' }) },
				request({
					id: 'serial:conformance-zte-mf79u',
					facts: [usbFact(USB_IDS.zteMf79u), firmwareFact('MF79U')],
					firmware: 'MF79U',
				}),
			),
	},
	{
		id: 'fleet/zte-mf266',
		kind: 'fleet-profile',
		summary: 'MF266 selects the salted SHA-256 profile and stays read-only',
		expected: selected('zte-goform', 'mf266-salted', false),
		run: () =>
			runScenario(
				{ zte: zteDevice({ firmware: 'MF266' }) },
				request({
					id: 'serial:conformance-zte-mf266',
					facts: [usbFact(USB_IDS.zteMf266), firmwareFact('MF266')],
					firmware: 'MF266',
				}),
			),
	},
	{
		id: 'fleet/ufi-himi-9024',
		kind: 'fleet-profile',
		summary: '05c6:9024 (RNDIS+ADB composition) selects the read-only HIMI profile',
		expected: selected('ufi-himi', 'ufi-himi-read-only', false),
		run: () =>
			runScenario(
				{ ufi: ufiDevice() },
				request({
					id: 'serial:conformance-ufi-9024',
					facts: [usbFact(USB_IDS.ufiRndisAdb)],
				}),
			),
	},
	{
		id: 'fleet/ufi-himi-9091',
		kind: 'fleet-profile',
		summary: '05c6:9091 (firmware-specific, NOT DIAG evidence) selects the same read-only profile',
		expected: selected('ufi-himi', 'ufi-himi-read-only', false),
		run: () =>
			runScenario(
				{ ufi: ufiDevice() },
				request({
					id: 'serial:conformance-ufi-9091',
					facts: [usbFact(USB_IDS.ufiFirmwareSpecific)],
				}),
			),
	},
	{
		id: 'ambiguity/colliding-write-capable-twins',
		kind: 'ambiguity',
		summary: 'two write-capable providers with one fingerprint tie into read-only ambiguity',
		expected: unresolved('ambiguous', 'supported'),
		run: () =>
			runScenario(
				{
					hilink: hilinkDevice({ profileId: HILINK_A }),
					hilinkTwin: hilinkDevice({ profileId: HILINK_A }),
				},
				request({
					id: 'serial:conformance-collision',
					facts: [usbFact(USB_IDS.huaweiE3372h), firmwareFact(HILINK_FIRMWARE[HILINK_A])],
					firmware: HILINK_FIRMWARE[HILINK_A],
				}),
			),
	},
	{
		id: 'ambiguity/zte-cross-profile-refusal',
		kind: 'ambiguity',
		summary: 'MF266-shaped answers to an MF79U login are refused, never re-tried salted',
		expected: unresolved('ambiguous', 'supported'),
		run: () =>
			runScenario(
				{ zte: zteDevice({ firmware: 'MF79U', login: 'salted-shape' }) },
				request({
					id: 'serial:conformance-zte-crossprofile',
					facts: [usbFact(USB_IDS.zteMf79u), firmwareFact('MF79U')],
					firmware: 'MF79U',
				}),
			),
	},
	{
		id: 'malformed/hilink-session-document',
		kind: 'malformed',
		summary: 'an unparseable SesTokInfo refuses the profile instead of guessing one',
		expected: unresolved('ambiguous', 'supported'),
		run: () =>
			runScenario(
				{ hilink: hilinkDevice({ profileId: HILINK_A, session: 'malformed' }) },
				request({
					id: 'serial:conformance-hilink-malformed',
					facts: [usbFact(USB_IDS.huaweiE3372h), firmwareFact(HILINK_FIRMWARE[HILINK_A])],
					firmware: HILINK_FIRMWARE[HILINK_A],
				}),
			),
	},
	{
		id: 'malformed/zte-goform-body',
		kind: 'malformed',
		summary: 'garbage goform evidence refuses to guess between the two MF79U encodings',
		expected: unresolved('ambiguous', 'supported'),
		run: () =>
			runScenario(
				{
					zte: zteDevice({
						firmware: 'MF79U',
						fingerprint: 'malformed',
						telemetry: 'malformed',
					}),
				},
				request({
					id: 'serial:conformance-zte-malformed',
					facts: [usbFact(USB_IDS.zteMf79u), firmwareFact('MF79U')],
					firmware: 'MF79U',
				}),
			),
	},
	{
		id: 'malformed/ufi-himi-body',
		kind: 'malformed',
		summary: 'a non-JSON HIMI body keeps the USB-proven profile read-only and records the conflict',
		expected: selected('ufi-himi', 'ufi-himi-read-only', false),
		run: () =>
			runScenario(
				{ ufi: ufiDevice({ telemetry: 'malformed' }) },
				request({
					id: 'serial:conformance-ufi-malformed',
					facts: [usbFact(USB_IDS.ufiRndisAdb)],
				}),
			),
	},
	{
		id: 'auth-expired/hilink-mid-login',
		kind: 'auth-expired',
		summary: 'HiLink error 125002 during login refuses without a second credential attempt',
		expected: unresolved('ambiguous', 'supported'),
		run: () =>
			runScenario(
				{ hilink: hilinkDevice({ profileId: HILINK_A, login: 'auth-expired' }) },
				request({
					id: 'serial:conformance-hilink-expired',
					facts: [usbFact(USB_IDS.huaweiE3372h), firmwareFact(HILINK_FIRMWARE[HILINK_A])],
					firmware: HILINK_FIRMWARE[HILINK_A],
				}),
			),
	},
	{
		id: 'lockout/zte-mf79u',
		kind: 'lockout',
		summary: 'a positive MF79U lockout probe refuses before any credential attempt',
		expected: unresolved('ambiguous', 'supported'),
		run: () =>
			runScenario(
				{ zte: zteDevice({ firmware: 'MF79U', lockout: true }) },
				request({
					id: 'serial:conformance-zte-lockout',
					facts: [usbFact(USB_IDS.zteMf79u), firmwareFact('MF79U')],
					firmware: 'MF79U',
				}),
			),
	},
	{
		id: 'unknown-firmware/zte-read-only',
		kind: 'unknown-firmware',
		summary: 'unknown ZTE firmware fingerprints into the read-only profile, never an auth guess',
		expected: selected('zte-goform', 'zte-unknown-read-only', false),
		run: () =>
			runScenario(
				{ zte: zteDevice({ firmware: 'unknown' }) },
				request({
					id: 'serial:conformance-zte-unknown',
					facts: [usbFact(USB_IDS.zteMf79u), firmwareFact('ZTE-UNLISTED-BUILD')],
					firmware: 'ZTE-UNLISTED-BUILD',
				}),
			),
	},
	{
		id: 'unknown-firmware/hilink-unlisted',
		kind: 'unknown-firmware',
		summary: 'an unlisted HiLink firmware is unsupported — no profile is inferred from the shape',
		expected: unresolved('unsupported', 'unsupported'),
		run: () =>
			runScenario(
				{ hilink: hilinkDevice({ profileId: HILINK_A }) },
				request({
					id: 'serial:conformance-hilink-unlisted',
					facts: [usbFact(USB_IDS.huaweiE3372h), firmwareFact('22.999.99.00.0000')],
					firmware: '22.999.99.00.0000',
				}),
			),
	},
	{
		id: 'wrong-interface/hilink-duplicate-ip-twin',
		kind: 'wrong-interface',
		summary: 'binding to the wrong twin reaches the other dongle and refuses before login',
		expected: unresolved('ambiguous', 'supported'),
		run: () =>
			runScenario(
				{
					hilinkInterface: HILINK_TWIN_INTERFACE,
					hilink: interfaceRoutedDevice(
						{
							[HILINK_PRIMARY_INTERFACE]: hilinkDevice({ profileId: HILINK_A }),
							[HILINK_TWIN_INTERFACE]: hilinkDevice({
								profileId: HILINK_A,
								reportedPasswordType: 4,
							}),
						},
						absentDevice,
					),
				},
				request({
					id: 'serial:conformance-hilink-twin',
					facts: [usbFact(USB_IDS.huaweiE3372h), firmwareFact(HILINK_FIRMWARE[HILINK_A])],
					firmware: HILINK_FIRMWARE[HILINK_A],
				}),
			),
	},
	{
		id: 'wrong-transport/usb-request-reaches-nobody',
		kind: 'wrong-transport',
		summary: 'a raw-USB request is refused by transport eligibility before any device is touched',
		expected: unresolved('unsupported', 'unsupported'),
		run: () =>
			runScenario(
				{
					hilink: hilinkDevice({ profileId: HILINK_A }),
					zte: zteDevice({ firmware: 'MF79U' }),
					ufi: ufiDevice(),
					mmModems: [QUECTEL_SPEC],
				},
				request({
					id: 'serial:conformance-wrong-transport',
					transport: 'usb',
					facts: [usbFact(USB_IDS.huaweiE3372h), firmwareFact(HILINK_FIRMWARE[HILINK_A])],
					firmware: HILINK_FIRMWARE[HILINK_A],
				}),
			),
	},
];

/** The observed decision, in the same shape the expectation is written in. */
export function observedExpectation(result: ProviderMatchResult): ConformanceExpectation {
	return {
		status: result.status,
		provider: result.provider,
		profile: result.profile,
		writable: result.writable,
		score: result.score,
	};
}
