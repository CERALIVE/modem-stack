// The bench CLI dispatcher — parse argv, wire the real stack, run one command.
//
// `runCli` is the testable core: it takes an argv array and a `CliIo`, so a test drives
// any command with captured output and no real process I/O. `--bus-address` (or the
// `MODEM_CONTROL_BUS_ADDRESS` env var) is the injection point that points the SAME code
// at the A2.3 fake ModemManager service instead of the real system bus.

import { parseArgs } from 'node:util';
import {
	createUhubctlPowerHook,
	createUsbEnumerator,
	MM_USB_MODES,
	type MmUsbMode,
	readUhubctlPortMap,
	SpawnUhubctlRunner,
} from '@ceralive/modem-control';
import { SpawnCommandRunner } from './certify/command-runner';
import { runApply } from './commands/apply';
import { type CertifyArgs, certifyDepsFromContext, runCertify } from './commands/certify';
import { runHilCycle } from './commands/hil-cycle';
import { runProbe } from './commands/probe';
import { runSetUsbMode, type UsbModeArgs } from './commands/set-usb-mode';
import { runUnlock } from './commands/unlock';
import { runUsage } from './commands/usage';
import { runWatch } from './commands/watch';
import { createStackContext, type GlobalOptions, type StackContext } from './context';
import { mmcliSlots, sysfsUsbSweep, usbIdPathPoller } from './hil-probe';
import type { CliIo } from './io';
import { readPolicyFile } from './policy-file';
import { buildRequestResolver, buildUsageInputs, buildUsbModeTransition } from './wiring';

const HELP = `modem-control — bench CLI for the CeraLive modem stack

Usage: modem-control <command> [options]

Commands:
  probe                          Stack snapshot: identities, classes, modes, features, cell info
  watch                          Live event stream of observation changes
  apply --policy <file>          Reconcile a desired-state policy (JSON/YAML); prints receipts
  set-usb-mode <slot> <target> --confirm   Certified USB-mode switch (refuses without --confirm)
  certify <slot>                 Capture a redacted, schema-validated certification bundle
  usage                          Print the data-usage sampler snapshot
  unlock-pin [slot]              Unlock a SIM PIN (redacted prompt)
  unlock-puk [slot]              Unblock a SIM PUK (redacted prompts)
  hil-cycle <slot> --hub-map <file>        HIL port cycle: cut VBUS and prove the modem came back (RB-10)

Global options:
  --bus-address <addr>           D-Bus bus address (harness/smoke injection; env MODEM_CONTROL_BUS_ADDRESS)
  --destination <name>           ModemManager bus name (default org.freedesktop.ModemManager1)

Command options:
  --policy <file>                (apply) desired-state file (.json / .yaml / .yml)
  --confirm                      (set-usb-mode) maps to the transaction confirm gate
  --duration <ms> | --events <n> (watch) exit bound; default runs until Ctrl-C
  --transition <mode>            (certify) capture transition evidence into <mode> (qmi/mbim/ecm-ncm)
  --output <file>                (certify) write the bundle here (default: stdout)
  --synthetic                    (certify) mark the bundle a synthetic sample (never for real captures)
  --hub-map <file>               (hil-cycle) uhubctl stable-key -> {hubLocation,port} map (required)
  --mm-slot <selector>           (hil-cycle) ModemManager selector for the same modem (default: <slot>)`;

