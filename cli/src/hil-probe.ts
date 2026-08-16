// Production wiring for the `hil-cycle` harness — the three system seams it reads.
//
// Kept out of `commands/hil-cycle.ts` on purpose: the orchestrator must stay pure so the
// integration test drives the REAL control flow with fakes, and nothing in the test path
// can accidentally reach udev, ModemManager, or a hub.
//
// NO `lsusb`. The bench image ships no `lsusb`/`usbutils` binary (confirmed on
// `ceralive2`), so the USB tree comes from the `/sys/bus/usb/devices/*` sweep that RB-9
// already standardised. `sysfsUsbSweep` emits byte-identical lines to RB-9's shell
// one-liner, so a harness capture and a manual capture are directly comparable.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UsbDeviceSnapshot, UsbEnumerationPoller } from '@ceralive/modem-control';
import type { CommandRunner } from './certify/command-runner';
import type { MmSlotRecord } from './commands/hil-cycle';

/** Where the kernel exposes the USB device tree. */
const SYSFS_USB_DEVICES = '/sys/bus/usb/devices';

/** Read one sysfs attribute, or `''` when the attribute does not exist. */
async function attr(dir: string, name: string): Promise<string> {
	try {
		return (await readFile(join(dir, name), 'utf8')).trim();
	} catch {
		return '';
	}
}

/**
 * The canonical RB-9 USB sweep, in-process. One line per device node that carries an
 * `idVendor`, in the exact shape the runbook's shell one-liner produces:
 *
 *   `1-1.1: 19d2:1405 mfg="ZTE,Incorporated" product="ZTE Mobile Boardband" serial="…"`
 */
export async function sysfsUsbSweep(root: string = SYSFS_USB_DEVICES): Promise<string> {
	const entries = (await readdir(root)).sort();
	const lines: string[] = [];
	for (const entry of entries) {
		const dir = join(root, entry);
		const idVendor = await attr(dir, 'idVendor');
		if (idVendor === '') {
			continue;
		}
		const idProduct = await attr(dir, 'idProduct');
		const mfg = await attr(dir, 'manufacturer');
		const product = await attr(dir, 'product');
		const serial = await attr(dir, 'serial');
		lines.push(
			`${entry}: ${idVendor}:${idProduct} mfg="${mfg}" product="${product}" serial="${serial}"`,
		);
	}
	return `${lines.join('\n')}\n`;
}

/** Pull the `/Modem/<n>` indices out of `mmcli -L` output. */
export function parseMmcliList(stdout: string): readonly string[] {
	const indices: string[] = [];
	for (const match of stdout.matchAll(/\/org\/freedesktop\/ModemManager1\/Modem\/(\d+)/g)) {
		const index = match[1];
		if (index !== undefined && !indices.includes(index)) {
			indices.push(index);
		}
	}
	return indices;
}

/** Pull `modem.generic.device` out of an `mmcli -m <n> -K` keyfile dump. */
export function parseMmcliDevice(stdout: string): string | undefined {
	for (const line of stdout.split('\n')) {
		const match = /^modem\.generic\.device\s*:\s*(.+)$/.exec(line.trim());
		if (match?.[1] !== undefined) {
			return match[1].trim();
		}
	}
	return undefined;
}

/**
 * Enumerate ModemManager's modems with their stable `modem.generic.device` slot UID.
 * A modem MM reports but that has no device value is skipped rather than recorded with
 * an empty UID — an empty UID would make the post-cycle equality check pass vacuously.
 */
export async function mmcliSlots(runner: CommandRunner): Promise<readonly MmSlotRecord[]> {
	const list = await runner.run('mmcli', ['-L']);
	if (list.exitCode !== 0) {
		throw new Error(`mmcli -L exited ${list.exitCode}: ${list.stderr.trim() || '(no output)'}`);
	}
	const records: MmSlotRecord[] = [];
	for (const index of parseMmcliList(list.stdout)) {
		const dump = await runner.run('mmcli', ['-m', index, '-K']);
		if (dump.exitCode !== 0) {
			continue;
		}
		const device = parseMmcliDevice(dump.stdout);
		if (device === undefined || device === '') {
			continue;
		}
		records.push({ path: `/org/freedesktop/ModemManager1/Modem/${index}`, device });
	}
	return records;
}

/**
 * A poller that resolves a stable key to the udev `ID_PATH` currently enumerated for it.
 *
 * The default matcher is `physicalUid === stableKey`, which means the `--hub-map` key on
 * the bench IS the modem's udev `ID_PATH`. That is deliberate: `ID_PATH` is the physical
 * topology path, the one identity that survives a replug, and the same key the
 * dongle-netns contract mandates. A MAC, an `ifname`, or a USB port number would all be
 * wrong here — this bench has already produced a duplicate-MAC pair and has seen port
 * numbers move when devices were reordered on the hub.
 *
 * `enumerate` MUST re-read udev on every call (`createUsbEnumerator()` does); a cached
 * enumeration would report a powered-down device as present and turn the VBUS-drop proof
 * into a no-op.
 */
export function usbIdPathPoller(
	enumerate: () => Promise<readonly UsbDeviceSnapshot[]>,
): UsbEnumerationPoller {
	return {
		async idPathFor(stableKey: string): Promise<string | undefined> {
			const devices = await enumerate();
			return devices.find((d) => d.physicalUid === stableKey)?.physicalUid;
		},
	};
}
