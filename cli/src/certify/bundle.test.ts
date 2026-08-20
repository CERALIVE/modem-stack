// Synthetic-fixture tests for the certification bundle — no real hardware (Phase A).
//
// Proves the three properties that matter: a valid bundle is built from fake tool output
// with a stable, reproducible sha256; a real capture is unambiguously `synthetic: false`;
// subscriber secrets (ICCID / IMSI / EID) are masked EVERYWHERE — the `mmcli -K` keyfile,
// the redacted `GetManagedObjects`, and the udev properties; and a failed or truncated
// capture fails LOUDLY with a named error instead of writing a broken bundle.

import { expect, test } from 'bun:test';
import type { DecodedManagedObjects, UsbDeviceSnapshot } from '@ceralive/modem-control';
import { buildCertificationBundle } from './bundle';
import type { SignalRecord } from './bundle-schema';
import { type BaseCaptureDeps, type BaseCaptureParts, captureBase } from './capture';
import type { CommandResult } from './command-runner';
import { CertifyError } from './errors';

const ICCID = '8900000000000000123';
const IMSI = '001010000000123';
const EID = '89033024000000000000000000012345';
const IMEI = '350000000000001';
const MODEM_REVISION = 'RM530NGLAAR05A01M4G';
const USB_REVISION = '0504';
const RM530N_SYSFS_PATH =
	'/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4';

const LSUSB = `Bus 004 Device 009: ID 2c7c:0801 Quectel RM530N-GL
Device Descriptor:
  bLength                18
  idVendor           0x2c7c Quectel
  idProduct          0x0801
  iSerial                 3 abcdef123456
`;

const USB_DEVICES = `T:  Bus=04 Dev#=  9 Spd=5000
P:  Vendor=2c7c ProdID=0801 Rev=05.04
S:  Product=RM530N-GL
`;

const MMCLI_K = `modem.generic.device-identifier : 0123456789abcdef
modem.generic.equipment-identifier : ${IMEI}
modem.3gpp.imei : ${IMEI}
sim.properties.iccid : ${ICCID}
sim.properties.imsi : ${IMSI}
sim.properties.eid : ${EID}
sim.properties.operator-name : CeraTel
`;

const TREE: DecodedManagedObjects = [
	[
		'/org/freedesktop/ModemManager1/Modem/0',
		[
			[
				'org.freedesktop.ModemManager1.Modem',
				[
					['EquipmentIdentifier', { signature: 's', value: IMEI }],
					['Device', { signature: 's', value: RM530N_SYSFS_PATH }],
					['Physdev', { signature: 's', value: RM530N_SYSFS_PATH }],
					['Revision', { signature: 's', value: MODEM_REVISION }],
					['Sim', { signature: 'o', value: '/org/freedesktop/ModemManager1/SIM/0' }],
					['State', { signature: 'i', value: 8 }],
				],
			],
		],
	],
	[
		'/org/freedesktop/ModemManager1/SIM/0',
		[
			[
				'org.freedesktop.ModemManager1.Sim',
				[
					['SimIdentifier', { signature: 's', value: ICCID }],
					['Imsi', { signature: 's', value: IMSI }],
					['Eid', { signature: 's', value: EID }],
					['OperatorName', { signature: 's', value: 'CeraTel' }],
				],
			],
		],
	],
];

const DEVICE: UsbDeviceSnapshot = {
	vendorId: '2c7c',
	productId: '0801',
	model: 'RM530N-GL',
	firmwareRevision: USB_REVISION,
	bDeviceClass: 0,
	interfaces: [
		{ interfaceClass: 255, interfaceSubClass: 255, interfaceProtocol: 255, driver: 'qmi_wwan' },
	],
	physicalUid: 'platform-xhci-hcd.0.auto-usb-0:1.4.4',
	ifname: 'wwan3',
	udevProperties: {
		ID_VENDOR_ID: '2c7c',
		ID_MODEL_ID: '0801',
		ID_MODEL: 'RM530N-GL',
		ID_REVISION: USB_REVISION,
		ID_SERIAL_SHORT: 'abcdef123456',
		// A udev rule that surfaced the SIM ICCID — proves redaction reaches udev props.
		iccid: ICCID,
	},
};

const SIGNALS: SignalRecord[] = [
	{
		atMs: 10,
		path: '/org/freedesktop/ModemManager1/Modem/0',
		interface: 'org.freedesktop.DBus.Properties',
		member: 'PropertiesChanged',
		changed: ['SignalQuality'],
		invalidated: [],
	},
];

const ok = (stdout: string): CommandResult => ({ stdout, stderr: '', exitCode: 0 });

interface RunnerScript {
	readonly lsusb?: CommandResult;
	readonly usbDevices?: CommandResult;
	readonly mmcli?: CommandResult;
}

function fakeDeps(script: RunnerScript = {}): BaseCaptureDeps {
	return {
		run(command) {
			if (command === 'lsusb') return Promise.resolve(script.lsusb ?? ok(LSUSB));
			if (command === 'usb-devices') return Promise.resolve(script.usbDevices ?? ok(USB_DEVICES));
			if (command === 'mmcli') return Promise.resolve(script.mmcli ?? ok(MMCLI_K));
			return Promise.resolve({ stdout: '', stderr: `unknown ${command}`, exitCode: 127 });
		},
		captureSignalWindow: () => Promise.resolve(SIGNALS),
	};
}

