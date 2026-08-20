// The transition transaction — the safety-critical core. This proves:
//   - the happy path walks all TEN steps in order and yields a NEW ifname on the SAME
//     stableKey;
//   - the THREE-TIER negative matrix: TIER A entry refusals fire ZERO actor/lease/AT
//     calls; TIER B an in-actor race is caught after exactly one actor entry with zero
//     lease/AT; TIER C a postcondition mismatch fails degraded, never reactivates, and
//     still releases the interlock via finally;
//   - a crash mid-transaction trips the watchdog, force-uninhibits, and returns
//     degraded rather than hanging forever.

import { describe, expect, test } from 'bun:test';
import { epochMillis } from '../domain';
import { connectionId, deviceIfname, type NetworkManagerPort, receipt } from '../ports';
import type { CertifiedCatalog } from '../usb-mode';
import type { UsbDeviceSnapshot } from './device-classifier';
import { ModemActor } from './modem-actor';
import type { TransitionInterlock, UsbModeTransitionRequest } from './transition-preconditions';
import { UsbModeTransition, type UsbModeTransitionDeps } from './usb-mode-transition';

const CACHED_UID = 'pci-0000:00-usb-0:1';
const SKU = {
	vidPid: '2c7c:0125',
	model: 'CERALIVE-SYNTHETIC-TEST-SKU',
	firmwarePrefix: 'SYNTHETICFW01',
};

const TEN_STEPS = [
	'nm-quiesce',
	'inhibit',
	'at-command',
	'await-port-drop',
	'uninhibit',
	'await-reenumeration',
	'postcondition',
	'resolve-ifname',
	'reactivate',
	'release-interlock',
];

const OLD_QMI: UsbDeviceSnapshot = {
	vendorId: '2c7c',
	productId: '0125',
	bDeviceClass: 0,
	physicalUid: CACHED_UID,
	ifname: 'wwan0',
	interfaces: [
		{ interfaceClass: 0xff, interfaceSubClass: 0xff, interfaceProtocol: 0xff, driver: 'qmi_wwan' },
	],
};

/** Re-enumerated as MBIM (target), same physical UID, NEW ifname — matches the catalog. */
const NEW_MBIM: UsbDeviceSnapshot = {
	vendorId: '2c7c',
	productId: '0126',
	bDeviceClass: 0,
	physicalUid: CACHED_UID,
	ifname: 'wwan1',
	interfaces: [
		{ interfaceClass: 0x02, interfaceSubClass: 0x0e, interfaceProtocol: 0x00, driver: 'cdc_mbim' },
		{ interfaceClass: 0x0a, interfaceSubClass: 0x00, interfaceProtocol: 0x02, driver: 'cdc_mbim' },
	],
};

/** Re-enumerated STILL as QMI — the postcondition-mismatch device (same UID). */
const STILL_QMI: UsbDeviceSnapshot = { ...OLD_QMI, ifname: 'wwan0' };

interface SpyLog {
	readonly calls: string[];
}

function makeNm(log: SpyLog): NetworkManagerPort {
	const rcpt = () => receipt('connection', 'applied', 'ok');
	return {
		createGsmProfile: () => Promise.reject(new Error('unused')),
		readGsmProfile: () => Promise.resolve(undefined),
		updateGsmProfile: () => Promise.reject(new Error('unused')),
		deleteGsmProfile: () => Promise.resolve(),
		activate: (_id, ifname) => {
			log.calls.push(`nm.activate:${ifname}`);
			return Promise.resolve(rcpt());
		},
		deactivate: () => Promise.resolve(rcpt()),
		acquireQuiesceLease: (id, ifname) => {
			log.calls.push('nm.acquireQuiesceLease');
			return Promise.resolve({
				connectionId: id,
				deviceIfname: ifname,
				acquiredAt: epochMillis(0),
			});
		},
		releaseQuiesceLease: () => {
			log.calls.push('nm.releaseQuiesceLease');
			return Promise.resolve();
		},
	};
}

