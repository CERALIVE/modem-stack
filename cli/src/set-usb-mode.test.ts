// Harness-driven `set-usb-mode` integration — against the fake NM + a scripted AT /
// enumeration, no D-Bus needed. Proves the two behaviours that matter most: omitting
// `--confirm` refuses the transition at ENTRY with ZERO side effects (no AT, no inhibit,
// no nmcli), and supplying `--confirm` drives the certified synthetic-SKU transition to
// success (postcondition-verified re-enumeration into the target mode).

import { expect, test } from 'bun:test';
import {
	type AtCommandSender,
	type AtResponse,
	connectionId,
	deviceIfname,
	epochMillis,
	ModemActor,
	type UsbDeviceSnapshot,
	UsbModeTransition,
	type UsbModeTransitionRequest,
} from '@ceralive/modem-control';
import { FakeNetworkManagerPort } from '../../control/test-support/fake-nm';
import { type RequestResolver, runSetUsbMode, type UsbModeArgs } from './commands/set-usb-mode';
import { capturingIo } from './io';

const SYNTHETIC_SKU = {
	vidPid: '2c7c:0125',
	model: 'CERALIVE-SYNTHETIC-TEST-SKU',
	firmwarePrefix: 'SYNTHETICFW01',
} as const;

function baseRequest(): UsbModeTransitionRequest {
	return {
		stableKey: 'slot-x',
		sku: SYNTHETIC_SKU,
		fromMode: 'qmi',
		toMode: 'mbim',
		connectionId: connectionId('uuid-1'),
		deviceIfname: deviceIfname('wwan0'),
		cachedPhysicalUid: 'usb-1-2',
		inhibitUid: 'usb-1-2',
		confirm: false,
		maintenance: true,
		now: epochMillis(Date.now()),
		probeReadiness: () => Promise.resolve({ identityConfidence: 'high' }),
	};
}

const resolverFor =
	(request: UsbModeTransitionRequest): RequestResolver =>
	(args: UsbModeArgs) =>
		Promise.resolve({ ok: true, request: { ...request, confirm: args.confirm } });

test('set-usb-mode refuses without --confirm and touches nothing', async () => {
	const nm = new FakeNetworkManagerPort();
	const sends: string[] = [];
	const inhibits: string[] = [];
	const atSender: AtCommandSender = {
		send(command: string): Promise<AtResponse> {
			sends.push(command);
			return Promise.resolve({ ok: true, raw: 'OK' });
		},
	};
	const transition = new UsbModeTransition({
		actor: new ModemActor(),
		nm,
		modemManager: {
			inhibit(uid: string) {
				inhibits.push(uid);
				return Promise.resolve({ uid, acquiredAt: epochMillis(Date.now()) });
			},
			uninhibit: () => Promise.resolve(),
		},
		atSender,
		enumerate: () => Promise.resolve([]),
	});
	const io = capturingIo();

	const code = await runSetUsbMode(io, resolverFor(baseRequest()), transition, {
		slot: 'slot-x',
		target: 'mbim',
		confirm: false,
		maintenance: true,
	});

	expect(code).toBe(1);
	expect(io.stdout.join('\n')).toContain('REFUSED (entry)');
	expect(io.stdout.join('\n')).toMatch(/confirm/i);
	// Zero side effects: no AT command, no inhibit, no nmcli call.
	expect(sends).toEqual([]);
	expect(inhibits).toEqual([]);
	expect(nm.runner.calls).toEqual([]);
});

test('set-usb-mode with --confirm runs the certified transition to success', async () => {
	const nm = new FakeNetworkManagerPort();
	const qmiDevice: UsbDeviceSnapshot = {
		vendorId: '2c7c',
		productId: '0125',
		bDeviceClass: 0,
		physicalUid: 'usb-1-2',
		ifname: 'wwan0',
		interfaces: [
			{ interfaceClass: 255, interfaceSubClass: 255, interfaceProtocol: 255, driver: 'qmi_wwan' },
		],
	};
	const mbimDevice: UsbDeviceSnapshot = {
		vendorId: '2c7c',
		productId: '0125',
		bDeviceClass: 0,
		physicalUid: 'usb-1-2',
		ifname: 'wwan0',
		interfaces: [
			{ interfaceClass: 2, interfaceSubClass: 14, interfaceProtocol: 0 },
			{ interfaceClass: 10, interfaceSubClass: 0, interfaceProtocol: 2 },
		],
	};
	let phase: 'qmi' | 'dropped' | 'mbim' = 'qmi';
	const enumerate = (): Promise<readonly UsbDeviceSnapshot[]> => {
		if (phase === 'qmi') {
			return Promise.resolve([qmiDevice]);
		}
		if (phase === 'dropped') {
			phase = 'mbim';
			return Promise.resolve([]);
		}
		return Promise.resolve([mbimDevice]);
	};
	const atSender: AtCommandSender = {
		send(): Promise<AtResponse> {
			phase = 'dropped';
			return Promise.resolve({ ok: true, raw: 'OK' });
		},
	};
	const transition = new UsbModeTransition({
		actor: new ModemActor(),
		nm,
		modemManager: {
			inhibit: (uid: string) => Promise.resolve({ uid, acquiredAt: epochMillis(Date.now()) }),
			uninhibit: () => Promise.resolve(),
		},
		atSender,
		enumerate,
		pollIntervalMs: 5,
		reenumerationTimeoutMs: 2000,
		watchdogMs: 2000,
	});
	const io = capturingIo();

	const code = await runSetUsbMode(io, resolverFor(baseRequest()), transition, {
		slot: 'slot-x',
		target: 'mbim',
		confirm: true,
		maintenance: true,
	});

	expect(code).toBe(0);
	expect(io.stdout.join('\n')).toContain('set-usb-mode: OK');
	expect(io.stdout.join('\n')).toContain('wwan0');
});
