// Transition-evidence mode — capturing a USB-mode switch as it happens.
//
// Certifying AROUND a transition records EXACTLY the fields A4.2's catalog entry
// declares: the before-mode USB descriptors, the exact AT command executed (taken FROM
// the certified catalog, never invented), the port-drop / re-enumeration timeline, and
// the after-mode USB descriptors. The output is shape-compatible with a catalog entry's
// evidence: a reviewer copies `afterDescriptors` into `expectedDescriptors` and the
// bundle sha256 into `evidenceBundleSha256`. This is capture-only — it observes and
// timestamps a real transition; it is NOT the safety-gated production switch (A4.2).

import {
	type AtCommandSender,
	CERTIFIED_CATALOG,
	type CertifiedCatalog,
	detectUsbMode,
	findCatalogEntry,
	findPermittedTransition,
	MM_USB_MODES,
	type MmUsbMode,
	type UsbDeviceSnapshot,
} from '@ceralive/modem-control';
import type { TransitionEvidence, TransitionTimelineEvent } from './bundle-schema';
import { CertifyError } from './errors';
import { descriptorsOf, skuOf } from './transform';

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;

/** The injectable seams the transition capture drives (fakes script the synthetic tests). */
export interface TransitionCaptureDeps {
	enumerate(): Promise<readonly UsbDeviceSnapshot[]>;
	readonly atSender: AtCommandSender;
	now(): number;
	readonly catalog?: CertifiedCatalog;
	readonly pollIntervalMs?: number;
	readonly timeoutMs?: number;
}

/** What to certify: the target mode and the matched before-transition device. */
export interface TransitionCaptureInput {
	readonly targetMode: MmUsbMode;
	readonly device: UsbDeviceSnapshot;
	readonly firmwareRevision: string | undefined;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isMmMode(mode: string): mode is MmUsbMode {
	return (MM_USB_MODES as readonly string[]).includes(mode);
}

/** Find the device with `physicalUid` in a snapshot list. */
function byPhysicalUid(
	devices: readonly UsbDeviceSnapshot[],
	physicalUid: string,
): UsbDeviceSnapshot | undefined {
	return devices.find((d) => d.physicalUid === physicalUid);
}

/** Poll `enumerate` until `predicate` holds, or throw on timeout. */
async function pollUntil(
	deps: TransitionCaptureDeps,
	predicate: (devices: readonly UsbDeviceSnapshot[]) => boolean,
	what: string,
): Promise<void> {
	const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const deadline = deps.now() + (deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	while (true) {
		if (predicate(await deps.enumerate())) {
			return;
		}
		if (deps.now() >= deadline) {
			throw new CertifyError(`transition timed out waiting for ${what}`);
		}
		await sleep(pollMs);
	}
}

/**
 * Capture transition evidence for one certified mode switch. Throws a `CertifyError`
 * for an uncertified SKU, a non-permitted transition, a missing physical UID, or a
 * capture timeout — the evidence is never partial.
 */
export async function captureTransitionEvidence(
	deps: TransitionCaptureDeps,
	input: TransitionCaptureInput,
): Promise<TransitionEvidence> {
	const before = input.device;
	const physicalUid = before.physicalUid;
	if (physicalUid === undefined) {
		throw new CertifyError('device has no stable physical UID; cannot track re-enumeration');
	}
	const fromMode = detectUsbMode(before);
	if (fromMode === undefined || !isMmMode(fromMode)) {
		throw new CertifyError(
			`device is not in an MM-manageable mode (detected ${fromMode ?? 'none'}); cannot certify a transition`,
		);
	}
	const sku = skuOf(before, input.firmwareRevision);
	if (sku === undefined) {
		throw new CertifyError(
			'device is missing a model or ModemManager firmware revision; SKU is not certifiable',
		);
	}
	const entry = findCatalogEntry(deps.catalog ?? CERTIFIED_CATALOG, sku);
	if (entry === undefined) {
		throw new CertifyError(
			`no certified catalog entry for SKU ${sku.vidPid}/${sku.model}/${sku.firmwarePrefix}`,
		);
	}
	const transition = findPermittedTransition(entry, fromMode, input.targetMode);
	if (transition === undefined) {
		throw new CertifyError(
			`no permitted transition ${fromMode} -> ${input.targetMode} in the catalog for ${sku.vidPid}`,
		);
	}

	const beforeDescriptors = descriptorsOf(before);
	const timeline: TransitionTimelineEvent[] = [];

	timeline.push({ event: 'command-sent', atMs: deps.now() });
	await deps.atSender.send(transition.atCommand);

	if (transition.expectsPortDrop) {
		await pollUntil(
			deps,
			(devices) => byPhysicalUid(devices, physicalUid) === undefined,
			'port drop',
		);
		timeline.push({ event: 'port-drop', atMs: deps.now() });
	}

	// Re-enumeration is complete when the device is back on the same physical port AND
	// its data-plane composition reads as the TARGET mode. Matching on the descriptor
	// composition (not the PID) is correct: a `usbnet` switch keeps the PID and only
	// re-composes the interfaces.
	let after: UsbDeviceSnapshot | undefined;
	await pollUntil(
		deps,
		(devices) => {
			const candidate = byPhysicalUid(devices, physicalUid);
			if (candidate === undefined || detectUsbMode(candidate) !== input.targetMode) {
				return false;
			}
			after = candidate;
			return true;
		},
		're-enumeration in the target mode',
	);
	timeline.push({ event: 're-enumeration', atMs: deps.now() });
	if (after === undefined) {
		throw new CertifyError('device did not re-enumerate in the target mode');
	}

	return {
		from: fromMode,
		to: input.targetMode,
		atCommand: transition.atCommand,
		expectedResponse: transition.expectedResponse,
		expectsPortDrop: transition.expectsPortDrop,
		beforeDescriptors,
		afterDescriptors: descriptorsOf(after),
		timeline,
	};
}
