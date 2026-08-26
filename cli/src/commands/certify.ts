// `modem-control certify <slot>` — capture a redacted, schema-validated certification
// bundle for one modem slot.
//
// The bundle records the USB and ModemManager evidence a human reviewer needs to certify
// a SKU: `lsusb -v`, `usb-devices`, the slot's udev properties, an `mmcli -K` dump, a
// redacted `GetManagedObjects`, and a bounded signal window. With `--transition <mode>`
// it also captures transition evidence (before/after descriptors, the executed AT command,
// the port-drop / re-enumeration timeline) shaped to drop straight into an A4.2 catalog
// entry. Real captures are marked `synthetic: false`; the bundle sha256 is the value that
// goes into a catalog entry's `evidenceBundleSha256`. A failed or malformed capture exits
// non-zero with a clear message — a broken bundle is never written.

import {
	type AtCommandSender,
	type DecodedManagedObjects,
	fetchManagedObjects,
	type MmUsbMode,
	readRevision,
	type UsbDeviceSnapshot,
} from '@ceralive/modem-control';
import { benchAtSender } from '../bench-at-sender';
import { buildCertificationBundle } from '../certify/bundle';
import type { SignalRecord } from '../certify/bundle-schema';
import { captureBase } from '../certify/capture';
import { type CommandResult, SpawnCommandRunner } from '../certify/command-runner';
import {
	createTransportSignalWindow,
	DEFAULT_SIGNAL_WINDOW,
	type SignalWindowBound,
} from '../certify/signal-window';
import { captureTransitionEvidence } from '../certify/transition-evidence';
import type { StackContext } from '../context';
import type { CliIo } from '../io';
import { selectModem } from '../select';
import { matchUsbDevice } from '../usb-device-match';

/** Parsed `certify` arguments. */
export interface CertifyArgs {
	readonly slot: string;
	/** Certify AROUND a transition to this MM mode (transition-evidence mode). */
	readonly transition?: MmUsbMode;
	/** Write the bundle JSON here; printed to stdout when omitted. */
	readonly output?: string;
	/** `true` marks the bundle a synthetic sample; a real bench capture is `false`. */
	readonly synthetic: boolean;
	readonly maxSignals?: number;
	readonly windowMs?: number;
}

/** The injectable capture seams — production builds these from the live stack. */
export interface CertifyDeps {
	run(command: string, args: readonly string[]): Promise<CommandResult>;
	fetchManagedObjects(): Promise<DecodedManagedObjects>;
	captureSignalWindow(): Promise<readonly SignalRecord[]>;
	enumerate(): Promise<readonly UsbDeviceSnapshot[]>;
	readonly atSender: AtCommandSender;
	now(): number;
	readonly synthetic: boolean;
	writeBundle(path: string, content: string): Promise<void>;
}

/** Build the production capture seams from a live stack context. */
export function certifyDepsFromContext(ctx: StackContext, args: CertifyArgs): CertifyDeps {
	const bound: SignalWindowBound | undefined =
		args.maxSignals !== undefined || args.windowMs !== undefined
			? {
					maxSignals: args.maxSignals ?? DEFAULT_SIGNAL_WINDOW.maxSignals,
					windowMs: args.windowMs ?? DEFAULT_SIGNAL_WINDOW.windowMs,
				}
			: undefined;
	return {
		run: (command, cmdArgs) => new SpawnCommandRunner().run(command, cmdArgs),
		fetchManagedObjects: () => fetchManagedObjects(ctx.transport, ctx.destination),
		captureSignalWindow: createTransportSignalWindow(ctx.transport, () => ctx.now(), bound),
		enumerate: () => ctx.enumerate(),
		atSender: benchAtSender,
		now: () => ctx.now(),
		synthetic: false,
		writeBundle: async (path, content) => {
			await Bun.write(path, content);
		},
	};
}

/** Run the certify capture, writing (or printing) the bundle. Returns an exit code. */
export async function runCertify(
	ctx: StackContext,
	io: CliIo,
	args: CertifyArgs,
	deps: CertifyDeps,
): Promise<number> {
	const list = await ctx.backend.start();
	const modem = selectModem(list.rows, args.slot);
	if (modem === undefined) {
		io.err(`certify: no modem matching slot '${args.slot}'`);
		return 1;
	}
	// A malformed / failed capture throws a `CertifyError`; catch it so the tool exits
	// non-zero with a clear message rather than crashing — a broken bundle is never written.
	try {
		const tree = await deps.fetchManagedObjects();
		const devices = await deps.enumerate().catch(() => []);
		const modemPath = String(modem.identity.runtimePath);
		const device = matchUsbDevice(tree, modemPath, devices);
		const firmwareRevision = readRevision(tree, modemPath);
		if (args.transition !== undefined && device === undefined) {
			io.err(
				`certify: --transition needs a matched USB device for slot '${args.slot}' (hardware-gated)`,
			);
			return 1;
		}
		const base = await captureBase(deps, {
			managedObjects: tree,
			modemPath,
			mmcliTarget: modemPath,
			...(device !== undefined ? { device } : {}),
		});

		let transition: Awaited<ReturnType<typeof captureTransitionEvidence>> | undefined;
		if (args.transition !== undefined && device !== undefined) {
			transition = await captureTransitionEvidence(
				{ enumerate: () => deps.enumerate(), atSender: deps.atSender, now: () => deps.now() },
				{ targetMode: args.transition, device, firmwareRevision },
			);
		}

		const { bundle, sha256 } = buildCertificationBundle({
			slot: args.slot,
			synthetic: deps.synthetic || args.synthetic,
			capturedAtMs: deps.now(),
			base,
			...(transition !== undefined ? { transition } : {}),
		});

		const json = `${JSON.stringify(bundle, null, 2)}\n`;
		if (args.output !== undefined) {
			await deps.writeBundle(args.output, json);
			io.out(`certify: wrote bundle to ${args.output}`);
		} else {
			io.out(json.trimEnd());
		}
		const transitionLabel =
			transition !== undefined ? `${transition.from}->${transition.to}` : 'none';
		io.out(
			`CERTIFY OK: sha256=${sha256} synthetic=${bundle.synthetic} transition=${transitionLabel} slot=${args.slot}`,
		);
		return 0;
	} catch (error) {
		io.err(`certify: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
