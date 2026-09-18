import { epochMillis } from '../../domain';
import type { InhibitLease } from '../../ports';
import { MM_MANAGER_IFACE, MM_ROOT_PATH } from '../constants';
import type { MmMutationContext } from './context';

export async function inhibitDevice(
	context: MmMutationContext,
	uid: string,
	now: () => number,
): Promise<InhibitLease> {
	await setInhibited(context, uid, true);
	return { uid, acquiredAt: epochMillis(now()) };
}

export async function uninhibitDevice(
	context: MmMutationContext,
	lease: InhibitLease,
): Promise<void> {
	await setInhibited(context, lease.uid, false);
}

function setInhibited(context: MmMutationContext, uid: string, inhibit: boolean): Promise<unknown> {
	return context.transport.callMethod({
		destination: context.destination,
		path: MM_ROOT_PATH,
		interface: MM_MANAGER_IFACE,
		member: 'InhibitDevice',
		signature: 'sb',
		args: [uid, inhibit],
	});
}
