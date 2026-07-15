// `modem-control unlock-pin` / `unlock-puk <slot>` — SIM unlock with redacted prompts.
//
// The PIN / PUK is read through the I/O seam's `promptSecret`, which reads the secret
// with terminal echo DISABLED — it is never rendered to the screen, and it is never
// written back to any stream (the outcome `reason` from A3.3 never carries the secret
// either). The mutations run through the ModemManager port's exactly-once `sendPin` /
// `sendPuk` (read-before-submit is the adapter's job, A3.3).

import type { StackContext } from '../context';
import type { CliIo } from '../io';
import { selectModem } from '../select';

/** Which secret the command unlocks. */
export type UnlockKind = 'pin' | 'puk';

/** Prompt for the secret(s) and submit them; never echoes the secret. Returns an exit code. */
export async function runUnlock(
	ctx: StackContext,
	io: CliIo,
	kind: UnlockKind,
	slot: string | undefined,
): Promise<number> {
	const list = await ctx.backend.start();
	const modem = selectModem(list.rows, slot);
	if (modem === undefined) {
		io.err(
			`unlock-${kind}: no modem${slot !== undefined ? ` matching slot '${slot}'` : ''} observed`,
		);
		return 1;
	}
	const ref = modem.identity.runtimePath;

	if (kind === 'pin') {
		const pin = await io.promptSecret('SIM PIN: ');
		const result = await ctx.backend.sendPin(ref, pin);
		const remaining =
			result.remainingAttempts !== undefined ? ` (remaining=${result.remainingAttempts})` : '';
		io.out(`unlock-pin: ${result.outcome}${remaining} — ${result.reason}`);
		return result.outcome === 'unlocked' ? 0 : 1;
	}

	const puk = await io.promptSecret('SIM PUK: ');
	const newPin = await io.promptSecret('New SIM PIN: ');
	const result = await ctx.backend.sendPuk(ref, puk, newPin);
	const remaining =
		result.remainingAttempts !== undefined ? ` (remaining=${result.remainingAttempts})` : '';
	io.out(`unlock-puk: ${result.outcome}${remaining} — ${result.reason}`);
	return result.outcome === 'unlocked' ? 0 : 1;
}
