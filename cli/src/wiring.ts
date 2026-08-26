// Production wiring — builds the real dependencies the `set-usb-mode` and `usage`
// commands need from a live `StackContext`. The harness tests build their OWN
// dependencies (fakes) against the fake MM + NM, so these builders are the bench /
// on-device path only. Where a dependency is genuinely hardware-gated (a raw AT serial
// port, an NM connection for a modem the fake cannot supply) they degrade with a clear
// error rather than pretending — full wiring lands with the Phase-B composition root.

import {
	createUsageFileStore,
	createUsageSampler,
	fetchManagedObjects,
	logicalSlotId,
	MODEM_IFACE,
	ModemActor,
	modemIdentityFactsFromTree,
	pathsWithInterface,
	procNetDevCounterSource,
	readBootId,
	resolveModemIdentities,
	type UsageObservation,
	type UsageSampler,
	UsbModeTransition,
} from '@ceralive/modem-control';
import { benchAtSender } from './bench-at-sender';
import type { RequestResolver, UsbModeArgs } from './commands/set-usb-mode';
import type { StackContext } from './context';
import { selectModem } from './select';
import { matchUsbDevice } from './usb-device-match';

/** Where per-slot usage state is persisted on device. */
const USAGE_STORE_PATH =
	process.env.MODEM_CONTROL_USAGE_STORE ?? '/var/lib/modem-control/usage.json';

/** Build the real USB-mode transaction over the live NM + MM ports. */
export function buildUsbModeTransition(ctx: StackContext): UsbModeTransition {
	return new UsbModeTransition({
		actor: new ModemActor(),
		nm: ctx.nm,
		modemManager: ctx.backend,
		atSender: benchAtSender,
		enumerate: () => ctx.enumerate(),
	});
}

/**
 * Resolve a transition request from the live stack. On the bench most physical facts
 * (a matched USB device, an NM connection for the modem) are unavailable, so this
 * returns a clear error — the real resolution runs on device. `confirm` and
 * `maintenance` are carried straight through so the transaction's entry gate decides.
 */
export function buildRequestResolver(ctx: StackContext): RequestResolver {
	return async (args: UsbModeArgs) => {
		const list = await ctx.backend.start();
		const modem = selectModem(list.rows, args.slot);
		if (modem === undefined) {
			return { ok: false, error: `no modem matching slot '${args.slot}'` };
		}
		const tree = await fetchManagedObjects(ctx.transport, ctx.destination);
		const paths = pathsWithInterface(tree, MODEM_IFACE);
		const resolved = resolveModemIdentities(paths.map((p) => modemIdentityFactsFromTree(tree, p)));
		const index = paths.indexOf(String(modem.identity.runtimePath));
		const stableKey = resolved[index]?.stableKey ?? String(modem.identity.runtimePath);
		const devices = await ctx.enumerate().catch(() => []);
		const device = matchUsbDevice(tree, String(modem.identity.runtimePath), devices);
		if (device === undefined || device.physicalUid === undefined) {
			return {
				ok: false,
				error: `cannot match modem ${stableKey} to a certified USB device on this bench (hardware-gated)`,
			};
		}
		return {
			ok: false,
			error:
				'set-usb-mode requires an NM connection for the modem, which the bench cannot supply (hardware-gated)',
		};
	};
}

/** Build the usage sampler and the per-slot observations from the live stack. */
export async function buildUsageInputs(
	ctx: StackContext,
): Promise<{ sampler: UsageSampler; observations: readonly UsageObservation[] }> {
	const bootId = await readBootId();
	const sampler = await createUsageSampler({
		bootId,
		source: procNetDevCounterSource(),
		store: createUsageFileStore({ path: USAGE_STORE_PATH }),
		now: () => ctx.now(),
	});
	const list = await ctx.backend.start();
	const observations: UsageObservation[] = [];
	for (const row of list.rows) {
		const slot = row.identity.logicalSlotId;
		const name = row.dataInterface.present ? row.dataInterface.name : undefined;
		if (slot === undefined || name === undefined) {
			continue;
		}
		observations.push({
			logicalSlotId: logicalSlotId(String(slot)),
			mappingGeneration: 0,
			ifname: name,
			confidence: row.identity.equipmentId.confidence,
			usage: {},
		});
	}
	return { sampler, observations };
}
