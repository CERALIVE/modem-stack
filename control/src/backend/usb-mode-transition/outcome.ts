import { readRuntimeCompositionCurrent } from '../../usb-mode';
import type { AtCommandLease } from '../at-lease';
import { descriptorsMatch, detectUsbMode, type UsbDeviceSnapshot } from '../device-classifier';
import type { UsbModeTransitionPlan } from '../transition-preconditions';

export async function transitionPostconditionFailure(
	plan: UsbModeTransitionPlan,
	device: UsbDeviceSnapshot,
	lease: AtCommandLease,
	inhibitUid: string,
	steps: string[],
): Promise<string | undefined> {
	if (plan.proof.tier === 'catalog-descriptors') {
		const observedMode = detectUsbMode(device);
		const descriptorsOk = descriptorsMatch(device, plan.proof.transition.expectedDescriptors);
		return observedMode === plan.proof.transition.to && descriptorsOk
			? undefined
			: `postcondition mismatch: observed ${observedMode ?? 'unknown'} vs target ${plan.proof.transition.to}; descriptors ${descriptorsOk ? 'ok' : 'mismatch'}`;
	}
	steps.push('postcondition-runtime-read');
	const response = await lease.run(plan.proof.currentQuery, { inhibitUid });
	const observed = readRuntimeCompositionCurrent(plan.proof.vendor, response.raw);
	return Object.is(observed, plan.proof.target)
		? undefined
		: `runtime readback mismatch: observed ${observed ?? 'unknown'} vs target ${plan.proof.target}`;
}