/** Run one CLI invocation. Returns a process exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
	const { values, positionals } = parseArgs({
		args: [...argv],
		allowPositionals: true,
		options: {
			'bus-address': { type: 'string' },
			destination: { type: 'string' },
			policy: { type: 'string' },
			confirm: { type: 'boolean', default: false },
			duration: { type: 'string' },
			events: { type: 'string' },
			transition: { type: 'string' },
			output: { type: 'string' },
			synthetic: { type: 'boolean', default: false },
			signals: { type: 'string' },
			window: { type: 'string' },
			'hub-map': { type: 'string' },
			'mm-slot': { type: 'string' },
			help: { type: 'boolean', default: false },
		},
	});

	const command = positionals[0];
	if (values.help || command === undefined || command === 'help') {
		io.out(HELP);
		return command === undefined ? 1 : 0;
	}

	const global: GlobalOptions = {
		...(values['bus-address'] !== undefined ? { busAddress: values['bus-address'] } : {}),
		...(values.destination !== undefined ? { destination: values.destination } : {}),
	};

	switch (command) {
		case 'probe':
			return withStack(global, io, (ctx) => runProbe(ctx, io));
		case 'watch':
			return withStack(global, io, (ctx) =>
				runWatch(ctx, io, {
					...(values.duration !== undefined ? { durationMs: Number(values.duration) } : {}),
					...(values.events !== undefined ? { events: Number(values.events) } : {}),
				}),
			);
		case 'apply': {
			if (values.policy === undefined) {
				io.err('apply: --policy <file> is required');
				return 2;
			}
			const spec = await readPolicyFile(values.policy);
			return withStack(global, io, (ctx) => runApply(ctx, io, spec));
		}
		case 'set-usb-mode': {
			const slot = positionals[1];
			const target = positionals[2];
			if (slot === undefined || target === undefined) {
				io.err('set-usb-mode: usage: set-usb-mode <slot> <target> --confirm');
				return 2;
			}
			if (!isMmUsbMode(target)) {
				io.err(`set-usb-mode: invalid target '${target}' (expected ${MM_USB_MODES.join(' | ')})`);
				return 2;
			}
			const args: UsbModeArgs = { slot, target, confirm: values.confirm, maintenance: true };
			return withStack(global, io, (ctx) =>
				runSetUsbMode(io, buildRequestResolver(ctx), buildUsbModeTransition(ctx), args),
			);
		}
		case 'certify': {
			const slot = positionals[1];
			if (slot === undefined) {
				io.err('certify: usage: certify <slot> [--transition <mode>] [--output <file>]');
				return 2;
			}
			if (values.transition !== undefined && !isMmUsbMode(values.transition)) {
				io.err(
					`certify: invalid --transition '${values.transition}' (expected ${MM_USB_MODES.join(' | ')})`,
				);
				return 2;
			}
			const args: CertifyArgs = {
				slot,
				synthetic: values.synthetic,
				...(values.transition !== undefined ? { transition: values.transition as MmUsbMode } : {}),
				...(values.output !== undefined ? { output: values.output } : {}),
				...(values.signals !== undefined ? { maxSignals: Number(values.signals) } : {}),
				...(values.window !== undefined ? { windowMs: Number(values.window) } : {}),
			};
			return withStack(global, io, (ctx) =>
				runCertify(ctx, io, args, certifyDepsFromContext(ctx, args)),
			);
		}
		case 'hil-cycle': {
			const slot = positionals[1];
			const hubMap = values['hub-map'];
			if (slot === undefined || hubMap === undefined) {
				io.err('hil-cycle: usage: hil-cycle <slot> --hub-map <file> [--mm-slot <selector>]');
				return 2;
			}
			// No stack context: the harness reads sysfs + `mmcli`, never the D-Bus stack,
			// so it must not open (and then lose) a bus connection across a port cycle.
			const commandRunner = new SpawnCommandRunner();
			const enumerator = createUsbEnumerator();
			const poller = usbIdPathPoller(() => enumerator.enumerate());
			try {
				return await runHilCycle(
					io,
					{ slot, mmSlot: values['mm-slot'] ?? slot },
					{
						readPortMap: () => readUhubctlPortMap(hubMap),
						createPowerHook: (ports, recordingPoller) =>
							createUhubctlPowerHook({
								ports,
								runner: new SpawnUhubctlRunner(),
								poller: recordingPoller,
							}),
						poller,
						usbSweep: () => sysfsUsbSweep(),
						mmSlots: () => mmcliSlots(commandRunner),
					},
				);
			} catch (error) {
				io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
				return 1;
			}
		}
		case 'usage':
			return withStack(global, io, async (ctx) => {
				const { sampler, observations } = await buildUsageInputs(ctx);
				return runUsage(io, sampler, observations);
			});
		case 'unlock-pin':
			return withStack(global, io, (ctx) => runUnlock(ctx, io, 'pin', positionals[1]));
		case 'unlock-puk':
			return withStack(global, io, (ctx) => runUnlock(ctx, io, 'puk', positionals[1]));
		default:
			io.err(`unknown command '${command}'`);
			io.out(HELP);
			return 2;
	}
}

/** Open a stack context, run `command`, and always close it. */
async function withStack(
	global: GlobalOptions,
	io: CliIo,
	command: (ctx: StackContext) => Promise<number>,
): Promise<number> {
	const ctx = createStackContext(global);
	try {
		return await command(ctx);
	} catch (error) {
		io.err(`error: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	} finally {
		await ctx.close();
	}
}

function isMmUsbMode(value: string): value is MmUsbMode {
	return (MM_USB_MODES as readonly string[]).includes(value);
}
