// Production USB enumeration — a refresh-triggered snapshot of udev/sysfs state.
//
// `enumerate()` shells out to `udevadm info --export-db` (via `Bun.spawn`) each call
// — it is deliberately NOT cached, so a caller re-reads current state after a hot-plug
// or a mode switch. The raw-database read is an injectable seam (`readUdevDatabase`)
// so tests drive canned udev output with no real hardware, and the parser itself is a
// pure, exported function. udev exports every interface's class/subclass/protocol on
// the parent device as `ID_USB_INTERFACES` (`:ff0000:0a0000:` …), and each interface's
// bound DRIVER on its own `usb_interface` record — this parser stitches the two.

import type { UsbDeviceSnapshot, UsbInterface } from './device-classifier';

/** The injectable dependencies for the enumerator. */
export interface UsbEnumeratorDeps {
	/** Provides the raw `udevadm info --export-db` text. Defaults to a `Bun.spawn` call. */
	readonly readUdevDatabase?: () => Promise<string>;
}

/** A refresh-triggered USB device enumerator. */
export interface UsbEnumerator {
	/** Snapshot current USB state — re-reads udev every call (never cached). */
	enumerate(): Promise<readonly UsbDeviceSnapshot[]>;
}

async function defaultReadUdevDatabase(): Promise<string> {
	const proc = Bun.spawn(['udevadm', 'info', '--export-db'], { stdout: 'pipe', stderr: 'pipe' });
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`udevadm info --export-db exited ${exitCode}: ${stderr.trim()}`);
	}
	return stdout;
}

interface UdevRecord {
	readonly devpath: string;
	readonly env: ReadonlyMap<string, string>;
}

function parseRecords(text: string): UdevRecord[] {
	const records: UdevRecord[] = [];
	let devpath = '';
	let env = new Map<string, string>();
	const flush = (): void => {
		if (env.size > 0 || devpath !== '') {
			records.push({ devpath, env });
		}
		devpath = '';
		env = new Map<string, string>();
	};
	for (const line of text.split('\n')) {
		if (line.trim() === '') {
			flush();
			continue;
		}
		const kind = line.slice(0, 2);
		const rest = line.slice(3);
		if (kind === 'P:') {
			devpath = rest;
		} else if (kind === 'E:') {
			const eq = rest.indexOf('=');
			if (eq > 0) {
				env.set(rest.slice(0, eq), rest.slice(eq + 1));
			}
		}
	}
	flush();
	return records;
}

/** Parse an `ID_USB_INTERFACES` value (`:ff0000:0a0000:`) into class/subclass/protocol triples. */
function parseInterfaces(value: string | undefined): UsbInterface[] {
	if (value === undefined) {
		return [];
	}
	const interfaces: UsbInterface[] = [];
	for (const token of value.split(':')) {
		if (token.length !== 6) {
			continue;
		}
		interfaces.push({
			interfaceClass: Number.parseInt(token.slice(0, 2), 16),
			interfaceSubClass: Number.parseInt(token.slice(2, 4), 16),
			interfaceProtocol: Number.parseInt(token.slice(4, 6), 16),
		});
	}
	return interfaces;
}

function interfaceIndex(devpath: string): number | undefined {
	const dot = devpath.lastIndexOf('.');
	if (dot < 0) {
		return undefined;
	}
	const index = Number.parseInt(devpath.slice(dot + 1), 10);
	return Number.isNaN(index) ? undefined : index;
}

function buildSnapshot(env: ReadonlyMap<string, string>): UsbDeviceSnapshot | undefined {
	const vendorId = env.get('ID_VENDOR_ID');
	const productId = env.get('ID_MODEL_ID');
	if (vendorId === undefined || productId === undefined) {
		return undefined;
	}
	const props: Record<string, string> = {};
	for (const [key, value] of env) {
		props[key] = value;
	}
	const model = env.get('ID_MODEL');
	const firmwareRevision = env.get('ID_REVISION');
	const physicalUid = env.get('ID_PATH');
	return {
		vendorId,
		productId,
		bDeviceClass: 0,
		interfaces: parseInterfaces(env.get('ID_USB_INTERFACES')),
		udevProperties: props,
		...(model !== undefined ? { model } : {}),
		...(firmwareRevision !== undefined ? { firmwareRevision } : {}),
		...(physicalUid !== undefined ? { physicalUid } : {}),
	};
}

/**
 * Parse `udevadm info --export-db` output into device snapshots. Pure and exported so
 * the production parse is unit-testable against canned udev text. Interface drivers
 * are stitched from each `usb_interface` record onto its parent `usb_device`.
 */
export function parseUdevDatabase(text: string): UsbDeviceSnapshot[] {
	const records = parseRecords(text);
	const devices = new Map<string, UsbInterface[]>();
	const snapshots = new Map<string, UsbDeviceSnapshot>();

	for (const record of records) {
		if (record.env.get('DEVTYPE') !== 'usb_device') {
			continue;
		}
		const snapshot = buildSnapshot(record.env);
		if (snapshot !== undefined) {
			snapshots.set(record.devpath, snapshot);
			devices.set(record.devpath, [...snapshot.interfaces]);
		}
	}

	for (const record of records) {
		if (record.env.get('DEVTYPE') !== 'usb_interface') {
			continue;
		}
		const driver = record.env.get('DRIVER');
		const index = interfaceIndex(record.devpath);
		if (driver === undefined || index === undefined) {
			continue;
		}
		const parent = record.devpath.slice(0, record.devpath.lastIndexOf('/'));
		const ifaces = devices.get(parent);
		const iface = ifaces?.[index];
		if (ifaces !== undefined && iface !== undefined) {
			ifaces[index] = { ...iface, driver };
		}
	}

	return [...snapshots.entries()].map(([devpath, snapshot]) => ({
		...snapshot,
		interfaces: devices.get(devpath) ?? snapshot.interfaces,
	}));
}

/** Create a refresh-triggered USB enumerator over an injectable udev reader. */
export function createUsbEnumerator(deps: UsbEnumeratorDeps = {}): UsbEnumerator {
	const read = deps.readUdevDatabase ?? defaultReadUdevDatabase;
	return {
		async enumerate(): Promise<readonly UsbDeviceSnapshot[]> {
			return parseUdevDatabase(await read());
		},
	};
}

/** Convenience: enumerate current USB devices once via the default udev reader. */
export function enumerateUsbDevices(): Promise<readonly UsbDeviceSnapshot[]> {
	return createUsbEnumerator().enumerate();
}
