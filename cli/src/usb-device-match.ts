import {
	type DecodedManagedObjects,
	modemIdentityFactsFromTree,
	type UsbDeviceSnapshot,
} from '@ceralive/modem-control';

export function matchUsbDevice(
	tree: DecodedManagedObjects,
	modemPath: string,
	devices: readonly UsbDeviceSnapshot[],
): UsbDeviceSnapshot | undefined {
	const facts = modemIdentityFactsFromTree(tree, modemPath);
	const modemPaths: string[] = [];
	for (const path of [facts.physdev, facts.device]) {
		if (path?.startsWith('/sys/')) {
			modemPaths.push(path.replace(/\/+$/, ''));
		}
	}

	let bestMatch: UsbDeviceSnapshot | undefined;
	for (const device of devices) {
		const sysfsPath = device.sysfsPath?.replace(/\/+$/, '');
		if (sysfsPath === undefined) {
			continue;
		}
		const matches = modemPaths.some(
			(path) => path === sysfsPath || path.startsWith(`${sysfsPath}/`),
		);
		if (matches && sysfsPath.length > (bestMatch?.sysfsPath?.length ?? 0)) {
			bestMatch = device;
		}
	}
	return bestMatch;
}
