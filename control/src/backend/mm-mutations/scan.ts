import type { ModemRef, NetworkScanResult, ScannedNetwork } from '../../ports';
import { MODEM3GPP_IFACE } from '../constants';
import type { DecodedProps } from '../managed-objects';
import { numberProp, stringProp } from '../managed-objects';
import type { MmMutationContext } from './context';
import { describeMutationError } from './context';

const AVAILABILITY: Record<number, ScannedNetwork['availability']> = {
	0: 'unknown',
	1: 'available',
	2: 'current',
	3: 'forbidden',
};

export function scanNetworks(
	context: MmMutationContext,
	modem: ModemRef,
	timeoutMs: number,
): Promise<NetworkScanResult> {
	return context.actor.run(context.resolveStableKey(modem), async () => {
		try {
			const reply = await context.transport.callMethod({
				destination: context.destination,
				path: modem,
				interface: MODEM3GPP_IFACE,
				member: 'Scan',
				timeoutMs,
			});
			return { ok: true, networks: parseScan(reply.body[0]) };
		} catch (error) {
			return { ok: false, reason: `network scan failed: ${describeMutationError(error)}` };
		}
	});
}

function parseScan(value: unknown): readonly ScannedNetwork[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const networks: ScannedNetwork[] = [];
	for (const entry of value as DecodedProps[]) {
		const operatorCode = stringProp(entry, 'operator-code');
		if (operatorCode === undefined) {
			continue;
		}
		const name = stringProp(entry, 'operator-long') ?? stringProp(entry, 'operator-short');
		const availability = AVAILABILITY[numberProp(entry, 'status') ?? 0] ?? 'unknown';
		networks.push({
			operatorCode,
			...(name !== undefined ? { operatorName: name } : {}),
			availability,
		});
	}
	return networks;
}
