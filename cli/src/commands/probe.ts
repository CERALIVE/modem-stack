// `modem-control probe` — a one-shot stack snapshot.
//
// Prints, for every currently-observed modem: its identity (with the identity-ladder
// resolution), lifecycle state, MM feature-detection result, read-only enrichment, and
// normalized cell info — plus the classified USB devices (device class + observed USB
// mode). It ends with a machine-checkable `PROBE OK: external-auth, objects=<n>` line
// the compiled-probe smoke asserts. The EXTERNAL-auth D-Bus handshake and the
// authoritative `GetManagedObjects` read both happen inside `backend.start()`.

import {
	classifyDevice,
	detectModemFeatures,
	detectUsbMode,
	fetchManagedObjects,
	MM_MANAGER_IFACE,
	MM_ROOT_PATH,
	MODEM_IFACE,
	modemIdentityFactsFromTree,
	pathsWithInterface,
	type ResolvedIdentity,
	resolveModemIdentities,
} from '@ceralive/modem-control';
import type { DbusValue } from '@ceralive/modem-control/transport';
import type { StackContext } from '../context';
import type { CliIo } from '../io';
import {
	renderCellReading,
	renderEnrichment,
	renderFeatures,
	renderIdentity,
	renderResolvedIdentity,
	renderState,
	renderUsbDevice,
} from '../render';

/** Read the MM daemon `Version` property; '' when unreadable (e.g. the fake service). */
async function readMmVersion(ctx: StackContext): Promise<string> {
	try {
		const reply = await ctx.transport.callMethod({
			destination: ctx.destination,
			path: MM_ROOT_PATH,
			interface: 'org.freedesktop.DBus.Properties',
			member: 'Get',
			signature: 'ss',
			args: [MM_MANAGER_IFACE, 'Version'],
		});
		return variantString(reply.body[0]);
	} catch {
		return '';
	}
}

/** Unwrap a `Get` reply value (a variant `{ signature, value }`) to a string. */
function variantString(value: DbusValue | undefined): string {
	if (
		value !== undefined &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		'value' in value
	) {
		return String((value as { value: unknown }).value);
	}
	return typeof value === 'string' ? value : '';
}

/** Run the probe against the stack, writing the snapshot to `io`. Returns an exit code. */
export async function runProbe(ctx: StackContext, io: CliIo): Promise<number> {
	const list = await ctx.backend.start();
	if (!list.ok) {
		io.err(`probe: observation source unavailable (${list.reason})`);
	}

	let objectCount = 0;
	const version = await readMmVersion(ctx);
	const resolvedByPath = new Map<string, ResolvedIdentity>();
	try {
		const tree = await fetchManagedObjects(ctx.transport, ctx.destination);
		objectCount = tree.length;
		const paths = pathsWithInterface(tree, MODEM_IFACE);
		const resolved = resolveModemIdentities(
			paths.map((path) => modemIdentityFactsFromTree(tree, path)),
		);
		paths.forEach((path, index) => {
			const entry = resolved[index];
			if (entry !== undefined) {
				resolvedByPath.set(path, entry);
			}
		});
		io.out(`ModemManager: version=${version || 'unknown'} objects=${objectCount}`);

		io.out(`modems: ${list.rows.length}`);
		for (const snapshot of list.rows) {
			const path = snapshot.identity.runtimePath;
			io.out('');
			io.out(`modem ${path}`);
			io.out(`  ${renderIdentity(snapshot.identity)}`);
			const ladder = resolvedByPath.get(path);
			if (ladder !== undefined) {
				io.out(`  ${renderResolvedIdentity(ladder)}`);
			}
			io.out(`  ${renderState(snapshot)}`);
			io.out(`  features: ${renderFeatures(detectModemFeatures(version, tree, path))}`);
			const enrichment = await ctx.backend.readEnrichment(path);
			io.out(`  enrichment: ${renderEnrichment(enrichment)}`);
			if (enrichment.cellInfo.length === 0) {
				io.out('  cell-info: (none)');
			} else {
				for (const reading of enrichment.cellInfo) {
					io.out(`  cell: ${renderCellReading(reading)}`);
				}
			}
		}
	} catch (error) {
		io.err(`probe: failed to read managed objects: ${message(error)}`);
		return 1;
	}

	const devices = await ctx.enumerate().catch(() => []);
	io.out('');
	io.out(`usb-devices: ${devices.length}`);
	for (const device of devices) {
		io.out(`  ${renderUsbDevice(device, classifyDevice(device), detectUsbMode(device))}`);
	}

	io.out('');
	io.out(`PROBE OK: external-auth, objects=${objectCount}`);
	return 0;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
