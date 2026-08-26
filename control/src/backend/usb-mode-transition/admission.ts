import type { InhibitLease, ModemManagerPort } from '../../ports';
import type { CertifiedCatalog } from '../../usb-mode';
import {
	checkTransitionPreconditions,
	type TransitionInterlock,
	type UsbModeTransitionRequest,
} from '../transition-preconditions';

export function checkTransitionAdmission(
	request: UsbModeTransitionRequest,
	catalog: CertifiedCatalog,
	interlock: TransitionInterlock,
) {
	return checkTransitionPreconditions(request, catalog, interlock);
}

export async function releaseInhibit(
	modemManager: Pick<ModemManagerPort, 'uninhibit'>,
	lease: InhibitLease | undefined,
	steps: string[],
): Promise<undefined> {
	if (lease === undefined) {
		return undefined;
	}
	steps.push('force-uninhibit');
	await modemManager.uninhibit(lease).catch(() => undefined);
	return undefined;
}