function makeMm(log: SpyLog): Pick<UsbModeTransitionDeps['modemManager'], 'inhibit' | 'uninhibit'> {
	return {
		inhibit: (uid) => {
			log.calls.push(`mm.inhibit:${uid}`);
			return Promise.resolve({ uid, acquiredAt: epochMillis(0) });
		},
		uninhibit: () => {
			log.calls.push('mm.uninhibit');
			return Promise.resolve();
		},
	};
}

function okSender(log: SpyLog): UsbModeTransitionDeps['atSender'] {
	return {
		send: (command) => {
			log.calls.push(`at.send:${command}`);
			return Promise.resolve({ ok: true, raw: 'OK' });
		},
	};
}

function scriptedEnumerate(
	frames: UsbDeviceSnapshot[][],
): () => Promise<readonly UsbDeviceSnapshot[]> {
	let i = 0;
	return () => {
		const frame = frames[Math.min(i, frames.length - 1)] ?? [];
		i += 1;
		return Promise.resolve(frame);
	};
}

function makeRequest(overrides: Partial<UsbModeTransitionRequest> = {}): UsbModeTransitionRequest {
	return {
		stableKey: 'slot:test',
		sku: SKU,
		fromMode: 'qmi',
		toMode: 'mbim',
		connectionId: connectionId('uuid-1'),
		deviceIfname: deviceIfname('wwan0'),
		cachedPhysicalUid: CACHED_UID,
		inhibitUid: CACHED_UID,
		confirm: true,
		maintenance: true,
		now: epochMillis(0),
		probeReadiness: () => Promise.resolve({ identityConfidence: 'high' }),
		...overrides,
	};
}

function makeTransition(
	log: SpyLog,
	overrides: Partial<UsbModeTransitionDeps> = {},
): UsbModeTransition {
	return new UsbModeTransition({
		actor: new ModemActor(),
		nm: makeNm(log),
		modemManager: makeMm(log),
		atSender: okSender(log),
		enumerate: scriptedEnumerate([[OLD_QMI], [], [NEW_MBIM]]),
		reenumerationTimeoutMs: 500,
		pollIntervalMs: 1,
		watchdogMs: 200,
		...overrides,
	});
}

describe('UsbModeTransition — the happy path walks all ten steps', () => {
	test('a certified qmi→mbim transition succeeds with a NEW ifname on the same stableKey', async () => {
		const log: SpyLog = { calls: [] };
		const transition = makeTransition(log);
		const request = makeRequest();
		const outcome = await transition.execute(request);

		expect(outcome.status).toBe('succeeded');
		if (outcome.status !== 'succeeded') {
			return;
		}
		// The row survives with the SAME stableKey but a NEW ifname.
		expect(request.stableKey).toBe('slot:test');
		expect(String(outcome.newIfname)).toBe('wwan1');
		expect(String(request.deviceIfname)).toBe('wwan0');
		// All ten goal steps, in order.
		expect(outcome.steps.filter((s) => TEN_STEPS.includes(s))).toEqual(TEN_STEPS);
		// The catalog command was sent exactly once; reactivation targeted the new ifname.
		expect(log.calls.filter((c) => c.startsWith('at.send:'))).toEqual([
			'at.send:AT+QCFG="usbnet",2',
		]);
		expect(log.calls).toContain('nm.activate:wwan1');
	});
});

/** No nm/mm/at side-effecting call ran, and the actor was never entered. */
function expectZeroSideEffects(log: SpyLog, steps: readonly string[]): void {
	expect(log.calls).toEqual([]);
	expect(steps).not.toContain('actor-enter');
}

