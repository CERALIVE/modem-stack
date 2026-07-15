// The bench CLI dispatcher — parse argv, wire the real stack, run one command.
//
// `runCli` is the testable core: it takes an argv array and a `CliIo`, so a test drives
// any command with captured output and no real process I/O. `--bus-address` (or the
// `MODEM_CONTROL_BUS_ADDRESS` env var) is the injection point that points the SAME code
// at the A2.3 fake ModemManager service instead of the real system bus.

import { parseArgs } from 'node:util';
import { MM_USB_MODES, type MmUsbMode } from '@ceralive/modem-control';
import { runApply } from './commands/apply';
import { runProbe } from './commands/probe';
import { runSetUsbMode, type UsbModeArgs } from './commands/set-usb-mode';
import { runUnlock } from './commands/unlock';
import { runUsage } from './commands/usage';
import { runWatch } from './commands/watch';
import { createStackContext, type GlobalOptions, type StackContext } from './context';
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
  usage                          Print the data-usage sampler snapshot
  unlock-pin [slot]              Unlock a SIM PIN (redacted prompt)
  unlock-puk [slot]              Unblock a SIM PUK (redacted prompts)

Global options:
  --bus-address <addr>           D-Bus bus address (harness/smoke injection; env MODEM_CONTROL_BUS_ADDRESS)
  --destination <name>           ModemManager bus name (default org.freedesktop.ModemManager1)

Command options:
  --policy <file>                (apply) desired-state file (.json / .yaml / .yml)
  --confirm                      (set-usb-mode) maps to the transaction confirm gate
  --duration <ms> | --events <n> (watch) exit bound; default runs until Ctrl-C`;

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
