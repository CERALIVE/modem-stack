// The enumerator parses `udevadm info --export-db` into device snapshots: interface
// class/subclass/protocol come from the parent device's `ID_USB_INTERFACES`, each
// interface's driver from its own `usb_interface` record. The raw read is injectable
// so this runs with canned udev text and no hardware, and `enumerate` re-reads every
// call (refresh-triggered, never cached).

import { describe, expect, test } from 'bun:test';
import { createUsbEnumerator, parseUdevDatabase } from './usb-enumerator';

const UDEV_DB = `P: /devices/pci0000:00/usb1/1-1
E: SUBSYSTEM=usb
E: DEVTYPE=usb_device
E: ID_VENDOR_ID=2c7c
E: ID_MODEL_ID=0125
E: ID_MODEL=EG25-G
E: ID_REVISION=0318
E: ID_PATH=pci-0000:00-usb-0:1
E: ID_USB_INTERFACES=:ff0000:ffffff:

P: /devices/pci0000:00/usb1/1-1/1-1:1.0
E: SUBSYSTEM=usb
E: DEVTYPE=usb_interface
E: DRIVER=option

P: /devices/pci0000:00/usb1/1-1/1-1:1.1
E: SUBSYSTEM=usb
E: DEVTYPE=usb_interface
E: DRIVER=qmi_wwan

P: /devices/pci0000:00/usb2/2-1
E: SUBSYSTEM=usb
E: DEVTYPE=usb_device
E: ID_VENDOR_ID=12d1
E: ID_MODEL_ID=14db
E: ID_MODEL=HUAWEI_HiLink
E: ID_USB_INTERFACES=:020600:0a0000:
`;

describe('parseUdevDatabase', () => {
	test('parses two devices with their vendor/product/model', () => {
		const devices = parseUdevDatabase(UDEV_DB);
		expect(devices).toHaveLength(2);
		const quectel = devices.find((d) => d.vendorId === '2c7c');
		expect(quectel?.productId).toBe('0125');
		expect(quectel?.model).toBe('EG25-G');
		expect(quectel?.firmwareRevision).toBe('0318');
		expect(quectel?.physicalUid).toBe('pci-0000:00-usb-0:1');
	});

	test('parses interface class triples from ID_USB_INTERFACES', () => {
		const devices = parseUdevDatabase(UDEV_DB);
		const huawei = devices.find((d) => d.vendorId === '12d1');
		expect(huawei?.interfaces).toEqual([
			{ interfaceClass: 0x02, interfaceSubClass: 0x06, interfaceProtocol: 0x00 },
			{ interfaceClass: 0x0a, interfaceSubClass: 0x00, interfaceProtocol: 0x00 },
		]);
	});

	test('stitches each interface driver onto its parent device', () => {
		const devices = parseUdevDatabase(UDEV_DB);
		const quectel = devices.find((d) => d.vendorId === '2c7c');
		expect(quectel?.interfaces[0]?.driver).toBe('option');
		expect(quectel?.interfaces[1]?.driver).toBe('qmi_wwan');
	});

	test('a record without a vendor/product id is skipped', () => {
		const devices = parseUdevDatabase('P: /devices/x\nE: DEVTYPE=usb_device\nE: SUBSYSTEM=usb\n');
		expect(devices).toEqual([]);
	});
});

describe('createUsbEnumerator', () => {
	test('enumerate() re-reads the injected source every call (refresh-triggered)', async () => {
		let reads = 0;
		const enumerator = createUsbEnumerator({
			readUdevDatabase: () => {
				reads += 1;
				return Promise.resolve(UDEV_DB);
			},
		});
		const first = await enumerator.enumerate();
		const second = await enumerator.enumerate();
		expect(first).toHaveLength(2);
		expect(second).toHaveLength(2);
		expect(reads).toBe(2);
	});
});
