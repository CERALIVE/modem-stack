import type { DesiredRadio, RadioAccessTechnology } from '../../domain';
import type { ModemRef, Receipt } from '../../ports';
import { receipt } from '../../ports';
import { MODEM_IFACE } from '../constants';
import type { MmMutationContext } from './context';
import { describeMutationError } from './context';

const MODE_BIT: Record<RadioAccessTechnology, number> = { gsm: 2, umts: 4, lte: 8, '5gnr': 16 };

export function setRadioModes(
	context: MmMutationContext,
	modem: ModemRef,
	preference: DesiredRadio,
): Promise<Receipt> {
	const allowed = maskOf(preference.allowedSet ?? new Set(preference.preferenceOrdered));
	const preferred = preference.preferenceOrdered[0];
	const preferredMask = preferred !== undefined ? MODE_BIT[preferred] : 0;
	if (allowed === 0) {
		return Promise.resolve(receipt('radio', 'failed', 'no radio modes were requested'));
	}
	return setModeMasks(context, modem, allowed, preferredMask, 'radio mode preference applied');
}

export function setModeCombination(
	context: MmMutationContext,
	modem: ModemRef,
	allowed: number,
	preferred: number,
): Promise<Receipt> {
	if (allowed === 0) {
		return Promise.resolve(receipt('radio', 'failed', 'no radio modes were requested'));
	}
	return setModeMasks(context, modem, allowed, preferred, 'radio mode combination applied');
}

function setModeMasks(
	context: MmMutationContext,
	modem: ModemRef,
	allowed: number,
	preferred: number,
	successMessage: string,
): Promise<Receipt> {
	return context.actor.runQuiesced({ stableKey: context.resolveStableKey(modem) }, async () => {
		try {
			await context.transport.callMethod({
				destination: context.destination,
				path: modem,
				interface: MODEM_IFACE,
				member: 'SetCurrentModes',
				signature: '(uu)',
				args: [[allowed, preferred]],
			});
			return receipt('radio', 'applied', successMessage);
		} catch (error) {
			return receipt('radio', 'failed', `SetCurrentModes failed: ${describeMutationError(error)}`);
		}
	});
}

function maskOf(rats: ReadonlySet<RadioAccessTechnology>): number {
	let mask = 0;
	for (const rat of rats) {
		mask |= MODE_BIT[rat];
	}
	return mask;
}
