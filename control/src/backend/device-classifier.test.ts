// The classifier's contract, one fixture per class — plus the HONESTY guarantee: an
// ambiguous descriptor set returns `unmanaged` with a truthful reason, never a
// confident guess, and mass storage without a modeswitch trigger is NOT a modem.

import { describe, expect, test } from 'bun:test';
import {
	cellularModelEvidence,
	classifyDevice,
	classifyUsbNetDevice,
	detectUsbMode,
	modelLabel,
	type UsbDeviceSnapshot,
	unitDiscriminator,
	vendorLabel,
} from './device-classifier';

const SIERRA_SYNTHETIC_FIXTURES = [
	['1199', '9071', 'EM74xx', 'mainline-kernel'],
	['1199', '9079', 'EM74xx', 'modemmanager-1.24.2-fcc'],
	['1199', '907b', 'EM74xx', 'mainline-kernel'],
	['03f0', '4e1d', 'EM74xx', 'modemmanager-1.24.2-fcc'],
	['413c', '81a3', 'EM74xx', 'modemmanager-1.24.2-fcc'],
	['413c', '81a8', 'EM74xx', 'modemmanager-1.24.2-fcc'],
	['1199', '9091', 'EM75xx', 'mainline-kernel'],
	['1199', 'c081', 'EM75xx', 'mainline-kernel'],
	['1199', '90d3', 'EM919x', 'mainline-kernel'],
] as const satisfies readonly (readonly [string, string, string, string])[];

/** A Quectel-style QMI composition: a `qmi_wwan` control port (+ AT serials). */
const QMI: UsbDeviceSnapshot = {
	vendorId: '2c7c',
	productId: '0125',
	model: 'EG25-G',
	bDeviceClass: 0,
	interfaces: [
		{ interfaceClass: 0xff, interfaceSubClass: 0xff, interfaceProtocol: 0xff, driver: 'option' },
		{ interfaceClass: 0xff, interfaceSubClass: 0xff, interfaceProtocol: 0xff, driver: 'qmi_wwan' },
	],
};

/** An MBIM composition: the standard 0x02/0x0e control + 0x0a data pair. */
const MBIM: UsbDeviceSnapshot = {
	vendorId: '1199',
	productId: '9071',
	model: 'Sierra EM-series',
	bDeviceClass: 0,
	interfaces: [
		{ interfaceClass: 0x02, interfaceSubClass: 0x0e, interfaceProtocol: 0x00, driver: 'cdc_mbim' },
		{ interfaceClass: 0x0a, interfaceSubClass: 0x00, interfaceProtocol: 0x02, driver: 'cdc_mbim' },
	],
};

/** A Huawei HiLink personality: CDC-ECM Ethernet, no control port — firmware, not switchable. */
const HILINK_ECM: UsbDeviceSnapshot = {
	vendorId: '12d1',
	productId: '14db',
	model: 'HUAWEI HiLink',
	bDeviceClass: 0x02,
	interfaces: [
		{ interfaceClass: 0x02, interfaceSubClass: 0x06, interfaceProtocol: 0x00, driver: 'cdc_ether' },
		{ interfaceClass: 0x0a, interfaceSubClass: 0x00, interfaceProtocol: 0x00, driver: 'cdc_ether' },
	],
};

/** An RNDIS tether: the wireless-RNDIS descriptor, no control port. */
const RNDIS: UsbDeviceSnapshot = {
	vendorId: '19d2',
	productId: '0601',
	model: 'RNDIS tether',
	bDeviceClass: 0x00,
	interfaces: [
		{
			interfaceClass: 0xe0,
			interfaceSubClass: 0x01,
			interfaceProtocol: 0x03,
			driver: 'rndis_host',
		},
		{
			interfaceClass: 0x0a,
			interfaceSubClass: 0x00,
			interfaceProtocol: 0x00,
			driver: 'rndis_host',
		},
	],
};

/** A modem in mass-storage installer mode, flagged for usb_modeswitch. */
const STORAGE_PRE_MODESWITCH: UsbDeviceSnapshot = {
	vendorId: '12d1',
	productId: '1f01',
	model: 'HUAWEI Mobile',
	bDeviceClass: 0x00,
	interfaces: [
		{
			interfaceClass: 0x08,
			interfaceSubClass: 0x06,
			interfaceProtocol: 0x50,
			driver: 'usb-storage',
		},
	],
	udevProperties: { ID_USB_MODESWITCH: '1' },
};

/** A composite that matches NO known modem pattern — vendor + HID, no driver. */
const AMBIGUOUS: UsbDeviceSnapshot = {
	vendorId: '1234',
	productId: '5678',
	model: 'Unknown Composite',
	bDeviceClass: 0x00,
	interfaces: [
		{ interfaceClass: 0x03, interfaceSubClass: 0x00, interfaceProtocol: 0x00 },
		{ interfaceClass: 0xff, interfaceSubClass: 0x42, interfaceProtocol: 0x01 },
	],
};

