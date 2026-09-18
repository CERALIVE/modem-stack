import { decodeBandList, encodeBandList, isResetSelection } from '../../band';
import type { BandReadResult, ModemRef, Receipt } from '../../ports';
import { receipt } from '../../ports';
import { MODEM_IFACE } from '../constants';
import { fetchManagedObjects, findInterface, propValue } from '../managed-objects';
import type { MmMutationContext } from './context';
import { describeMutationError } from './context';

export async function readBands(
	context: MmMutationContext,
	modem: ModemRef,
): Promise<BandReadResult> {
	try {
		const tree = await fetchManagedObjects(context.transport, context.destination);
		const props = findInterface(tree, modem, MODEM_IFACE);
		if (props === undefined) {
			return { ok: false, reason: 'the modem exports no Modem interface' };
		}
		return {
			ok: true,
			bands: {
				supported: decodeBandList(propValue(props, 'SupportedBands')),
				current: decodeBandList(propValue(props, 'CurrentBands')),
			},
		};
	} catch (error) {
		return { ok: false, reason: `reading bands failed: ${describeMutationError(error)}` };
	}
}

export function setCurrentBands(
	context: MmMutationContext,
	modem: ModemRef,
	bands: readonly string[],
): Promise<Receipt> {
	if (bands.length === 0) {
		return Promise.resolve(receipt('band', 'failed', 'no bands were requested'));
	}
	const encoded = encodeBandList(bands);
	if (!encoded.ok) {
		return Promise.resolve(
			receipt('band', 'unsupported', `this build does not know the band "${encoded.unknown}"`),
		);
	}
	return context.actor.runQuiesced({ stableKey: context.resolveStableKey(modem) }, async () => {
		try {
			await context.transport.callMethod({
				destination: context.destination,
				path: modem,
				interface: MODEM_IFACE,
				member: 'SetCurrentBands',
				signature: 'au',
				args: [encoded.values],
			});
			return receipt(
				'band',
				'applied',
				isResetSelection(bands) ? 'band lock released' : `bands set to ${bands.join(', ')}`,
			);
		} catch (error) {
			return receipt('band', 'failed', `SetCurrentBands failed: ${describeMutationError(error)}`);
		}
	});
}