const INPUT = {
	managedObjects: TREE,
	modemPath: '/org/freedesktop/ModemManager1/Modem/0',
	mmcliTarget: '/org/freedesktop/ModemManager1/Modem/0',
	device: DEVICE,
};

const buildFrom = (base: BaseCaptureParts, synthetic: boolean) =>
	buildCertificationBundle({ slot: 'Modem/0', synthetic, capturedAtMs: 1000, base });

test('builds a schema-valid synthetic bundle with a stable, reproducible sha256', async () => {
	const first = buildFrom(await captureBase(fakeDeps(), INPUT), true);
	expect(first.bundle.schemaVersion).toBe(1);
	expect(first.bundle.synthetic).toBe(true);
	expect(first.bundle.sku).toEqual({
		vidPid: '2c7c:0801',
		model: 'RM530N-GL',
		firmwarePrefix: MODEM_REVISION,
	});
	expect(first.sha256).toMatch(/^[0-9a-f]{64}$/);

	const second = buildFrom(await captureBase(fakeDeps(), INPUT), true);
	expect(second.sha256).toBe(first.sha256);
});

test('uses Modem.Revision rather than USB ID_REVISION for the firmware-keyed SKU', async () => {
	// Given
	const deps = fakeDeps();

	// When
	const base = await captureBase(deps, INPUT);

	// Then
	expect(base.sku?.firmwarePrefix).toBe(MODEM_REVISION);
	expect(base.sku?.firmwarePrefix).not.toBe(USB_REVISION);
});

test('a real capture is unambiguously marked synthetic:false', async () => {
	const { bundle } = buildFrom(await captureBase(fakeDeps(), INPUT), false);
	expect(bundle.synthetic).toBe(false);
});

test('redacts subscriber and modem identifiers across mmcli-K, managed objects, and udev', async () => {
	const { bundle } = buildFrom(await captureBase(fakeDeps(), INPUT), true);
	const serialized = JSON.stringify(bundle);
	expect(serialized).not.toContain(ICCID);
	expect(serialized).not.toContain(IMSI);
	expect(serialized).not.toContain(EID);
	expect(serialized).not.toContain(IMEI);

	expect(bundle.modemManager.mmcliKeyfile['sim.properties.iccid']).toBe('[redacted]');
	expect(bundle.modemManager.mmcliKeyfile['sim.properties.imsi']).toBe('[redacted]');
	expect(bundle.modemManager.mmcliKeyfile['sim.properties.eid']).toBe('[redacted]');
	expect(bundle.modemManager.mmcliKeyfile['modem.generic.equipment-identifier']).toBe('[redacted]');
	expect(bundle.modemManager.mmcliKeyfile['modem.3gpp.imei']).toBe('[redacted]');

	// GetManagedObjects: MM's SimIdentifier surfaced as `iccid` and masked; Imsi/Eid masked.
	const sim = bundle.modemManager.managedObjects['/org/freedesktop/ModemManager1/SIM/0']?.[
		'org.freedesktop.ModemManager1.Sim'
	] as Record<string, unknown>;
	expect(sim.iccid).toBe('[redacted]');
	expect(sim.Imsi).toBe('[redacted]');
	expect(sim.Eid).toBe('[redacted]');
	expect(sim.OperatorName).toBe('CeraTel');
	const modem =
		bundle.modemManager.managedObjects['/org/freedesktop/ModemManager1/Modem/0']?.[
			'org.freedesktop.ModemManager1.Modem'
		];
	expect(modem).toEqual(expect.objectContaining({ EquipmentIdentifier: '[redacted]' }));

	// udev: redaction reaches the props (the ICCID-bearing rule is masked); the device
	// serial is equipment identity (non-subscriber), retained per the A2.1 policy.
	expect(bundle.usb.udevProperties.iccid).toBe('[redacted]');
	expect(bundle.usb.udevProperties.ID_SERIAL_SHORT).toBe('abcdef123456');
});

test('a failed lsusb capture fails loudly with a named error', async () => {
	const deps = fakeDeps({ lsusb: { stdout: '', stderr: 'lsusb: cannot open', exitCode: 1 } });
	await expect(captureBase(deps, INPUT)).rejects.toThrow(CertifyError);
	await expect(captureBase(deps, INPUT)).rejects.toThrow(/lsusb.*failed/);
});

test('a truncated lsusb (no Device Descriptor block) fails loudly', async () => {
	const deps = fakeDeps({ lsusb: ok('Bus 001 Device 004: ID 2c7c:0125 Quectel EG25-G\n') });
	await expect(captureBase(deps, INPUT)).rejects.toThrow(/truncated or malformed/);
});

test('a malformed mmcli -K (no keyfile properties) fails loudly', async () => {
	const deps = fakeDeps({ mmcli: ok('no properties parsed here\n') });
	await expect(captureBase(deps, INPUT)).rejects.toThrow(/mmcli.*malformed/);
});

test('buildCertificationBundle rejects a schema-invalid bundle loudly', () => {
	const badBase: BaseCaptureParts = {
		usb: { lsusb: '', usbDevices: 'x', udevProperties: {} },
		modemManager: { mmcliKeyfile: { a: 'b' }, managedObjects: {}, signalWindow: [] },
	};
	expect(() => buildFrom(badBase, true)).toThrow(CertifyError);
});
