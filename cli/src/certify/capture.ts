// The base capture — the always-present half of a certification bundle.
//
// Runs `lsusb -v`, `usb-devices`, and `mmcli -K`, reads the target slot's udev
// properties off the matched USB device, dumps `GetManagedObjects`, and records a
// BOUNDED window of D-Bus signals. Every tool output is sanity-checked: a failed or
// truncated capture throws a `CertifyError` here, so the command never assembles a
// broken bundle. The subscriber secrets live in the `mmcli -K` keyfile and the managed
// objects, both captured as OBJECTS so the shared key-based redactor can mask them.

import {
	type DecodedManagedObjects,
	readRevision,
	type SkuDiscriminator,
	type UsbDeviceSnapshot,
} from '@ceralive/modem-control';
import type { SignalRecord } from './bundle-schema';
import type { CommandResult } from './command-runner';
import { CertifyError } from './errors';
import { type JsonValue, objectifyManagedObjects, parseKeyfile, skuOf } from './transform';

/** The parts of a bundle the base capture produces. */
export interface BaseCaptureParts {
	readonly sku?: SkuDiscriminator;
	readonly usb: {
		readonly lsusb: string;
		readonly usbDevices: string;
		readonly udevProperties: Record<string, string>;
	};
	readonly modemManager: {
		readonly mmcliKeyfile: Record<string, string>;
		readonly managedObjects: Record<string, Record<string, JsonValue>>;
		readonly signalWindow: readonly SignalRecord[];
	};
}

/** The injectable seams the base capture reads from (fakes drive the synthetic tests). */
export interface BaseCaptureDeps {
	run(command: string, args: readonly string[]): Promise<CommandResult>;
	captureSignalWindow(): Promise<readonly SignalRecord[]>;
}

/** The target selection the base capture needs (matched device + the mmcli selector). */
export interface BaseCaptureInput {
	/** The matched target USB device — source of the slot's udev properties and SKU. */
	readonly device?: UsbDeviceSnapshot;
	readonly managedObjects: DecodedManagedObjects;
	readonly modemPath: string;
	/** The `mmcli -m <target>` modem selector (a modem index or D-Bus path). */
	readonly mmcliTarget: string;
}

/** Run a capture command and fail loudly on a non-zero exit. */
async function runOrThrow(
	deps: BaseCaptureDeps,
	command: string,
	args: readonly string[],
): Promise<string> {
	const result = await deps.run(command, args);
	if (result.exitCode !== 0) {
		throw new CertifyError(
			`${command} ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr.trim() || 'no stderr'}`,
		);
	}
	return result.stdout;
}

/** Capture `lsusb -v`, rejecting empty or truncated (no descriptor block) output. */
async function captureLsusb(deps: BaseCaptureDeps): Promise<string> {
	const stdout = await runOrThrow(deps, 'lsusb', ['-v']);
	if (stdout.trim() === '') {
		throw new CertifyError('lsusb -v produced no output (truncated or failed capture)');
	}
	if (!stdout.includes('Device Descriptor:')) {
		throw new CertifyError(
			'lsusb -v output is truncated or malformed (no "Device Descriptor:" block)',
		);
	}
	return stdout;
}

/** Capture `usb-devices`, rejecting empty output. */
async function captureUsbDevices(deps: BaseCaptureDeps): Promise<string> {
	const stdout = await runOrThrow(deps, 'usb-devices', []);
	if (stdout.trim() === '') {
		throw new CertifyError('usb-devices produced no output (truncated or failed capture)');
	}
	return stdout;
}

/** Capture `mmcli -m <target> -K`, rejecting output that parses to zero keys. */
async function captureMmcli(
	deps: BaseCaptureDeps,
	mmcliTarget: string,
): Promise<Record<string, string>> {
	const stdout = await runOrThrow(deps, 'mmcli', ['-m', mmcliTarget, '-K']);
	const keyfile = parseKeyfile(stdout);
	if (Object.keys(keyfile).length === 0) {
		throw new CertifyError('mmcli -K output is malformed (no keyfile properties parsed)');
	}
	return keyfile;
}

/**
 * Capture the always-present base of a certification bundle. Throws a `CertifyError`
 * the instant any tool fails or returns malformed output — a partial bundle is never
 * returned.
 */
export async function captureBase(
	deps: BaseCaptureDeps,
	input: BaseCaptureInput,
): Promise<BaseCaptureParts> {
	const lsusb = await captureLsusb(deps);
	const usbDevices = await captureUsbDevices(deps);
	const mmcliKeyfile = await captureMmcli(deps, input.mmcliTarget);
	const managedObjects = objectifyManagedObjects(input.managedObjects);
	const signalWindow = await deps.captureSignalWindow();
	const udevProperties = { ...(input.device?.udevProperties ?? {}) };
	const firmwareRevision = readRevision(input.managedObjects, input.modemPath);
	const sku = input.device !== undefined ? skuOf(input.device, firmwareRevision) : undefined;

	return {
		...(sku !== undefined ? { sku } : {}),
		usb: { lsusb, usbDevices, udevProperties },
		modemManager: { mmcliKeyfile, managedObjects, signalWindow },
	};
}
