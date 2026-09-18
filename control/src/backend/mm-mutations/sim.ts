import type { ModemRef, Receipt, SimPukUnlockResult, SimUnlockResult } from '../../ports';
import { receipt } from '../../ports';
import { MODEM_IFACE } from '../constants';
import { fetchManagedObjects, findInterface, propValue } from '../managed-objects';
import { sendSimPin, sendSimPuk } from '../sim-unlock';
import type { MmMutationContext } from './context';
import { describeMutationError } from './context';

export async function setPrimarySimSlot(
	context: MmMutationContext,
	modem: ModemRef,
	slotIndex: number,
): Promise<Receipt> {
	const slots = await readSlotCount(context, modem);
	if (slots === undefined) {
		return receipt('simSlot', 'failed', 'could not read the modem SIM-slot list');
	}
	if (slots <= 1) {
		return receipt('simSlot', 'unsupported', 'single-slot modem has no primary slot to select');
	}
	if (slotIndex < 1 || slotIndex > slots) {
		return receipt('simSlot', 'failed', `slot ${slotIndex} is out of range (1..${slots})`);
	}
	return context.actor.runQuiesced({ stableKey: context.resolveStableKey(modem) }, async () => {
		try {
			await context.transport.callMethod({
				destination: context.destination,
				path: modem,
				interface: MODEM_IFACE,
				member: 'SetPrimarySimSlot',
				signature: 'u',
				args: [slotIndex],
			});
			return receipt('simSlot', 'applied', `primary SIM slot set to ${slotIndex}`);
		} catch (error) {
			return receipt(
				'simSlot',
				'failed',
				`SetPrimarySimSlot failed: ${describeMutationError(error)}`,
			);
		}
	});
}

export function unlockWithPin(
	context: MmMutationContext,
	modem: ModemRef,
	pin: string,
): Promise<SimUnlockResult> {
	return context.actor.run(context.resolveStableKey(modem), () =>
		sendSimPin(context.transport, context.destination, modem, pin),
	);
}

export function unlockWithPuk(
	context: MmMutationContext,
	modem: ModemRef,
	puk: string,
	newPin: string,
): Promise<SimPukUnlockResult> {
	return context.actor.run(context.resolveStableKey(modem), () =>
		sendSimPuk(context.transport, context.destination, modem, puk, newPin),
	);
}

async function readSlotCount(
	context: MmMutationContext,
	modem: ModemRef,
): Promise<number | undefined> {
	try {
		const tree = await fetchManagedObjects(context.transport, context.destination);
		const slots = propValue(findInterface(tree, modem, MODEM_IFACE), 'SimSlots');
		return Array.isArray(slots) ? slots.length : undefined;
	} catch {
		return undefined;
	}
}
