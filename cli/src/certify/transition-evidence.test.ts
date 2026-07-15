// Transition-evidence capture — synthetic fixtures, no real hardware (Phase A).
//
// Proves the evidence is SHAPE-COMPATIBLE with an A4.2 catalog entry: the before/after
// descriptors validate against `expectedDescriptorsSchema`, the AT command comes FROM the
// certified catalog (never invented), and the port-drop / re-enumeration timeline is
// ordered. An uncertified SKU, a non-permitted transition, and a device with no stable
// physical UID each fail loudly.

import { expect, test } from 'bun:test';
import {
	type AtCommandSender,
	type AtResponse,
	expectedDescriptorsSchema,
	type UsbDeviceSnapshot,
} from '@ceralive/modem-control';
import { buildCertificationBundle } from './bundle';
import type { BaseCaptureParts } from './capture';
import { captureTransitionEvidence, type TransitionCaptureDeps } from './transition-evidence';

const QMI_DEVICE: UsbDeviceSnapshot = {
	vendorId: '2c7c',
	productId: '0125',
	model: 'CERALIVE-SYNTHETIC-TEST-SKU',
	firmwareRevision: 'SYNTHETICFW01',
	bDeviceClass: 0,
	physicalUid: 'usb-1-2',
	ifname: 'wwan0',
	interfaces: [
		{ interfaceClass: 255, interfaceSubClass: 255, interfaceProtocol: 255, driver: 'qmi_wwan' },
	],
};

const MBIM_DEVICE: UsbDeviceSnapshot = {
	vendorId: '2c7c',
	productId: '0125',
	model: 'CERALIVE-SYNTHETIC-TEST-SKU',
	firmwareRevision: 'SYNTHETICFW01',
	bDeviceClass: 0,
	physicalUid: 'usb-1-2',
	ifname: 'wwan0',
	interfaces: [
		{ interfaceClass: 2, interfaceSubClass: 14, interfaceProtocol: 0 },
		{ interfaceClass: 10, interfaceSubClass: 0, interfaceProtocol: 2 },
	],
};

interface ScriptedDeps {
	readonly deps: TransitionCaptureDeps;
	readonly sends: string[];
}

/** A scripted transition: qmi present → AT sends → port drops → mbim re-enumerates. */
function scripted(): ScriptedDeps {
	let phase: 'qmi' | 'dropped' | 'mbim' = 'qmi';
	let clock = 0;
	const sends: string[] = [];
	const atSender: AtCommandSender = {
		send(command: string): Promise<AtResponse> {
			sends.push(command);
			phase = 'dropped';
			return Promise.resolve({ ok: true, raw: 'OK' });
		},
	};
	const deps: TransitionCaptureDeps = {
		enumerate() {
			clock += 10;
			if (phase === 'qmi') return Promise.resolve([QMI_DEVICE]);
			if (phase === 'dropped') {
				phase = 'mbim';
				return Promise.resolve([]);
			}
			return Promise.resolve([MBIM_DEVICE]);
		},
		atSender,
		now: () => clock,
		pollIntervalMs: 1,
		timeoutMs: 5000,
	};
	return { deps, sends };
}

test('captures shape-compatible transition evidence with the catalog AT command', async () => {
	const { deps, sends } = scripted();
	const evidence = await captureTransitionEvidence(deps, {
		targetMode: 'mbim',
		device: QMI_DEVICE,
	});

	expect(evidence.from).toBe('qmi');
	expect(evidence.to).toBe('mbim');
	expect(evidence.atCommand).toBe('AT+QCFG="usbnet",2');
	expect(sends).toEqual(['AT+QCFG="usbnet",2']);
	expect(evidence.expectsPortDrop).toBe(true);

	// before/after descriptors are drop-in for a catalog entry's `expectedDescriptors`.
	expect(expectedDescriptorsSchema.safeParse(evidence.beforeDescriptors).success).toBe(true);
	expect(expectedDescriptorsSchema.safeParse(evidence.afterDescriptors).success).toBe(true);
	expect(evidence.afterDescriptors).toEqual({
		deviceClass: 0,
		interfaces: [
			{ interfaceClass: 2, interfaceSubClass: 14, interfaceProtocol: 0 },
			{ interfaceClass: 10, interfaceSubClass: 0, interfaceProtocol: 2 },
		],
	});

	// The timeline records the three transition milestones in order, monotonic in time.
	expect(evidence.timeline.map((e) => e.event)).toEqual([
		'command-sent',
		'port-drop',
		're-enumeration',
	]);
	const times = evidence.timeline.map((e) => e.atMs);
	for (let i = 1; i < times.length; i++) {
		expect(times[i] ?? 0).toBeGreaterThanOrEqual(times[i - 1] ?? 0);
	}
});

test('the evidence embeds into a bundle and validates against the bundle schema', async () => {
	const { deps } = scripted();
	const transition = await captureTransitionEvidence(deps, {
		targetMode: 'mbim',
		device: QMI_DEVICE,
	});
	const base: BaseCaptureParts = {
		usb: { lsusb: 'Device Descriptor:', usbDevices: 'T:', udevProperties: {} },
		modemManager: { mmcliKeyfile: { a: 'b' }, managedObjects: {}, signalWindow: [] },
	};
	const { bundle, sha256 } = buildCertificationBundle({
		slot: 'Modem/0',
		synthetic: true,
		capturedAtMs: 1,
		base,
		transition,
	});
	expect(bundle.transition).toEqual(transition);
	expect(sha256).toMatch(/^[0-9a-f]{64}$/);
});

test('an uncertified SKU fails loudly', async () => {
	const { deps } = scripted();
	const uncertified: UsbDeviceSnapshot = { ...QMI_DEVICE, model: 'UNKNOWN-MODEL' };
	await expect(
		captureTransitionEvidence(deps, { targetMode: 'mbim', device: uncertified }),
	).rejects.toThrow(/no certified catalog entry/);
});

test('a non-permitted transition (mbim -> ecm-ncm) fails loudly', async () => {
	const { deps } = scripted();
	await expect(
		captureTransitionEvidence(deps, { targetMode: 'ecm-ncm', device: MBIM_DEVICE }),
	).rejects.toThrow(/no permitted transition mbim -> ecm-ncm/);
});

test('a device without a stable physical UID fails loudly', async () => {
	const { deps } = scripted();
	const { physicalUid: _drop, ...noUid } = QMI_DEVICE;
	await expect(
		captureTransitionEvidence(deps, { targetMode: 'mbim', device: noUid }),
	).rejects.toThrow(/no stable physical UID/);
});
