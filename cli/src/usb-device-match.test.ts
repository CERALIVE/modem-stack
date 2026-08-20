import { describe, expect, test } from 'bun:test';
import { type DecodedManagedObjects, MODEM_IFACE } from '@ceralive/modem-control';
import { variant } from '@ceralive/modem-control/transport';
import { matchUsbDevice } from './usb-device-match';

const MODEM_PATH = '/org/freedesktop/ModemManager1/Modem/39';
const RM530N_SYSFS_PATH =
	'/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4/4-1.4.4';
const HUB_SYSFS_PATH = '/sys/devices/platform/fc400000.usb/xhci-hcd.0.auto/usb4/4-1/4-1.4';

function modemTree(device: string, physdev?: string): DecodedManagedObjects {
	const properties: Array<readonly [string, ReturnType<typeof variant>]> = [
		['Device', variant('s', device)],
	];
	if (physdev !== undefined) {
		properties.push(['Physdev', variant('s', physdev)]);
	}
	return [[MODEM_PATH, [[MODEM_IFACE, properties]]]];
}

const hub = {
	vendorId: '0bda',
	productId: '0411',
	bDeviceClass: 9,
	interfaces: [],
	sysfsPath: HUB_SYSFS_PATH,
};

const rm530n = {
	vendorId: '2c7c',
	productId: '0801',
	model: 'RM530N-GL',
	bDeviceClass: 0,
	interfaces: [
		{ interfaceClass: 0xff, interfaceSubClass: 0xff, interfaceProtocol: 0xff, driver: 'qmi_wwan' },
	],
	sysfsPath: RM530N_SYSFS_PATH,
};

describe('matchUsbDevice', () => {
	test('matches the real RM530N USB parent from Modem.Device and Physdev without an ifname', () => {
		// Given
		const tree = modemTree(RM530N_SYSFS_PATH, RM530N_SYSFS_PATH);

		// When
		const matched = matchUsbDevice(tree, MODEM_PATH, [hub, rm530n]);

		// Then
		expect(matched).toBe(rm530n);
	});

	test('chooses the most specific USB ancestor when Modem.Device names an interface child', () => {
		// Given
		const interfacePath = `${RM530N_SYSFS_PATH}/4-1.4.4:1.4/net/wwan3`;
		const tree = modemTree(interfacePath);

		// When
		const matched = matchUsbDevice(tree, MODEM_PATH, [hub, rm530n]);

		// Then
		expect(matched).toBe(rm530n);
	});
});