describe('classifyDevice — the six canonical fixtures', () => {
	test('QMI composition → mm-managed', () => {
		expect(classifyDevice(QMI).deviceClass).toBe('mm-managed');
		expect(detectUsbMode(QMI)).toBe('qmi');
	});

	test('MBIM composition → mm-managed', () => {
		const result = classifyDevice(MBIM);
		expect(result.deviceClass).toBe('mm-managed');
		expect(result.reason).toContain('MBIM');
		expect(detectUsbMode(MBIM)).toBe('mbim');
	});

	test('Huawei HiLink-ECM (firmware personality) → router-mode', () => {
		const result = classifyDevice(HILINK_ECM);
		expect(result.deviceClass).toBe('router-mode');
		expect(result.reason).toContain('ECM');
		expect(detectUsbMode(HILINK_ECM)).toBe('router-ethernet');
	});

	test('RNDIS tether → router-mode', () => {
		const result = classifyDevice(RNDIS);
		expect(result.deviceClass).toBe('router-mode');
		expect(result.reason).toContain('RNDIS');
		expect(detectUsbMode(RNDIS)).toBe('rndis');
	});

	test('mass-storage before usb_modeswitch → pending-modeswitch (a distinct state)', () => {
		const result = classifyDevice(STORAGE_PRE_MODESWITCH);
		expect(result.deviceClass).toBe('pending-modeswitch');
		expect(result.reason).toContain('usb_modeswitch');
	});

	test('ambiguous composite → unmanaged, with an HONEST reason (never guessed)', () => {
		const result = classifyDevice(AMBIGUOUS);
		expect(result.deviceClass).toBe('unmanaged');
		expect(result.reason).toContain('vendor-specific');
		// Never a confident modem/router class.
		expect(result.deviceClass).not.toBe('mm-managed');
		expect(result.deviceClass).not.toBe('router-mode');
	});
});

describe('classifyDevice — honesty guards', () => {
	test('mass storage WITHOUT a modeswitch trigger is unmanaged, not pending-modeswitch', () => {
		const plainDisk: UsbDeviceSnapshot = {
			vendorId: '0781',
			productId: '5567',
			model: 'SanDisk Cruzer',
			bDeviceClass: 0x00,
			interfaces: [
				{
					interfaceClass: 0x08,
					interfaceSubClass: 0x06,
					interfaceProtocol: 0x50,
					driver: 'usb-storage',
				},
			],
		};
		const result = classifyDevice(plainDisk);
		expect(result.deviceClass).toBe('unmanaged');
		expect(result.reason).toContain('usb_modeswitch');
	});

	test('a bare vendor interface with no driver is NOT assumed to be a QMI modem', () => {
		const bareVendor: UsbDeviceSnapshot = {
			vendorId: '2357',
			productId: '0001',
			bDeviceClass: 0x00,
			interfaces: [{ interfaceClass: 0xff, interfaceSubClass: 0x00, interfaceProtocol: 0x00 }],
		};
		expect(classifyDevice(bareVendor).deviceClass).toBe('unmanaged');
	});
});

describe('Sierra model evidence — exact VID:PID rows only', () => {
	for (const [vendorId, productId, family, evidenceTier] of SIERRA_SYNTHETIC_FIXTURES) {
		test(`Given synthetic ${vendorId}:${productId}, When model evidence is resolved, Then it names ${family} at its evidence tier`, () => {
			const fixture = {
				snapshot: { vendorId, productId, bDeviceClass: 0, interfaces: [] },
				provenance: { synthetic: true },
			} as const;

			expect(fixture.provenance.synthetic).toBe(true);
			expect(cellularModelEvidence(fixture.snapshot)).toEqual({
				family,
				evidenceTier,
				vendor: 'Sierra Wireless',
			});
		});
	}

	test('Given an unlisted Sierra PID, When model evidence is resolved, Then it stays unknown', () => {
		const fixture = {
			snapshot: { vendorId: '1199', productId: 'ffff', bDeviceClass: 0, interfaces: [] },
			provenance: { synthetic: true },
		} as const;

		expect(fixture.provenance.synthetic).toBe(true);
		expect(cellularModelEvidence(fixture.snapshot)).toBeUndefined();
	});
});

describe('CeraUI USB-net classification parity', () => {
	test('requires positive cellular evidence before naming a tether cellular', () => {
		const plainNic: UsbDeviceSnapshot = {
			vendorId: '0b95',
			productId: '772b',
			bDeviceClass: 0,
			interfaces: [
				{
					interfaceClass: 0x02,
					interfaceSubClass: 0x06,
					interfaceProtocol: 0,
					driver: 'cdc_ether',
				},
			],
		};
		expect(classifyUsbNetDevice(plainNic).deviceClass).toBe('wired-ethernet');
		expect(classifyUsbNetDevice(HILINK_ECM).deviceClass).toBe('router-cellular');
		expect(classifyUsbNetDevice(QMI).deviceClass).toBe('mm-managed');
	});

	test('replaces duplicated class strings with database identity', () => {
		const hilink: UsbDeviceSnapshot = {
			...HILINK_ECM,
			manufacturer: 'HUAWEI_MOBILE',
			product: 'HUAWEI_MOBILE',
			databaseVendor: 'Huawei Technologies Co., Ltd.',
			databaseModel: 'E3372 LTE/UMTS/GSM HiLink Modem/Networkcard',
			serialNumber: 'Y4QDU17621000872',
		};
		expect(vendorLabel(hilink)).toBe('Huawei');
		expect(modelLabel(hilink)).toBe('E3372 LTE/UMTS/GSM HiLink Modem/Networkcard');
		expect(unitDiscriminator(hilink)).toBe('Y4QDU17621000872');
	});
});