describe('UsbModeTransition — TIER A: entry refusals fire ZERO actor/lease/AT calls', () => {
	const cases: Array<[string, Partial<UsbModeTransitionRequest>]> = [
		['unconfirmed (confirm:false)', { confirm: false }],
		['uncertified SKU (no catalog entry)', { sku: { ...SKU, firmwarePrefix: 'UNKNOWNFW' } }],
		[
			'non-permitted transition (mbim→ecm-ncm not certified)',
			{ fromMode: 'mbim', toMode: 'ecm-ncm' },
		],
		[
			'ambiguous / low-confidence identity',
			{ probeReadiness: () => Promise.resolve({ identityConfidence: 'low' }) },
		],
		['missing maintenance flag', { maintenance: false }],
	];
	for (const [name, overrides] of cases) {
		test(name, async () => {
			const log: SpyLog = { calls: [] };
			const transition = makeTransition(log);
			const outcome = await transition.execute(makeRequest(overrides));
			expect(outcome.status).toBe('refused');
			if (outcome.status === 'refused') {
				expect(outcome.stage).toBe('entry');
			}
			expectZeroSideEffects(log, outcome.steps);
		});
	}

	test('interlock already held → refused at entry, hold never acquired', async () => {
		const log: SpyLog = { calls: [] };
		const heldInterlock: TransitionInterlock = {
			canDisrupt: () => Promise.resolve({ allow: false, reason: 'a stream is admitted' }),
			hold: () => Promise.reject(new Error('hold must not be acquired')),
		};
		const transition = makeTransition(log, { interlock: heldInterlock });
		const outcome = await transition.execute(makeRequest());
		expect(outcome.status).toBe('refused');
		expectZeroSideEffects(log, outcome.steps);
	});
});

describe('UsbModeTransition — TIER B: an in-actor race is caught with zero lease/AT', () => {
	test('valid at entry, invalid in-actor → one actor entry, zero lease/AT calls', async () => {
		const log: SpyLog = { calls: [] };
		let probes = 0;
		const transition = makeTransition(log, {});
		const request = makeRequest({
			// High at entry, low by the time the actor runs (a duplicate IMEI appeared).
			probeReadiness: () => {
				probes += 1;
				return Promise.resolve({ identityConfidence: probes === 1 ? 'high' : 'low' });
			},
		});
		const outcome = await transition.execute(request);

		expect(outcome.status).toBe('refused');
		if (outcome.status === 'refused') {
			expect(outcome.stage).toBe('in-actor');
		}
		// Exactly one actor entry.
		expect(outcome.steps.filter((s) => s === 'actor-enter')).toEqual(['actor-enter']);
		// Zero lease/AT (and zero nm/mm) calls fired.
		expect(log.calls).toEqual([]);
	});
});

describe('UsbModeTransition — TIER C: a postcondition mismatch fails degraded', () => {
	test('AT returned OK but the device stayed qmi → FAILED+degraded, NO reactivation, interlock released', async () => {
		const log: SpyLog = { calls: [] };
		let holdReleases = 0;
		const interlock: TransitionInterlock = {
			canDisrupt: () => Promise.resolve({ allow: true }),
			hold: () =>
				Promise.resolve({
					release: () => {
						holdReleases += 1;
						return Promise.resolve();
					},
				}),
		};
		const transition = makeTransition(log, {
			interlock,
			// Re-enumerates STILL as qmi — the switch did not take, even though AT said OK.
			enumerate: scriptedEnumerate([[OLD_QMI], [], [STILL_QMI]]),
		});
		const outcome = await transition.execute(makeRequest());

		expect(outcome.status).toBe('failed');
		if (outcome.status === 'failed') {
			expect(outcome.degraded).toBe(true);
			expect(outcome.reason).toContain('postcondition mismatch');
		}
		// The AT command WAS sent (OK ignored) but reactivation NEVER happened.
		expect(log.calls.filter((c) => c.startsWith('at.send:'))).toHaveLength(1);
		expect(log.calls.some((c) => c.startsWith('nm.activate:'))).toBe(false);
		expect(outcome.steps).not.toContain('reactivate');
		// The interlock hook was released via finally, on the failure path.
		expect(outcome.steps).toContain('release-interlock');
		expect(holdReleases).toBe(1);
	});
});

describe('UsbModeTransition — crash mid-transaction trips the watchdog', () => {
	test('a hung AT command force-uninhibits, reprobes, and returns degraded (never hangs)', async () => {
		const log: SpyLog = { calls: [] };
		const hangingSender: UsbModeTransitionDeps['atSender'] = {
			send: (command) => {
				log.calls.push(`at.send:${command}`);
				return new Promise(() => undefined);
			},
		};
		const transition = makeTransition(log, {
			atSender: hangingSender,
			enumerate: scriptedEnumerate([[OLD_QMI]]),
			watchdogMs: 30,
		});
		const outcome = await transition.execute(makeRequest());

		expect(outcome.status).toBe('failed');
		if (outcome.status === 'failed') {
			expect(outcome.degraded).toBe(true);
			expect(outcome.reason).toContain('timed out');
		}
		// The watchdog force-uninhibited the modem and released the interlock.
		expect(outcome.steps).toContain('force-uninhibit');
		expect(outcome.steps).toContain('release-interlock');
		expect(log.calls).toContain('mm.uninhibit');
	});
});

