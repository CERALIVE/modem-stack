// The classifier's contract, one fixture per class — plus the HONESTY guarantee: an
// ambiguous descriptor set returns `unmanaged` with a truthful reason, never a
// confident guess, and mass storage without a modeswitch trigger is NOT a modem.

import { describe, expect, test } from 'bun:test';
import {
	CELLULAR_MODEL_EVIDENCE_SOURCES,
	CELLULAR_USB_MODEL_ROWS,
	cellularModelEvidence,
	cellularVendorName,
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

const MODULE_SYNTHETIC_FIXTURES = [
	['1bc7', '1031', 'Telit', 'LE910C1-EUX'],
	['1bc7', '1034', 'Telit', 'LE910C4-WWX'],
	['1bc7', '1040', 'Telit', 'LE922A'],
	['1bc7', '1050', 'Telit', 'FN980'],
	['1bc7', '1060', 'Telit', 'LN920'],
	['1bc7', '1070', 'Telit', 'FN990A'],
	['1bc7', '1080', 'Telit', 'FE990A'],
	['1bc7', '10a0', 'Telit', 'FN920C04'],
	['1bc7', '1100', 'Telit', 'ME910'],
	['1bc7', '1200', 'Telit', 'LE920'],
	['1546', '1311', 'u-blox', 'LARA-R6'],
	['1546', '1312', 'u-blox', 'LARA-R6'],
	['1546', '1313', 'u-blox', 'LARA-R6'],
	['1546', '1341', 'u-blox', 'LARA-L6'],
	['1546', '1342', 'u-blox', 'LARA-L6'],
	['1546', '1343', 'u-blox', 'LARA-L6'],
] as const satisfies readonly (readonly [string, string, string, string])[];

const UNLISTED_SYNTHETIC_FIXTURES = [
	['1bc7', 'ffff'],
	['1546', 'ffff'],
	['0846', '9052'],
] as const satisfies readonly (readonly [string, string])[];

/**
 * NETGEAR's LB1120 as it actually enumerates: an RNDIS tether and nothing else. No
 * kernel modem driver claims `0846:68e1` and ModemManager 1.24.2 ships no NETGEAR
 * plugin, so there is no control port for one to bind — the vendor web UI is the
 * whole control surface.
 */
const NETGEAR_ROUTER_WEBUI: UsbDeviceSnapshot = {
	vendorId: '0846',
	productId: '68e1',
	bDeviceClass: 0x00,
	interfaces: [
		{ interfaceClass: 0xe0, interfaceSubClass: 0x01, interfaceProtocol: 0x03 },
		{ interfaceClass: 0x0a, interfaceSubClass: 0x00, interfaceProtocol: 0x00 },
	],
};

describe('Telit / u-blox model evidence — exact VID:PID rows only', () => {
	for (const [vendorId, productId, vendor, family] of MODULE_SYNTHETIC_FIXTURES) {
		test(`Given synthetic ${vendorId}:${productId}, When model evidence is resolved, Then it names ${family} from the pinned kernel tables`, () => {
			const fixture = {
				snapshot: { vendorId, productId, bDeviceClass: 0, interfaces: [] },
				provenance: { synthetic: true },
			} as const;

			expect(fixture.provenance.synthetic).toBe(true);
			expect(cellularModelEvidence(fixture.snapshot)).toEqual({
				vendor,
				family,
				evidenceTier: 'mainline-kernel',
			});
		});
	}

	for (const [vendorId, productId] of UNLISTED_SYNTHETIC_FIXTURES) {
		test(`Given an unlisted ${vendorId}:${productId}, When model evidence is resolved, Then it stays unknown rather than inferring the vendor range`, () => {
			const fixture = {
				snapshot: { vendorId, productId, bDeviceClass: 0, interfaces: [] },
				provenance: { synthetic: true },
			} as const;

			expect(fixture.provenance.synthetic).toBe(true);
			expect(cellularModelEvidence(fixture.snapshot)).toBeUndefined();
		});
	}
});

describe('NETGEAR 0846 — a router/WebUI family, never an MM-managed modem', () => {
	test('Given the LB1120 row, When model evidence is resolved, Then it is labelled router-webui from the USB ID Repository', () => {
		const fixture = { snapshot: NETGEAR_ROUTER_WEBUI, provenance: { synthetic: true } } as const;

		expect(fixture.provenance.synthetic).toBe(true);
		expect(cellularModelEvidence(fixture.snapshot)).toEqual({
			vendor: 'NETGEAR',
			family: 'LB1120',
			evidenceTier: 'usb-ids-registry',
			familyKind: 'router-webui',
		});
	});

	test('Given the LB1120 composition, When it is classified, Then it is router-mode and never mm-managed', () => {
		const result = classifyDevice(NETGEAR_ROUTER_WEBUI);

		expect(result.deviceClass).toBe('router-mode');
		expect(result.deviceClass).not.toBe('mm-managed');
		expect(detectUsbMode(NETGEAR_ROUTER_WEBUI)).toBe('rndis');
	});

	test('Given the same composition under an unlisted PID, When it is classified, Then the class is unchanged — interfaces decide it, not the family row', () => {
		const unlisted: UsbDeviceSnapshot = { ...NETGEAR_ROUTER_WEBUI, productId: '9052' };

		expect(cellularModelEvidence(unlisted)).toBeUndefined();
		expect(classifyDevice(unlisted).deviceClass).toBe(
			classifyDevice(NETGEAR_ROUTER_WEBUI).deviceClass,
		);
	});

	test('Given a Telit module row on a bare tether, When it is classified, Then a modem-module label still cannot promote it to mm-managed', () => {
		const telitTether: UsbDeviceSnapshot = {
			...NETGEAR_ROUTER_WEBUI,
			vendorId: '1bc7',
			productId: '1070',
		};

		expect(cellularModelEvidence(telitTether)?.family).toBe('FN990A');
		expect(classifyDevice(telitTether).deviceClass).toBe('router-mode');
	});

	test('Given NETGEAR 0846, When the vendor range is consulted, Then it is NOT a cellular vendor id — the range carries Wi-Fi and Ethernet adapters too', () => {
		expect(cellularVendorName('0846')).toBeUndefined();
		expect(cellularVendorName('1bc7')).toBe('Telit');
	});

	test('Given the LB1120 tether, When it is USB-net classified, Then it reads wired-ethernet — there is no positive cellular evidence to claim', () => {
		expect(classifyUsbNetDevice(NETGEAR_ROUTER_WEBUI).deviceClass).toBe('wired-ethernet');
	});
});

describe('model-evidence provenance', () => {
	test('Given every row in the table, When its tier is looked up, Then a pinned source exists for it', () => {
		for (const evidence of CELLULAR_USB_MODEL_ROWS.values()) {
			expect(CELLULAR_MODEL_EVIDENCE_SOURCES[evidence.evidenceTier].pin).not.toBe('');
		}
	});

	test('Given the whole table, When router-webui claims are counted, Then only rows with that evidence carry one — absence is not a modem-module claim', () => {
		const routerRows = [...CELLULAR_USB_MODEL_ROWS.entries()].filter(
			([, evidence]) => evidence.familyKind === 'router-webui',
		);

		expect(routerRows.map(([key]) => key)).toEqual(['0846:68e1']);
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