/**
 * A LOCAL fixture SKU, deliberately not a shipped-catalog entry.
 *
 * What is under test here is the ENGINE's behaviour when a catalog entry declares an
 * `applyCommand` — the send order, the allowlist, and the refusal — not whether any
 * particular device is certified. Driving it through the shipped catalog would make this
 * suite a certification claim, and would couple an engine test to a review decision.
 */
const NV_ONLY_SKU = {
	vidPid: '2c7c:0801',
	model: 'CERALIVE-NV-ONLY-TEST-SKU',
	firmwarePrefix: 'NVONLYFW01',
};

/** The transition shape this engine behaviour exists for: the switch only writes NV. */
const NV_ONLY_CATALOG: CertifiedCatalog = {
	schemaVersion: 1,
	entries: [
		{
			...NV_ONLY_SKU,
			canonicalMode: 'qmi',
			permittedTransitions: [
				{
					from: 'qmi',
					to: 'mbim',
					atCommand: 'AT+QCFG="usbnet",2',
					applyCommand: 'AT+CFUN=1,1',
					expectedResponse: 'OK',
					expectsPortDrop: true,
					expectedDescriptors: {
						deviceClass: 0,
						interfaces: [
							{ interfaceClass: 0x02, interfaceSubClass: 0x0e, interfaceProtocol: 0x00 },
							{ interfaceClass: 0x0a, interfaceSubClass: 0x00, interfaceProtocol: 0x02 },
						],
					},
				},
				{
					from: 'mbim',
					to: 'qmi',
					atCommand: 'AT+QCFG="usbnet",0',
					applyCommand: 'AT+CFUN=1,1',
					expectedResponse: 'OK',
					expectsPortDrop: true,
					expectedDescriptors: {
						deviceClass: 0,
						interfaces: [
							{ interfaceClass: 0xff, interfaceSubClass: 0xff, interfaceProtocol: 0xff },
						],
					},
				},
			],
		},
	],
};

/** Descriptors transcribed from the 2026-08-19 bench capture of `4-1.4.4` on usbnet=0. */
const NV_ONLY_QMI: UsbDeviceSnapshot = {
	vendorId: '2c7c',
	productId: '0801',
	bDeviceClass: 0,
	physicalUid: CACHED_UID,
	ifname: 'wwan2',
	interfaces: [
		{ interfaceClass: 0xff, interfaceSubClass: 0xff, interfaceProtocol: 0x30, driver: 'option' },
		{ interfaceClass: 0xff, interfaceSubClass: 0x00, interfaceProtocol: 0x40, driver: 'option' },
		{ interfaceClass: 0xff, interfaceSubClass: 0x00, interfaceProtocol: 0x00, driver: 'option' },
		{ interfaceClass: 0xff, interfaceSubClass: 0x00, interfaceProtocol: 0x00, driver: 'option' },
		{ interfaceClass: 0xff, interfaceSubClass: 0xff, interfaceProtocol: 0xff, driver: 'qmi_wwan' },
	],
};

/** From the same capture on usbnet=2 — the PID is UNCHANGED across the switch. */
const NV_ONLY_MBIM: UsbDeviceSnapshot = {
	...NV_ONLY_QMI,
	ifname: 'wwan3',
	interfaces: [
		{ interfaceClass: 0xff, interfaceSubClass: 0xff, interfaceProtocol: 0x30, driver: 'option' },
		{ interfaceClass: 0xff, interfaceSubClass: 0x00, interfaceProtocol: 0x40, driver: 'option' },
		{ interfaceClass: 0xff, interfaceSubClass: 0x00, interfaceProtocol: 0x00, driver: 'option' },
		{ interfaceClass: 0xff, interfaceSubClass: 0x00, interfaceProtocol: 0x00, driver: 'option' },
		{ interfaceClass: 0x02, interfaceSubClass: 0x0e, interfaceProtocol: 0x00, driver: 'cdc_mbim' },
		{ interfaceClass: 0x0a, interfaceSubClass: 0x00, interfaceProtocol: 0x02, driver: 'cdc_mbim' },
	],
};

function nvOnlyRequest(fromMode: 'qmi' | 'mbim', toMode: 'qmi' | 'mbim'): UsbModeTransitionRequest {
	return makeRequest({ sku: NV_ONLY_SKU, fromMode, toMode, deviceIfname: deviceIfname('wwan2') });
}

describe('UsbModeTransition — a SKU whose AT command only writes NV also sends applyCommand', () => {
	test('qmi→mbim sends the switch THEN the commit, in that order', async () => {
		const log: SpyLog = { calls: [] };
		const transition = makeTransition(log, {
			catalog: NV_ONLY_CATALOG,
			enumerate: scriptedEnumerate([[NV_ONLY_QMI], [], [NV_ONLY_MBIM]]),
		});

		const outcome = await transition.execute(nvOnlyRequest('qmi', 'mbim'));

		expect(outcome.status).toBe('succeeded');
		expect(log.calls.filter((c) => c.startsWith('at.send:'))).toEqual([
			'at.send:AT+QCFG="usbnet",2',
			'at.send:AT+CFUN=1,1',
		]);
		// The commit is its OWN step, so a transcript distinguishes it from a retry.
		expect(outcome.steps.indexOf('apply-command')).toBeGreaterThan(
			outcome.steps.indexOf('at-command'),
		);
		expect(outcome.steps.indexOf('await-port-drop')).toBeGreaterThan(
			outcome.steps.indexOf('apply-command'),
		);
	});

	test('mbim→qmi sends the reverse switch and the SAME commit', async () => {
		const log: SpyLog = { calls: [] };
		const transition = makeTransition(log, {
			catalog: NV_ONLY_CATALOG,
			enumerate: scriptedEnumerate([[NV_ONLY_MBIM], [], [NV_ONLY_QMI]]),
		});

		const outcome = await transition.execute(nvOnlyRequest('mbim', 'qmi'));

		expect(outcome.status).toBe('succeeded');
		expect(log.calls.filter((c) => c.startsWith('at.send:'))).toEqual([
			'at.send:AT+QCFG="usbnet",0',
			'at.send:AT+CFUN=1,1',
		]);
	});

	test('a SKU that declares NO applyCommand still sends exactly one command', async () => {
		const log: SpyLog = { calls: [] };
		const transition = makeTransition(log);

		const outcome = await transition.execute(makeRequest());

		expect(outcome.status).toBe('succeeded');
		expect(log.calls.filter((c) => c.startsWith('at.send:'))).toHaveLength(1);
		expect(outcome.steps).not.toContain('apply-command');
	});

	test('a commit command that the AT layer REJECTS fails the transaction, never a silent skip', async () => {
		const log: SpyLog = { calls: [] };
		const rejectingSender: UsbModeTransitionDeps['atSender'] = {
			send: (command) => {
				log.calls.push(`at.send:${command}`);
				return command === 'AT+CFUN=1,1'
					? Promise.reject(new Error('commit refused by module'))
					: Promise.resolve({ ok: true, raw: 'OK' });
			},
		};
		const transition = makeTransition(log, {
			atSender: rejectingSender,
			catalog: NV_ONLY_CATALOG,
			enumerate: scriptedEnumerate([[NV_ONLY_QMI], [], [NV_ONLY_MBIM]]),
		});

		const outcome = await transition.execute(nvOnlyRequest('qmi', 'mbim'));

		expect(outcome.status).toBe('failed');
		if (outcome.status === 'failed') {
			expect(outcome.degraded).toBe(true);
			expect(outcome.reason).toContain('commit refused by module');
		}
		expect(log.calls.some((c) => c.startsWith('nm.activate:'))).toBe(false);
		expect(log.calls).toContain('mm.uninhibit');
	});
});
